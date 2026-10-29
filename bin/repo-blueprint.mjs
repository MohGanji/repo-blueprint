#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const HOME = path.join(os.homedir(), '.repo-blueprint');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', '.nx', 'tmp', '.next', 'out', '.turbo']);
const WATCHED = /\.(tsx?|py)$|(^|\/)(package\.json|tsconfig[\w.-]*\.json|pyproject\.toml|project\.json|catalog-info\.ya?ml|\.blueprint\.json|Dockerfile)$/;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|coverage|\.venv|venv|__pycache__|\.nx|tmp|\.next|out|\.turbo|playwright-report|test-results)(\/|$)/;

const HELP = `repo-blueprint: map a code repository by static analysis.

Usage
  repo-blueprint build [repo] [--out file] [--open]
  repo-blueprint watch [repo] [--port 4321] [--open]

Commands
  build   Analyse the repo once and write a standalone HTML file.
  watch   Serve the blueprint and rebuild it when source files change.

Options
  repo        Path to the repository. Defaults to the current directory.
  --out, -o   Where to write the HTML. Defaults to ~/.repo-blueprint/<repo>.blueprint.html
  --port, -p  Port for watch mode. Defaults to 4321, or the next free port.
  --open      Open the result in the default browser.
  --help, -h  Show this help.

Per-repo settings go in <repo>/.blueprint.json (see SKILL.md).`;

function parseArgs(argv) {
  const args = { cmd: null, repo: null, out: null, port: 4321, open: false };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--open') args.open = true;
    else if (a === '--out' || a === '-o') args.out = rest.shift();
    else if (a === '--port' || a === '-p') args.port = Number(rest.shift());
    else if (!args.cmd && (a === 'build' || a === 'watch')) args.cmd = a;
    else if (!args.repo && !a.startsWith('-')) args.repo = a;
    else fail(`Unknown argument: ${a}\n\n${HELP}`);
  }
  return args;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function ensureDeps() {
  const req = createRequire(path.join(ROOT, 'package.json'));
  const have = (m) => {
    try {
      req.resolve(`${m}/package.json`);
      return true;
    } catch {
      return false;
    }
  };
  if (have('typescript') && have('pele')) return;
  console.error('[repo-blueprint] installing dependencies (typescript, pele) once…');
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('[repo-blueprint] npm install failed. Run it yourself in ' + ROOT);
}

function hasPyproject(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'pyproject.toml'))) return true;
  if (depth >= 4) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && hasPyproject(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

function pythonCommand() {
  const ok = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  if (ok('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'])) return ['python3', ['-I']];
  if (ok('uv', ['--version'])) return ['uv', ['run', '--no-project', '--python', '3.12', 'python', '-I']];
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', opts.quiet ? 'ignore' : 'inherit', 'inherit'], cwd: SRC });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function build(repo, out) {
  const name = path.basename(repo);
  const cache = path.join(HOME, 'cache', `${name}-${crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8)}`);
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await run(process.execPath, [path.join(SRC, 'extract-ts.mjs'), repo, path.join(cache, `${name}-ts.json`)], { quiet: true });
  const pyFacts = path.join(cache, `${name}-py.json`);
  fs.rmSync(pyFacts, { force: true });
  if (hasPyproject(repo)) {
    const py = pythonCommand();
    if (py) await run(py[0], [...py[1], path.join(SRC, 'extract-py.py'), repo, pyFacts], { quiet: true });
    else console.error('[repo-blueprint] Python packages found but no Python 3.10+ or uv; skipping them.');
  }
  await run(process.execPath, [path.join(SRC, 'build.mjs'), repo, out, cache]);
}

function openFile(target) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function watch(repo, out, port, open) {
  const clients = new Set();
  let building = false;
  let queued = false;
  const rebuild = async (reason) => {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    const t0 = Date.now();
    console.log(`[repo-blueprint] building (${reason})`);
    try {
      await build(repo, out);
      console.log(`[repo-blueprint] built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      for (const res of clients) res.write('data: reload\n\n');
    } catch (err) {
      console.error(`[repo-blueprint] build failed: ${err.message}`);
    }
    building = false;
    if (queued) {
      queued = false;
      rebuild('changes during last build');
    }
  };

  const reload = '<script>new EventSource("/events").onmessage = () => location.reload();</script>';
  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (!fs.existsSync(out)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Building…</title><p style="font:15px system-ui;padding:24px">Building the blueprint. This page reloads when it is ready.</p>${reload}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(out, 'utf8').replace('</body>', `${reload}</body>`));
  });
  const listen = (p) =>
    new Promise((resolve, reject) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(listen(p + 1)) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  const actual = await listen(port);
  const url = `http://127.0.0.1:${actual}`;
  console.log(`[repo-blueprint] serving ${path.basename(repo)} at ${url}, watching for changes (Ctrl+C to stop)`);
  if (open) openFile(url);

  let timer = null;
  const changed = new Set();
  fs.watch(repo, { recursive: true }, (_e, file) => {
    if (!file || IGNORED.test(file) || !WATCHED.test(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = [...changed];
      changed.clear();
      rebuild(list.length > 3 ? `${list.length} files changed` : list.join(', '));
    }, 600);
  });
  await rebuild('start');
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.cmd) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}
const repo = path.resolve(args.repo || process.cwd());
if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) fail(`Not a directory: ${repo}`);
const out = path.resolve(args.out || path.join(HOME, `${path.basename(repo)}.blueprint.html`));
ensureDeps();
if (args.cmd === 'build') {
  try {
    await build(repo, out);
  } catch (err) {
    fail(`[repo-blueprint] ${err.message}`);
  }
  console.log(out);
  if (args.open) openFile(out);
} else {
  await watch(repo, out, args.port, args.open);
}
