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
const TEST_RE = /(\.spec\.|\.test\.|\.d\.ts$|(^|\/)(__tests__|__fixtures__|__test-fixtures__|__mocks__|test|tests|test-d|simulations)\/|vitest\.|playwright\.)/;
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
const SOURCE_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;
const isSource = (f) => SOURCE_RE.test(f) && !/\.d\.[mc]?ts$/.test(f);
// Single-file components hold imports too, but are not parsed yet: they are counted and reported as skipped.
const COMPONENT_RE = /\.(vue|svelte|astro)$/;
const inSkippedDir = (relPath) => relPath.split('/').slice(0, -1).some((seg) => SKIP_DIRS.has(seg) || seg.startsWith('.'));

// Used when a package has neither a tsconfig.json nor a jsconfig.json.
const DEFAULT_OPTIONS = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  resolveJsonModule: true,
};

// Source files under dir. With nested: true, it descends into nested packages and also lists component files.
function walkSources(dir, nested = false) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && (nested || !fs.existsSync(path.join(abs, 'package.json')))) walk(abs);
      } else if (isSource(e.name) || (nested && COMPONENT_RE.test(e.name))) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

// Compiler options and file list for a package: its tsconfig.json, else its jsconfig.json, else defaults over every source file.
// JavaScript is always analysed, whatever the config says about allowJs.
function compilerSetup(dir) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(dir, name);
    if (!fs.existsSync(cfgPath)) continue;
    const raw = ts.readConfigFile(cfgPath, ts.sys.readFile).config || {};
    raw.compilerOptions = { ...raw.compilerOptions, allowJs: true };
    const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, dir, { noEmit: true }, cfgPath);
    return { options: parsed.options, fileNames: parsed.fileNames, config: name };
  }
  return { options: DEFAULT_OPTIONS, fileNames: walkSources(dir), config: null };
}

function discoverWorkspaces() {
  const out = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
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

const isStringish = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

// Names a require() call takes: `const { a } = require(x)` → a, `require(x).a` → a, anything else → the whole module.
function requiredNames(call) {
  const p = call.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) return p.name.elements.map((e) => (e.propertyName || e.name).getText());
  if (p && ts.isPropertyAccessExpression(p) && p.expression === call) return [p.name.text];
  return ['*'];
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
  if (/^[A-Z]/.test(name) && /\.[jt]sx$/.test(file)) return 'component';
  return 'function';
}

// Target name of a CommonJS export assignment: `module.exports` → '', `exports.a` / `module.exports.a` → 'a', anything else → null.
function cjsTarget(left) {
  const t = left.getText();
  if (t === 'module.exports') return '';
  const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(t);
  return m ? m[1] : null;
}

// CommonJS exports: `module.exports = { a, b: fn }`, `module.exports = fn`, `exports.a = …`.
function cjsDecls(sf, file) {
  const local = new Map();
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) local.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) local.set(d.name.text, d.initializer);
  }
  const declOf = (name, value) => {
    const v = value && ts.isIdentifier(value) && local.has(value.text) ? local.get(value.text) : value;
    if (v && (ts.isClassDeclaration(v) || ts.isClassExpression(v))) return { name, kind: 'class', decorators: [], extends: [], members: [], routes: [] };
    if (v && (ts.isFunctionDeclaration(v) || ts.isFunctionExpression(v) || ts.isArrowFunction(v) || ts.isMethodDeclaration(v))) return { name, kind: classifyFn(name, file), sig: paramsSig(v) };
    return { name, kind: 'const' };
  };
  const decls = [];
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression) || st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const { left, right } = st.expression;
    const target = cjsTarget(left);
    if (target === null) continue;
    if (target) decls.push(declOf(target, right));
    else if (ts.isObjectLiteralExpression(right)) {
      for (const p of right.properties) {
        if (ts.isShorthandPropertyAssignment(p)) decls.push(declOf(p.name.text, p.name));
        else if (ts.isPropertyAssignment(p) && p.name) decls.push(declOf(p.name.getText(sf), p.initializer));
        else if (ts.isMethodDeclaration(p) && p.name) decls.push(declOf(p.name.getText(sf), p));
      }
    } else decls.push(declOf('default', right));
  }
  return decls;
}

function extractDecls(sf, file) {
  const decls = cjsDecls(sf, file);
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

// Files a package.json publishes through main, module, browser, bin and exports, as repo-relative paths.
function publishedFiles(dir, pj) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string') {
      if (!v.startsWith('.') && !/^[\w@-]/.test(v)) return;
      const abs = path.resolve(dir, v);
      for (const c of [abs, ...['.js', '.ts', '.mjs', '.cjs', '/index.js', '/index.ts'].map((x) => abs + x)]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return out.add(rel(c));
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  for (const k of ['main', 'module', 'browser', 'bin', 'exports', 'types']) add(pj[k]);
  return [...out].sort();
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
    published: publishedFiles(ws.dir, pj),
    declared: declaredRole(ws.dir),
  };
  const setup = compilerSetup(ws.dir);
  const options = { ...setup.options, noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false, maxNodeModuleJsDepth: 0 };
  const owner = (f) => allWs.filter((w) => f.startsWith(w.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  let roots = setup.fileNames.filter((f) => isSource(f) && !TEST_RE.test(rel(f)) && !inSkippedDir(rel(f)) && owner(f) === ws);
  const rootIndex = path.join(ws.dir, 'index.ts');
  if (fs.existsSync(rootIndex) && !roots.includes(rootIndex)) roots.push(rootIndex);
  roots = roots.sort();
  const program = ts.createProgram(roots, options);
  const checker = program.getTypeChecker();
  const host = ts.createCompilerHost(options);
  const aliases = Object.entries(options.paths || {}).map(([k, v]) => ({ pattern: k, targets: v.map((t) => rel(path.resolve(options.baseUrl || options.pathsBasePath || ws.dir, t))) }));

  const files = {};
  const mq = [];
  const skipped = [];
  const inRoots = new Set(roots);
  const configName = setup.config || 'package settings';
  for (const abs of walkSources(ws.dir, true)) {
    if (owner(abs) !== ws || TEST_RE.test(rel(abs)) || inRoots.has(abs)) continue;
    skipped.push({ file: rel(abs), reason: COMPONENT_RE.test(abs) ? 'not parsed: Vue, Svelte and Astro files are not supported yet' : `left out by its ${configName}` });
  }
  for (const abs of roots) {
    const sf = program.getSourceFile(abs);
    if (!sf) {
      skipped.push({ file: rel(abs), reason: 'could not be read' });
      continue;
    }
    const file = rel(abs);
    const imports = [];
    const unresolved = new Set();
    const dynamic = new Set();
    const externals = new Set();
    const boot = new Set();
    const mount = new Set();
    const lines = sf.getLineAndCharacterOfPosition(sf.end).line + 1;

    const addImport = (spec, names, node) => {
      if (spec.startsWith('node:') || BUILTINS.has(spec)) return;
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
      if (!r) {
        const bare = spec.replace(/[?#].*$/, '');
        if (!/\.[A-Za-z0-9]+$/.test(bare) || SOURCE_RE.test(bare)) unresolved.add(spec);
        return;
      }
      if (r.isExternalLibraryImport || /node_modules/.test(r.resolvedFileName)) return;
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
        const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1;
        if ((isImport || isRequire) && node.arguments[0]) {
          if (isStringish(node.arguments[0])) addImport(node.arguments[0].text, isImport ? ['*'] : requiredNames(node), node);
          else dynamic.add(clip(node.arguments[0].getText(sf), 50));
        }
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
            for (const s of values.filter((v) => SUBJECT_RE.test(v))) mq.push({ kind: 'rpc-call', subject: s, file, inferred });
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
    files[file] = { lines, imports, unresolved: [...unresolved].sort(), dynamic: [...dynamic].sort(), externals: [...externals].sort(), boot: [...boot].sort(), mount: [...mount].sort(), decls: extractDecls(sf, file) };
  }
  return { id: ws.id, dir: rel(ws.dir) || '.', parent: ws.parent, aliases, files, mq, meta, skipped, lang: Object.keys(files).some((f) => /\.[mc]?tsx?$/.test(f)) ? 'typescript' : 'javascript' };
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
// Every JS/TS source file in the repo (tests excluded) is either analysed or listed here with the reason.
const skipped = [];
const owned = (f) => wss.some((w) => f.startsWith(w.dir + path.sep));
for (const abs of walkSources(REPO, true)) if (!TEST_RE.test(rel(abs)) && !owned(abs)) skipped.push({ pkg: null, file: rel(abs), reason: 'outside any package: no package.json above it' });
for (const ws of wss) {
  const t0 = Date.now();
  const r = analyzeWorkspace(ws, wss);
  for (const x of r.skipped) skipped.push({ pkg: ws.id, ...x });
  delete r.skipped;
  if (!Object.keys(r.files).length) continue;
  result.workspaces.push(r);
  process.stdout.write(`${ws.id}: ${Object.keys(r.files).length} files, ${r.mq.length} mq facts, ${Date.now() - t0}ms\n`);
}
const analyzed = result.workspaces.reduce((n, w) => n + Object.keys(w.files).length, 0);
result.coverage = { total: analyzed + skipped.length, analyzed, skipped };
fs.writeFileSync(OUT, JSON.stringify(result));
