// End-to-end check of the review tour while agents keep working, against the
// same setup as review-tour.mjs (a running `bun run dev`, the FastAPI template
// imported, web/e2e/agent-session.sh played on it). A second agent edits the
// file under review: the detail panel still shows only the reviewed agent's
// diff. A function's stop also shows its file's hunks outside every changed
// function (crud.py's import). The agent deletes the function you're on: its stop moves to
// the file and shows only the hunk that takes it away, and switching to By function, which shows
// no files, moves the tour to the nearest change it does show. The agent deletes a file: its stop, on the
// folder that's left, shows the deleted file's diff. Then the reviewed agent
// takes a file back: the tour goes on to the change now in its place. Puts
// the files and the session back as they were.
//
//   node web/e2e/review-tour-live.mjs <fastapi clone> [url] [--shots dir]

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = process.argv[2];
assert.ok(repo, 'usage: review-tour-live.mjs <fastapi clone> [url]');
const url = process.argv.slice(3).find((a) => /^https?:/.test(a)) ?? 'http://localhost:5178/';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const here = dirname(fileURLToPath(import.meta.url));
const FILE = 'frontend/src/routes/_layout/items.tsx';
const GONE = 'backend/app/utils.py';
const CRUD = 'backend/app/crud.py';
const hook = (session, file = FILE) =>
  execFileSync('node', [join(here, '../../agent/bin/fiada-hook.mjs'), 'changed', '--client', 'claude-code', '--session', session, '--cwd', repo, file]);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => r.fulfill({ response: await r.fetch() }).catch(() => r.abort()));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const hunks = () => page.locator('.agent-diff .hunk-at').allInnerTexts();
const goTo = async (name) => {
  await page.locator(`.tour-tick[aria-label*=": ${name},"]`).click();
  await page.locator('.tour-name', { hasText: name }).waitFor();
  await page.locator('.agent-diff').first().waitFor();
  await page.waitForTimeout(600);
};
const count = async () => {
  const m = /change (\d+) of (\d+)/.exec(await page.locator('.tour-count').innerText());
  assert.ok(m, 'the tour says where you are');
  return { at: +m[1], of: +m[2] };
};

try {
  await page.goto(url);
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fiada.tour.')).forEach((k) => localStorage.removeItem(k)));
  await page.reload();
  await page.locator('.queue-card').first().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'review', exact: true }).click();
  await page.locator('.tour').waitFor();
  await page.waitForTimeout(800);
  const before = await count();
  // Go to the first stop in the file the other agent will touch.
  const ticks = page.locator('.tour-tick');
  for (let i = 0; i < (await ticks.count()) && !(await page.locator('.tour-path').innerText()).endsWith(FILE); i++) {
    await ticks.nth(i).click();
    await page.waitForTimeout(300);
  }
  const name = await page.locator('.tour-name').innerText();
  assert.ok((await page.locator('.tour-path').innerText()).endsWith(FILE), `a stop is in ${FILE}`);
  await page.locator('.agent-diff').first().waitFor();

  // Another agent edits the same file: the review still shows only its own agent's diff.
  appendFileSync(join(repo, FILE), '\n// touched by another agent\n');
  hook('zz-other');
  await page.waitForTimeout(1500);
  const state = await (await fetch('http://localhost:4178/api/agent/state')).json();
  assert.ok(state.agents.some((a) => a.id.endsWith('#zz-other')), 'the second agent reported its change');
  const diffs = page.locator('.agent-diff');
  await diffs.first().waitFor();
  assert.equal(await diffs.count(), 1, 'one diff: the reviewed agent’s');
  assert.match(await page.locator('.agent-diff-head').innerText(), /· demo/, 'and it is the reviewed agent’s');
  assert.equal(await page.locator('.tour-name').innerText(), name, 'still on the same change');

  // crud.py changed an import and added items_by_priority: the function's stop shows both hunks.
  await goTo('items_by_priority');
  assert.equal((await hunks()).length, 2, 'two hunks: the function and the import');
  assert.match(await page.locator('.agent-diff').innerText(), /from sqlmodel import Session, col, select/, 'the import hunk comes with the function');

  // The agent changes update_user in crud.py, then deletes it while you're on it: its stop moves
  // to the file, with only the hunk that takes it away.
  const crudPath = join(repo, CRUD);
  const src = readFileSync(crudPath, 'utf8');
  writeFileSync(crudPath, src.replace(/(\ndef update_user\([^\n]*\n)/, '$1    # checked by the agent\n'));
  hook('demo-review', CRUD);
  await page.waitForTimeout(1500);
  await goTo('update_user');
  assert.equal(await page.locator('.detail-title').innerText(), 'update_user', 'on the function while it is there');
  writeFileSync(crudPath, src.replace(/\ndef update_user\([\s\S]*?\n(?=\n\ndef )/, '\n'));
  hook('demo-review', CRUD);
  await page.locator('.detail-title', { hasText: /^crud\.py$/ }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.tour-name').innerText(), 'update_user', 'still the same change');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.detail-title').innerText(), 'crud.py', 'a deleted function is read on its file');
  assert.match(await page.locator('.agent-change .block-title').innerText(), /deleted by an agent · update_user/);
  assert.equal(await page.locator('.agent-diff').count(), 1);
  assert.match(await page.locator('.agent-diff').innerText(), /def update_user\(/, 'the hunk that takes it away');
  assert.doesNotMatch(await page.locator('.agent-diff').innerText(), /def items_by_priority/, 'and not another function’s');
  // By function shows no files: switching to it moves the tour to the nearest change it does show.
  const view = (v) => page.getByRole('radiogroup', { name: 'view' }).getByRole('radio', { name: v, exact: true }).click();
  await view('by function');
  await page.waitForTimeout(1200);
  const moved = await page.locator('.tour-name').innerText();
  assert.notEqual(moved, 'update_user', 'the tour left the stop By function can’t show');
  assert.equal(await page.locator('.detail-title').innerText(), moved, 'and the detail panel shows where it went');
  if (shots) await page.screenshot({ path: `${shots}/view-switch.png` });
  await view('code');
  await page.waitForTimeout(1200);
  writeFileSync(crudPath, src);
  hook('demo-review', CRUD);
  await page.waitForTimeout(1500);

  // The agent deletes a file: its stop stands on the folder left, with the deleted file's diff.
  execFileSync('git', ['-C', repo, 'rm', '-q', '--cached', GONE]);
  execFileSync('rm', [join(repo, GONE)]);
  hook('demo-review', GONE);
  await page.waitForTimeout(1500);
  await goTo('utils.py');
  assert.equal(await page.locator('.detail-title').innerText(), 'backend/app', 'a deleted file is read on its folder');
  assert.match(await page.locator('.agent-change .block-title').innerText(), /deleted by an agent · backend\/app\/utils\.py/);
  assert.equal(await page.locator('.agent-diff').count(), 1);
  assert.ok((await page.locator('.agent-diff .del').count()) > 10, 'the deleted lines are shown');
  execFileSync('git', ['-C', repo, 'checkout', 'HEAD', '--', GONE]);
  hook('demo-review', GONE);
  await page.waitForTimeout(1500);
  await goTo(name);

  // The reviewed agent takes the file back: the tour goes on to the change in its place.
  execFileSync('git', ['-C', repo, 'checkout', '--', FILE]);
  hook('demo-review');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.tour').count(), 1, 'the tour goes on');
  const after = await count();
  assert.ok(after.of < before.of, `fewer changes once the file is taken back (${before.of} → ${after.of})`);
  const now = await page.locator('.tour-name').innerText();
  assert.notEqual(now, name, 'no longer on the change that is gone');
  assert.equal(await page.locator('.detail-title').innerText(), now, 'the detail panel shows the change the tour is on');
  await page.getByRole('button', { name: 'end', exact: true }).click();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`review tour live: diff scoped to the reviewed agent; ${before.of} → ${after.of} changes, moved from ${name} to ${now}; all checks passed`);
} finally {
  await browser.close();
  // Put things back: the other agent gone, the reviewed agent's edit to the page made again.
  await fetch(`http://localhost:4178/api/agent?id=${encodeURIComponent(`claude-code@${repo}#zz-other`)}`, { method: 'DELETE' }).catch(() => {});
  execFileSync('git', ['-C', repo, 'checkout', 'HEAD', '--', FILE, GONE, CRUD]);
  hook('demo-review', GONE);
  execFileSync('python3', [join(here, 'agent-edits.py'), repo, 'crud']);
  hook('demo-review', CRUD);
  execFileSync('python3', [join(here, 'agent-edits.py'), repo, 'page']);
  hook('demo-review');
}
