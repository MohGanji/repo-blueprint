// Takes the README screenshots. Usage: SCHEME=dark|light node media/record-stills.mjs <url> <outDir>
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: process.env.SCHEME || 'dark' });
const at = (label) => p.evaluate((label) => { const g = [...document.querySelectorAll('#stage .pele-node')].find((g) => g.getBoundingClientRect().width > 0 && g.querySelector('text tspan')?.textContent.trim() === label); const r = g.querySelector('rect:not(.stack)').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, label);
await p.goto(url); await p.waitForSelector('#stage .pele-node'); await p.waitForTimeout(500);
await p.click('#zfit'); await p.waitForTimeout(900);
let c = await at('query-core'); await p.mouse.move(c.x, c.y); await p.waitForTimeout(600);
await p.screenshot({ path: out + '/overview.png' });
c = await at('react-query'); await p.mouse.dblclick(c.x, c.y); await p.waitForTimeout(1500);
c = await at('src'); await p.mouse.dblclick(c.x, c.y); await p.waitForTimeout(1500);
c = await at('useQuery.ts'); await p.mouse.click(c.x, c.y); await p.mouse.move(c.x, c.y); await p.waitForTimeout(700);
await p.screenshot({ path: out + '/file-detail.png' });
await p.fill('#q', 'QueryCache'); await p.waitForTimeout(600); await p.keyboard.press('Enter'); await p.waitForTimeout(1800);
await p.setViewportSize({ width: 1440, height: 1200 }); await p.waitForTimeout(400);
await p.locator('#stage').focus(); await p.keyboard.press('Escape'); await p.evaluate(() => document.activeElement.blur()); await p.waitForTimeout(300);
await p.evaluate(() => fitTo(svgBox(state.layer, state.layer.querySelector('.pele-cluster[data-id^="C"] rect'))));
await p.waitForTimeout(900); await p.mouse.move(5, 5);
// show the cycle finding in the side panel
await p.evaluate(() => { const d = [...document.querySelectorAll('aside details.fgroup')].find((d) => /cycle/i.test(d.textContent)); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } });
await p.waitForTimeout(400);
await p.screenshot({ path: out + '/import-cycle.png' });
await b.close();
