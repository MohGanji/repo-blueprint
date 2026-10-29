#!/usr/bin/env node
// Rebuilds the example blueprints from the open-source repos pinned in corpus.json.
// Usage: node examples/build-examples.mjs [name ...]
// Each repo is fetched once at its pinned commit into ~/.repo-blueprint/corpus, then mapped
// with this checkout's CLI into examples/<name>.blueprint.html. Then examples/index.html,
// the gallery GitHub Pages serves, is rewritten from corpus.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeGallery } from './gallery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'repo-blueprint.mjs');
const CACHE = path.join(os.homedir(), '.repo-blueprint', 'corpus');
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
const only = process.argv.slice(2);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function checkout({ name, repo, commit }) {
  const dir = path.join(CACHE, name);
  if (fs.existsSync(path.join(dir, '.git')) && git(dir, 'rev-parse', 'HEAD') === commit) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'fetch', '-q', '--depth', '1', repo, commit);
  git(dir, 'checkout', '-q', 'FETCH_HEAD');
  return dir;
}

let failed = 0;
for (const entry of corpus.filter((e) => !only.length || only.includes(e.name))) {
  try {
    const dir = checkout(entry);
    const out = path.join(HERE, `${entry.name}.blueprint.html`);
    const summary = execFileSync(process.execPath, [CLI, 'build', dir, '--out', out], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim().split('\n');
    console.log(summary.slice(-4, -1).join('\n') + '\n');
  } catch (err) {
    failed++;
    console.error(`${entry.name}: ${err.message}\n`);
  }
}
writeGallery(HERE);
process.exit(failed ? 1 : 0);
