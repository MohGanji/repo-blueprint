// Records the README demo: a scripted walk through a blueprint page.
// Needs playwright (npm i playwright). Usage: node media/record-demo.mjs <url> <outDir>
// Set SCHEME=light for the light-mode version. Writes lossless frames plus <outDir>/frames.txt;
// see CONTRIBUTING.md for turning them into media/demo.gif.
import { chromium } from 'playwright';

const [url, outDir] = process.argv.slice(2);
const W = 1440, H = 900;

const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  colorScheme: process.env.SCHEME || 'dark',
});
import fs from 'node:fs';
fs.mkdirSync(outDir + '/frames', { recursive: true });
const frames = [];

// Fake cursor, since recorded video has no pointer.
await ctx.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.3 L10 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, pointerEvents: 'none', transform: 'translate(-100px,-100px)' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', width: '28px', height: '28px', margin: '-14px 0 0 -14px', borderRadius: '50%', border: '2px solid #7aa2ff', zIndex: 99998, pointerEvents: 'none', opacity: '0', transition: 'opacity .35s, transform .35s' });
    document.body.append(ring, c);
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      ring.style.transition = 'none'; ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      ring.style.opacity = '1'; ring.style.transform = 'scale(.6)';
      requestAnimationFrame(() => { ring.style.transition = 'opacity .45s, transform .45s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.6)'; });
    }, true);
  });
});

const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
let n = 0;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const f = `${outDir}/frames/${String(n++).padStart(5, '0')}.png`;
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  frames.push({ f, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
async function startCapture() { await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 }); }
const wait = (ms) => page.waitForTimeout(ms);
let pos = { x: W / 2, y: H / 2 };
async function moveTo(x, y, steps = 30) { await page.mouse.move(x, y, { steps }); pos = { x, y }; }

// Centre of the visible node whose text starts with `label`.
async function nodeAt(label) {
  const p = await page.evaluate((label) => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const g = [...document.querySelectorAll('#stage .pele-node')].find((g) => {
      const r = g.getBoundingClientRect();
      return r.width > 0 && r.left > stage.left && r.right < stage.right && r.top > stage.top && r.bottom < stage.bottom && ((g.querySelector('text tspan') || g.querySelector('text'))?.textContent.trim() === label);
    }) || [...document.querySelectorAll('#stage .pele-node')].find((g) => g.getBoundingClientRect().width > 0 && ((g.querySelector('text tspan') || g.querySelector('text'))?.textContent.trim() === label));
    if (!g) return null;
    const r = (g.querySelector('rect:not(.stack)') || g).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
  if (!p) {
    await page.screenshot({ path: outDir + '/../fail.png' });
    console.log(await page.evaluate(() => document.getElementById('crumbs').textContent + '\n' + [...document.querySelectorAll('#stage .pele-node')].map((g) => (g.querySelector('text tspan') || g.querySelector('text'))?.textContent + ' w' + Math.round(g.getBoundingClientRect().width)).join(' | ')));
    throw new Error('node not found: ' + label);
  }
  return p;
}
async function hover(label, ms = 1400) { const p = await nodeAt(label); await moveTo(p.x, p.y); await wait(ms); }
async function dbl(label, ms = 1800) { const p = await nodeAt(label); await moveTo(p.x, p.y); await wait(350); await page.mouse.dblclick(p.x, p.y); await wait(ms); }
async function click(label, ms = 1600) { const p = await nodeAt(label); await moveTo(p.x, p.y); await wait(250); await page.mouse.click(p.x, p.y); await wait(ms); }

await page.goto(url);
await page.waitForSelector('#stage .pele-node');
await startCapture();
await wait(500);
await page.click('#zfit');
await page.mouse.move(W * 0.62, H * 0.55);
await wait(1800);

// 1. Overview: hover the base package and see everything built on it.
await hover('query-core', 1800);
await hover('react-query-devtools', 900);
// zoom toward react-query with the wheel for a closer look
{ const p = await nodeAt('react-query'); await moveTo(p.x, p.y); await page.keyboard.down('Control'); for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -8); await wait(40); } await page.keyboard.up('Control'); await wait(600); }

// 2. Zoom into react-query, then its src folder.
await dbl('react-query', 1900);
await hover('src', 600);
await dbl('src', 1900);

// 3. Inspect files.
await hover('useBaseQuery.ts', 1000);
await click('useQuery.ts', 1800);

// 4. Search across the whole repo.
const q = page.locator('#q');
const qb = await q.boundingBox();
await moveTo(qb.x + 60, qb.y + qb.height / 2);
await page.mouse.click(qb.x + 60, qb.y + qb.height / 2);
await q.pressSequentially('QueryCache', { delay: 90 });
await wait(1300);
await page.keyboard.press('Enter');
await wait(1900);

// 4b. Zoom out to the whole import cycle queryCache.ts belongs to.
await moveTo(W * 0.86, H * 0.78, 25); // park over the side panel so no box is hovered
await page.locator('#stage').focus();
await page.keyboard.press('Escape'); // clear the selection so every line in the cycle shows
await page.evaluate(() => document.activeElement.blur());
await page.evaluate(() => fitTo(svgBox(state.layer, state.layer.querySelector('.pele-cluster[data-id^="C"] rect'))));
await wait(2800);

// 5. Back out to the whole repo via the breadcrumb.
const root = page.locator('#crumbs button').first();
const rb = await root.boundingBox();
await moveTo(rb.x + rb.width / 2, rb.y + rb.height / 2);
await wait(300);
await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
await wait(900);
{ const b = await page.locator('#zfit').boundingBox(); await moveTo(b.x + b.width / 2, b.y + b.height / 2, 20); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
await moveTo(W * 0.6, H * 0.5, 25);
await wait(2000);

await cdp.send('Page.stopScreencast');
await wait(300);
// ffmpeg concat list: each frame shown until the next one arrived
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
  lines.push(`file '${frames[i].f}'`, `duration ${d.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].f}'`);
fs.writeFileSync(outDir + '/frames.txt', lines.join('\n') + '\n');
console.log(frames.length + ' frames, ' + (frames.at(-1).t - frames[0].t).toFixed(1) + 's');
await browser.close();
