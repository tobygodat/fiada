import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ActivityState, AgentRef } from '@fiada/shared';
import { AgentHub, remoteKey, sameProcess, touches } from './agents.ts';
import type { ProjectStore, SavedRepo } from './store.ts';
import { Workspace } from './workspace.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function memoryStore(saved: SavedRepo[]): ProjectStore {
  return {
    describe: () => 'memory',
    loadRepos: async () => saved,
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
  };
}

const API = `export function listItems() {
  return fetch('/api/items');
}

export function getItem(id: string) {
  return fetch('/api/items/' + id);
}
`;

async function localRepo(extra: Record<string, string> = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-agents-')));
  const files = { 'src/api.ts': API, 'src/old.ts': 'export function legacy() {\n  return 1;\n}\n', ...extra };
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  const ws = new Workspace(memoryStore([{ id: 'web', name: 'web', source: dir, kind: 'local' }]), 'default');
  await ws.init();
  for (let i = 0; i < 200 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));
  return { dir, ws };
}

/** The next state pushed after something changed the graph. */
const nextPush = (hub: AgentHub, until: (s: ActivityState) => boolean) =>
  new Promise<ActivityState>((resolve) => {
    const off = hub.subscribe((s) => {
      if (until(s)) {
        off();
        resolve(s);
      }
    });
  });

test('remote URLs compare however they are spelled', () => {
  assert.equal(remoteKey('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(remoteKey('https://github.com/org/repo'), 'github.com/org/repo');
  assert.equal(remoteKey('https://x-access-token:abc@github.com/org/repo.git/'), 'github.com/org/repo');
});

test('a reporter without a session joins the one sharing its nearest parent process', () => {
  const peer = (session: string, procs: number[]) => ({ ref: { client: 'claude-code', session, cwd: '/r', procs } });
  const a = peer('a', [101, 50, 1]);
  const b = peer('b', [202, 50, 1]);
  assert.equal(sameProcess([202, 50], [a, b]), b);
  // Both run under process 50: that says nothing about which one.
  assert.equal(sameProcess([303, 50], [a, b]), null);
  assert.equal(sameProcess(undefined, [a, b]), null);
});

test('line ranges touch a symbol; pure removals only inside it', () => {
  assert.ok(touches([5, 10], [[10, 12]]));
  assert.ok(!touches([5, 10], [[11, 12]]));
  assert.ok(touches([5, 10], [[8, 7]]));
  assert.ok(!touches([5, 10], [[5, 4]]));
});

test('an agent edit is mapped to its file and symbols, and the file re-indexed', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };

  await hub.ingest([
    { agent, type: 'prompt', text: 'Add item search' },
    { agent, type: 'task', steps: [{ text: 'Add searchItems', status: 'active' }, { text: 'Use it on the page', status: 'pending' }] },
  ]);

  // getItem changes and searchItems is added after it; old.ts is deleted.
  await fs.writeFile(
    path.join(dir, 'src/api.ts'),
    API.replace("'/api/items/' + id", '`/api/items/${id}`') + `\nexport function searchItems(q: string) {\n  return fetch('/api/items?q=' + q);\n}\n`,
  );
  await fs.rm(path.join(dir, 'src/old.ts'));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1 && !!s.nodes['web/src/api.ts#searchItems']);
  const reply = await hub.ingest([
    {
      agent,
      type: 'changes',
      files: [
        { path: path.join(dir, 'src/api.ts'), kind: 'modified', lines: [[6, 6], [9, 12]], oldLines: [[6, 6], [9, 8]], additions: 5, deletions: 1, diff: '@@ -6 +6 @@\n-x\n+y\n' },
        { path: 'src/old.ts', kind: 'deleted', oldLines: [[1, 3]], deletions: 3 },
        { path: '/somewhere/else.ts', kind: 'added' },
      ],
    },
  ]);
  assert.deepEqual(
    reply.files.map((f) => [f.path, f.repo, f.node]),
    [
      ['src/api.ts', 'web', 'web/src/api.ts'],
      ['src/old.ts', 'web', 'web/src/old.ts'],
      ['/somewhere/else.ts', undefined, undefined],
    ],
  );

  const s = await pushed;
  assert.equal(s.nodes['web/src/api.ts'].kind, 'modified');
  assert.equal(s.nodes['web/src/api.ts#getItem'].kind, 'modified');
  assert.equal(s.nodes['web/src/api.ts#searchItems'].kind, 'added');
  assert.equal(s.nodes['web/src/api.ts#listItems'], undefined);
  // The deleted file left the graph; its folder stands in for it on the map.
  assert.equal(s.nodes['web/src/old.ts'].kind, 'deleted');
  assert.equal(s.nodes['web/src/old.ts'].anchor, 'web/src');
  assert.equal(s.nodes['web/src/old.ts#legacy'].kind, 'deleted');
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/src/api.ts#searchItems'));
  assert.ok(!ws.getGraph().nodes.some((n) => n.id === 'web/src/old.ts'));

  const [a] = s.agents;
  assert.equal(a.name, 'Claude Code');
  assert.equal(a.where, 'web');
  assert.equal(a.prompt, 'Add item search');
  assert.deepEqual(a.steps.map((x) => x.status), ['active', 'pending']);
  assert.deepEqual(a.files.map((f) => f.path).sort(), ['/somewhere/else.ts', 'src/api.ts', 'src/old.ts']);
  assert.equal(hub.diffs('web/src/api.ts#getItem')[0].diff, '@@ -6 +6 @@\n-x\n+y\n');

  // Moving on to the next step finishes the one before; done finishes the plan.
  await hub.ingest([{ agent, type: 'task', step: 'Use it on the page' }]);
  assert.deepEqual(hub.state().agents[0].steps.map((x) => x.status), ['done', 'active']);
  await hub.ingest([{ agent, type: 'state', state: 'waiting' }, { agent, type: 'changes', files: [{ path: 'src/api.ts', kind: 'reverted' }] }]);
  assert.equal(hub.state().agents[0].state, 'waiting');
  assert.equal(hub.state().nodes['web/src/api.ts'], undefined);

  hub.clear();
  assert.deepEqual(hub.state().agents, []);
});

test('two sessions in one checkout are two agents, and a sweep does not claim the other one\'s edit', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const base = { client: 'claude-code', cwd: dir, root: dir };
  const s1: AgentRef = { ...base, session: 'aaaa1111', procs: [101, 50, 1] };
  const s2: AgentRef = { ...base, session: 'bbbb2222', procs: [202, 50, 1] };
  const mcp2: AgentRef = { ...base, procs: [202, 50] };
  const byId = () => Object.fromEntries(hub.state().agents.map((a) => [a.name, a]));

  await hub.ingest([
    { agent: s1, type: 'session', phase: 'start' },
    { agent: s2, type: 'session', phase: 'start' },
    { agent: s1, type: 'prompt', text: 'Add search' },
    { agent: s2, type: 'prompt', text: 'Fix login' },
    // Session 2's MCP server, told apart by the process it shares with session 2's hooks.
    { agent: mcp2, type: 'task', task: 'Fixing the login redirect' },
  ]);
  let a = byId();
  assert.deepEqual(Object.keys(a).sort(), ['Claude Code · aaaa', 'Claude Code · bbbb']);
  assert.equal(a['Claude Code · aaaa'].task, undefined);
  assert.equal(a['Claude Code · bbbb'].task, 'Fixing the login redirect');

  // Session 1 edits api.ts; session 2's next sweep sees it in the tree but it isn't session 2's.
  await fs.appendFile(path.join(dir, 'src/api.ts'), '// more\n');
  await fs.writeFile(path.join(dir, 'src/gen.ts'), 'export const g = 1;\n');
  await hub.ingest([{ agent: s1, type: 'changes', files: [{ path: 'src/api.ts', kind: 'modified' }] }]);
  const reply = await hub.ingest([
    {
      agent: s2,
      type: 'changes',
      files: [
        { path: 'src/api.ts', kind: 'modified', swept: true },
        { path: 'src/gen.ts', kind: 'added', swept: true },
      ],
    },
  ]);
  assert.deepEqual(reply.files.map((f) => f.kind), ['elsewhere', 'added']);
  a = byId();
  assert.deepEqual(a['Claude Code · aaaa'].files.map((f) => f.path), ['src/api.ts']);
  assert.deepEqual(a['Claude Code · bbbb'].files.map((f) => f.path), ['src/gen.ts']);

  // Session 1 then names gen.ts itself (it made it with a shell command): the sweep's claim gives way.
  await hub.ingest([{ agent: s1, type: 'changes', files: [{ path: 'src/gen.ts', kind: 'added' }] }]);
  a = byId();
  assert.deepEqual(a['Claude Code · aaaa'].files.map((f) => f.path).sort(), ['src/api.ts', 'src/gen.ts']);
  assert.deepEqual(a['Claude Code · bbbb'].files, []);

  // One session ending leaves the other working.
  await hub.ingest([{ agent: s1, type: 'session', phase: 'end' }, { agent: s2, type: 'state', state: 'working' }]);
  a = byId();
  assert.equal(a['Claude Code · aaaa'].state, 'ended');
  assert.equal(a['Claude Code · bbbb'].state, 'working');
  // With session 1 gone, an MCP server nobody can place joins the session still working.
  await hub.ingest([{ agent: { ...base, procs: [999] }, type: 'task', note: 'almost there' }]);
  assert.equal(byId()['Claude Code · bbbb'].note, 'almost there');
});

test('an MCP server that reports before its session\'s hooks is taken over by that session', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const base = { client: 'claude-code', cwd: dir, root: dir };
  await hub.ingest([{ agent: { ...base, procs: [303, 60] }, type: 'task', task: 'Early' }]);
  // A session under another parent doesn't take it; the one under 303 does.
  await hub.ingest([{ agent: { ...base, session: 'dddd', procs: [404, 60, 1] }, type: 'session', phase: 'start' }]);
  await hub.ingest([{ agent: { ...base, session: 'cccc', procs: [303, 60, 1] }, type: 'session', phase: 'start' }]);
  const agents = hub.state().agents;
  assert.equal(agents.length, 2);
  assert.equal(agents.find((x) => x.id.endsWith('#cccc'))?.task, 'Early');
  assert.equal(agents.find((x) => x.id.endsWith('#dddd'))?.task, undefined);
});

test('a deleted file stands on the collapsed folder that now covers its directory', async () => {
  // lib holds only lib/deep, so they are one node; once one.ts goes, lib/deep holds only lib/deep/x too.
  const { dir, ws } = await localRepo({ 'lib/deep/one.ts': 'export const one = 1;\n', 'lib/deep/x/two.ts': 'export const two = 2;\n' });
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/lib/deep'));
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  await fs.rm(path.join(dir, 'lib/deep/one.ts'));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1 && !!s.nodes['web/lib/deep/one.ts']);
  await hub.ingest([{ agent, type: 'changes', files: [{ path: 'lib/deep/one.ts', kind: 'deleted', oldLines: [[1, 1]], deletions: 1 }] }]);
  const s = await pushed;
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/lib/deep/x'));
  assert.equal(s.nodes['web/lib/deep/one.ts'].anchor, 'web/lib/deep/x');
  assert.equal(s.nodes['web/lib/deep/one.ts#one'].kind, 'deleted');
});
