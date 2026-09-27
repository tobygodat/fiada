// Zoom and pan smoothness of the map on a real graph, in headless Chromium.
//
//   npm run build
//   npm run index -- vercel/next.js --out "$PWD/next.graph.json"
//   npm run bench -w @fiada/web -- "$PWD/next.graph.json"
//
// Needs a Chromium for Playwright (npx playwright install chromium), or set
// CHROMIUM_PATH to one that's already installed.
//
// Serves web/dist, answers the indexer API from the saved graph, then drives
// continuous gestures (one wheel event per frame, like a trackpad) in both
// expansion modes and reports frame intervals. At 60Hz a smooth frame is
// 16.7ms; anything above that is a dropped frame. Headless Chromium draws in
// software, so a real browser with a GPU does better than these numbers.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [graphFile, ...rest] = process.argv.slice(2);
if (!graphFile) {
  console.error('usage: npm run bench -w @fiada/web -- <graph.json> [--frames 80]');
  process.exit(1);
}
const opt = (name, d) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : d);
const frames = Number(opt('--frames', 80));
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('web/dist is missing: run npm run build first');
  process.exit(1);
}

const graphJson = fs.readFileSync(graphFile, 'utf8');
const graph = JSON.parse(graphJson);
const workspace = {
  repos: graph.repos.map((r) => ({ ...r, status: 'ready' })),
  busy: false,
  graphVersion: 1,
  suggestions: [],
  project: { id: 'bench', groupingLocation: 'bench' },
};
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(dist, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dist) || !fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// CHROMIUM_PATH points at an installed Chrome/Chromium when Playwright's own download isn't there.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean: +mean.toFixed(1), median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1), dropped: s.filter((x) => x > 20).length };
};

const rows = [];
for (const mode of ['click', 'zoom']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((m) => localStorage.setItem('strata.expandMode', m), mode);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route('**/api/workspace', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(workspace) }));
  await page.route('**/api/graph', (r) => r.fulfill({ contentType: 'application/json', body: graphJson }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('.stage canvas');
  await page.waitForTimeout(1000);

  const gesture = (kind, dy) =>
    page.evaluate(
      ({ kind, dy, n }) =>
        new Promise((resolve) => {
          const el = document.querySelector('.stage');
          const r = el.getBoundingClientRect();
          const x = r.left + 316 + (r.width - 316) / 2;
          const y = r.top + r.height / 2;
          const out = [];
          let last = 0;
          let i = 0;
          const tick = () => {
            const now = performance.now();
            if (i > 0) out.push(now - last);
            last = now;
            if (i++ >= n) {
              if (kind === 'pan') el.dispatchEvent(new PointerEvent('pointerup', { clientX: x + n * 4, clientY: y, bubbles: true, pointerId: 1 }));
              return resolve(out);
            }
            if (kind === 'zoom') el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
            else {
              if (i === 1) el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0 }));
              el.dispatchEvent(new PointerEvent('pointermove', { clientX: x + i * 4, clientY: y + i * 2, bubbles: true, pointerId: 1, buttons: 1 }));
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      { kind, dy, n: frames },
    );
  rows.push({ mode, gesture: 'zoom in', ...stats(await gesture('zoom', -40)) });
  rows.push({ mode, gesture: 'pan', ...stats(await gesture('pan', 0)) });
  rows.push({ mode, gesture: 'zoom out', ...stats(await gesture('zoom', 40)) });
  await page.close();
}

const n = graph.nodes.length;
console.log(`${graphFile}: ${n} nodes, ${graph.edges.length} edges; frame intervals in ms (dropped = frames over 20ms)`);
console.table(rows);
await browser.close();
server.close();
