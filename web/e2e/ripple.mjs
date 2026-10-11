// End to end: the ripple on the real stack. Two real repositories are imported
// into a running indexer, a change is made in one of them and reported by the
// agent hook exactly as Claude Code's would be, and a real browser checks that
// the map and the detail panel say what the change reaches, across both.
//
//   git clone --depth 1 https://github.com/fastapi/full-stack-fastapi-template /tmp/fastapi
//   bun run dev                                    # in another terminal
//   node web/e2e/ripple.mjs /tmp/fastapi [--video <dir>] [--shots <dir>]
//
// The template's frontend/ and backend/ are copied into a temporary folder as
// two git repositories, so the requests from one reach routes in the other.
// Set CHROMIUM_PATH if Playwright's own browser isn't installed, SCHEME=light for the light theme.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [template, ...rest] = process.argv.slice(2);
if (!template || !fs.existsSync(path.join(template, 'backend'))) {
  console.error('usage: node web/e2e/ripple.mjs <full-stack-fastapi-template checkout> [--video <dir>] [--shots <dir>]');
  process.exit(1);
}
const opt = (name) => (rest.includes(name) ? path.resolve(rest[rest.indexOf(name) + 1]) : null);
const video = opt('--video');
const shots = opt('--shots');
const INDEXER = process.env.FIADA_URL ?? 'http://127.0.0.1:4178';
const MAP = process.env.MAP_URL ?? 'http://localhost:5178/';
const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent/bin/fiada-hook.mjs');

const api = async (method, route, body) => {
  const res = await fetch(INDEXER + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${route} answered ${res.status}`);
  return res.json();
};

// Two repositories, as on a real machine.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiada-ripple-'));
const repos = {};
for (const name of ['frontend', 'backend']) {
  const dir = path.join(root, name);
  fs.cpSync(path.join(template, name), dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=e2e@fiada.tech', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  repos[name] = dir;
}
const before = new Set((await api('GET', '/api/workspace')).repos.map((r) => r.id));
for (const dir of Object.values(repos)) await api('POST', '/api/repos', { source: dir });
let ids = [];
for (let i = 0; i < 120; i++) {
  const ws = await api('GET', '/api/workspace');
  const mine = ws.repos.filter((r) => !before.has(r.id));
  ids = mine.map((r) => r.id);
  if (mine.length === 2 && mine.every((r) => r.status === 'ready') && !ws.busy) break;
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(ids.length, 2, 'both repositories imported');
const backend = ids.find((id) => id.startsWith('backend'));
const frontend = ids.find((id) => id.startsWith('frontend'));

// The agent: a task, then a change to a shared type and a route, reported by the hook.
const session = `e2e-${Date.now()}`;
const report = (...args) => execFileSync('node', [hook, ...args, '--session', session], { cwd: repos.backend, env: { ...process.env, FIADA_URL: INDEXER }, stdio: 'pipe' });
const edit = (file, from, to) => {
  const p = path.join(repos.backend, file);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `${file} has ${from}`);
  fs.writeFileSync(p, text.replace(from, to));
};
report('task', 'Add tags to items');
report('status', 'Adding a tag filter to the items list');
edit('app/models.py', 'class ItemPublic(ItemBase):\n    id: uuid.UUID\n', 'class ItemPublic(ItemBase):\n    id: uuid.UUID\n    tags: list[str] = []\n');
edit('app/api/routes/items.py', 'skip: int = 0, limit: int = 100\n) -> Any:', 'skip: int = 0, limit: int = 100, tag: str | None = None\n) -> Any:');
report('changed', 'app/models.py', 'app/api/routes/items.py');
const state = await api('GET', '/api/agent/state');
assert.equal(state.nodes[`${backend}/app/api/routes/items.py#read_items`]?.kind, 'modified', 'the route is marked changed');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark', recordVideo: video ? { dir: video, size: { width: 1440, height: 900 } } : undefined });
  const page = await ctx.newPage();
  const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));
  const pause = (ms) => page.waitForTimeout(ms);
  await page.goto(MAP);
  await page.waitForSelector('.stage canvas');
  const queue = page.locator('.queue');
  await queue.getByText('Adding a tag filter to the items list').waitFor();
  // The key says what the dotted ring means.
  await queue.locator('.queue-key').getByText('depends on a change').waitFor();
  await pause(1500);
  await shot('1-map');

  // Light the agent's changes, then follow its route: the panel says who calls it, from the other repository.
  await queue.getByText('show on map').click();
  await pause(1500);
  await shot('2-lit');
  await queue.locator('.queue-sym', { hasText: 'read_items' }).click();
  const reach = page.locator('.detail .agent-reach');
  await reach.waitFor();
  assert.equal((await reach.innerText()).trim(), `1 request from ${frontend} calls this route.`);
  await pause(1500);
  await shot('3-route');

  // The shared type: what in its own repository uses it.
  await page.keyboard.press('Escape');
  await pause(500);
  await queue.locator('.queue-sym', { hasText: 'ItemPublic' }).click();
  await page.locator('.detail .detail-title', { hasText: 'ItemPublic' }).waitFor();
  assert.match((await reach.innerText()).trim(), new RegExp(`^\\d+ places in ${backend} use this class\\.$`));
  await pause(1500);
  await shot('4-type');

  // A node nobody changed has no sentence, even when it depends on a change.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await pause(500);

  // The agent puts the files back: the change, and with it the ripple, is gone.
  execFileSync('git', ['checkout', '--', '.'], { cwd: repos.backend });
  report('changed', 'app/models.py', 'app/api/routes/items.py');
  await queue.locator('.queue-key').getByText('depends on a change').waitFor();
  for (let i = 0; i < 40 && Object.keys((await api('GET', '/api/agent/state')).nodes).length; i++) await pause(250);
  assert.deepEqual(Object.keys((await api('GET', '/api/agent/state')).nodes), [], 'reverted: nothing marked');
  await pause(1500);
  await shot('5-reverted');
  await ctx.close();
  console.log('ripple e2e: passed');
} finally {
  await browser.close();
  for (const a of (await api('GET', '/api/agent/state')).agents) if (a.cwd === repos.backend) await fetch(`${INDEXER}/api/agent?id=${encodeURIComponent(a.id)}`, { method: 'DELETE' });
  for (const id of ids) await fetch(`${INDEXER}/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  fs.rmSync(root, { recursive: true, force: true });
}
