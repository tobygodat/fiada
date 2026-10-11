// End-to-end run behind this PR's screenshots and video. It drives the real
// agent package against a running indexer and map, the way Claude Code would:
// the MCP server over stdio (initialize, tools/list, tools/call) and the hook
// with Claude Code's payloads on stdin, then checks the map in Chromium.
//
//   node e2e.mjs <after|before> <checkout> <indexer url> <map url> <media dir>
//
// <checkout> is a git checkout whose backend/ and frontend/ folders are
// imported on the map as two repositories (the FastAPI full-stack template).
// "before" runs the same steps against main, which has no read tools.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, checkout, indexer, map, media] = process.argv.slice(2);
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const agentBin = (name) => path.join(process.env.AGENT_ROOT ?? repoRoot, 'agent/bin', name);
const { chromium } = await import(path.join(repoRoot, 'node_modules/playwright/index.mjs'));
const SESSION = 'e2e-session';
const env = { ...process.env, FIADA_URL: indexer, FIADA_CONFIG: '/nonexistent', CLAUDE_CODE_SESSION_ID: SESSION, FIADA_CWD: checkout };
const step = (s) => console.log(`\n▸ ${s}`);
await fs.mkdir(media, { recursive: true });

// ── the agent side ──

function mcpServer() {
  const child = spawn(process.execPath, [agentBin('fiada-mcp.mjs')], { cwd: checkout, env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (c) => {
    buf += c;
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const i = ++id;
      waiting.set(i, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`);
    });
  return { rpc, close: () => child.stdin.end() };
}

/** Runs the hook with a Claude Code payload, as Claude Code does after a tool call. */
const hook = (payload) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [agentBin('fiada-hook.mjs')], { env, stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: SESSION, cwd: checkout, transcript_path: '/dev/null', ...payload }));
  });

const state = async () => (await fetch(`${indexer}/api/agent/state`)).json();

// ── the browser ──

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  try {
    if (!sessionStorage.getItem('e2e')) {
      localStorage.setItem('strata-theme', 'dark');
      localStorage.setItem('strata.expandMode', 'click');
      sessionStorage.setItem('e2e', '1');
    }
  } catch {}
});
const page = await context.newPage();
// The video: Chromium's own screencast, frame by frame with when each was painted, put together with ffmpeg at the end.
const frames = path.join(media, `${mode}-frames`);
await fs.rm(frames, { recursive: true, force: true });
await fs.mkdir(frames);
const cdp = await context.newCDPSession(page);
const painted = [];
let filming = true;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  if (!filming) return;
  const file = path.join(frames, `${String(painted.length).padStart(5, '0')}.jpg`);
  painted.push({ file, at: metadata.timestamp });
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && errors.push(m.text()));
const shot = async (name) => {
  await page.waitForTimeout(700);
  // The caption is for the video only.
  await page.evaluate(() => document.getElementById('e2e-caption')?.style.setProperty('display', 'none'));
  await page.screenshot({ path: path.join(media, `${mode}-${name}.png`) });
  await page.evaluate(() => document.getElementById('e2e-caption')?.style.removeProperty('display'));
  console.log(`  screenshot ${mode}-${name}.png`);
};
/** A line along the bottom of the video saying what the agent just did, since its side doesn't show in the browser. */
async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('e2e-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'e2e-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99;max-width:760px;padding:10px 16px;background:var(--ground-raised);border:1px solid var(--hairline-strong);color:var(--text);font:400 15px/1.5 var(--font-serif);white-space:pre-line';
      document.body.append(el);
    }
    el.textContent = t;
  }, text);
  await page.waitForTimeout(1600);
}
/** Opens the agent window (it folds while the detail panel is open) and its list of what the agent looked at. */
async function openLooked() {
  const folded = page.locator('.queue-folded');
  if (await folded.isVisible()) await folded.click();
  const toggle = page.getByRole('button', { name: /looked at \d+ places/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

step('the map loads both repositories');
await page.goto(map);
await page.getByText('backend', { exact: true }).first().waitFor();
await page.getByText('frontend', { exact: true }).first().waitFor();
await page.waitForTimeout(1500);
await shot('01-map');

step('Claude Code starts and its MCP server lists its tools');
await hook({ hook_event_name: 'SessionStart', source: 'startup' });
await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a description length check when an item is created' });
const mcp = mcpServer();
await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1' } });
const tools = (await mcp.rpc('tools/list')).result.tools.map((t) => t.name);
console.log(`  tools: ${tools.join(', ')}`);
const call = async (name, args) => {
  const res = await mcp.rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
  console.log(`  ${name} ${JSON.stringify(args)}\n${text.replace(/^/gm, '    | ')}`);
  return { text, isError: !!res.result?.isError };
};
await call('status', { now: 'Finding where an item is created, before adding the length check.' });

const transcript = [];
if (mode === 'after') {
  assert.deepEqual(tools, ['status', 'flag_changes', 'where_is', 'who_uses', 'impact']);

  step('where_is: where is an item created?');
  await caption('Claude Code asks Fiada: where_is "create item"');
  const where = await call('where_is', { query: 'create item', limit: 4 });
  transcript.push(['where_is', { query: 'create item', limit: 4 }, where.text]);
  assert.match(where.text, /create_item \(function\) in backend\/app\/api\/routes\/items\.py:\d+-\d+\n   API layer, Items domain; serves POST \/api\/v1\/items\//);
  assert.match(where.text, /id: backend\/app\/crud\.py#create_item/);

  await caption('Fiada answers with create_item in backend/app/api/routes/items.py, API layer, Items domain.\nThe matches it was shown are marked looked at.');
  step('who_uses: what calls the route?');
  await caption('Claude Code asks: who_uses backend/app/api/routes/items.py#create_item');
  const users = await call('who_uses', { target: 'backend/app/api/routes/items.py#create_item' });
  transcript.push(['who_uses', { target: 'backend/app/api/routes/items.py#create_item' }, users.text]);
  assert.match(users.text, /ItemsService \(class\) in frontend\/src\/client\/sdk\.gen\.ts:\d+-\d+, another repository\n  http, proven\n    frontend\/src\/client\/sdk\.gen\.ts:\d+ /);

  await caption('ItemsService in the frontend calls it over HTTP: sdk.gen.ts:308, proven.');
  step('impact: what does an edit to the Item model reach?');
  await caption('Claude Code asks: impact of an edit to backend/app/models.py#Item');
  const target = path.join(checkout, 'backend/app/models.py#Item');
  const reach = await call('impact', { target, depth: 3, limit: 15 });
  transcript.push(['impact', { target: '<checkout>/backend/app/models.py#Item', depth: 3, limit: 15 }, reach.text]);
  assert.match(reach.text, /^An edit to Item \(class in backend\/app\/models\.py:\d+-\d+\) reaches \d+ places within 3 links, in 2 repositories\./);
  assert.match(reach.text, /By repository: backend \d+, frontend \d+\./);
  assert.match(reach.text, /ItemsService \(class\) in frontend\/src\/client\/sdk\.gen\.ts:\d+-\d+: http, another repository/);

  await caption('49 places within 3 links, in 2 repositories: backend 33, frontend 16.');
  step('several things are called Item: the tool asks which');
  const which = await call('who_uses', { target: 'Item' });
  assert.match(which.text, /could be any of these/);
} else {
  assert.deepEqual(tools, ['status', 'flag_changes']);
  const nope = await call('where_is', { query: 'create item' });
  transcript.push(['where_is', { query: 'create item' }, nope.text]);
  assert.match(nope.text, /Unknown tool/);
}

step('Claude Code reads two files with its Read tool');
await caption('Claude Code reads crud.py and AddItem.tsx (its Read tool)');
for (const f of ['backend/app/crud.py', 'frontend/src/components/Items/AddItem.tsx']) {
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(checkout, f) }, tool_response: {} });
}

step('then edits one: crud.create_item checks the description');
await caption('…and edits crud.py');
const crud = path.join(checkout, 'backend/app/crud.py');
const before = await fs.readFile(crud, 'utf8');
await fs.writeFile(crud, before.replace('def create_item(', 'MAX_DESCRIPTION = 255\n\n\ndef create_item('));
await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: crud }, tool_response: {} });

const s = await state();
const agent = s.agents[0];
if (mode === 'after') {
  const looked = Object.keys(s.looked ?? {}).sort();
  console.log(`  looked at: ${looked.join(', ')}`);
  // The file it changed is marked changed, not looked at; everything else it asked about or read is looked at.
  for (const id of ['backend/app/api/routes/items.py#create_item', 'backend/app/models.py#Item', 'frontend/src/components/Items/AddItem.tsx']) assert.ok(looked.includes(id), id);
  assert.ok(!looked.includes('backend/app/crud.py'), 'crud.py changed, so it is not marked looked at');
  assert.equal(s.nodes['backend/app/crud.py']?.kind, 'modified');
  assert.equal(agent.looked.count, looked.length);
} else {
  assert.equal(s.looked, undefined, 'main keeps no looks');
  assert.equal(s.nodes['backend/app/crud.py']?.kind, 'modified');
}

step('the map marks it');
await caption(mode === 'after' ? 'Changed: an ochre ring. Looked at: a faint dotted one.' : 'Only the change shows; nothing says what it read.');
await shot('02-map-agent');
if (mode === 'after') {
  // The agent card says how much it looked at, and the key says what the dotted ring means.
  await page.getByText(/looked at \d+ places/).waitFor();
  await page.getByText('looked at', { exact: true }).waitFor();
}
step('the file it changed, opened from the agent card: the same view before and after');
await caption('Opening crud.py, the file it changed, from the agent card');
await page.getByRole('button', { name: /1 file changed/ }).click();
await page.locator('.queue-file', { hasText: 'crud.py' }).first().click();
await page.locator('.detail-title', { hasText: 'crud.py' }).waitFor();
await page.waitForTimeout(1200);
await shot('03-changed-file');
if (mode === 'after') {
  // Its neighbours in app/: the route and the model it asked about, ringed as looked at; crud.py as changed.
  assert.equal(await page.locator('.detail-looked').count(), 0, 'a changed file says changed, not looked at');
}

if (mode === 'after') {

  step('the agent card lists what it looked at; one click goes to it on the map');
  await caption('The agent card lists what it looked at');
  await openLooked();
  await shot('04-looked-list');
  await page.locator('.queue-file', { hasText: 'Item' }).filter({ hasText: 'backend/app/models.py' }).first().click();
  await page.locator('.detail-looked').waitFor();
  await caption('Selected: Item. The detail panel says "looked at by Claude Code".');
  const said = await page.locator('.detail-looked').innerText();
  console.log(`  detail panel: ${said}`);
  assert.match(said, /looked at by Claude Code · just now/);
  await shot('05-item-selected');

  step('the route the agent asked about, next to the file it changed');
  await openLooked();
  await page.locator('.queue-file', { hasText: 'create_item' }).filter({ hasText: 'routes/items.py' }).first().click();
  await page.locator('.detail-looked').waitFor();
  await caption('The route it asked about, next to crud.py, which it changed');
  await shot('06-route-selected');

  step('light theme');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    localStorage.setItem('strata-theme', 'light');
  });
  await page.reload();
  await page.getByText('backend', { exact: true }).first().waitFor();
  await page.waitForTimeout(1200);
  await openLooked();
  await page.locator('.queue-file', { hasText: 'AddItem' }).filter({ hasText: 'AddItem.tsx' }).first().click();
  await page.locator('.detail-looked').waitFor();
  await shot('07-light');
}

mcp.close();
await fs.writeFile(crud, before);
await fs.writeFile(path.join(media, `${mode}-transcript.json`), JSON.stringify(transcript, null, 2));
await page.waitForTimeout(1500);
await cdp.send('Page.stopScreencast');
filming = false;
await new Promise((r) => setTimeout(r, 300));
await context.close();
await browser.close();
// Each frame stays up until the next one was painted.
const list = painted.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.04, ((painted[i + 1]?.at ?? f.at + 1.5) - f.at)).toFixed(3)}`);
await fs.writeFile(path.join(frames, 'list.txt'), `${list.join('\n')}\nfile '${painted[painted.length - 1].file}'\n`);
const ffmpeg = (args) => new Promise((resolve, reject) => spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }).on('close', (c) => (c ? reject(new Error(`ffmpeg ${c}`)) : resolve())));
await ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(frames, 'list.txt'), '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '23', '-movflags', '+faststart', path.join(media, `${mode}-run.mp4`)]);
await fs.rm(frames, { recursive: true, force: true });
console.log(`  video ${mode}-run.mp4 from ${painted.length} frames`);
assert.deepEqual(errors, [], `the page logged errors: ${errors.join('; ')}`);
console.log(`\n✓ ${mode}: every check passed`);
