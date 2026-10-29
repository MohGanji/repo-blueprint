import { loadConfig } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO = path.resolve(process.argv[2] || process.cwd());
const CONFIG = loadConfig(REPO);
const MSG = CONFIG.messaging;
const OUT = path.resolve(process.argv[3] || 'facts-ts.json');

import { builtinModules } from 'node:module';
const BUILTINS = new Set([...builtinModules, 'bun', 'bun:test']);
const TEST_RE = /(\.spec\.|\.test\.|\.d\.ts$|\/__fixtures__\/|\/__test-fixtures__\/|\/__mocks__\/|\/test\/|\/tests\/|\/simulations\/|vitest\.|playwright\.)/;
const ROUTE_DECORATORS = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', All: 'ALL' };
const BOOT_RE = /^(NestFactory\.(create|createMicroservice|createApplicationContext)|Bun\.serve|serve|http\.createServer|https\.createServer|createServer|Worker\.create|[\w.]*\.listen)$/;
const MOUNT_RE = /^(createRoot|hydrateRoot|ReactDOM\.render|ReactDOM\.createRoot|ReactDOM\.hydrate|createApp|bootstrapApplication|platformBrowserDynamic)$/;
const SUBJECT_RE = /^[A-Za-z][\w-]*(\.[\w#*-]+)+$/;

const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
const clip = (s, n = 70) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', '.nx', 'tmp', '.next', 'out', '.turbo', 'playwright-report', 'test-results']);

function discoverWorkspaces() {
  const out = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, 'tsconfig.json')) && fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
    if (depth >= 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(REPO, 0);
  const ids = new Map();
  return out.map((dir) => {
    let id = dir === REPO ? path.basename(REPO) : path.basename(dir);
    if (ids.has(id)) id = rel(dir).replace(/\//g, '-');
    ids.set(id, dir);
    return { id, dir, parent: dir === REPO ? '' : path.basename(path.dirname(dir)) };
  });
}

function literalOf(checker, expr) {
  if (!expr) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  const t = checker.getTypeAtLocation(expr);
  if (t && t.isStringLiteral && t.isStringLiteral()) return t.value;
  return null;
}

function subjectsOf(checker, expr) {
  if (!expr) return { values: [], inferred: false };
  const one = literalOf(checker, expr);
  if (one) return { values: [one], inferred: false };
  const t = checker.getTypeAtLocation(expr);
  if (t && t.isUnion && t.isUnion() && t.types.every((x) => x.isStringLiteral && x.isStringLiteral()) && t.types.length <= 8) return { values: t.types.map((x) => x.value).sort(), inferred: true };
  return { values: [], inferred: false };
}

function literalsOf(checker, expr) {
  if (!expr) return [];
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((e) => literalOf(checker, e)).filter(Boolean);
  const one = literalOf(checker, expr);
  return one ? [one] : [];
}

function declFileOf(checker, expr) {
  let sym = checker.getSymbolAtLocation(expr);
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym.declarations && sym.declarations[0];
  return d ? rel(d.getSourceFile().fileName) : null;
}

function isParamOf(id, checker) {
  const sym = checker.getSymbolAtLocation(id);
  return !!(sym && sym.declarations && sym.declarations.some((d) => ts.isParameter(d)));
}

function prop(obj, name) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.properties.find((x) => ts.isPropertyAssignment(x) && x.name && x.name.getText() === name);
  return p ? p.initializer : undefined;
}

function decoratorsOf(node) {
  const ds = (ts.canHaveDecorators && ts.canHaveDecorators(node) ? ts.getDecorators(node) : node.decorators) || [];
  return ds.map((d) => {
    const e = d.expression;
    if (ts.isCallExpression(e)) {
      const a0 = e.arguments[0];
      const arg = a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) ? a0.text : a0 && ts.isArrayLiteralExpression(a0) && a0.elements[0] && ts.isStringLiteral(a0.elements[0]) ? a0.elements[0].text : null;
      return { name: e.expression.getText(), arg };
    }
    return { name: e.getText(), arg: null };
  });
}

const isExported = (node) => !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
const isHidden = (m) => {
  const f = ts.getCombinedModifierFlags(m);
  return !!(f & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) || (m.name && /^[#_]/.test(m.name.getText()));
};

function paramsSig(fn) {
  const ps = fn.parameters.map((p) => p.name.getText() + (p.questionToken ? '?' : '') + (p.type ? ': ' + clip(p.type.getText(), 28) : ''));
  const ret = fn.type ? ': ' + clip(fn.type.getText(), 32) : '';
  return `(${ps.join(', ')})${ret}`;
}

function classifyFn(name, file) {
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name) && file.endsWith('.tsx')) return 'component';
  return 'function';
}

function extractDecls(sf, file) {
  const decls = [];
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name && isExported(st)) {
      const decos = decoratorsOf(st);
      const ctrl = decos.find((d) => d.name === 'Controller');
      const gateway = decos.find((d) => d.name === 'WebSocketGateway');
      const members = [];
      const routes = [];
      for (const m of st.members) {
        if (!(ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) || !m.name || isHidden(m)) continue;
        if (ts.isMethodDeclaration(m)) members.push(m.name.getText() + paramsSig(m));
        for (const d of decoratorsOf(m)) {
          if (ctrl && ROUTE_DECORATORS[d.name]) {
            const p = ['', ctrl.arg || '', d.arg || ''].join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
            routes.push(`${ROUTE_DECORATORS[d.name]} ${p}`);
          }
          if (gateway && d.name === 'SubscribeMessage' && d.arg) routes.push(`WS ${d.arg}`);
        }
      }
      const ext = st.heritageClauses?.flatMap((h) => h.types.map((t) => t.expression.getText())) || [];
      decls.push({ name: st.name.text, kind: 'class', decorators: decos.map((d) => d.name), extends: ext, members, routes });
    } else if (ts.isFunctionDeclaration(st) && st.name && isExported(st)) {
      decls.push({ name: st.name.text, kind: classifyFn(st.name.text, file), sig: paramsSig(st) });
    } else if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
        const wrapped = init && ts.isCallExpression(init) && init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (fn || wrapped) decls.push({ name: d.name.text, kind: classifyFn(d.name.text, file), sig: paramsSig(fn || wrapped) });
        else decls.push({ name: d.name.text, kind: 'const' });
      }
    } else if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && isExported(st)) {
      decls.push({ name: st.name.text, kind: 'type' });
    } else if (ts.isEnumDeclaration(st) && isExported(st)) {
      decls.push({ name: st.name.text, kind: 'enum', members: st.members.map((m) => m.name.getText()) });
    }
  }
  return decls;
}

function declaredRole(dir) {
  const out = {};
  const pj = path.join(dir, 'project.json');
  if (fs.existsSync(pj)) {
    const t = JSON.parse(fs.readFileSync(pj, 'utf8')).projectType;
    if (t) out.nx = t;
  }
  for (const f of ['catalog-info.yaml', 'catalog-info.yml']) {
    const cp = path.join(dir, f);
    if (!fs.existsSync(cp)) continue;
    const m = /^spec:\s*\n(?:[ \t]+.*\n)*?[ \t]+type:\s*([\w-]+)/m.exec(fs.readFileSync(cp, 'utf8'));
    if (m) out.backstage = m[1];
  }
  return out;
}

function analyzeWorkspace(ws, allWs) {
  const pj = fs.existsSync(path.join(ws.dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(ws.dir, 'package.json'), 'utf8')) : {};
  const meta = {
    name: pj.name || null,
    deps: Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies }).sort(),
    start: pj.scripts && pj.scripts.start ? pj.scripts.start : null,
    bin: !!pj.bin,
    exportsField: !!(pj.exports || pj.main || pj.module || pj.types),
    dockerfile: fs.existsSync(path.join(ws.dir, 'Dockerfile')),
    declared: declaredRole(ws.dir),
  };
  const cfgPath = path.join(ws.dir, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ws.dir, { noEmit: true }, cfgPath);
  const options = { ...parsed.options, noEmit: true, skipLibCheck: true, allowJs: false };
  const owner = (f) => allWs.filter((w) => f.startsWith(w.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  let roots = parsed.fileNames.filter((f) => /\.tsx?$/.test(f) && !TEST_RE.test(rel(f)) && owner(f) === ws);
  const rootIndex = path.join(ws.dir, 'index.ts');
  if (fs.existsSync(rootIndex) && !roots.includes(rootIndex)) roots.push(rootIndex);
  roots = roots.sort();
  const program = ts.createProgram(roots, options);
  const checker = program.getTypeChecker();
  const host = ts.createCompilerHost(options);
  const aliases = Object.entries(options.paths || {}).map(([k, v]) => ({ pattern: k, targets: v.map((t) => rel(path.resolve(options.baseUrl || options.pathsBasePath || ws.dir, t))) }));

  const files = {};
  const mq = [];
  for (const abs of roots) {
    const sf = program.getSourceFile(abs);
    if (!sf) continue;
    const file = rel(abs);
    const imports = [];
    const externals = new Set();
    const boot = new Set();
    const mount = new Set();
    const lines = sf.getLineAndCharacterOfPosition(sf.end).line + 1;

    const addImport = (spec, names, node) => {
      const pkg = Object.keys(PKG_NAMES).find((n) => spec === n || spec.startsWith(n + '/'));
      if (pkg && PKG_NAMES[pkg] !== ws.id) {
        imports.push({ spec, target: `pkg:${PKG_NAMES[pkg]}`, names });
        return;
      }
      const r = ts.resolveModuleName(spec, abs, options, host).resolvedModule;
      if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('node:') && (!r || r.isExternalLibraryImport || /node_modules/.test(r.resolvedFileName))) {
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!ts.isBuiltinModule?.(pkgName) && !BUILTINS.has(pkgName)) externals.add(pkgName);
        return;
      }
      if (!r || r.isExternalLibraryImport || /node_modules/.test(r.resolvedFileName)) return;
      const target = rel(r.resolvedFileName);
      if (target.startsWith('..')) return;
      imports.push({ spec, target, names });
    };

    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const names = [];
        const ic = ts.isImportDeclaration(node) ? node.importClause : null;
        if (ic) {
          if (ic.name) names.push('default');
          const nb = ic.namedBindings;
          if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.push((e.propertyName || e.name).text);
          if (nb && ts.isNamespaceImport(nb)) names.push('*');
        } else if (ts.isExportDeclaration(node)) {
          if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const e of node.exportClause.elements) names.push((e.propertyName || e.name).text);
          else names.push('*');
        }
        addImport(node.moduleSpecifier.text, names, node);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) addImport(node.arguments[0].text, ['*'], node);
        const text = callee.getText(sf);
        if (BOOT_RE.test(text)) boot.add(text.replace(/^.*\.(?=listen$)/, '.'));
        if (MOUNT_RE.test(text)) mount.add(text);
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (MSG.handlerRegistrations.some((h) => text === h || text.endsWith('.' + h))) mq.push(...readMqModule(checker, node.arguments[0], file));
        const pubArg = MSG.publishMethods.includes(method) ? node.arguments[0] : MSG.publishToMethods.includes(method) ? node.arguments[1] : null;
        if (pubArg && !(ts.isIdentifier(pubArg) && /^(subject|routingKey|event)$/.test(pubArg.text) && isParamOf(pubArg, checker))) {
          const { values, inferred } = subjectsOf(checker, pubArg);
          const ok = values.filter((s) => SUBJECT_RE.test(s));
          for (const s of ok) mq.push({ kind: 'publish', subject: s, file, inferred });
          if (!ok.length && (MSG.publishToMethods.includes(method) || method === MSG.publishMethods[0])) mq.push({ kind: 'publish-dynamic', file, expr: clip(pubArg.getText(sf), 50) });
        }
        if (MSG.rpcSendMethods.includes(method) && node.arguments.length >= 2) {
          const subj = prop(node.arguments[1], MSG.rpcSubjectProperty);
          if (subj) {
            const { values, inferred } = subjectsOf(checker, subj);
            for (const s of values) mq.push({ kind: 'rpc-call', subject: s, file, inferred });
            if (!values.length) mq.push({ kind: 'rpc-call-dynamic', file, expr: clip(subj.getText(sf), 50) });
          }
        }
        if (MSG.subscribeMethods.includes(method) && node.arguments.length >= 2) {
          const s = literalOf(checker, node.arguments[0]);
          if (s && SUBJECT_RE.test(s)) mq.push({ kind: 'subscribe', subject: s, file, handler: declFileOf(checker, node.arguments[1]) });
        }
      } else if (ts.isNewExpression(node) && /^(Worker|QueueEvents)$/.test(node.expression.getText(sf))) {
        boot.add('new ' + node.expression.getText(sf));
      } else if (ts.isPropertyAssignment(node) && node.name) {
        const n = node.name.getText(sf);
        if (MSG.routingKeyProperties.includes(n)) for (const s of literalsOf(checker, node.initializer)) if (SUBJECT_RE.test(s)) mq.push({ kind: 'subscribe', subject: s, file });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    files[file] = { lines, imports, externals: [...externals].sort(), boot: [...boot].sort(), mount: [...mount].sort(), decls: extractDecls(sf, file) };
  }
  return { id: ws.id, dir: rel(ws.dir) || '.', parent: ws.parent, aliases, files, mq, meta, lang: 'typescript' };
}

function readMqModule(checker, obj, file) {
  const out = [];
  if (!obj || !ts.isObjectLiteralExpression(obj)) return out;
  const rpc = prop(obj, 'rpc');
  const rpcServer = rpc && prop(rpc, 'server') && prop(rpc, 'server').kind === ts.SyntaxKind.TrueKeyword;
  const bound = new Set();
  const binding = prop(obj, 'binding');
  if (binding && ts.isArrayLiteralExpression(binding)) {
    for (const b of binding.elements) for (const s of literalsOf(checker, prop(b, 'subjects'))) bound.add(s);
  }
  const handlers = prop(obj, 'handlers');
  const entries = handlers && ts.isNewExpression(handlers) && handlers.arguments && handlers.arguments[0] && ts.isArrayLiteralExpression(handlers.arguments[0]) ? handlers.arguments[0].elements : [];
  const handled = new Set();
  for (const e of entries) {
    if (!ts.isArrayLiteralExpression(e) || e.elements.length < 2) continue;
    const s = literalOf(checker, e.elements[0]);
    if (!s) continue;
    handled.add(s);
    const isEvent = bound.has(s);
    out.push({ kind: isEvent || !rpcServer ? 'subscribe' : 'rpc-serve', subject: s, file, handler: declFileOf(checker, e.elements[1]), handlerName: e.elements[1].getText() });
  }
  for (const s of bound) if (!handled.has(s)) out.push({ kind: 'subscribe', subject: s, file });
  return out;
}

const wss = discoverWorkspaces();
const PKG_NAMES = {};
const localDeps = new Set();
const pjOf = (ws) => (fs.existsSync(path.join(ws.dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(ws.dir, 'package.json'), 'utf8')) : {});
for (const ws of wss) {
  const pj = pjOf(ws);
  for (const [n, v] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) if (/^(file:|workspace:|link:)/.test(String(v))) localDeps.add(n);
}
for (const ws of wss) {
  const name = pjOf(ws).name;
  if (name && localDeps.has(name)) PKG_NAMES[name] = ws.id;
}
const result = { repo: REPO, workspaces: [] };
for (const ws of wss) {
  const t0 = Date.now();
  const r = analyzeWorkspace(ws, wss);
  if (!Object.keys(r.files).length) continue;
  result.workspaces.push(r);
  process.stdout.write(`${ws.id}: ${Object.keys(r.files).length} files, ${r.mq.length} mq facts, ${Date.now() - t0}ms\n`);
}
fs.writeFileSync(OUT, JSON.stringify(result));
