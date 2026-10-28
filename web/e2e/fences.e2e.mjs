// End to end: fences and collisions on a real repository, through the real
// map, the real indexer and the real agent hook, the way Claude Code runs it.
//
//   bun run dev                                   # indexer on :4178, map on :5178
//   git clone https://github.com/fastapi/full-stack-fastapi-template /tmp/fastapi
//   node web/e2e/fences.e2e.mjs /tmp/fastapi --scratch [--out <dir>]
//
// The checkout must be a scratch clone: the script edits files in it as two
// agents would, then puts them back with `git checkout`. It imports the clone
// by its path if the map doesn't have it, and leaves the project as it found
// it (no fences, no agents). Every step asserts; a failure exits non-zero.
// Screenshots go to --out (default e2e-out/), and a recording of the browser
// as frames from Chromium's screencast, made into fences.mp4 when ffmpeg is on
// the PATH.
//
// Needs Chromium for Playwright; set CHROMIUM_PATH if Playwright's own isn't installed.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const repoDir = args[0] && path.resolve(args[0]);

if (!repoDir || !args.includes('--scratch')) {
  console.error('usage: node web/e2e/fences.e2e.mjs <scratch clone> --scratch [--out <dir>]');
  process.exit(1);
}

const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'e2e-out');

fs.mkdirSync(out, { recursive: true });

const API = process.env.FIADA_URL ?? 'http://127.0.0.1:4178';
const MAP = process.env.FIADA_MAP ?? 'http://localhost:5178/';
const HOOK = fileURLToPath(new URL('../../agent/bin/fiada-hook.mjs', import.meta.url));

const api = async (method, p, body) => {
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- GET calls pass no body, so body is undefined there
  const res = await fetch(`${API}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const json = await res.json();

  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`);

  return json;
};

/** Runs the agent hook with a Claude Code payload on stdin; resolves to what it printed. */
const hook = (payload) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { cwd: repoDir, env: { ...process.env, FIADA_URL: API }, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.on('error', reject);
    child.on('close', () => resolve(text));
    child.stdin.end(JSON.stringify({ transcript_path: '/dev/null', cwd: repoDir, ...payload }));
  });

/** One Claude Code session: its start, a prompt, then each edit asked about before it lands and reported after. */
async function agent(session, prompt) {
  await hook({ session_id: session, hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt });

  return {
    async edit(rel, oldText, newText) {
      const input = { file_path: path.join(repoDir, rel), old_string: oldText, new_string: newText };
      const said = await hook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: input });
      const answer = said ? JSON.parse(said).hookSpecificOutput : null;

      // Claude Code runs the edit only when the hook let it through (an "ask" waits for the person; this script says no).
      if (!answer) {
        const file = path.join(repoDir, rel);
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(text.includes(oldText), `${rel} holds the text to replace`);
        fs.writeFileSync(file, text.replace(oldText, newText));
        await hook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: input, tool_response: {} });
      }

      return answer;
    },
  };
}

const step = (s) => console.log(`· ${s}`);

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;

  for (;;) {
    const v = await fn().catch(() => null);

    if (v) return v;

    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

// ── the project ──
const real = fs.realpathSync(repoDir);
let ws = await api('GET', '/api/workspace');
let repo = ws.repos.find((r) => r.source === real || r.source === repoDir);

if (!repo) {
  step(`importing ${repoDir}`);
  ws = await api('POST', '/api/repos', { source: repoDir });
  repo = ws.repos.find((r) => r.source === real || r.source === repoDir);
}

await until('the repository to be indexed', async () => !(await api('GET', '/api/workspace')).busy && (await api('GET', '/api/workspace')).repos.find((r) => r.id === repo.id)?.status === 'ready', 60_000);

const R = repo.id;
const ROUTES = `${R}/backend/app/api/routes`;
const CORE = `${R}/backend/app/core`;
const LOGIN = `${R}/backend/app/api/routes/login.py`;

execFileSync('git', ['-C', repoDir, 'checkout', '--', '.']);

await api('DELETE', '/api/agent');

for (const f of (await api('GET', '/api/fences')).fences) await api('PUT', '/api/fences', { node: f.node, rule: null });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// The recording: each frame Chromium paints, with when it was painted.
const framesDir = path.join(out, 'frames');

fs.rmSync(framesDir, { recursive: true, force: true });

fs.mkdirSync(framesDir);

const frames = [];
const cdp = await context.newCDPSession(page);

cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });

const errors = [];

page.on('pageerror', (e) => errors.push(e.message));

const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const pause = (ms = 700) => page.waitForTimeout(ms);
const row = (name) => page.locator('.outline-row', { has: page.locator('.outline-name', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }) }).first();

/** Opens the structure outline down to `names` and selects the last one. */
async function open(...names) {
  for (const n of names.slice(0, -1)) {
    const r = row(n);

    if ((await r.locator('.chev').getAttribute('aria-expanded')) !== 'true') await r.locator('.chev').click();
    await pause(150);
  }

  await row(names.at(-1)).locator('.outline-name').click();
  await pause(1200);
}

try {
  await page.goto(MAP);
  await page.waitForSelector('canvas');
  await pause(1500);

  // ── 1. two agents in one folder ──
  step('two Claude Code sessions edit files in the same folder');
  const a = await agent('a41f-e2e', 'Paginate the items list');
  assert.equal(await a.edit('backend/app/api/routes/items.py', 'skip: int = 0, limit: int = 100', 'skip: int = 0, limit: int = 50'), null);
  const b = await agent('b7c2-e2e', 'Lock down user updates');
  assert.equal(await b.edit('backend/app/api/routes/users.py', 'def update_user_me(', 'def update_user_me_locked('), null);

  const state = await until('the collision', async () => {
    const s = await api('GET', '/api/agent/state');

    return s.collisions.length ? s : null;
  });

  assert.deepEqual(state.collisions.map((c) => [c.node, c.unit, c.agents.length]), [[ROUTES, 'folder', 2]]);
  const line = page.locator('.queue-collision').first();
  await line.waitFor();
  assert.match(await line.innerText(), new RegExp(`two agents in ${ROUTES.replace(/\//g, '\\/')}`));
  assert.match(await line.locator('.queue-collision-who').innerText(), /Claude Code · (a41f|b7c2) and Claude Code · (a41f|b7c2)/);
  await pause(1500);
  await shot('after-collision-window');
  step('the collision line takes the map to the folder');
  await line.click();
  await pause(1500);
  assert.equal(await page.locator('.detail-title').innerText(), 'routes');
  await shot('after-collision-map');
  step('…and from the by-function view, which has no folders, it switches to code first');
  await page.keyboard.press('Escape');
  const views = page.getByRole('radiogroup', { name: 'view' });
  await views.getByRole('radio', { name: 'by function' }).click();
  await pause(800);
  await line.click();
  await pause(1500);
  assert.equal(await views.getByRole('radio', { name: 'code' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.detail-title').innerText(), 'routes');

  // ── 2. fences from the detail panel ──
  step('fence backend/app/core off limits from the detail panel');
  await page.keyboard.press('Escape');
  await pause(400);
  await open(R, 'backend/app', 'core');
  assert.equal(await page.locator('.detail-title').innerText(), 'core');
  const fence = page.locator('.fence-block');
  assert.equal(await fence.locator('[role=radio][aria-checked=true]').innerText(), 'none');
  await fence.getByRole('radio', { name: 'off limits' }).click();
  await until('the off-limits fence', async () => (await api('GET', '/api/fences')).fences.some((f) => f.node === CORE && f.rule === 'off'));
  await fence.locator('.fence-words.off').waitFor();
  assert.match(await fence.locator('.fence-words.off').innerText(), /Agents can't change anything in this module with their edit tools/);
  await pause(800);
  await shot('after-fence-off');
  step('a file inside says which fence it is in');
  await open(R, 'backend/app', 'core', 'config.py');
  assert.match(await page.locator('.fence-block').innerText(), new RegExp(`Inside the off-limits fence round ${CORE.replace(/\//g, '\\/')}`));
  step('…and from the by-function view, its link switches to code to show the fence');
  await page.keyboard.press('Escape');
  await views.getByRole('radio', { name: 'by function' }).click();
  await pause(800);
  await page.getByRole('combobox').fill('Settings');
  await page.getByRole('option').filter({ hasText: 'config.py' }).first().click();
  await pause(1200);
  await page.locator('.fence-block').getByRole('button', { name: CORE }).click();
  await pause(1500);
  assert.equal(await views.getByRole('radio', { name: 'code' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.detail-title').innerText(), 'core');
  step('mark login.py ask first');
  await open(R, 'backend/app', 'api', 'routes', 'login.py');
  await page.locator('.fence-block').getByRole('radio', { name: 'ask first' }).click();
  await until('the ask-first fence', async () => (await api('GET', '/api/fences')).fences.some((f) => f.node === LOGIN && f.rule === 'ask'));
  await pause(800);
  await shot('after-fence-ask');

  // ── 3. a hook run that gets blocked ──
  step("a third session tries to edit core/config.py: the hook denies it before it lands");
  const before = fs.readFileSync(path.join(repoDir, 'backend/app/core/config.py'), 'utf8');
  const c = await agent('c90d-e2e', 'Move the secret key into settings');
  const denied = await c.edit('backend/app/core/config.py', '    SECRET_KEY: str\n', '    SECRET_KEY: str = "changeme"\n');
  assert.equal(denied?.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /off limits on the Fiada map/);
  assert.equal(fs.readFileSync(path.join(repoDir, 'backend/app/core/config.py'), 'utf8'), before, 'the fenced file is untouched');
  step('…and asks the person before an edit to login.py');
  const asked = await c.edit('backend/app/api/routes/login.py', 'def login_access_token(', 'def login_token(');
  assert.equal(asked?.permissionDecision, 'ask');
  assert.match(asked.permissionDecisionReason, /marked "ask first"/);
  step('…and an edit outside every fence goes through');
  assert.equal(await c.edit('backend/app/api/main.py', 'api_router = APIRouter()', 'api_router = APIRouter()  # routes'), null);
  // The last fenced attempt shows on its entry: the off-limits one was first, the ask-first one after.
  const fenced = await until('the fenced attempt on the entry', async () => Object.values((await api('GET', '/api/agent/state')).fenced)[0]);
  assert.deepEqual([fenced.node, fenced.decision], [LOGIN, 'ask']);
  // Ask again at the off-limits fence so the entry shows the refusal.
  await c.edit('backend/app/core/config.py', '    SECRET_KEY: str\n', '    SECRET_KEY: str = "changeme"\n');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const stopped = page.locator('.queue-fenced.deny');
  await stopped.waitFor();
  assert.equal(await stopped.innerText(), `stopped at the off-limits fence round ${CORE}: config.py stays as it is`);
  await pause(1200);
  await shot('after-blocked');

  // ── 4. kept for the project ──
  step('the fences are still there after a reload');
  await page.reload();
  await page.waitForSelector('canvas');
  await pause(1500);
  await open(R, 'backend/app', 'core');
  assert.equal(await page.locator('.fence-block [role=radio][aria-checked=true]').innerText(), 'off limits');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await pause(800);
  await shot('after-dark');
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  step('taking the fence down lets the edit through');
  await page.locator('.fence-block').getByRole('radio', { name: 'none' }).click();
  await until('the fence to come down', async () => !(await api('GET', '/api/fences')).fences.some((f) => f.node === CORE));
  assert.equal((await api('POST', '/api/agent/check', { agent: { client: 'claude-code', session: 'c90d-e2e', cwd: real, root: real }, files: [{ path: path.join(real, 'backend/app/core/config.py') }] })).decision, 'allow');
  await pause(800);
  assert.deepEqual(errors, [], 'no errors on the page');
  console.log(`ok: fences and collisions, end to end. Screenshots and video in ${out}`);
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  await context.close();

  // Frames to a video at the pace they were painted.
  if (frames.length > 1) {
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(3)}`).join('\n');
    fs.writeFileSync(path.join(framesDir, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);

    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(framesDir, 'list.txt'), '-vf', 'fps=25,scale=1440:-2', '-pix_fmt', 'yuv420p', path.join(out, 'fences.mp4')]);
    } catch {
      console.log(`no ffmpeg: the recording is the frames in ${framesDir}`);
    }
  }

  await browser.close();

  // Leave the project and the clone as they were.
  for (const f of (await api('GET', '/api/fences')).fences) await api('PUT', '/api/fences', { node: f.node, rule: null });
  await api('DELETE', '/api/agent');
  execFileSync('git', ['-C', repoDir, 'checkout', '--', '.']);
}
