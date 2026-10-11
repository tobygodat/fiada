// End-to-end walk for "words on resting links", in headless Chromium.
//
//   bun run build
//   bun run index fastapi/full-stack-fastapi-template --out "$PWD/fastapi.graph.json"
//   node docs/pr-media/claude-link-labels-at-rest-8ily39/e2e.mjs web/dist fastapi.graph.json out/ [--before]
//
// Serves a built map, answers the indexer API from a saved graph and records
// every word the canvas paints, frame by frame (a hook on the 2D context, so
// it checks what was drawn, not what the code meant to draw). Then it walks
// the map like a person: first screen, point at a labelled link, click it,
// clear, open a circle, and fails on the first thing that is wrong. Writes
// screenshots and a video (walkthrough.mp4, needs ffmpeg) into out/. --before only takes the screenshots, for
// a build without the change.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const [distArg, graphFile, outArg, ...flags] = process.argv.slice(2);
const before = flags.includes('--before');
const dist = path.resolve(distArg);
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const graphJson = fs.readFileSync(graphFile, 'utf8');
const graph = JSON.parse(graphJson);
const workspace = { repos: graph.repos.map((r) => ({ ...r, status: 'ready' })), busy: false, graphVersion: 1, suggestions: [], project: { id: 'e2e', groupingLocation: 'e2e' } };
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(dist, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// The walk is filmed from Chromium's own screencast, frame by frame, and put together with ffmpeg at the end.
const frames = [];
const cdp = before ? null : await ctx.newCDPSession(page);
if (cdp) {
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
}

// Every word painted, per frame: a frame starts where the paper is filled. The map draws only when
// something changes, so between frames `__frame` holds the whole of the last one.
await page.addInitScript(() => {
  const P = CanvasRenderingContext2D.prototype;
  const w = window;
  w.__frame = { labels: [], words: [], curves: [] };
  const fillRect = P.fillRect;
  P.fillRect = function (x, y, ww, hh) {
    if (x === 0 && y === 0 && ww >= this.canvas.width / 4) w.__frame = { labels: [], words: [], curves: [] };
    return fillRect.call(this, x, y, ww, hh);
  };
  const box = (ctx, text, x, y) => {
    const m = ctx.measureText(text);
    const left = ctx.textAlign === 'center' ? x - m.width / 2 : ctx.textAlign === 'right' || ctx.textAlign === 'end' ? x - m.width : x;
    return { text, x: left, y: y - 7, w: m.width, h: 14, font: ctx.font, alpha: ctx.globalAlpha, fill: String(ctx.fillStyle) };
  };
  // Every link the map strokes: a quadratic curve from the last moveTo.
  let at = [0, 0];
  const moveTo = P.moveTo;
  P.moveTo = function (x, y) {
    at = [x, y];
    return moveTo.call(this, x, y);
  };
  const quad = P.quadraticCurveTo;
  P.quadraticCurveTo = function (cx, cy, x, y) {
    w.__frame.curves.push([...at, cx, cy, x, y]);
    return quad.call(this, cx, cy, x, y);
  };
  const strokeText = P.strokeText;
  P.strokeText = function (text, x, y) {
    w.__frame.labels.push(box(this, text, x, y));
    return strokeText.call(this, text, x, y);
  };
  const fillText = P.fillText;
  P.fillText = function (text, x, y) {
    w.__frame.words.push(box(this, text, x, y));
    return fillText.call(this, text, x, y);
  };
});
// Literata comes from Google Fonts, which headless Chromium here can't verify; fetch it with curl.
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => {
  try {
    const body = execFileSync('curl', ['-sSL', '-A', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', r.request().url()], { maxBuffer: 1 << 24 });
    const ct = r.request().url().includes('googleapis') ? 'text/css' : 'font/woff2';
    await r.fulfill({ body, contentType: ct, headers: { 'access-control-allow-origin': '*' } });
  } catch {
    await r.abort();
  }
});
await page.route('**/api/workspace', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(workspace) }));
await page.route('**/api/graph', (r) => r.fulfill({ contentType: 'application/json', body: graphJson }));
await page.route('**/api/summary**', (r) => r.fulfill({ status: 404, body: '' }));
await page.route('**/api/auth**', (r) => r.fulfill({ status: 404, body: '' }));

await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForSelector('.stage canvas');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1800);
await page.mouse.move(720, 20);
await page.waitForTimeout(400);
const frame = () => page.evaluate(() => window.__frame);
// Canvas coordinates to the page's: the map sits under the top bar.
const origin = await page.evaluate(() => {
  const r = document.querySelector('.stage canvas').getBoundingClientRect();
  return { x: r.left, y: r.top };
});
const centre = (b) => [origin.x + b.x + b.w / 2, origin.y + b.y + b.h / 2];
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

await shot(before ? 'before-first-screen' : 'after-first-screen');
const overlap = (a, b, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
const crosses = ([x0, y0, cx, cy, x2, y2], b) => {
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x2;
    const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y2;
    if (x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1) return true;
  }
  return false;
};
const checkFrame = async (where) => {
  const f = await frame();
  for (const l of f.labels) {
    assert.match(l.text, /^\d+ [a-z]+( & [a-z]+)?\??$/, `${where}: "${l.text}" reads as a count and a verb`);
    assert.ok(/Literata/.test(l.font) && /13px/.test(l.font), `${where}: "${l.text}" is Literata 13px (${l.font})`);
    // Its own fill sits exactly on it; nothing else painted may touch it.
    const others = f.words.filter((w) => !(w.text === l.text && Math.abs(w.x - l.x) < 1 && Math.abs(w.y - l.y) < 1));
    for (const w of others) assert.ok(!overlap(l, w), `${where}: "${l.text}" collides with "${w.text}"`);
    for (const m of f.labels) if (m !== l) assert.ok(!overlap(l, m, 2), `${where}: "${l.text}" collides with "${m.text}"`);
    // Only its own link may run through its words (when they sit in a gap cut from it), never another.
    const through = f.curves.filter((c) => crosses(c, l));
    assert.ok(through.length <= 1, `${where}: "${l.text}" sits on ${through.length} links`);
  }
  return f;
};

if (before) {
  const f = await frame();
  console.log('before: words on resting links:', f.labels.length);
} else {
  // 1. First screen: the resting links say what they are, where they have room. On a big
  // repository the top-level circles touch and their links are too short for words, so
  // zoom in towards the middle until the links open up.
  let f = await checkFrame('first screen');
  console.log('first screen labels:', f.labels.map((l) => l.text));
  for (let i = 0; i < 12 && !f.labels.length; i++) {
    await page.mouse.move(origin.x + 560, origin.y + 420);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(350);
    await page.mouse.move(720, 20);
    await page.waitForTimeout(150);
    f = await checkFrame(`zoom in ${i}`);
  }
  // Let the camera settle before reading where the words are.
  await page.waitForTimeout(1000);
  f = await checkFrame('settled');
  console.log('labels once there is room:', f.labels.map((l) => l.text));
  await shot('after-labelled');
  assert.ok(f.labels.length >= 1, 'resting links get words once they have room');

  // 2. Point at a labelled link: its words stay where they are and turn green (the one
  // colour for "here"), the tip says the whole contract, and the other words stay.
  const target = f.labels[0];
  const fillOf = (fr, l) => fr.words.find((w) => w.text === l.text && Math.abs(w.x - l.x) < 1 && Math.abs(w.y - l.y) < 1)?.fill;
  const restFill = fillOf(f, target);
  const [hx, hy] = centre(target);
  await page.mouse.move(hx, hy, { steps: 8 });
  await page.waitForTimeout(500);
  await shot('after-hover-label');
  f = await checkFrame('hover');
  const held = f.labels.find((l) => l.text === target.text);
  assert.ok(held && overlap(held, target, 2), 'the pointed-at words stay where they were');
  assert.notEqual(fillOf(f, held), restFill, 'the pointed-at words change colour');
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase());
  console.log('hover fill:', fillOf(f, held), 'accent token:', accent);
  const tip = await page.locator('.map-tip').innerText().catch(() => '');
  console.log('hover tip:', tip);
  assert.ok(tip.length > 0, 'the link under the pointer gets its one-line tip');

  // 3. Click it: the contract opens in the panel, and with a link in focus the resting words step back.
  await page.mouse.click(...centre(target));
  await page.waitForTimeout(900);
  await page.mouse.move(720, 20, { steps: 6 });
  await page.waitForTimeout(400);
  await shot('after-click-label');
  const panel = await page.locator('.detail, aside').last().innerText();
  assert.ok(panel.length > 0, 'the contract panel opened');
  console.log('panel opens with:', panel.split('\n').slice(0, 3).join(' | '));
  f = await checkFrame('contract selected');
  assert.equal(f.labels.length, 0, 'no resting words while a contract is selected');

  // 4. Escape clears, and the words come back.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  f = await checkFrame('cleared');
  assert.ok(f.labels.length >= 1, 'words come back once nothing is selected');

  // 5. Open the biggest closed circle on screen (select, then Enter): its own links get words, no tangle.
  const before5 = f.labels.length;
  const pick = await page.evaluate(() => {
    const s = document.querySelector('.stage canvas').getBoundingClientRect();
    const names = window.__frame.words.filter((w) => /600/.test(w.font) && w.x > 340 && w.x < s.width - 420 && w.y > 80 && w.y < s.height - 80);
    const px = (w) => Number(/(\d+)px/.exec(w.font)[1]);
    // Open circles' names are 15 or 17px on their rims; a big closed circle's name is set larger.
    return names.filter((w) => px(w) > 17).sort((a, b) => px(b) - px(a) || b.w - a.w)[0];
  });
  if (pick) {
    await page.mouse.click(...centre({ ...pick, y: pick.y + 20 }));
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.mouse.move(720, 20, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    await shot('after-opened-circle');
    f = await checkFrame('opened circle');
    console.log(`opened "${pick.text}": labels ${before5} → ${f.labels.length}`, f.labels.map((l) => l.text));
    assert.ok(f.labels.length <= 12, 'opening a circle keeps the words to a few links');
  }

  // 6. Zoom out and in: the words follow and never collide.
  for (const dy of [300, -300]) {
    await page.mouse.move(900, 450);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, dy / 6), await page.waitForTimeout(60);
    await page.waitForTimeout(600);
    await checkFrame(`zoom ${dy}`);
  }
  await shot('after-zoomed');

  // 7. Light theme: same words, read from the tokens.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.waitForTimeout(500);
  await page.mouse.move(721, 21);
  await page.waitForTimeout(300);
  await checkFrame('light theme');
  await shot('after-light');
  console.log('e2e: all checks passed');
}

if (cdp && frames.length) {
  await cdp.send('Page.stopScreencast');
  const dir = fs.mkdtempSync(path.join(out, 'frames-'));
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1];
    list.push(`file '${file}'`, `duration ${Math.max(0.02, next ? next.t - f.t : 0.5).toFixed(3)}`);
  });
  list.push(`file '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', 'fps=25,scale=1440:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', path.join(out, 'walkthrough.mp4')]);
  fs.rmSync(dir, { recursive: true });
}
await ctx.close();
await browser.close();
server.close();
