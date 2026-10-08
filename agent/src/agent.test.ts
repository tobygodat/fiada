import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent } from '@fiada/shared';
import { ancestors, startedAt } from './client.ts';
import { checkout, kindOf, merge, parseDiff, parseStatus, real } from './git.ts';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { aboutToEdit, fenceAnswer, firstLine, linesOf, STATUS_BRIEF, STATUS_NUDGE, sweep } from './hook.ts';
import { clientId, nowLines, FiadaMcp } from './mcp.ts';
import { applyConfig, configPath } from './env.ts';
import { commandsFor, EDIT_MATCHER, flag, hooksBlock, mergeHooks, nextConfig } from './setup.ts';
import { changedSince, compare, take } from './snapshot.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function repo(files: Record<string, string>) {
  const dir = await real(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-agent-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('changed lines from a unified diff, on both sides', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,6 +1,7 @@',
    ' a',
    '-b',
    '+B',
    '+B2',
    ' c',
    ' d',
    '-e',
    ' f',
  ].join('\n');
  const d = parseDiff(diff);
  assert.deepEqual(d.lines, [[2, 3], [6, 5]]);
  assert.deepEqual(d.oldLines, [[2, 2], [5, 5]]);
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 2);
  // A removal right after a change joins it; separate removals stay as empty ranges.
  assert.deepEqual(merge([[4, 3], [2, 3]]), [[2, 3]]);
});

test('git status entries and what they mean for the map', () => {
  const st = parseStatus(' M src/a.ts\0R  src/new.ts\0src/old.ts\0?? notes.md\0 D gone.py\0');
  assert.deepEqual(st, [
    { xy: ' M', path: 'src/a.ts' },
    { xy: 'R ', path: 'src/new.ts', from: 'src/old.ts' },
    { xy: '??', path: 'notes.md' },
    { xy: ' D', path: 'gone.py' },
  ]);
  assert.deepEqual(st.map((e) => kindOf(e.xy)), ['modified', 'added', 'added', 'deleted']);
  assert.equal(kindOf('AM'), 'added');
  assert.equal(kindOf('MD'), 'deleted');
});

test('snapshots: new, touched again and reverted files, but not committed ones', () => {
  const prev = { head: 'h1', files: { 'a.ts': { xy: ' M', mtime: 1 }, 'b.ts': { xy: ' M', mtime: 1 }, 'c.ts': { xy: ' M', mtime: 1 } } };
  const cur = { head: 'h1', files: { 'a.ts': { xy: ' M', mtime: 1 }, 'b.ts': { xy: ' M', mtime: 2 }, 'd.ts': { xy: '??', mtime: 1 } } };
  assert.deepEqual(compare(prev, cur), [
    { path: 'b.ts', kind: 'modified' },
    { path: 'd.ts', kind: 'added' },
    { path: 'c.ts', kind: 'reverted' },
  ]);
  assert.deepEqual(compare(prev, { ...cur, head: 'h2' }), [
    { path: 'b.ts', kind: 'modified' },
    { path: 'd.ts', kind: 'added' },
  ]);
});

test('a hook sweep reports edits, new files, deletions made from a shell, and reverts', async () => {
  const dir = await repo({ 'src/a.ts': 'export function a() {\n  return 1;\n}\n', 'src/b.ts': 'export const b = 2;\n', 'README.md': 'hi\n' });
  const co = await checkout(dir);
  assert.ok(co);
  const key = `test:${dir}`;
  // The tree was already dirty before the agent started: not the agent's change.
  await fs.writeFile(path.join(dir, 'README.md'), 'hi there\n');
  assert.deepEqual(await sweep(key, co), []);

  await fs.writeFile(path.join(dir, 'src/a.ts'), 'export function a() {\n  return 42;\n}\n');
  let out = await sweep(key, co, [path.join(dir, 'src/a.ts')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'modified');
  assert.equal(out[0].swept, undefined);
  assert.deepEqual(out[0].lines, [[2, 2]]);
  assert.match(out[0].diff!, /\+  return 42;/);

  // A shell command: one file removed, one generated.
  git(dir, 'rm', '-q', 'src/b.ts');
  await fs.writeFile(path.join(dir, 'src/gen.ts'), 'export const g = 1;\nexport const h = 2;\n');
  out = await sweep(key, co);
  const byPath = Object.fromEntries(out.map((c) => [path.relative(dir, c.path), c]));
  assert.deepEqual(Object.keys(byPath).sort(), ['src/b.ts', 'src/gen.ts']);
  assert.equal(byPath['src/b.ts'].kind, 'deleted');
  assert.equal(byPath['src/gen.ts'].kind, 'added');
  assert.deepEqual(byPath['src/gen.ts'].lines, [[1, 2]]);
  // Found in the tree, not named by a tool: another agent in this checkout may have made them.
  assert.ok(byPath['src/b.ts'].swept && byPath['src/gen.ts'].swept);

  // Put a.ts back as it was: reported as reverted, so the map drops it.
  git(dir, 'checkout', '--', 'src/a.ts');
  out = await sweep(key, co);
  assert.deepEqual(out.map((c) => [path.relative(dir, c.path), c.kind]), [['src/a.ts', 'reverted']]);

  // A file the agent made and then removed again: git no longer knows it, and it's reverted too.
  await fs.rm(path.join(dir, 'src/gen.ts'));
  out = await sweep(key, co);
  assert.deepEqual(out.map((c) => [path.relative(dir, c.path), c.kind, c.swept]), [['src/gen.ts', 'reverted', true]]);
});

test('a first sweep with a start time reports what changed after it, and nothing older', async () => {
  const dir = await repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'lib/c.ts': 'export const c = 1;\n' });
  const co = (await checkout(dir))!;
  // Dirty before the session began.
  await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 2;\n');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(dir, 'src/a.ts'), old, old);
  // Well between the two: file times come from a coarse kernel clock and can trail Date.now() by a few ms.
  const since = Date.now() - 30_000;
  // During the session: an edit, a new file, a deletion (its folder's time moves).
  await fs.writeFile(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
  await fs.writeFile(path.join(dir, 'src/new.ts'), 'export const n = 1;\n');
  await fs.rm(path.join(dir, 'lib/c.ts'));
  const cur = (await take(co))!;
  assert.deepEqual((await changedSince(co, cur, since)).sort((x, y) => x.path.localeCompare(y.path)), [
    { path: 'lib/c.ts', kind: 'deleted' },
    { path: 'src/b.ts', kind: 'modified' },
    { path: 'src/new.ts', kind: 'added' },
  ]);

  // Through sweep: only with no earlier snapshot, and only when asked.
  const out = await sweep(`test-since:${dir}`, co, [], undefined, async () => since);
  assert.deepEqual(out.map((c) => path.relative(dir, c.path)).sort(), ['lib/c.ts', 'src/b.ts', 'src/new.ts']);
  assert.deepEqual(await sweep(`test-since:${dir}`, co, [], undefined, async () => since), []);
  assert.deepEqual(await sweep(`test-none:${dir}`, co), []);
});

test('the MCP server answers the handshake and forwards tool calls', async () => {
  const dir = await repo({ 'app/models.py': 'class Item:\n    pass\n' });
  const sent: AgentEvent[][] = [];
  const out: any[] = [];
  const post = async (events: AgentEvent[]) => {
    sent.push(events);
    return { files: [{ path: 'app/models.py', repo: 'r', node: 'r/app/models.py', kind: 'modified', symbols: 1 }] };
  };
  process.env.FIADA_CWD = dir;
  const fresh = new FiadaMcp((m) => out.push(m), post);
  delete process.env.FIADA_CWD;
  const outer = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';

  await fresh.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } });
  assert.equal(out[0].result.protocolVersion, '2025-03-26');
  assert.ok(out[0].result.capabilities.tools);
  await fresh.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(out[1].result.tools.map((t: any) => t.name), ['status', 'flag_changes']);
  assert.deepEqual(out[1].result.tools[0].inputSchema.required, ['now']);

  await fresh.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'report_task', arguments: { task: 'Add tags', steps: [{ text: 'Model', status: 'done' }, { text: 'API', status: 'active' }] } },
  });
  assert.match(out[2].result.content[0].text, /step 2 of 2/);
  const task = sent[0][0];
  assert.equal(task.type, 'task');
  assert.equal(task.agent.client, 'claude-code');
  // Claude Code names the session in the server's environment.
  assert.equal(task.agent.session, 'sess-1');
  if (outer === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = outer;
  assert.equal(task.agent.root, dir);

  await fs.writeFile(path.join(dir, 'app/models.py'), 'class Item:\n    tags: list\n');
  await fresh.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flag_changes', arguments: { files: [{ path: 'app/models.py', change: 'modified', symbols: ['Item'] }] } } });
  const change = sent[1][0];
  assert.equal(change.type, 'changes');
  if (change.type === 'changes') {
    assert.equal(change.files[0].path, path.join(dir, 'app/models.py'));
    assert.deepEqual(change.files[0].symbols, ['Item']);
    assert.deepEqual(change.files[0].lines, [[2, 2]]);
  }
  assert.match(out[3].result.content[0].text, /On the map: app\/models\.py \(modified, 1 symbol\)/);

  await fresh.handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(out[4].error.code, -32601);
  assert.equal(clientId('Cursor-VSCode'), 'cursor');

  // status: the line alone, or the plan first and then the line said with it.
  sent.length = 0;
  await fresh.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: { now: 'Reading app/models.py for the Item fields.' } } });
  assert.equal(out[5].result.content[0].text, 'Shown in Fiada.');
  assert.deepEqual(sent[0].map((e) => [e.type, e.type === 'status' ? e.text : '']), [['status', 'Reading app/models.py for the Item fields.']]);
  await fresh.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'status', arguments: { now: 'Adding tags to Item.', task: 'Add tags', steps: [{ text: 'Model', status: 'active' }] } },
  });
  assert.deepEqual(sent[1].map((e) => e.type), ['task', 'status']);
  await fresh.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'status', arguments: { now: 'Added tags; tests pass.', done: true } } });
  assert.deepEqual(sent[2].map((e) => [e.type, e.type === 'state' ? e.state : '']), [['task', ''], ['status', ''], ['state', 'waiting']]);
  await fresh.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'status', arguments: { task: 'No line' } } });
  assert.equal(out[8].result.isError, true);
  assert.equal(sent.length, 3);
});

test('a status keeps two short lines', () => {
  assert.equal(nowLines('  Reading the routes.  \n\n  Then   the model. \nAnd more.'), 'Reading the routes.\nThen the model.');
  assert.equal(nowLines('x'.repeat(200))!.length, 160);
  assert.equal(nowLines(' \n '), null);
  assert.equal(nowLines(42), null);
  assert.equal(firstLine('\n  Add paging to items  \n\n```\npasted\n```'), 'Add paging to items');
});

/** Runs the hook as Claude Code does, with a payload on stdin; resolves to what it printed. */
function runHook(payload: object, env: Record<string, string>): Promise<string> {
  const bin = fileURLToPath(new URL('../bin/fiada-hook.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.on('error', reject);
    child.on('close', () => resolve(text));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('the hook briefs the agent on its status line at the start and with each prompt, only when Fiada answers', async () => {
  const dir = await repo({ 'a.py': 'x = 1\n' });
  const got: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(...JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end('{"files":[]}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const base = { session_id: 'hook-test', cwd: dir, transcript_path: '/dev/null' };
    const start = JSON.parse(await runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, { FIADA_URL: url }));
    assert.deepEqual(start, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: STATUS_BRIEF } });
    const prompt = JSON.parse(await runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Add paging\nto the items list' }, { FIADA_URL: url }));
    assert.deepEqual(prompt, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: STATUS_NUDGE } });
    assert.deepEqual(got.map((e) => e.type), ['session', 'prompt']);
    assert.equal(got[1].text, 'Add paging');
    // Other events print nothing.
    assert.equal(await runHook({ ...base, hook_event_name: 'Stop' }, { FIADA_URL: url }), '');
  } finally {
    server.close();
  }
  // Nobody listening: nothing for the agent to act on.
  assert.equal(await runHook({ session_id: 'hook-test-2', cwd: dir, hook_event_name: 'SessionStart' }, { FIADA_URL: 'http://127.0.0.1:9' }), '');
});

test('the processes above this one, nearest first, and when one started', async () => {
  const procs = await ancestors(2);
  if (process.platform === 'win32') return assert.deepEqual(procs, []);
  assert.equal(procs[0], process.ppid);
  assert.ok(procs.length <= 2);
  const t = await startedAt(process.pid);
  assert.ok(t != null && t <= Date.now() && t > Date.now() - 10 * 60_000);
});

test('setup merges hooks without disturbing others and replaces its own', () => {
  const mine = { type: 'command' as const, command: 'echo other' };
  const settings = { model: 'x', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [mine] }] } };
  const once = mergeHooks(settings, hooksBlock('node /x/fiada-hook.mjs'));
  const twice = mergeHooks(once, hooksBlock('node /y/fiada-hook.mjs'));
  assert.equal(twice.model, 'x');
  assert.equal(twice.hooks.PostToolUse.length, 2);
  assert.deepEqual(twice.hooks.PostToolUse[0].hooks, [mine]);
  assert.equal(twice.hooks.PostToolUse[1].hooks[0].command, 'node /y/fiada-hook.mjs');
  assert.equal(twice.hooks.Stop.length, 1);
});

test('the saved config fills in the indexer and token, and never sends the token elsewhere', () => {
  const saved = { url: 'https://indexer.test/', token: 'fa_x.y' };
  const bare: NodeJS.ProcessEnv = {};
  applyConfig(bare, saved);
  assert.equal(bare.FIADA_URL, 'https://indexer.test/');
  assert.equal(bare.FIADA_TOKEN, 'fa_x.y');
  const elsewhere: NodeJS.ProcessEnv = { FIADA_URL: 'http://127.0.0.1:4178' };
  applyConfig(elsewhere, saved);
  assert.equal(elsewhere.FIADA_URL, 'http://127.0.0.1:4178');
  assert.equal(elsewhere.FIADA_TOKEN, undefined);
  const own: NodeJS.ProcessEnv = { FIADA_URL: 'https://indexer.test', FIADA_TOKEN: 'mine' };
  applyConfig(own, saved);
  assert.equal(own.FIADA_TOKEN, 'mine');
  assert.equal(configPath({ FIADA_CONFIG: '/tmp/x.json' }), '/tmp/x.json');
});

test('setup keeps a token only for the indexer it was given for', () => {
  assert.deepEqual(nextConfig({}, 'https://a.test/', 'fa_1'), { url: 'https://a.test', token: 'fa_1' });
  assert.deepEqual(nextConfig({ url: 'https://a.test', token: 'fa_1' }, 'https://a.test'), { url: 'https://a.test', token: 'fa_1' });
  assert.deepEqual(nextConfig({ url: 'https://a.test', token: 'fa_1' }, 'https://b.test'), { url: 'https://b.test' });
  assert.equal(flag(['--write', '.', '--url', 'u'], '--url'), 'u');
  assert.equal(flag(['--write', '.'], '--token'), undefined);
  assert.equal(flag(['--write', '--url', 'u'], '--write', true), undefined);
  // A key may start with dashes: after --token it's the value, and --token= says so outright.
  assert.equal(flag(['--url', 'u', '--token', '--odd-key'], '--token'), '--odd-key');
  assert.equal(flag(['--token=--odd=key', '--write', '.'], '--token'), '--odd=key');
  assert.equal(flag(['--url=https://a.test'], '--url'), 'https://a.test');
});

test('setup runs this copy by its path, or through npx when it lives in npx cache', () => {
  const pkg = { name: '@fiadatech/agent', version: '1.2.3' };
  const installed = commandsFor('/usr/lib/node_modules/@fiadatech/agent/bin', pkg);
  assert.equal(installed.hook, 'node /usr/lib/node_modules/@fiadatech/agent/bin/fiada-hook.mjs');
  assert.deepEqual(installed.mcp, ['node', '/usr/lib/node_modules/@fiadatech/agent/bin/fiada-mcp.mjs']);
  const cached = commandsFor('/home/a/.npm/_npx/9f2c/node_modules/@fiadatech/agent/bin', pkg);
  assert.equal(cached.hook, 'npx -y --prefer-offline --package=@fiadatech/agent@1.2.3 fiada hook');
  assert.deepEqual(cached.mcp, ['npx', '-y', '--prefer-offline', '--package=@fiadatech/agent@1.2.3', 'fiada', 'mcp']);
  // Setting up again replaces the npx hook as it does a path to fiada-hook.
  const merged = mergeHooks({ hooks: hooksBlock(cached.hook) }, hooksBlock(installed.hook));
  assert.deepEqual(merged.hooks.Stop, hooksBlock(installed.hook).Stop);
  // And an npx hook written before the package moved to the fiadatech scope.
  const renamed = mergeHooks({ hooks: hooksBlock('npx -y --package=@fiada/agent@0.1.0 fiada hook') }, hooksBlock(installed.hook));
  assert.deepEqual(renamed.hooks.Stop, hooksBlock(installed.hook).Stop);
});

test('an edit is placed on the lines it replaces; a write, or text not in the file, is the whole file', async () => {
  const text = 'a\nb\nc\nb\n';
  assert.deepEqual(linesOf(text, 'b'), [[2, 2]]);
  assert.deepEqual(linesOf(text, 'b', true), [[2, 2], [4, 4]]);
  assert.deepEqual(linesOf(text, 'b\nc'), [[2, 3]]);
  assert.deepEqual(linesOf(text, 'zz'), []);
  const dir = await repo({ 'app.py': 'def a():\n    return 1\n\n\ndef b():\n    return 2\n' });
  assert.deepEqual(await aboutToEdit('Edit', { file_path: 'app.py', old_string: 'return 2' }, dir), { path: path.join(dir, 'app.py'), lines: [[6, 6]] });
  assert.deepEqual(await aboutToEdit('MultiEdit', { file_path: path.join(dir, 'app.py'), edits: [{ old_string: 'def a' }, { old_string: 'def b' }] }, dir), {
    path: path.join(dir, 'app.py'),
    lines: [
      [1, 1],
      [5, 5],
    ],
  });
  assert.deepEqual(await aboutToEdit('Edit', { file_path: 'app.py', old_string: 'not there' }, dir), { path: path.join(dir, 'app.py') });
  assert.deepEqual(await aboutToEdit('Write', { file_path: 'new.py', content: 'x' }, dir), { path: path.join(dir, 'new.py') });
  assert.equal(await aboutToEdit('Bash', { command: 'rm -rf app.py' }, dir), null);
});

test("the hook's answer to an edit inside a fence is Claude Code's own decision; outside, it says nothing", () => {
  assert.equal(fenceAnswer(null), undefined);
  assert.equal(fenceAnswer({ decision: 'allow' }), undefined);
  assert.deepEqual(JSON.parse(fenceAnswer({ decision: 'deny', reason: 'off limits' })!), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'off limits' } });
  assert.equal(JSON.parse(fenceAnswer({ decision: 'ask', reason: 'ask first' })!).hookSpecificOutput.permissionDecision, 'ask');
  // Setup asks before every edit tool, and only those.
  assert.deepEqual(hooksBlock('node /x/fiada-hook.mjs').PreToolUse, [{ matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: 'node /x/fiada-hook.mjs', timeout: 10 }] }]);
});

test('the hook asks Fiada before an edit lands, as Claude Code runs it, and stays out of the way when Fiada is down', async () => {
  const dir = await repo({ 'core/config.py': 'SECRET = 1\n', 'main.py': 'print(1)\n' });
  const asked: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/api/agent/check') return res.end('{"files":[]}');
      const check = JSON.parse(body);
      asked.push(check);
      const p: string = check.files[0].path;
      res.end(JSON.stringify(p.includes('/core/') ? { decision: 'deny', reason: 'core is off limits' } : p.endsWith('main.py') ? { decision: 'ask', reason: 'main.py: ask first' } : { decision: 'allow' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const edit = (file: string, extra: object = {}) => ({ session_id: 'fence-test', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, file), old_string: 'SECRET', new_string: 'KEY', ...extra } });
  try {
    const deny = JSON.parse(await runHook(edit('core/config.py'), { FIADA_URL: url }));
    assert.deepEqual(deny, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'core is off limits' } });
    assert.equal(asked[0].agent.session, 'fence-test');
    assert.equal(asked[0].agent.root, dir);
    assert.equal(asked[0].tool, 'Edit');
    assert.deepEqual(asked[0].files, [{ path: path.join(dir, 'core/config.py'), lines: [[1, 1]] }]);
    assert.equal(JSON.parse(await runHook(edit('main.py'), { FIADA_URL: url })).hookSpecificOutput.permissionDecision, 'ask');
    // Allowed: nothing printed, so the person's own permission settings decide.
    assert.equal(await runHook(edit('other.py'), { FIADA_URL: url }), '');
    // Not an edit tool: not asked.
    const before = asked.length;
    assert.equal(await runHook({ ...edit('main.py'), tool_name: 'Read' }, { FIADA_URL: url }), '');
    assert.equal(asked.length, before);
  } finally {
    server.close();
  }
  // Nobody listening: the edit goes ahead as if there were no fences.
  assert.equal(await runHook(edit('core/config.py'), { FIADA_URL: 'http://127.0.0.1:9' }), '');
});
