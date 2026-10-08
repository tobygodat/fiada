import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActivityState, AgentRef, Fence, FenceVerdict, Graph, GraphNode } from '@fiada/shared';
import { AgentHub, collisions } from './agents.ts';
import { cleanFences, covers, Fences, verdict } from './fences.ts';
import { FileProjectStore, type ProjectStore, type SavedRepo } from './store.ts';
import { Workspace } from './workspace.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const node = (id: string, kind: GraphNode['kind'], parent: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind, name: id.split(/[/#]/).pop()!, parent, repo: 'api', ...extra });
const GRAPH = {
  nodes: [
    node('api', 'repo', 'root'),
    node('api/app', 'folder', 'api', { path: 'app' }),
    node('api/app/core', 'folder', 'api/app', { path: 'app/core' }),
    node('api/app/core/config.py', 'file', 'api/app/core', { path: 'app/core/config.py' }),
    node('api/app/routes', 'folder', 'api/app', { path: 'app/routes' }),
    node('api/app/routes/items.py', 'file', 'api/app/routes', { path: 'app/routes/items.py' }),
    node('api/app/routes/users.py', 'file', 'api/app/routes', { path: 'app/routes/users.py' }),
    node('api/app/routes/items.py#create_item', 'symbol', 'api/app/routes/items.py', { path: 'app/routes/items.py', lines: [10, 20] }),
    node('api/app/main.py', 'file', 'api/app', { path: 'app/main.py' }),
  ],
  edges: [],
} as unknown as Graph;

const fence = (n: string, rule: Fence['rule']): Fence => ({ node: n, rule, at: '2026-10-08T00:00:00.000Z' });
const file = (rel: string, lines?: [number, number][], symbols?: Record<string, [number, number]>) => ({ repo: 'api', rel, lines, symbols: symbols && new Map(Object.entries(symbols)) });
/** create_item where the edited file has it now. */
const at = (lines: [number, number]) => ({ 'api/app/routes/items.py#create_item': lines });

test('a fence covers its own circle and everything inside it, and a symbol only the lines it spans', () => {
  const nodes = new Map(GRAPH.nodes.map((n) => [n.id, n]));
  assert.ok(covers(fence('api', 'off'), file('app/main.py'), nodes));
  assert.ok(covers(fence('api/app/core', 'off'), file('app/core/config.py'), nodes));
  assert.ok(covers(fence('api/app/core/config.py', 'ask'), file('app/core/config.py'), nodes));
  // A sibling whose name starts the same is not inside.
  assert.ok(!covers(fence('api/app/core', 'off'), file('app/core_utils.py'), nodes));
  assert.ok(!covers(fence('api/app/routes', 'off'), file('app/main.py'), nodes));
  const sym = fence('api/app/routes/items.py#create_item', 'off');
  assert.ok(covers(sym, file('app/routes/items.py', [[15, 16]], at([10, 20])), nodes));
  assert.ok(!covers(sym, file('app/routes/items.py', [[30, 31]], at([10, 20])), nodes));
  // Lines are placed against the symbol where the edited file has it now, not where the graph last saw it.
  assert.ok(covers(sym, file('app/routes/items.py', [[30, 31]], at([28, 40])), nodes));
  assert.ok(!covers(sym, file('app/routes/items.py', [[15, 16]], at([28, 40])), nodes));
  // Lines that can't be placed in the file as it is now count for nothing: the whole file is covered.
  assert.ok(covers(sym, file('app/routes/items.py', [[30, 31]]), nodes));
  assert.ok(covers(sym, file('app/routes/items.py', [[30, 31]], {}), nodes));
  // Without lines the edit may rewrite the whole file, the symbol with it.
  assert.ok(covers(sym, file('app/routes/items.py'), nodes));
  assert.ok(!covers(sym, file('app/routes/users.py'), nodes));
});

test('off limits beats ask first, the nearest fence names the reason, and outside every fence is allowed', () => {
  const fences = [fence('api/app', 'ask'), fence('api/app/core', 'off'), fence('api/app/routes/items.py', 'ask')];
  const off = verdict(fences, [file('app/core/config.py')], GRAPH);
  assert.equal(off.decision, 'deny');
  assert.equal(off.fence?.node, 'api/app/core');
  assert.equal(off.file, 'api/app/core/config.py');
  assert.match(off.reason!, /api\/app\/core\/config\.py is inside api\/app\/core, which is off limits/);
  // The nearer ask-first fence names it.
  const ask = verdict(fences, [file('app/routes/items.py')], GRAPH);
  assert.deepEqual([ask.decision, ask.fence?.node], ['ask', 'api/app/routes/items.py']);
  assert.match(ask.reason!, /^api\/app\/routes\/items\.py is marked "ask first"/);
  // One file of a batch inside an off-limits fence refuses the batch.
  assert.equal(verdict(fences, [file('app/main.py'), file('app/core/config.py')], GRAPH).decision, 'deny');
  assert.deepEqual(verdict(fences, [{ repo: 'web', rel: 'src/app.ts' }], GRAPH), { decision: 'allow' });
  assert.deepEqual(verdict([], [file('app/main.py')], GRAPH), { decision: 'allow' });
  const sym = verdict([fence('api/app/routes/items.py#create_item', 'off')], [file('app/routes/items.py', [[12, 12]], at([10, 20]))], GRAPH);
  assert.match(sym.reason!, /^This edit reaches create_item in api\/app\/routes\/items\.py, which is off limits/);
});

test('fences read from a store keep only well-formed ones, one per node', () => {
  assert.deepEqual(cleanFences(null), []);
  assert.deepEqual(
    cleanFences([{ node: 'a', rule: 'ask', at: 't' }, { node: 'a', rule: 'off', at: 't2' }, { node: 'b', rule: 'maybe' }, { rule: 'off' }, 'x']),
    [{ node: 'a', rule: 'off', at: 't2' }],
  );
});

test('fences are kept per project in the file store, changed one node at a time, and deleted with the project', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-fences-'));
  const store = new FileProjectStore(home);
  const fences = new Fences(store, 'p1', () => new Date('2026-10-08T12:00:00Z'));
  await fences.init();
  assert.deepEqual(fences.all(), []);
  await fences.set('api/app/core', 'off', GRAPH);
  await fences.set('api/app/routes', 'ask', GRAPH);
  await fences.set('api/app/routes', 'off', GRAPH);
  assert.deepEqual(await store.loadFences('p1'), [
    { node: 'api/app/core', rule: 'off', at: '2026-10-08T12:00:00.000Z' },
    { node: 'api/app/routes', rule: 'off', at: '2026-10-08T12:00:00.000Z' },
  ]);
  // Another project sees none of them; a new instance reads them back.
  assert.equal(await store.loadFences('p2'), null);
  const again = new Fences(store, 'p1');
  await again.init();
  assert.equal(again.all().length, 2);
  await again.set('api/app/core', null, GRAPH);
  assert.deepEqual((await store.loadFences('p1'))?.map((f) => f.node), ['api/app/routes']);
  // Only nodes on the map, and only the two rules.
  await assert.rejects(again.set('api/nowhere', 'off', GRAPH), /not on the map/);
  await assert.rejects(again.set('api/app', 'sometimes', GRAPH), /"ask", "off" or null/);
  await assert.rejects(again.set(42, 'off', GRAPH), /Body must be/);
  // Taking one down works for a node that has left the map.
  await again.set('api/gone', null, GRAPH);
  await store.deleteProject('p1');
  assert.equal(await store.loadFences('p1'), null);
});

test('a failed save leaves the fences as they were', async () => {
  let fail = false;
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => [],
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
    loadFences: async () => [fence('api/app', 'ask')],
    saveFences: async () => {
      if (fail) throw new Error('saved by another indexer');
    },
  };
  const fences = new Fences(store, 'p');
  await fences.init();
  fail = true;
  await assert.rejects(fences.set('api/app/core', 'off', GRAPH), /another indexer/);
  assert.deepEqual(fences.all().map((f) => f.node), ['api/app']);
});

test('closing waits for saves under way and takes no more, so a deleted project stays deleted', async () => {
  const saved: string[][] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => [],
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
    saveFences: async (_id, list) => {
      await slow;
      saved.push(list.map((f) => f.node));
    },
  };
  const fences = new Fences(store, 'p');
  await fences.init();
  const putting = fences.set('api/app/core', 'off', GRAPH);
  let closed = false;
  const closing = fences.close().then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, false);
  release();
  await Promise.all([putting, closing]);
  assert.deepEqual(saved, [['api/app/core']]);
  await assert.rejects(fences.set('api/app', 'ask', GRAPH), /closed/);
  assert.deepEqual(saved, [['api/app/core']]);
});

test('collisions: the deepest file or folder two agents share, never a whole repository', () => {
  const nodes = new Map(GRAPH.nodes.map((n) => [n.id, n]));
  const agent = (id: string, ...files: string[]) => ({ id, files: files.map((f) => ({ node: f, path: f, kind: 'modified' as const, symbols: [], at: '', diff: false })) });
  // Two files in one folder: they meet in the folder, said once (not again for api/app).
  assert.deepEqual(collisions([agent('a', 'api/app/routes/items.py'), agent('b', 'api/app/routes/users.py')], nodes), [
    { node: 'api/app/routes', unit: 'folder', agents: ['a', 'b'], files: { a: ['api/app/routes/items.py'], b: ['api/app/routes/users.py'] } },
  ]);
  // The same file.
  assert.deepEqual(collisions([agent('a', 'api/app/main.py'), agent('b', 'api/app/main.py')], nodes).map((c) => [c.node, c.unit]), [['api/app/main.py', 'file']]);
  // Only the repository in common is no collision; one agent alone is none.
  assert.deepEqual(collisions([agent('a', 'api/app/main.py'), agent('b')], nodes), []);
  // A third agent further up makes a second, wider meeting place.
  const three = collisions([agent('a', 'api/app/routes/items.py'), agent('b', 'api/app/routes/users.py'), agent('c', 'api/app/core/config.py')], nodes);
  assert.deepEqual(three.map((c) => [c.node, c.agents.length]), [['api/app/routes', 2], ['api/app', 3]]);
});

async function localRepo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-fenced-')));
  const files = {
    'app/core/config.py': 'SECRET = "x"\n',
    'app/routes/items.py': 'def list_items():\n    return []\n\n\ndef create_item(item):\n    return item\n',
    'app/routes/users.py': 'def list_users():\n    return []\n',
  };
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('an agent asking before an edit gets the verdict, and an edit stopped at a fence shows on its entry until its next prompt', async () => {
  const dir = await localRepo();
  const saved: SavedRepo[] = [{ id: 'api', name: 'api', source: dir, kind: 'local' }];
  const store: ProjectStore = { describe: () => 'memory', loadRepos: async () => saved, saveRepos: async () => {}, loadGrouping: async () => null, saveGrouping: async () => {} };
  const ws = new Workspace(store, 'default');
  await ws.init();
  for (let i = 0; i < 200 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));
  const fences = new Fences(store, 'default');
  await fences.set('api/app/core', 'off', ws.getGraph());
  await fences.set('api/app/routes/items.py#create_item', 'ask', ws.getGraph());
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's1', cwd: dir, root: dir };

  // Absolute paths, as the hook sends them.
  const deny = await hub.check({ agent, tool: 'Edit', files: [{ path: path.join(dir, 'app/core/config.py') }] }, fences);
  assert.deepEqual([deny.decision, deny.fence?.node, deny.file], ['deny', 'api/app/core', 'api/app/core/config.py']);
  // Lines that miss create_item go ahead; lines in it ask.
  assert.equal((await hub.check({ agent, files: [{ path: path.join(dir, 'app/routes/items.py'), lines: [[1, 2]] }] }, fences)).decision, 'allow');
  assert.equal((await hub.check({ agent, files: [{ path: path.join(dir, 'app/routes/items.py'), lines: [[5, 6]] }] }, fences)).decision, 'ask');
  // Outside every imported repository: nothing to fence.
  assert.equal((await hub.check({ agent, files: [{ path: '/etc/hosts' }] }, fences)).decision, 'allow');

  // Another checkout of the repository, where create_item has moved down. Its lines can't be
  // placed against the copy Fiada read, so the edit counts as the whole file and the fence holds.
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-checkout-')));
  const clone = path.join(elsewhere, 'api');
  execFileSync('git', ['clone', '-q', dir, clone]);
  await fs.writeFile(path.join(clone, 'app/routes/items.py'), '# moved\n'.repeat(8) + 'def list_items():\n    return []\n\n\ndef create_item(item):\n    return item\n');
  const away: AgentRef = { client: 'claude-code', session: 's3', cwd: clone, root: clone };
  // Lines 13-14 are create_item in this checkout, and miss it in the copy Fiada indexed.
  const moved = await hub.check({ agent: away, files: [{ path: path.join(clone, 'app/routes/items.py'), lines: [[13, 14]] }] }, fences);
  assert.deepEqual([moved.decision, moved.fence?.node], ['ask', 'api/app/routes/items.py#create_item']);
  assert.equal((await hub.check({ agent: away, files: [{ path: path.join(clone, 'app/core/config.py') }] }, fences)).decision, 'deny');
  // An agent working elsewhere edits a file in that checkout: the file says which checkout it's in.
  const web = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-web-')));
  const neighbour: AgentRef = { client: 'claude-code', session: 's5', cwd: web, root: web, remote: 'https://github.com/acme/web.git' };
  const target = { path: path.join(clone, 'app/core/config.py') };
  assert.equal((await hub.check({ agent: neighbour, files: [target] }, fences)).decision, 'allow');
  assert.equal((await hub.check({ agent: neighbour, files: [{ ...target, checkout: { root: clone } }] }, fences)).decision, 'deny');
  // A checkout of some other repository that happens to share the folder name is not fenced.
  const stranger: AgentRef = { ...away, session: 's4', remote: 'https://github.com/someone/else.git' };
  assert.equal((await hub.check({ agent: stranger, files: [{ path: path.join(clone, 'app/core/config.py') }] }, fences)).decision, 'allow');

  const s = hub.state();
  const mine = s.agents.find((a) => a.cwd === dir)!.id;
  assert.deepEqual(s.fenced[mine], { node: 'api/app/routes/items.py#create_item', rule: 'ask', decision: 'ask', file: 'api/app/routes/items.py', at: s.fenced[mine].at });
  await hub.ingest([{ agent, type: 'prompt', text: 'Try something else' }]);
  assert.equal(hub.state().fenced[mine], undefined);

  // Two sessions changing files in one folder meet there.
  const other: AgentRef = { ...agent, session: 's2' };
  await hub.ingest([
    { agent, type: 'changes', files: [{ path: 'app/routes/items.py', kind: 'modified' }] },
    { agent: other, type: 'changes', files: [{ path: 'app/routes/users.py', kind: 'modified' }] },
  ]);
  const met: ActivityState['collisions'] = hub.state().collisions;
  assert.deepEqual(met.map((c) => [c.node, c.unit, c.agents.length]), [['api/app/routes', 'folder', 2]]);
  hub.close();
  ws.close();
});

/** A free port on localhost. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });

test('the fence routes: set and list fences, and an agent checks an edit over HTTP', { timeout: 60_000 }, async () => {
  const dir = await localRepo();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-fence-routes-'));
  const port = await freePort();
  const blank = ['MONGODB_URI', 'FIADA_GITHUB_CLIENT_ID', 'STRATA_GITHUB_CLIENT_ID', 'FIADA_API_KEY', 'STRATA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), FIADA_HOME: home, STRATA_HOME: home, FIADA_PROJECT: 'routes', STRATA_PROJECT: 'routes', HOST: '127.0.0.1', PORT: String(port) };
  const server = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  const url = `http://127.0.0.1:${port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${url}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    for (let i = 0; i < 200 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(log, /listening/);
    const added = await call('POST', '/api/repos', { source: dir });
    assert.equal(added.status, 202);
    const id: string = added.body.repos[0].id;
    for (let i = 0; i < 200 && (await call('GET', '/api/workspace')).body.busy; i++) await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual((await call('GET', '/api/fences')).body, { fences: [] });
    const put = await call('PUT', '/api/fences', { node: `${id}/app/core`, rule: 'off' });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.fences.map((f: Fence) => [f.node, f.rule]), [[`${id}/app/core`, 'off']]);
    assert.equal((await call('PUT', '/api/fences', { node: `${id}/nowhere`, rule: 'off' })).status, 400);
    assert.equal((await call('PUT', '/api/fences', { node: `${id}/app/core`, rule: 'never' })).status, 400);
    // Kept for the project, on disk.
    const kept = JSON.parse(await fs.readFile(path.join(home, 'projects', 'routes', 'fences.json'), 'utf8'));
    assert.equal(kept.fences[0].node, `${id}/app/core`);

    const agent: AgentRef = { client: 'claude-code', session: 'route', cwd: dir, root: dir };
    const deny = await call('POST', '/api/agent/check', { agent, tool: 'Write', files: [{ path: path.join(dir, 'app/core/config.py') }] });
    assert.equal(deny.status, 200);
    assert.equal((deny.body as FenceVerdict).decision, 'deny');
    assert.equal((await call('POST', '/api/agent/check', { agent, files: [{ path: path.join(dir, 'app/routes/users.py') }] })).body.decision, 'allow');
    assert.equal((await call('POST', '/api/agent/check', { files: [] })).status, 400);
    const state = (await call('GET', '/api/agent/state')).body as ActivityState;
    assert.equal(Object.values(state.fenced)[0].node, `${id}/app/core`);

    // Taking it down lets the edit through.
    assert.deepEqual((await call('PUT', '/api/fences', { node: `${id}/app/core`, rule: null })).body, { fences: [] });
    assert.equal((await call('POST', '/api/agent/check', { agent, files: [{ path: path.join(dir, 'app/core/config.py') }] })).body.decision, 'allow');
  } finally {
    server.kill();
  }
});
