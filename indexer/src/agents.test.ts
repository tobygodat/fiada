import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ActivityState, AgentRef } from '@fiada/shared';
import { AgentHub, remoteKey, sameProcess, statusLine, touches } from './agents.ts';
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

test('the status line is the newest of the agent\'s words, its active step and the prompt', () => {
  const steps = [
    { text: 'Read the routes', status: 'done' as const },
    { text: 'Add the field', activeText: 'Adding the field', status: 'active' as const },
  ];
  const said = { text: 'Adding created_at to Item.\nThen the migration.', at: 2000 };
  const prompt = { text: 'Add created_at', at: 500 };
  assert.deepEqual(statusLine(said, steps, 1000, prompt), { text: said.text, from: 'agent', at: new Date(2000).toISOString() });
  // Said with the step it started: its words win the tie.
  assert.equal(statusLine(said, steps, 2000, prompt)?.from, 'agent');
  // The plan moved to another step after the agent last said anything.
  assert.deepEqual(statusLine(said, steps, 3000, prompt), { text: 'Adding the field', from: 'plan', at: new Date(3000).toISOString() });
  // No active step: the agent's words stand however old.
  assert.equal(statusLine(said, [{ text: 'x', status: 'done' }], 3000, prompt)?.from, 'agent');
  // A step left active from an earlier turn is older than the new prompt.
  assert.deepEqual(statusLine(undefined, steps, 100, prompt), { text: 'Add created_at', from: 'prompt', at: new Date(500).toISOString() });
  assert.equal(statusLine(undefined, [], 0, undefined), undefined);
});

test('an agent\'s status line follows what it says, its plan and each new prompt', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 12, 0, s)).toISOString();
  const now = () => hub.state().agents[0].now;

  await hub.ingest([{ agent, type: 'prompt', text: 'Add item search', at: at(0) }]);
  assert.deepEqual(now(), { text: 'Add item search', from: 'prompt', at: at(0) });
  // A plan from the todo list: its active step, until the agent says something itself.
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', activeText: 'Adding searchItems', status: 'active' }, { text: 'Test it', status: 'pending' }], at: at(1) }]);
  assert.deepEqual(now(), { text: 'Adding searchItems', from: 'plan', at: at(1) });
  await hub.ingest([{ agent, type: 'status', text: 'Reading src/api.ts to see how listItems builds its URL.', at: at(2) }]);
  assert.deepEqual(now(), { text: 'Reading src/api.ts to see how listItems builds its URL.', from: 'agent', at: at(2) });
  // Ticking the same step again leaves the agent's line; moving to the next step replaces it.
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', activeText: 'Adding searchItems', status: 'active' }, { text: 'Test it', status: 'pending' }], at: at(3) }]);
  assert.equal(now()?.from, 'agent');
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', status: 'done' }, { text: 'Test it', status: 'active' }], at: at(4) }]);
  assert.deepEqual(now(), { text: 'Test it', from: 'plan', at: at(4) });
  await hub.ingest([{ agent, type: 'status', text: 'Running the tests.', at: at(5) }, { agent, type: 'state', state: 'waiting', at: at(6) }]);
  assert.equal(now()?.text, 'Running the tests.');
  // A new prompt: last turn's line is dropped.
  await hub.ingest([{ agent, type: 'prompt', text: 'Now add paging', at: at(7) }]);
  assert.deepEqual(now(), { text: 'Now add paging', from: 'prompt', at: at(7) });
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add a page parameter', status: 'active' }], at: at(8) }]);
  assert.deepEqual(now(), { text: 'Add a page parameter', from: 'plan', at: at(8) });
});

test('line ranges touch a symbol; pure removals only inside it', () => {
  assert.ok(touches([5, 10], [[10, 12]]));
  assert.ok(!touches([5, 10], [[11, 12]]));
  assert.ok(touches([5, 10], [[8, 7]]));
  assert.ok(!touches([5, 10], [[5, 4]]));
});

test('each function keeps its own change time: editing another one in its file does not move it', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const SEARCH = `\nexport function searchItems(q: string) {\n  return fetch('/api/items?q=' + q);\n}\n`;
  // The changed lines on each side, as the hook reports them.
  const edit = async (text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const diff = git(dir, 'diff', '--', 'src/api.ts');
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff, lines, oldLines }] }]);
    // Looked at before the file is re-indexed, as the map does while it waits.
    hub.state();
    await pushed;
    const f = hub.state().agents[0].files[0];
    return { file: f.at, ...Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) } as Record<string, string>;
  };

  const one = await edit(API + SEARCH, [[8, 11]], [[8, 7]]);
  assert.equal(one.searchItems, one.file);
  assert.equal(one.getItem, undefined);
  // getItem changes next: searchItems, added before, keeps its time.
  const getItem = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  const two = await edit(getItem + SEARCH, [[6, 6], [8, 11]], [[6, 6], [8, 7]]);
  assert.equal(two.getItem, two.file);
  assert.equal(two.searchItems, one.searchItems, 'searchItems keeps the time it was added');
  assert.notEqual(two.file, one.file);
  // listItems changes: one hunk now covers it and getItem, but getItem's own text is as it was.
  const three = await edit(getItem.replace("'/api/items')", "'/api/items?all=1')") + SEARCH, [[2, 2], [6, 6], [8, 11]], [[2, 2], [6, 6], [8, 7]]);
  assert.equal(three.listItems, three.file);
  assert.equal(three.getItem, two.getItem, 'getItem keeps the time it was changed');
  assert.equal(three.searchItems, one.searchItems);
  assert.equal(hub.state().nodes['web/src/api.ts#getItem'].at, Date.parse(two.getItem));
});

test("the file's code outside its functions has its own change time, and a re-index overtaken by a newer change settles nothing", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  // Holds a re-index after the graph is rebuilt and before the text is read back, when set.
  let hold: Promise<void> | null = null;
  const update = ws.updateFiles.bind(ws);
  ws.updateFiles = async (...a: Parameters<Workspace['updateFiles']>) => {
    const h = hold;
    await update(...a);
    if (h) await h;
  };
  const times = () => {
    const f = hub.state().agents[0].files[0];
    return { file: f.at, top: f.topAt, ...Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) } as Record<string, string>;
  };
  const report = async (text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
  };
  const settle = async (report: () => Promise<void>) => {
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await report();
    await pushed;
    return times();
  };

  const getItem = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  const a = await settle(() => report(getItem, [[6, 6]], [[6, 6]]));
  assert.equal(a.getItem, a.file);
  assert.equal(a.top, a.file, 'from the first change');

  // listItems changes, and its re-index is held until a newer change (an import on top, which moves every line) is in.
  const both = getItem.replace("'/api/items')", "'/api/items?all=1')");
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  await report(both, [[2, 2], [6, 6]], [[2, 2], [6, 6]]);
  await new Promise((r) => setTimeout(r, 600));
  hold = null;
  const c = await settle(async () => {
    await report(`import { z } from './z';\n${both}`, [[1, 1], [3, 3], [7, 7]], [[1, 0], [2, 2], [6, 6]]);
    release();
  });
  await new Promise((r) => setTimeout(r, 600));
  const after = times();
  assert.equal(after.getItem, a.getItem, 'getItem’s own text never changed after the first edit');
  assert.equal(after.listItems, c.file, 'listItems was first seen while held, so the import that came before its first re-index counts for it too');
  assert.equal(after.top, after.file, 'the import moved the file’s other code on');
  assert.notEqual(after.top, a.top);
});

test('a function changed twice before its file is first re-indexed takes the later change', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  let hold: Promise<void> | null = null;
  const update = ws.updateFiles.bind(ws);
  ws.updateFiles = async (...a: Parameters<Workspace['updateFiles']>) => {
    const h = hold;
    await update(...a);
    if (h) await h;
  };
  const report = async (text: string) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines: [[6, 6]], oldLines: [[6, 6]] }] }]);
    hub.state();
  };
  // The first edit's re-index is held; a second edit to the same function comes in meanwhile.
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  await report(API.replace("'/api/items/' + id", '`/api/items/${id}`'));
  await new Promise((r) => setTimeout(r, 600));
  hold = null;
  const v = hub.state().graphVersion;
  const pushed = nextPush(hub, (s) => s.graphVersion > v);
  await report(API.replace("'/api/items/' + id", "'/api/items/' + encodeURIComponent(id)"));
  release();
  await pushed;
  const f = hub.state().agents[0].files[0];
  assert.equal(f.symbols.find((s) => s.name === 'getItem')?.at, f.at, 'the second edit is new to read too');
});

test('only source files the indexer reads are kept as text, never a large artifact', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  await fs.writeFile(path.join(dir, 'src/api.ts'), API.replace("'/api/items')", "'/api/items?all=1')"));
  await fs.writeFile(path.join(dir, 'src/big.ts'), '// generated\n'.repeat(40_000));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'todo\n');
  const pushed = nextPush(hub, (s) => s.graphVersion > 1);
  await hub.ingest([{ agent, type: 'changes', files: ['src/api.ts', 'src/big.ts', 'notes.txt'].map((p) => ({ path: path.join(dir, p), kind: 'modified' as const })) }]);
  await pushed;
  const recs = (hub as unknown as { agents: Map<string, { files: Map<string, { rel?: string; text: string[] | null }> }> }).agents;
  const text = Object.fromEntries([...[...recs.values()][0].files.values()].map((f) => [f.rel, f.text != null]));
  assert.deepEqual(text, { 'src/api.ts': true, 'src/big.ts': false, 'notes.txt': false });
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
