// End-to-end check of the review tour in a real browser: against a running
// `bun run dev` with a repository imported and an agent session reported
// (web/e2e/agent-session.sh plays one on the FastAPI template). Starts the
// tour from the agents window, walks every stop with the buttons and the
// arrow keys, marks changes read, reloads to see the marks kept, and ends it
// with Esc. Fails on the first thing that isn't so.
//
//   node web/e2e/review-tour.mjs [url] [--video file.mp4] [--shots dir]
//
// --video records the run from Chromium's screencast and needs ffmpeg on the PATH.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const url = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:5178/';
const video = flag('--video');
const shots = flag('--shots');
const LAYERS = ['UI', 'Client', 'API', 'Service', 'Data', 'Job', 'Contract', 'Test'];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const page = await context.newPage();
// The run as frames from the screencast, each held until the next arrives.
const frames = [];
if (video) {
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
}
const encode = () => {
  if (!video || frames.length < 2) return;
  const dir = `${video}.frames`;
  mkdirSync(dir, { recursive: true });
  const list = frames.map((f, i) => {
    writeFileSync(`${dir}/${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.t ?? f.t + 1;
    return `file '${String(i).padStart(5, '0')}.jpg'\nduration ${Math.max(0.02, next - f.t).toFixed(3)}`;
  });
  writeFileSync(`${dir}/list.txt`, `${list.join('\n')}\n`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`, '-vf', 'fps=25,scale=1600:-2,format=yuv420p', '-c:v', 'libx264', '-crf', '23', '-movflags', '+faststart', video]);
};
// Headless Chromium may not trust a proxy's CA: fetch the fonts from Node instead.
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => r.fulfill({ response: await r.fetch() }).catch(() => r.abort()));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
const pause = (ms) => page.waitForTimeout(video ? ms : 150);
const count = async () => {
  const m = /change (\d+) of (\d+) · (?:all )?(\d+) read/.exec(await page.locator('.tour-count').innerText());
  assert.ok(m, 'the tour says where you are');
  return { at: +m[1], of: +m[2], read: +m[3] };
};
const stopName = () => page.locator('.tour-name').innerText();

try {
  await page.goto(url);
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fiada.tour.')).forEach((k) => localStorage.removeItem(k)));
  await page.reload();
  await page.locator('.queue-card').first().waitFor({ timeout: 20000 });
  await pause(1200);
  await shot('1-agents-window');

  // Start from the agent's entry.
  await page.getByRole('button', { name: 'review', exact: true }).click();
  await page.locator('.tour').waitFor();
  await pause(1400);
  await shot('2-first-stop');
  const first = await count();
  assert.equal(first.at, 1);
  assert.equal(first.read, 0);
  assert.ok(first.of >= 5, `a real session has several changes (got ${first.of})`);
  assert.equal(await page.locator('.tour-tick').count(), first.of, 'one tick per change');
  assert.equal(await page.locator('.legend').count(), 0, 'the tour takes the legend’s place');

  // Walk every stop with the arrow key: the detail panel follows, with the diff, and the layers go page → … → contract.
  const seen = [];
  for (let i = 1; i <= first.of; i++) {
    const name = await stopName();
    const layer = await page.locator('.tour-layer').innerText().catch(() => null);
    await page.locator('.detail-title').filter({ hasText: name }).waitFor({ timeout: 4000 }).catch(async () => {
      // A file-level stop selects its file: the panel names the file.
      const path = await page.locator('.tour-path').innerText();
      await page.locator('.detail-title').filter({ hasText: path.slice(path.lastIndexOf('/') + 1) }).waitFor({ timeout: 4000 });
    });
    await page.locator('.agent-change').waitFor({ timeout: 4000 });
    assert.equal((await count()).at, i);
    assert.equal(await page.locator('.tour-tick.here').count(), 1);
    seen.push({ name, layer });
    if (i === 3) await shot('3-third-stop');
    if (i < first.of) {
      await page.keyboard.press('ArrowRight');
      await pause(900);
    }
  }
  console.log('stops:', seen.map((s) => `${s.name} (${s.layer ?? 'no layer'})`).join(' → '));
  const ranks = seen.map((s) => (s.layer ? LAYERS.indexOf(s.layer) : LAYERS.length));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'stops go in layer order');
  assert.ok(await page.locator('.tour-next').isDisabled(), 'next stops at the last change');

  // Back with the arrow key and the button.
  await page.keyboard.press('ArrowLeft');
  await pause(700);
  assert.equal((await count()).at, first.of - 1);
  await page.getByRole('button', { name: 'previous' }).click();
  await pause(700);
  assert.equal((await count()).at, first.of - 2);

  // Jump to the start with a tick, then mark read: it moves on to the next unread.
  await page.locator('.tour-tick').first().click();
  await pause(900);
  assert.equal((await count()).at, 1);
  await page.getByRole('button', { name: 'mark read' }).click();
  await pause(900);
  let c = await count();
  assert.deepEqual([c.at, c.read], [2, 1]);
  await page.keyboard.press('r');
  await pause(900);
  c = await count();
  assert.deepEqual([c.at, c.read], [3, 2]);
  assert.equal(await page.locator('.tour-tick.read').count(), 2);
  await shot('4-two-read');
  // Unmark with r on a read one.
  await page.locator('.tour-tick').nth(1).click();
  await pause(700);
  assert.match(await page.locator('.tour-count').innerText(), / · read$/);
  await page.keyboard.press('r');
  await pause(500);
  assert.equal((await count()).read, 1);
  await page.keyboard.press('r');
  await pause(700);
  assert.equal((await count()).read, 2);

  // Clicking one of the changes on the map's outline moves the tour there too: covered by selecting a tick; Esc ends the tour and keeps the selection.
  await page.keyboard.press('Escape');
  await pause(600);
  assert.equal(await page.locator('.tour').count(), 0, 'esc ends the tour');
  assert.equal(await page.locator('.detail').count(), 1, 'the change you were on stays selected');
  await shot('5-ended');

  // Marks are kept: a new tour after a reload starts at the first unread change.
  await page.reload();
  await page.locator('.queue-card').first().waitFor({ timeout: 20000 });
  await pause(800);
  await page.getByRole('button', { name: 'review', exact: true }).click();
  await page.locator('.tour').waitFor();
  await pause(1200);
  c = await count();
  assert.deepEqual([c.at, c.read], [3, 2], 'starts at the first unread, with the marks kept');

  // The other theme too.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await pause(600);
  await shot('6-dark');
  await page.getByRole('button', { name: 'end', exact: true }).click();
  assert.equal(await page.locator('.tour').count(), 0);

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`review tour: ${first.of} stops walked, marks kept across a reload, all checks passed`);
} finally {
  encode();
  await context.close();
  await browser.close();
}
