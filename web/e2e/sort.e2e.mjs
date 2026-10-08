// End to end: import a real repository into a local indexer whose Claude is
// web/e2e/mock-claude.mjs, wait for the model sort, and check on the map
// that it placed the code the classifier couldn't. Drives the app the way a
// person does: the import box, the view toggle, the domains outline and a
// symbol's details.
//
//   git clone --depth 1 https://github.com/pmndrs/zustand /tmp/zustand
//   node web/e2e/sort.e2e.mjs /tmp/zustand --out /tmp/sort-e2e [--video]
//
// --indexer <checkout> runs another checkout's indexer (say, main's, to see
// the bug); --expect unplaced then passes when the sort placed nothing.
// Needs Chromium for Playwright, or CHROMIUM_PATH pointing at one. Exits
// non-zero when the map isn't what --expect says (placed by default).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const repo = args.find((a, i) => !a.startsWith('--') && !['--out', '--indexer', '--expect'].includes(args[i - 1]));
if (!repo) {
  console.error('usage: node web/e2e/sort.e2e.mjs <local repository> [--out dir] [--indexer checkout] [--expect placed|unplaced] [--video]');
  process.exit(1);
}
const out = path.resolve(opt('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'fiada-sort-e2e-'))));
const checkout = path.resolve(opt('--indexer', path.join(here, '../..')));
const expect = opt('--expect', 'placed');
fs.mkdirSync(out, { recursive: true });
const INDEXER_PORT = 4188;
const WEB_PORT = 5188;

const children = [];
function start(cmd, argv, cwd, env, logFile, inherit = process.env) {
  const p = spawn(cmd, argv, { cwd, env: { ...inherit, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logFile);
  p.stdout.pipe(log);
  p.stderr.pipe(log);
  children.push(p);
  return p;
}
const stopAll = () => children.forEach((p) => p.kill());
process.on('exit', stopAll);

async function until(what, check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Another indexer or map already on these ports would answer instead of ours.
for (const port of [INDEXER_PORT, WEB_PORT]) {
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) {
    console.error(`port ${port} is taken: stop what's listening there first`);
    process.exit(1);
  }
}

// 1. The stand-in for Claude.
const mock = start('node', [path.join(here, 'mock-claude.mjs')], here, { MOCK_CLAUDE_LOG: path.join(out, 'claude-requests.jsonl') }, path.join(out, 'mock.log'));
const mockUrl = await until('the mock', () => /http:\/\/\S+/.exec(fs.readFileSync(path.join(out, 'mock.log'), 'utf8'))?.[0]);

// 2. The indexer, with a fresh home and no keys but the mock's.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fiada-home-'));
// Left out, not blanked: a legacy STRATA_* name wins over its FIADA_* one even when empty.
const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FIADA|STRATA)_|^(OPENAI|ANTHROPIC)_|^MONGODB_URI$/.test(k)));
start('node', ['--import', 'tsx', 'src/server.ts'], path.join(checkout, 'indexer'), { PORT: String(INDEXER_PORT), HOST: '127.0.0.1', FIADA_HOME: home, ANTHROPIC_API_KEY: 'mock', ANTHROPIC_BASE_URL: mockUrl }, path.join(out, 'indexer.log'), bare);
await until('the indexer', async () => (await fetch(`http://127.0.0.1:${INDEXER_PORT}/api/workspace`)).ok);

// 3. The map, proxying /api to that indexer.
const vite = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
start('node', [vite, '--port', String(WEB_PORT), '--strictPort'], path.join(here, '..'), { FIADA_INDEXER_PORT: String(INDEXER_PORT) }, path.join(out, 'web.log'));
const app = `http://127.0.0.1:${WEB_PORT}`;
await until('the map', async () => (await fetch(app)).ok);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
// --video: the page's frames over CDP, joined by ffmpeg into run.mp4 at the end.
const frames = [];
if (args.includes('--video')) {
  const cdp = await context.newCDPSession(page);
  fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(out, 'frames', `${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
}
// A watchable pace for the video; as fast as it goes otherwise.
const pace = args.includes('--video') ? 1200 : 0;
const pause = (ms) => page.waitForTimeout(ms + pace);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

try {
  await page.goto(app);
  await pause(0);
  await page.getByLabel('Repository to import: org/repo, a git URL, or a local path').pressSequentially(path.resolve(repo), { delay: pace ? 12 : 0 });
  await pause(400);
  await page.getByRole('button', { name: 'import', exact: true }).click();

  // The sort runs after indexing; the sidebar says when it's done.
  const sorting = page.locator('.sorting').first();
  await sorting.waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.sorting')?.textContent ?? '';
    return t && !/is sorting/.test(t);
  }, null, { timeout: 120_000 });
  await pause(800);
  const said = (await sorting.textContent()).trim();
  console.log(`sidebar: ${said}`);
  await shot('1-code-view');

  await page.getByRole('radio', { name: 'by function' }).click();
  await pause(1200);
  await shot('2-by-function');

  const graph = await (await fetch(`http://127.0.0.1:${INDEXER_PORT}/api/graph`)).json();
  const files = graph.nodes.filter((n) => n.kind === 'file');
  const withSymbols = new Set(graph.nodes.filter((n) => n.kind === 'symbol').map((n) => n.parent));
  const leaves = graph.nodes.filter((n) => n.kind === 'symbol' || (n.kind === 'file' && !withSymbols.has(n.id)));
  const unsorted = leaves.filter((n) => (n.domain?.id ?? 'unsorted') === 'unsorted').length;
  const byModel = leaves.filter((n) => n.domain?.source === 'model' || n.layer?.source === 'model').length;
  const domains = graph.domains.map((d) => d.name);
  const sortLines = fs.readFileSync(path.join(out, 'indexer.log'), 'utf8').split('\n').filter((l) => /sort/.test(l));
  console.log(sortLines.join('\n'));
  const summary = { repo: path.basename(repo), files: files.length, leaves: leaves.length, unsorted, placedByModel: byModel, domains, sidebar: said };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));

  if (expect === 'unplaced') {
    check(sortLines.some((l) => /sorted in/.test(l)), 'the sort finished');
    check(byModel === 0 && unsorted === leaves.length, `the sort placed nothing: ${unsorted} of ${leaves.length} unsorted`);
  } else {
    check(unsorted === 0, `every symbol has a domain (${unsorted} of ${leaves.length} unsorted)`);
    check(byModel === leaves.length, `the model placed all ${leaves.length} (${byModel})`);
    check(/placed \d+ files and symbols the classifier couldn't/.test(said), 'the sidebar says what the sort placed');
    check(!sortLines.some((l) => /asking again/.test(l)), 'no file needed a second ask');

    // A domain in the outline, then one of its symbols, then why it's there.
    const domain = page.locator('.outline-row.group .outline-name', { hasText: 'Middleware' }).first();
    await domain.click();
    await pause(1200);
    await shot('3-domain-selected');
    const detail = page.locator('aside.detail').first();
    // Open the outline down to a symbol: Middleware, its layers, its files.
    const target = page.locator('.outline-row .outline-name', { hasText: /^combine$/ }).first();
    for (let i = 0; i < 6 && !(await target.count()); i++) {
      const labels = await page.getByRole('button', { name: /^Unfold / }).evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label').slice('Unfold '.length)));
      const next = labels.find((l) => l === 'Middleware' || !domains.includes(l));
      if (!next) break;
      await page.getByRole('button', { name: `Unfold ${next}`, exact: true }).first().click();
      await page.waitForTimeout(300 + pace / 3);
    }
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await pause(1200);
    await shot('4-symbol-detail');
    await pause(800);
    check(/inferred by Claude/.test((await detail.textContent()) ?? ''), 'the details credit Claude and say why');
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
  await shot('error').catch(() => {});
} finally {
  await context.close();
  await browser.close();
  mock.kill();
  stopAll();
}
if (frames.length) {
  // Each frame shows until the next one arrives, so the video keeps the run's own pace.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, ((frames[i + 1]?.at ?? f.at + 1) - f.at)).toFixed(3)}`).join('\n');
  fs.writeFileSync(path.join(out, 'frames.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(out, 'frames.txt'), '-vf', 'scale=1440:-2,format=yuv420p', '-r', '30', path.join(out, 'run.mp4')], { stdio: 'inherit' });
  await new Promise((r) => ff.on('close', r));
}
console.log(`artifacts in ${out}`);
process.exit(failures.length ? 1 : 0);
