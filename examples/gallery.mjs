// Writes examples/index.html: the gallery GitHub Pages serves, one card per example, in corpus.json order.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function card(e) {
  return `<article class="card">
  <h3><a class="open" href="${esc(e.name)}.blueprint.html">${esc(e.name)}</a></h3>
  <p class="about">${esc(e.about)}</p>
</article>`;
}

export function writeGallery(dir) {
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repo-blueprint gallery</title>
<meta name="description" content="Architecture maps of open-source projects, built with repo-blueprint.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg: #e9efee; --surface: #fdfefe; --ink: #14233a; --muted: #576878; --line: #c3cfd2; --accent: #1d6bb0;
  --display: "Barlow Condensed", "Arial Narrow", sans-serif; --body: "Barlow", "Segoe UI", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0d141a; --surface: #18232d; --ink: #e2e9ee; --muted: #8fa0ad; --line: #2b3b47; --accent: #66adec; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #0d141a; --surface: #18232d; --ink: #e2e9ee; --muted: #8fa0ad; --line: #2b3b47; --accent: #66adec; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 var(--body); }
main { max-width: 1080px; margin: 0 auto; padding: 48px 16px 64px; }
a { color: var(--accent); }
h1 { font: 700 44px/1.05 var(--display); margin: 0 0 16px; }
.try { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin: 0 0 44px; }
code { font: 13px var(--mono); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px 14px; display: flex; flex-direction: column; gap: 6px; transition: border-color 120ms ease; }
.card:hover { border-color: var(--accent); }
h3 { font: 700 24px/1.1 var(--display); margin: 0; }
h3 a { color: inherit; text-decoration: none; }
.open::after { content: ""; position: absolute; inset: 0; border-radius: 10px; }
.open:focus-visible { outline: none; }
.card:has(.open:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.about { margin: 0; }
footer { margin-top: 48px; color: var(--muted); font-size: 14px; }
@media (max-width: 520px) { main { padding-top: 32px; } h1 { font-size: 36px; } }
</style>
</head>
<body>
<main>
<h1>repo-blueprint gallery</h1>
<div class="try"><code>npx repo-blueprint build .</code><a href="https://github.com/MohGanji/repo-blueprint">Source on GitHub</a><a href="https://www.npmjs.com/package/repo-blueprint">npm</a></div>
<div class="grid">
${corpus.map(card).join('\n')}
</div>
<footer>Rebuilt with <code>node examples/build-examples.mjs</code>. Each repo is pinned in <a href="https://github.com/MohGanji/repo-blueprint/blob/main/examples/corpus.json">corpus.json</a>.</footer>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}
