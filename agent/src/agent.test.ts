import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, DependentsAnswer, FindAnswer, ImpactAnswer, NodeRef } from '@fiada/shared';
import { ancestors, startedAt } from './client.ts';
import { checkout, kindOf, merge, parseDiff, parseStatus, real } from './git.ts';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { aboutToEdit, fenceAnswer, placed, firstLine, linesOf, STATUS_BRIEF, STATUS_NUDGE, sweep } from './hook.ts';
import { ask } from './client.ts';
import { clientId, formatImpact, nowLines, FiadaMcp } from './mcp.ts';
import { applyConfig, configPath } from './env.ts';
import { commandsFor, EDIT_MATCHER, flag, hooksBlock, MATCHER, mergeHooks, nextConfig } from './setup.ts';
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
  assert.deepEqual(out[1].result.tools.map((t: any) => t.name), ['status', 'flag_changes', 'where_is', 'who_uses', 'impact']);
  // The questions only read.
  for (const t of out[1].result.tools.slice(2)) assert.equal(t.annotations.readOnlyHint, true);
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
  const src = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';
  const dir = await repo({ 'app.py': src });
  // The digest of the text the lines were counted in, so the indexer can tell if it changed since.
  const sha256 = createHash('sha256').update(src).digest('hex');
  assert.deepEqual(await aboutToEdit('Edit', { file_path: 'app.py', old_string: 'return 2' }, dir), { path: path.join(dir, 'app.py'), lines: [[6, 6]], sha256 });
  assert.deepEqual(await aboutToEdit('MultiEdit', { file_path: path.join(dir, 'app.py'), edits: [{ old_string: 'def a' }, { old_string: 'def b' }] }, dir), {
    path: path.join(dir, 'app.py'),
    lines: [
      [1, 1],
      [5, 5],
    ],
    sha256,
  });
  assert.deepEqual(await aboutToEdit('Edit', { file_path: 'app.py', old_string: 'not there' }, dir), { path: path.join(dir, 'app.py') });
  assert.deepEqual(await aboutToEdit('Write', { file_path: 'new.py', content: 'x' }, dir), { path: path.join(dir, 'new.py') });
  assert.equal(await aboutToEdit('Bash', { command: 'rm -rf app.py' }, dir), null);
});

test("a file in another checkout than the agent's says which, even one not written yet", async () => {
  const own = await repo({ 'a.py': 'x\n' });
  const other = await repo({ 'lib/b.py': 'y\n' });
  git(other, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
  const co = await checkout(own);
  assert.deepEqual(await placed({ path: path.join(own, 'a.py') }, co), { path: path.join(own, 'a.py'), rel: 'a.py' });
  const theirs = { root: other, remote: 'https://github.com/acme/other.git' };
  assert.deepEqual(await placed({ path: path.join(other, 'lib/b.py'), lines: [[1, 1]] }, co), { path: path.join(other, 'lib/b.py'), rel: 'lib/b.py', lines: [[1, 1]], checkout: theirs });
  assert.deepEqual(await placed({ path: path.join(other, 'new/deep/c.py') }, co), { path: path.join(other, 'new/deep/c.py'), rel: 'new/deep/c.py', checkout: theirs });
  // A link is placed where it leads, lines and all, in this checkout or another.
  await fs.symlink(path.join(own, 'a.py'), path.join(own, 'alias.py'));
  assert.deepEqual(await placed({ path: path.join(own, 'alias.py'), lines: [[1, 1]] }, co), { path: path.join(own, 'a.py'), rel: 'a.py', lines: [[1, 1]] });
  await fs.symlink(path.join(other, 'lib/b.py'), path.join(own, 'b-link.py'));
  assert.deepEqual(await placed({ path: path.join(own, 'b-link.py') }, co), { path: path.join(other, 'lib/b.py'), rel: 'lib/b.py', checkout: theirs });
  // A checkout inside the agent's own (a submodule) is its own repository.
  const nested = path.join(own, 'vendor/sdk');
  await fs.mkdir(nested, { recursive: true });
  git(nested, 'init', '-q');
  git(nested, 'remote', 'add', 'origin', 'https://github.com/acme/sdk.git');
  assert.deepEqual(await placed({ path: path.join(nested, 'client.py') }, co), { path: path.join(nested, 'client.py'), rel: 'client.py', checkout: { root: nested, remote: 'https://github.com/acme/sdk.git' } });
  // A link to a file not written yet is placed where the write would land.
  await fs.symlink(path.join(other, 'lib/new.py'), path.join(own, 'dangling.py'));
  assert.deepEqual(await placed({ path: path.join(own, 'dangling.py') }, co), { path: path.join(other, 'lib/new.py'), rel: 'lib/new.py', checkout: theirs });
  // Outside any checkout: nothing to say.
  const loose = await real(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-loose-')));
  assert.deepEqual(await placed({ path: path.join(loose, 'd.py') }, co), { path: path.join(loose, 'd.py') });
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
    assert.deepEqual(asked[0].files, [{ path: path.join(dir, 'core/config.py'), rel: 'core/config.py', lines: [[1, 1]], sha256: createHash('sha256').update('SECRET = 1\n').digest('hex') }]);
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

const item: NodeRef = { id: 'api/app/models.py#Item', kind: 'symbol', name: 'Item', repo: 'api', path: 'app/models.py', symbolKind: 'class', lines: [87, 93], layer: 'Data', domain: 'Items' };
const route: NodeRef = { id: 'api/app/routes/items.py#create_item', kind: 'symbol', name: 'create_item', repo: 'api', path: 'app/routes/items.py', symbolKind: 'function', lines: [61, 72], layer: 'API', domain: 'Items', routes: ['POST /api/v1/items/'] };
const client: NodeRef = { id: 'web/src/sdk.ts#ItemsService', kind: 'symbol', name: 'ItemsService', repo: 'web', path: 'src/sdk.ts', symbolKind: 'class', lines: [287, 365], layer: 'Client', domain: 'Items' };

test('the read tools ask the map, answer in plain lines, and report what the agent looked at', async () => {
  const dir = await repo({ 'app/models.py': 'class Item:\n    pass\n' });
  const sent: AgentEvent[][] = [];
  const asked: [string, Record<string, unknown>][] = [];
  const answers: Record<string, any> = {
    find: { ok: true, body: { query: 'item', hits: [{ ...item, summary: 'The item table.' }, route], more: 4 } satisfies FindAnswer },
    dependents: {
      ok: true,
      body: {
        target: route,
        dependents: [{ ...client, crossRepo: true, links: [{ kind: 'http', to: route.id, basis: 'evidenced', evidence: [{ file: 'web/src/sdk.ts', line: 308, code: 'return client.post({' }] }] }],
        more: 0,
      } satisfies DependentsAnswer,
    },
    impact: {
      ok: true,
      body: {
        target: item,
        depth: 2,
        reached: [
          { ...route, depth: 1, via: item.id, link: 'calls', crossRepo: false },
          { ...client, depth: 2, via: route.id, link: 'http', crossRepo: true },
        ],
        more: 0,
        byRepo: { api: 1, web: 1 },
        byLayer: { API: 1, Client: 1 },
        byDomain: { Items: 2 },
      } satisfies ImpactAnswer,
    },
  };
  const asker = (async (r: string, params: Record<string, unknown>) => {
    asked.push([r, params]);
    return answers[r];
  }) as typeof ask;
  process.env.FIADA_CWD = dir;
  const mcp = new FiadaMcp(() => undefined, async (events) => (sent.push(events), { files: [] }), asker);
  delete process.env.FIADA_CWD;
  const call = async (name: string, args: Record<string, unknown>) => (await mcp.call(name, args)) as { content: { text: string }[]; isError?: boolean };

  const where = await call('where_is', { query: 'item', limit: 2 });
  assert.deepEqual(asked[0], ['find', { q: 'item', limit: 2 }]);
  const text = where.content[0].text;
  assert.match(text, /^2 of 6 matches for "item", best first:/);
  assert.match(text, /1\. Item \(class\) in api\/app\/models\.py:87-93\n   Data layer, Items domain\n   The item table\.\n   id: api\/app\/models\.py#Item/);
  assert.match(text, /serves POST \/api\/v1\/items\//);
  // What it was shown is what it looked at.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[0], [{ agent: sent[0][0].agent, type: 'looked', nodes: [item.id, route.id] }]);

  // An absolute path in its own checkout goes to the map relative to the repository.
  const users = await call('who_uses', { target: path.join(dir, 'app/routes/items.py#create_item') });
  assert.deepEqual(asked[1], ['dependents', { node: 'app/routes/items.py#create_item', limit: undefined, depth: undefined }]);
  assert.match(users.content[0].text, /^1 place uses create_item \(function in api\/app\/routes\/items\.py:61-72\):/);
  assert.match(users.content[0].text, /- ItemsService \(class\) in web\/src\/sdk\.ts:287-365, another repository\n  http, proven\n    web\/src\/sdk\.ts:308  return client\.post\(\{/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((sent[1][0] as { nodes: string[] }).nodes, [route.id]);

  const reach = await call('impact', { target: item.id, depth: 2 });
  assert.deepEqual(asked[2], ['impact', { node: item.id, limit: undefined, depth: 2 }]);
  assert.match(reach.content[0].text, /^An edit to Item \(class in api\/app\/models\.py:87-93\) reaches 2 places within 2 links, in 2 repositories\./);
  assert.match(reach.content[0].text, /Uses it directly:\n- create_item \(function\) in api\/app\/routes\/items\.py:61-72: calls\n2 links away:\n- ItemsService \(class\) in web\/src\/sdk\.ts:287-365: http, another repository/);

  // Several matches: pick one. None: a plain answer, not an error. No indexer: carry on.
  answers.dependents = { ok: true, body: { target: null, query: 'Item', candidates: [item, { ...item, id: 'web/src/Main.tsx#Item', repo: 'web', path: 'src/Main.tsx', symbolKind: 'type' }] } };
  assert.match((await call('who_uses', { target: 'Item' })).content[0].text, /could be any of these; ask again with one of their ids:\n- api\/app\/models\.py#Item/);
  answers.impact = { ok: false, status: 404, error: 'Nothing on the map matches "x".' };
  const none = await call('impact', { target: 'x' });
  assert.equal(none.isError, undefined);
  answers.find = { ok: false, status: 0, error: "Fiada isn't reachable at http://127.0.0.1:9." };
  assert.equal((await call('where_is', { query: 'x' })).isError, undefined);
  assert.equal((await call('where_is', {})).isError, true);
  assert.equal((await call('impact', {})).isError, true);
  // Questions that found nothing to look at report nothing.
  assert.equal(sent.length, 3);
});

test('an edit that reaches nothing says so, and a long answer says how many more', () => {
  const empty: ImpactAnswer = { target: item, depth: 3, reached: [], more: 0, byRepo: {}, byLayer: {}, byDomain: {} };
  assert.match(formatImpact(empty), /^Nothing on the map uses Item/);
  const more = formatImpact({ ...empty, reached: [{ ...route, depth: 1, via: item.id, link: 'calls', crossRepo: false }], more: 7, byRepo: { api: 8 }, byLayer: { API: 8 }, byDomain: { Items: 8 } });
  assert.match(more, /reaches 8 places within 3 links\./);
  assert.match(more, /…and 7 more/);
});

test('the MCP server asks the indexer over HTTP with the agent token', async () => {
  const seen: { url: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') return req.resume().on('end', () => res.end('{"files":[]}'));
    res.end(JSON.stringify({ query: 'cart', hits: [{ id: 'shop/src/cart.ts#addToCart', kind: 'symbol', name: 'addToCart', repo: 'shop', path: 'src/cart.ts', lines: [1, 3] }], more: 0 }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bin = fileURLToPath(new URL('../bin/fiada-mcp.mjs', import.meta.url));
  try {
    const child = spawn(process.execPath, [bin], { env: { ...process.env, FIADA_URL: url, FIADA_TOKEN: 'fa_test', FIADA_CONFIG: '/nonexistent' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let outText = '';
    child.stdout.on('data', (c) => (outText += c));
    const rpc = (id: number, method: string, params?: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    rpc(2, 'tools/call', { name: 'where_is', arguments: { query: 'cart' } });
    for (let i = 0; i < 100 && !outText.includes('"id":2'); i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 40 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    const reply = outText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
    assert.match(reply.result.content[0].text, /addToCart \(symbol\) in shop\/src\/cart\.ts:1-3/);
    assert.equal(seen[0].url, '/api/agent/find?q=cart');
    assert.equal(seen[0].auth, 'Bearer fa_test');
    // Then it says what it looked at.
    assert.equal(seen[1].url, '/api/agent/events');
  } finally {
    server.close();
  }
});

test('the hook reports a file the agent read as looked at', async () => {
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
    await runHook({ session_id: 'read-test', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a.py' } }, { FIADA_URL: url });
    assert.deepEqual(got.map((e) => e.type), ['state', 'looked']);
    assert.deepEqual(got[1].paths, [path.join(dir, 'a.py')]);
  } finally {
    server.close();
  }
  // Claude Code only runs the hook for Read when setup asks it to.
  assert.ok(MATCHER.split('|').includes('Read'));
  assert.equal(hooksBlock('x').PostToolUse[0].matcher, MATCHER);
});
