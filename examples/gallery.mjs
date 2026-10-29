// Writes examples/index.html: the gallery GitHub Pages serves, one card per example in corpus.json.
// Stats come from examples/stats.json, which build-examples.mjs updates after each build.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// Reads the summary lines the CLI prints after a build.
export function parseSummary(lines, bytes) {
  const head = /: (\d+) packages? \(([^)]*)\), (\d+) files/.exec(lines.find((l) => / packages? \(/.test(l)) || '') || [];
  const findings = (lines.find((l) => l.startsWith('findings:')) || '').match(/ (\d+)(?=,|$)/g) || [];
  return { packages: Number(head[1] || 0), files: Number(head[3] || 0), findings: findings.reduce((n, x) => n + Number(x), 0), bytes };
}

function card(e, s) {
  const size = s && s.bytes > 2e6 ? ` · <span class="heavy">${(s.bytes / 1e6).toFixed(1)} MB, takes a few seconds to open</span>` : '';
  const stats = s ? `${plural(s.packages, 'package')} · ${plural(s.files, 'file')} · ${plural(s.findings, 'finding')}${size}` : 'not built yet';
  return `<article class="card">
  <div class="top"><h3><a class="open" href="${esc(e.name)}.blueprint.html">${esc(e.name)}</a></h3><span class="lang">${esc(e.language)}</span></div>
  <p class="about">${esc(e.about)}</p>
  <p class="stats">${stats}</p>
  <p class="src"><a href="${esc(e.repo)}/tree/${esc(e.commit)}">${esc(e.repo.replace('https://github.com/', ''))} @ ${esc(e.commit.slice(0, 7))}</a></p>
</article>`;
}

export function writeGallery(dir) {
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  const statsFile = path.join(dir, 'stats.json');
  const stats = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : {};
  const version = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')).version;
  const groups = [
    ['JavaScript and TypeScript', corpus.filter((e) => e.language !== 'Python')],
    ['Python', corpus.filter((e) => e.language === 'Python')],
  ];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repo-blueprint examples</title>
<meta name="description" content="Architecture maps of ${corpus.length} open-source projects, built by static analysis with repo-blueprint.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg: #e9efee; --surface: #fdfefe; --ink: #14233a; --muted: #576878; --line: #c3cfd2; --accent: #1d6bb0; --amber: #8a5f00;
  --display: "Barlow Condensed", "Arial Narrow", sans-serif; --body: "Barlow", "Segoe UI", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0d141a; --surface: #18232d; --ink: #e2e9ee; --muted: #8fa0ad; --line: #2b3b47; --accent: #66adec; --amber: #e2b34e; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #0d141a; --surface: #18232d; --ink: #e2e9ee; --muted: #8fa0ad; --line: #2b3b47; --accent: #66adec; --amber: #e2b34e; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 var(--body); }
main { max-width: 1080px; margin: 0 auto; padding: 48px 16px 64px; }
a { color: var(--accent); }
.eyebrow { font: 600 14px var(--display); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0; }
h1 { font: 700 44px/1.05 var(--display); margin: 6px 0 12px; }
.lede { max-width: 640px; margin: 0 0 20px; color: var(--muted); font-size: 17px; }
.try { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin: 0 0 44px; }
code { font: 13px var(--mono); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
h2 { font: 600 15px var(--display); letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
section + section { margin-top: 40px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px 14px; display: flex; flex-direction: column; gap: 6px; transition: border-color 120ms ease; }
.card:hover { border-color: var(--accent); }
.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
h3 { font: 700 24px/1.1 var(--display); margin: 0; }
h3 a { color: inherit; text-decoration: none; }
.open::after { content: ""; position: absolute; inset: 0; border-radius: 10px; }
.open:focus-visible { outline: none; }
.card:has(.open:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.lang { font: 12px var(--mono); color: var(--muted); white-space: nowrap; }
.about { margin: 0; flex: 1; }
.stats { margin: 0; font: 12.5px var(--mono); color: var(--muted); }
.heavy { color: var(--amber); }
.src { margin: 0; font: 12.5px var(--mono); }
.src a { position: relative; z-index: 1; color: var(--muted); }
.src a:hover { color: var(--accent); }
footer { margin-top: 48px; color: var(--muted); font-size: 14px; }
@media (max-width: 520px) { main { padding-top: 32px; } h1 { font-size: 36px; } }
</style>
</head>
<body>
<main>
<p class="eyebrow">repo-blueprint ${esc(version)}</p>
<h1>Example blueprints</h1>
<p class="lede">Architecture maps of ${corpus.length} open-source projects, each built from one pinned commit by static analysis. Open one, zoom from packages down to files, and press <strong>?</strong> on the map for help.</p>
<div class="try"><code>npx repo-blueprint build .</code><a href="https://github.com/MohGanji/repo-blueprint">Source on GitHub</a><a href="https://www.npmjs.com/package/repo-blueprint">npm</a></div>
${groups.map(([title, list]) => `<section>
<h2>${esc(title)}</h2>
<div class="grid">
${list.map((e) => card(e, stats[e.name])).join('\n')}
</div>
</section>`).join('\n')}
<footer>Rebuilt with <code>node examples/build-examples.mjs</code>. Each repo is pinned in <a href="https://github.com/MohGanji/repo-blueprint/blob/main/examples/corpus.json">corpus.json</a>.</footer>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}
