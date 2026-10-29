import ast
import json
import os
import re
import sys

REPO = os.path.abspath(sys.argv[1])
OUT = sys.argv[2]
SUBJECT_RE = re.compile(r"^[A-Za-z][\w-]*(\.[\w#*-]+)+$")
TEST_RE = re.compile(r"(^|/)(tests?|migrations|scripts|examples)/|(^|/)(test_|conftest)")


def ext_name(mod):
    parts = mod.split(".")
    return ".".join(parts[:2]) if parts[0] == "google" and len(parts) > 1 else parts[0]


def rel(p):
    return os.path.relpath(p, REPO).replace(os.sep, "/")


SKIP = {"node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "__pycache__", "tmp", ".nx"}


def discover():
    out = []

    def walk(d, depth):
        if os.path.exists(os.path.join(d, "pyproject.toml")):
            out.append((os.path.basename(d) if d != REPO else os.path.basename(REPO), d))
        if depth >= 4:
            return
        for e in sorted(os.listdir(d)):
            p = os.path.join(d, e)
            if os.path.isdir(p) and e not in SKIP and not e.startswith("."):
                walk(p, depth + 1)

    walk(REPO, 0)
    return out


def clip(s, n=70):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def sig(fn):
    args = [a.arg + (": " + clip(ast.unparse(a.annotation), 28) if a.annotation else "") for a in fn.args.args if a.arg not in ("self", "cls")]
    ret = ": " + clip(ast.unparse(fn.returns), 32) if fn.returns else ""
    return f"({', '.join(args)}){ret}"


def enums_of(tree):
    out = {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and any(ast.unparse(b) in ("Enum", "str, Enum") or ast.unparse(b).endswith("Enum") for b in node.bases):
            for st in node.body:
                if isinstance(st, ast.Assign) and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str):
                    for t in st.targets:
                        if isinstance(t, ast.Name):
                            out[f"{node.name}.{t.id}"] = st.value.value
    return out


def main():
    result = []
    packages = discover()
    for wid, wdir in packages:
        nested = [d for _, d in packages if d != wdir and d.startswith(wdir + os.sep)]
        paths = []
        for root, dirs, fs in os.walk(wdir):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP and os.path.join(root, d) not in nested)
            for f in sorted(fs):
                p = os.path.join(root, f)
                if f.endswith(".py") and not TEST_RE.search(rel(p)[len(rel(wdir)) + 1 :]):
                    paths.append(p)
        trees = {p: ast.parse(open(p, encoding="utf-8").read(), filename=p) for p in paths}
        enums = {}
        for t in trees.values():
            enums.update(enums_of(t))

        def lit(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            text = ast.unparse(node)
            text = re.sub(r"\.value$", "", text)
            return enums.get(text)

        def resolve(mod, level, here):
            if level:
                base = os.path.dirname(here)
                for _ in range(level - 1):
                    base = os.path.dirname(base)
                parts = mod.split(".") if mod else []
                cand = os.path.join(base, *parts)
            else:
                cand = os.path.join(wdir, *mod.split("."))
            for c in (cand + ".py", os.path.join(cand, "__init__.py")):
                if c in trees:
                    return rel(c)
            return None

        files = {}
        mq = []
        for p, tree in trees.items():
            f = rel(p)
            imports = []
            decls = []
            ext = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    t = resolve(node.module or "", node.level, p)
                    names = [a.name for a in node.names]
                    if t is None and node.module:
                        for a in node.names:
                            t2 = resolve(f"{node.module}.{a.name}", 0, p)
                            if t2:
                                imports.append({"spec": node.module, "target": t2, "names": ["*"]})
                    if t:
                        imports.append({"spec": node.module or "." * node.level, "target": t, "names": names})
                    elif node.level == 0 and node.module and not any(i["spec"] == node.module for i in imports):
                        ext.add(ext_name(node.module))
                elif isinstance(node, ast.Import):
                    for a in node.names:
                        t = resolve(a.name, 0, p)
                        if t:
                            imports.append({"spec": a.name, "target": t, "names": ["*"]})
                        else:
                            ext.add(ext_name(a.name))
                elif isinstance(node, ast.Dict):
                    for k, v in zip(node.keys, node.values):
                        s = lit(k) if k is not None else None
                        if s and SUBJECT_RE.match(s) and isinstance(v, ast.Call) and ast.unparse(v.func) == "HandlerConfig":
                            pattern = next((ast.unparse(kw.value) for kw in v.keywords if kw.arg == "pattern"), "")
                            mq.append({"kind": "rpc-serve" if "REQUEST_REPLY" in pattern or "RPC" in pattern else "subscribe", "subject": s, "file": f})
                elif isinstance(node, ast.Call):
                    for kw in node.keywords:
                        if kw.arg == "routing_key":
                            s = lit(kw.value)
                            if s and SUBJECT_RE.match(s):
                                mq.append({"kind": "publish", "subject": s, "file": f})
            boot = set()
            for st in tree.body:
                if isinstance(st, ast.If) and "__name__" in ast.unparse(st.test) and "__main__" in ast.unparse(st.test):
                    boot.add("__main__")
                if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and ast.unparse(st.value.func) in ("uvicorn.run", "asyncio.run", "app.run"):
                    boot.add(ast.unparse(st.value.func))
            for st in tree.body:
                if isinstance(st, ast.ClassDef) and not st.name.startswith("_"):
                    members = [m.name + sig(m) for m in st.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and not m.name.startswith("_")]
                    decls.append({"name": st.name, "kind": "class", "decorators": [], "extends": [ast.unparse(b) for b in st.bases], "members": members, "routes": []})
                elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)) and not st.name.startswith("_"):
                    decls.append({"name": st.name, "kind": "function", "sig": sig(st)})
            lines = len(open(p, encoding="utf-8").read().splitlines())
            local_roots = {os.path.basename(os.path.dirname(x)) for x in trees} | {"app"}
            files[f] = {"lines": lines, "imports": imports, "boot": sorted(boot), "mount": [], "externals": sorted(e for e in ext if e.split(".")[0] not in sys.stdlib_module_names and e not in local_roots), "decls": decls}
        meta = {"name": wid, "deps": [], "start": None, "bin": False, "exportsField": False, "dockerfile": os.path.exists(os.path.join(wdir, "Dockerfile"))}
        if not files:
            continue
        result.append({"id": wid, "dir": rel(wdir) if wdir != REPO else ".", "parent": os.path.basename(os.path.dirname(wdir)) if wdir != REPO else "", "aliases": [], "files": files, "mq": mq, "lang": "python", "meta": meta})
        sys.stdout.write(f"{wid}: {len(files)} files, {len(mq)} mq facts\n")
    json.dump({"workspaces": result}, open(OUT, "w"))


main()
