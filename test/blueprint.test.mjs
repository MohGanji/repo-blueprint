import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../src/model.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildViews } from '../src/views.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-blueprint-test-'));

// Runs the TypeScript/JavaScript extractor on a fixture repo and builds the model the page renders.
// Python facts are extracted only for fixtures with a pyproject.toml, as the CLI does.
function blueprint(fixture) {
  const repo = path.join(HERE, 'fixtures', fixture);
  const ts = path.join(TMP, `${fixture}-ts.json`);
  execFileSync(process.execPath, [path.join(SRC, 'extract-ts.mjs'), repo, ts], { cwd: SRC, stdio: 'ignore' });
  const facts = [JSON.parse(fs.readFileSync(ts, 'utf8'))];
  if (fs.readdirSync(repo, { recursive: true }).some((f) => f.endsWith('pyproject.toml'))) {
    const py = path.join(TMP, `${fixture}-py.json`);
    execFileSync('python3', ['-I', path.join(SRC, 'extract-py.py'), repo, py], { cwd: SRC, stdio: 'ignore' });
    facts.push(JSON.parse(fs.readFileSync(py, 'utf8')));
  }
  return buildModel(fixture, facts.flatMap((f) => f.workspaces), loadConfig(repo), facts.map((f) => f.coverage));
}

const edge = (model, from, to, kind = 'import') => model.fineEdges.find((e) => e.from === from && e.to === to && e.kind === kind);

test('a CommonJS package without a tsconfig is mapped, with its require() imports', () => {
  const m = blueprint('cjs-service');
  assert.ok(m.packages['cjs-service'], 'package found from package.json alone');
  assert.deepEqual(Object.keys(m.files).sort(), ['db.js', 'index.js', 'mailer.js', 'routes/users.js'], 'tests under __tests__/ are left out');
  assert.deepEqual(edge(m, 'index.js', 'routes/users.js')?.details, ['listUsers']);
  assert.ok(edge(m, 'routes/users.js', 'db.js'));
});

test('every imported package is an external node, named by a system only on an exact driver match', () => {
  const m = blueprint('cjs-service');
  assert.ok(edge(m, 'index.js', 'ext:express', 'ext'), 'unlisted package still drawn, under its own name');
  assert.ok(edge(m, 'db.js', 'ext:SQLite', 'ext'), 'better-sqlite3 is the SQLite driver');
  assert.ok(edge(m, 'db.js', 'ext:drizzle-orm', 'ext'), 'an ORM is drawn as itself');
  assert.equal(m.fineEdges.filter((e) => e.to === 'ext:PostgreSQL').length, 0, 'an ORM never implies a database');
});

test('CommonJS exports are listed as the file’s exports', () => {
  const m = blueprint('cjs-service');
  const names = (f) => m.files[f].decls.map((d) => `${d.name}:${d.kind}`).sort();
  assert.deepEqual(names('routes/users.js'), ['listUsers:function', 'router:const']);
  assert.deepEqual(names('db.js'), ['all:function', 'orm:const']);
});

test('an import the analysis cannot follow is reported, never dropped', () => {
  const m = blueprint('cjs-service');
  const titles = (type) => m.findings.filter((f) => f.type === type).map((f) => f.title);
  assert.deepEqual(titles('unresolved-import'), ['index.js imports ./missing, which does not resolve to a file']);
  assert.deepEqual(titles('dynamic-import'), ['index.js imports a module named at runtime: process.env.PLUGIN']);
});

test('a JavaScript file inside a TypeScript package is mapped, even without allowJs', () => {
  const m = blueprint('mixed-monorepo');
  assert.deepEqual(edge(m, 'packages/web/src/main.tsx', 'packages/web/src/legacy.js')?.details, ['greet']);
});

test('a JavaScript-only library is a package, and other packages link to the file that exports what they import', () => {
  const m = blueprint('mixed-monorepo');
  assert.deepEqual(Object.fromEntries(Object.values(m.packages).map((p) => [p.id, p.role])), { lib: 'library', web: 'app' });
  assert.deepEqual(edge(m, 'packages/web/src/main.tsx', 'packages/lib/index.js')?.details, ['add']);
  assert.equal(m.findings.filter((f) => f.type === 'unused-library').length, 0);
});

test('every source file is either mapped or reported as skipped, with the reason', () => {
  const m = blueprint('mixed-monorepo');
  assert.deepEqual(m.coverage, { total: 8, analyzed: 5, skipped: 3 });
  const skipped = m.findings.filter((f) => f.type === 'skipped-files').map((f) => [f.title, f.files]);
  assert.deepEqual(skipped, [
    ['1 file outside any package: no package.json above it', ['scripts/deploy.js']],
    ['1 file in lib not parsed: Vue, Svelte and Astro files are not supported yet', ['packages/lib/Widget.vue']],
    ['1 file in web left out by its tsconfig.json', ['packages/web/stray.ts']],
  ]);
});

test('a package with no TypeScript files is labelled JavaScript', () => {
  const m = blueprint('mixed-monorepo');
  assert.equal(m.packages.lib.runtime, 'JavaScript');
  assert.equal(m.packages.web.runtime, 'React');
});

test('Node built-ins are neither dependencies nor unresolved imports', () => {
  const m = blueprint('cjs-service');
  assert.deepEqual(m.findings.filter((f) => f.files?.includes('mailer.js')).map((f) => f.type), []);
  assert.deepEqual(m.fineEdges.filter((e) => e.from === 'mailer.js' && e.kind === 'ext'), []);
});

test('a send() whose subject is not a message subject is not an RPC call', () => {
  const m = blueprint('cjs-service');
  assert.deepEqual(m.findings.filter((f) => f.type === 'rpc-no-server').map((f) => f.title), []);
});

test('build output is never mapped, even when a config includes it', () => {
  const m = blueprint('mixed-monorepo');
  assert.deepEqual(Object.keys(m.files).filter((f) => f.startsWith('packages/lib/')), ['packages/lib/bin/cli.js', 'packages/lib/browser.js', 'packages/lib/index.js']);
});

test('files a package.json publishes (main, exports, bin) are entry points, not unused files', () => {
  const m = blueprint('mixed-monorepo');
  assert.deepEqual(m.findings.filter((f) => f.type === 'orphan-files' && f.pkg === 'lib'), []);
});

test('a repo that is a single library is not reported as an unused library', () => {
  const m = blueprint('single-library');
  assert.equal(m.packages['single-library'].role, 'library');
  assert.deepEqual(m.findings.filter((f) => f.type === 'unused-library'), []);
});

test('Python: absolute imports resolve in a src/ layout, and every .py file is mapped or reported', () => {
  const m = blueprint('py-src-layout');
  assert.ok(edge(m, 'pkg/src/acme/core.py', 'pkg/src/acme/util.py'), 'from acme.util import helper');
  assert.ok(edge(m, 'pkg/src/acme/core.py', 'ext:httpx', 'ext'));
  assert.deepEqual(m.coverage, { total: 5, analyzed: 3, skipped: 2 });
  assert.deepEqual(m.findings.filter((f) => f.type === 'skipped-files').map((f) => [f.title, f.files]), [
    ['1 file outside any package: no pyproject.toml above it', ['tools/run.py']],
    ['1 file in pkg could not be parsed: invalid syntax on line 1', ['pkg/src/acme/broken.py']],
  ]);
});

test('the external dependencies a view shows are ordered by how many files use them', () => {
  const root = buildViews(blueprint('cjs-service')).root;
  const order = Object.values(root.nodes).map((n) => n.key).filter((k) => k.startsWith('ext:'));
  assert.deepEqual(order, ['ext:express', 'ext:drizzle-orm', 'ext:SQLite']);
});

test('Python: tests are left out, scripts are mapped, for a package at the repo root too', () => {
  const m = blueprint('py-flat');
  assert.deepEqual(Object.keys(m.files).sort(), ['app.py', 'scripts/run.py']);
  assert.ok(edge(m, 'scripts/run.py', 'app.py'));
  assert.deepEqual(m.findings.filter((f) => f.type === 'orphan-files'), []);
});
