import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent } from '@strata/shared';
import { ancestors, startedAt } from './client.ts';
import { checkout, kindOf, merge, parseDiff, parseStatus, real } from './git.ts';
import { sweep } from './hook.ts';
import { clientId, StrataMcp } from './mcp.ts';
import { hooksBlock, mergeHooks } from './setup.ts';
import { changedSince, compare, take } from './snapshot.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function repo(files: Record<string, string>) {
  const dir = await real(await fs.mkdtemp(path.join(os.tmpdir(), 'strata-agent-')));
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
  const since = Date.now() - 5;
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
  process.env.STRATA_CWD = dir;
  const fresh = new StrataMcp((m) => out.push(m), post);
  delete process.env.STRATA_CWD;
  const outer = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';

  await fresh.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } });
  assert.equal(out[0].result.protocolVersion, '2025-03-26');
  assert.ok(out[0].result.capabilities.tools);
  await fresh.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(out[1].result.tools.map((t: any) => t.name), ['report_task', 'flag_changes']);

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
  const once = mergeHooks(settings, hooksBlock('node /x/strata-hook.mjs'));
  const twice = mergeHooks(once, hooksBlock('node /y/strata-hook.mjs'));
  assert.equal(twice.model, 'x');
  assert.equal(twice.hooks.PostToolUse.length, 2);
  assert.deepEqual(twice.hooks.PostToolUse[0].hooks, [mine]);
  assert.equal(twice.hooks.PostToolUse[1].hooks[0].command, 'node /y/strata-hook.mjs');
  assert.equal(twice.hooks.Stop.length, 1);
});
