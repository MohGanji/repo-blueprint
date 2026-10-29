import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { buildModel } from './model.mjs';
import { buildViews } from './views.mjs';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const FACTS = path.resolve(process.argv[4]);
const name = path.basename(REPO);

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).workspaces : []);
const model = buildModel(name, [...read(path.join(FACTS, `${name}-ts.json`)), ...read(path.join(FACTS, `${name}-py.json`))], loadConfig(REPO));
const t0 = Date.now();
const views = buildViews(model);

for (const v of Object.values(views)) {
  if (!v.cycles.length || (v.kind !== 'pkg' && v.kind !== 'root')) continue;
  for (const cyc of v.cycles) {
    const label = (k) => (k.startsWith('pkg:') ? k.slice(4) : model.nodes[k].name);
    model.findings.push({
      type: v.kind === 'root' ? 'package-cycle' : 'component-cycle',
      severity: 'design',
      pkg: v.kind === 'pkg' ? v.ref.slice(4) : undefined,
      title: v.kind === 'root' ? `Packages import each other: ${cyc.map(label).join(' ↔ ')}` : `Import cycle in ${v.title}: ${cyc.length} parts`,
      detail: cyc.map(label).join(' ↔ '),
      members: cyc,
    });
  }
}
const order = { design: 0, smell: 1, check: 2 };
model.findings.sort((a, b) => order[a.severity] - order[b.severity] || a.type.localeCompare(b.type) || (a.pkg || '').localeCompare(b.pkg || ''));

const used = new Set();
for (const id of Object.keys(views).sort()) {
  let t = id === 'root' ? '' : id.replace(/^v:(pkg:)?/, '').replace(/[^A-Za-z0-9_~-]/g, '.');
  if (t && used.has(t)) {
    let i = 2;
    while (used.has(`${t}~${i}`)) i++;
    t = `${t}~${i}`;
  }
  used.add(t);
  views[id].token = t;
}

let commit = '';
let branch = '';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}

fs.writeFileSync(path.join(FACTS, `${name}-mermaid.txt`), Object.values(views).map((v) => `%% ${v.id}\n${v.source}`).join('\n\n'));
for (const v of Object.values(views)) delete v.source;
delete model.fineEdges;
const version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
const data = { version, commit, branch, model, views };
const json = JSON.stringify(data);
const packed = zlib.gzipSync(Buffer.from(json), { level: 9 }).toString('base64');
const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
fs.writeFileSync(OUT, tpl.replace('/*__DATA__*/', () => packed).replace(/<title>[^<]*<\/title>/, `<title>${name} blueprint</title>`));
const roles = {};
for (const p of Object.values(model.packages)) roles[p.role] = (roles[p.role] || 0) + 1;
const byType = {};
for (const f of model.findings) byType[f.type] = (byType[f.type] || 0) + 1;
const nFiles = Object.keys(model.files).length;
console.log(`${name}${commit ? ` (${branch}@${commit})` : ''}: ${Object.keys(model.packages).length} packages (${Object.entries(roles).map(([r, n]) => `${n} ${r}`).join(', ')}), ${nFiles} files, ${Object.keys(views).length} views`);
console.log(`findings: ${model.findings.length ? Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ') : 'none'}`);
