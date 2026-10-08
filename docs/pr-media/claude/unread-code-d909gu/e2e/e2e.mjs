// End to end: unread marks on a real imported repo with a played agent. node e2e.mjs <outdir>
// Run from a checkout with `bun run dev` up: node e2e.mjs <outdir>. demo.mjs beside it builds the demo repo's edits; set its `dir` to a git copy of web/ and run `node demo.mjs import` once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire('/home/claude/hackgt13/web/package.json');
const { chromium } = require('playwright');

const out = process.argv[2];
const here = path.dirname(new URL(import.meta.url).pathname);
const demo = (cmd) => execFileSync('node', [path.join(here, 'demo.mjs'), cmd], { encoding: 'utf8' }).trim();
const step = (s) => console.log(`✓ ${s}`);

demo('reset');
demo('edit1');
// Let the indexer re-index the changed files, so functions map too.
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.getItem('strata-theme') || localStorage.setItem('strata-theme', 'dark'));
const page = await ctx.newPage();
page.on('pageerror', (e) => {
  throw e;
});
// Video: the page's own screencast frames, timed, stitched by ffmpeg at the end.
const fs = await import('node:fs');
fs.mkdirSync(`${out}/frames`, { recursive: true });
const frames = [];
const cdp = await ctx.newCDPSession(page);
cdp.on('Page.screencastFrame', async (f) => {
  const file = `${out}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, t: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await page.goto('http://localhost:5178/');
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fiada.read.')).forEach((k) => localStorage.removeItem(k)));
await page.reload();
await page.waitForSelector('.queue-card');
await page.waitForTimeout(1200);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });

const card = page.locator('.queue-card').first();
const readLine = card.locator('.queue-read > span').first();
const marks = (id) =>
  page.evaluate((id) => {
    const m = document.querySelector('.stage').fiada.scene.activity?.get(id);
    return m ? { unread: m.unread, selfUnread: m.selfUnread, n: m.added + m.modified + m.deleted } : null;
  }, id);
const at = (id) =>
  page.evaluate((id) => {
    const r = document.querySelector('.stage').fiada;
    const d = r.drawnNodes.find((n) => n.n.id === id);
    const box = document.querySelector('.stage').getBoundingClientRect();
    return d ? { x: box.x + d.x, y: box.y + d.y, open: d.open } : null;
  }, id);
const clickNode = async (id) => {
  const p = await at(id);
  assert.ok(p, `${id} is drawn`);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(900);
};

// 1. Nothing opened yet: every change is unread.
await assert.doesNotReject(readLine.waitFor());
assert.equal(await readLine.textContent(), '0 of 7 changes read');
assert.ok(await page.getByRole('button', { name: 'mark all read' }).isVisible());
assert.ok(await card.getByRole('button', { name: 'mark read' }).isVisible());
step('agent entry: 0 of 7 changes read, with mark read and mark all read');

for (const id of ['fiada-web', 'fiada-web/src']) {
  const p = await at(id);
  if (p && !p.open) {
    await clickNode(id);
    await clickNode(id);
  }
}
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
assert.deepEqual(await marks('fiada-web/src/graph'), { unread: 3, selfUnread: false, n: 3 });
assert.deepEqual(await marks('fiada-web/src/render'), { unread: 2, selfUnread: false, n: 2 });
step('closed folders count their unread changes (graph 3 of 3, render 2 of 2)');
await page.screenshot({ path: `${out}/after-unread.png` });

// 2. Open the file list and one file from it: that file is read, the counts follow.
await card.locator('.queue-fold-toggle', { hasText: 'files changed' }).click();
await page.waitForTimeout(400);
assert.equal(await card.locator('.queue-file-item.unread').count(), 7);
await page.screenshot({ path: `${out}/after-window.png`, clip: { x: 1060, y: 50, width: 380, height: 560 } });
await card.locator('.queue-file', { hasText: 'activity.ts' }).filter({ hasText: 'graph' }).click();
await page.waitForTimeout(1200);
assert.equal(await page.evaluate(() => document.querySelector('.stage').fiada.scene.selected), 'fiada-web/src/graph/activity.ts');
assert.deepEqual(await marks('fiada-web/src/graph/activity.ts'), { unread: 0, selfUnread: false, n: 0 });
assert.equal((await marks('fiada-web/src/graph')).unread, 2);
step('opening graph/activity.ts from the agents window reads it; graph now has 2 unread');
await page.screenshot({ path: `${out}/after-opened.png` });

// The window folds while the detail panel is open; open it to check the line.
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
assert.equal(await readLine.textContent(), '1 of 7 changes read');
const filesOpen = card.locator('.queue-fold-toggle', { hasText: 'files changed' });
if ((await filesOpen.getAttribute('aria-expanded')) !== 'true') await filesOpen.click();
assert.equal(await card.locator('.queue-file-item.unread').count(), 6);
step('agent entry: 1 of 7 changes read, six files still marked unread');

// 3. Open a file on the map itself: open graph, then select render/edges.ts by clicking circles.
await clickNode('fiada-web/src/render');
await clickNode('fiada-web/src/render');
await clickNode('fiada-web/src/render/edges.ts');
assert.equal(await page.evaluate(() => document.querySelector('.stage').fiada.scene.selected), 'fiada-web/src/render/edges.ts');
assert.equal((await marks('fiada-web/src/render/edges.ts')).selfUnread, false);
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
assert.equal(await readLine.textContent(), '2 of 7 changes read');
step('clicking a changed circle on the map reads it: 2 of 7');

// 4. Read marks are kept per project: a reload remembers them.
await page.reload();
await page.waitForSelector('.queue-card');
await page.waitForTimeout(1500);
assert.equal(await readLine.textContent(), '2 of 7 changes read');
const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fiada.read.')));
assert.equal(keys.length, 1, `one project's marks: ${keys}`);
step(`reload keeps them (${keys[0]})`);

// 5. The agent changes a file you read: it's unread again.
demo('edit2');
await page.waitForFunction(() => document.querySelector('.queue-read > span')?.textContent === '1 of 7 changes read', null, { timeout: 15000 });
step('the agent changes graph/activity.ts again: back to 1 of 7');
for (const id of ['fiada-web', 'fiada-web/src']) {
  const p = await at(id);
  if (p && !p.open) {
    await clickNode(id);
    await clickNode(id);
  }
}
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
assert.equal((await marks('fiada-web/src/graph')).unread, 3);
await page.screenshot({ path: `${out}/after-changed-again.png` });

// 6. Mark all read.
await page.getByRole('button', { name: 'mark all read' }).click();
await page.waitForTimeout(600);
assert.equal(await readLine.textContent(), '7 of 7 changes read');
assert.equal(await page.getByRole('button', { name: 'mark all read' }).count(), 0);
assert.equal((await marks('fiada-web/src/graph')).unread, 0);
if ((await filesOpen.getAttribute('aria-expanded')) !== 'true') await filesOpen.click();
assert.equal(await card.locator('.queue-file-item').count(), 7);
assert.equal(await card.locator('.queue-file-item.unread').count(), 0);
step('mark all read: 7 of 7, no unread marks left, the button goes');
await page.screenshot({ path: `${out}/after-all-read.png` });

// 7. Light theme, with something unread again.
demo('reset');
demo('edit1');
await page.waitForTimeout(3000);
await page.locator('.sidebar button', { hasText: /^light$/ }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/after-light.png` });
step('light theme drawn');

await cdp.send('Page.stopScreencast').catch(() => {});
await ctx.close();
await browser.close();
// One line per frame with how long it stays, for ffmpeg's concat demuxer.
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, ((frames[i + 1]?.t ?? f.t + 1) - f.t)).toFixed(3)}`).join('\n');
fs.writeFileSync(`${out}/frames.txt`, `${list}\nfile '${frames.at(-1).file}'\n`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${out}/frames.txt`, '-vf', 'fps=25,scale=1440:-2,format=yuv420p', '-c:v', 'libx264', '-crf', '26', `${out}/demo.mp4`]);
console.log(`video: ${frames.length} frames`);
console.log('e2e passed');
