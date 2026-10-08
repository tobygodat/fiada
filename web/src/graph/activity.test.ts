import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentActivity, AgentFile, GraphNode, NodeChange } from '@fiada/shared';
import { agentLooked, agentNodes, describeMarks, rollupActivity, spotlight } from './activity.ts';
import { fixtureGraph } from './fixture.test-util.ts';
import { buildCodeTree, buildFunctionTree } from './tree.ts';

const graph = fixtureGraph();
const graphIndex = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
const change = (kind: NodeChange['kind'], unit: NodeChange['unit'], at: number, anchor?: string): NodeChange => ({ kind, unit, at, agents: ['a'], anchor });

const nodes: Record<string, NodeChange> = {
  'web/src/pages/items.tsx': change('modified', 'file', 10),
  'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 10),
  'web/src/pages/items.tsx#useTags': change('added', 'symbol', 20, 'web/src/pages/items.tsx'),
  'web/src/pages/tags.tsx': change('added', 'file', 30, 'web/src/pages'),
  'api/app/routes/old.py': change('deleted', 'file', 5, 'api/app/routes'),
};

test('Code view: changed nodes mark themselves and closed ancestors count files', () => {
  const a = rollupActivity(buildCodeTree(graph), graphIndex, nodes);
  assert.equal(a.get('web/src/pages/items.tsx')?.self, 'modified');
  assert.equal(a.get('web/src/pages/items.tsx#ItemsPage')?.self, 'modified');
  // Symbols aren't counted in Code view, files are: items.tsx modified, tags.tsx added (not indexed yet).
  assert.deepEqual(pick(a.get('web/src/pages')), { self: null, added: 1, modified: 1, deleted: 0, at: 30 });
  assert.deepEqual(pick(a.get('web')), { self: null, added: 1, modified: 1, deleted: 0, at: 30 });
  // A deleted file counts on the folder standing in for it, and up.
  assert.deepEqual(pick(a.get('api/app/routes')), { self: null, added: 0, modified: 0, deleted: 1, at: 5 });
});

test('By function view counts symbols under their layer and domain', () => {
  const tree = buildFunctionTree(graph);
  const a = rollupActivity(tree, graphIndex, nodes);
  assert.equal(a.get('web/src/pages/items.tsx#ItemsPage')?.self, 'modified');
  const domain = a.get('domain:items');
  assert.equal(domain?.modified, 1);
  assert.equal(domain?.added, 0);
});

const file = (path: string, at: string, symbols: AgentFile['symbols'] = []): AgentFile => ({ repo: 'web', path, node: `web/${path}`, kind: 'modified', symbols, at, diff: true });
const agent = (state: AgentActivity['state'], files: AgentFile[]): AgentActivity => ({
  id: `a-${state}`,
  client: 'claude-code',
  name: 'Claude Code',
  where: 'web',
  cwd: '/w',
  state,
  steps: [],
  files,
  startedAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:30Z',
});

test('a working agent is here: at the file it changed last, and inside every circle round it', () => {
  const tree = buildCodeTree(graph);
  const a = rollupActivity(tree, graphIndex, nodes, [
    agent('working', [file('src/pages/tags.tsx', '2026-09-27T10:00:10Z'), file('src/pages/items.tsx', '2026-09-27T10:00:20Z')]),
  ]);
  assert.equal(a.get('web/src/pages/items.tsx')?.here, 'self');
  assert.equal(a.get('web/src/pages')?.here, 'inside');
  assert.equal(a.get('web')?.here, 'inside');
  assert.equal(a.get('root')?.here ?? null, null, 'not on the workspace');
  assert.equal(a.get('api/app/routes')?.here, null, 'not where it only changed things earlier');
  assert.match(describeMarks(a.get('web/src/pages/items.tsx')!, 'code'), /working here/);
});

test('an agent that waits, or has ended, is nowhere', () => {
  const tree = buildCodeTree(graph);
  for (const state of ['waiting', 'ended'] as const) {
    const a = rollupActivity(tree, graphIndex, nodes, [agent(state, [file('src/pages/items.tsx', '2026-09-27T10:00:20Z')])]);
    assert.equal(a.get('web/src/pages/items.tsx')?.here, null, state);
  }
});

test('By function: the agent is at the symbols it changed in that file', () => {
  const tree = buildFunctionTree(graph);
  const sym = { id: 'web/src/pages/items.tsx#ItemsPage', name: 'ItemsPage', kind: 'modified' as const };
  const a = rollupActivity(tree, graphIndex, nodes, [agent('working', [file('src/pages/items.tsx', '2026-09-27T10:00:20Z', [sym])])]);
  assert.equal(a.get(sym.id)?.here, 'self');
  assert.equal(a.get('domain:items')?.here, 'inside');
});

test("one agent's changes: the circles standing for them, and every circle round them", () => {
  const tree = buildCodeTree(graph);
  const mixed: Record<string, NodeChange> = {
    ...nodes,
    'web/src/client/api.ts': { ...change('modified', 'file', 40), agents: ['b'] },
    'web/src/pages/about.tsx': { ...change('modified', 'file', 50), agents: ['a', 'b'] },
  };
  assert.deepEqual(Object.keys(agentNodes(mixed, 'b')).sort(), ['web/src/client/api.ts', 'web/src/pages/about.tsx']);
  const s = spotlight(tree, graphIndex, mixed, 'b');
  assert.deepEqual(s?.targets, ['web/src/client/api.ts', 'web/src/pages/about.tsx']);
  assert.deepEqual([...s!.lit].sort(), ['root', 'web', 'web/src', 'web/src/client', 'web/src/client/api.ts', 'web/src/pages', 'web/src/pages/about.tsx']);
  assert.ok(!s!.lit.has('api'), "another agent's changes stay dim");
  // A file that isn't indexed yet, or was deleted, stands in at the nearest circle that's left.
  const a = spotlight(tree, graphIndex, nodes, 'a');
  assert.ok(a?.targets.includes('web/src/pages') && a.targets.includes('api/app/routes'));
  assert.ok(a?.targets.includes('web/src/pages/items.tsx#ItemsPage'));
  assert.equal(spotlight(tree, graphIndex, nodes, 'nobody'), null);
});

test('By function: an agent lights up the symbols it changed, their layers and domains', () => {
  const tree = buildFunctionTree(graph);
  const s = spotlight(tree, graphIndex, nodes, 'a');
  assert.ok(s?.lit.has('web/src/pages/items.tsx#ItemsPage'));
  assert.ok(s?.lit.has('domain:items'));
  assert.ok(!s?.lit.has('web/src/pages/items.tsx#useItems'), 'an unchanged symbol stays dim');
});

const pick = (m: ReturnType<ReturnType<typeof rollupActivity>['get']>) => m && { self: m.self, added: m.added, modified: m.modified, deleted: m.deleted, at: m.at };

test('what an agent looked at marks the node, and every circle round it as looked inside', () => {
  const looked = { 'web/src/pages/items.tsx#useItems': { agents: ['a'], at: 40 }, 'api/app/routes/old.py': { agents: ['b'], at: 50 } };
  const tree = buildCodeTree(graph);
  const a = rollupActivity(tree, graphIndex, {}, [], looked);
  assert.equal(a.get('web/src/pages/items.tsx#useItems')?.looked, 'self');
  assert.equal(a.get('web/src/pages/items.tsx')?.looked, 'inside');
  assert.equal(a.get('web')?.looked, 'inside');
  assert.equal(a.get('root')?.looked ?? null, null, 'not on the workspace');
  // Looking is not changing: no counts, no change mark.
  assert.deepEqual(pick(a.get('web')), { self: null, added: 0, modified: 0, deleted: 0, at: 0 });
  assert.match(describeMarks(a.get('web/src/pages/items.tsx#useItems')!, 'code'), /an agent looked at this/);
  // A node the graph no longer has isn't marked anywhere.
  assert.equal(a.get('api/app/routes')?.looked ?? null, null);

  // By function shows a file as its symbols: a look at the file marks them.
  const byFunction = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], { 'web/src/pages/items.tsx': { agents: ['a'], at: 40 } });
  assert.equal(byFunction.get('web/src/pages/items.tsx#ItemsPage')?.looked, 'self');
  assert.equal(byFunction.get('web/src/pages/items.tsx#useItems')?.looked, 'self');
  assert.equal(byFunction.get('domain:items')?.looked, 'inside');

  // By function draws no folders: a look at one marks what it holds that the view draws.
  const folder = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], { 'web/src': { agents: ['a'], at: 40 } });
  assert.equal(folder.get('web/src/pages/items.tsx#useItems')?.looked, 'self');
  assert.equal(folder.get('domain:items')?.looked, 'inside');
  // A whole repository marks nothing By function, rather than every symbol in it.
  const repo = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], { web: { agents: ['a'], at: 40 } });
  assert.equal([...repo.values()].filter((m) => m.looked).length, 0);
  assert.equal(rollupActivity(tree, graphIndex, {}, [], { web: { agents: ['a'], at: 40 } }).get('web')?.looked, 'self');

  assert.deepEqual(Object.keys(agentLooked(looked, 'b')), ['api/app/routes/old.py']);
  assert.deepEqual(agentLooked(undefined, 'b'), {});
});

test('lighting an agent lights what it looked at too; the camera goes to what it changed, or else to what it looked at', () => {
  const tree = buildCodeTree(graph);
  const looked = { 'web/src/client/api.ts': { agents: ['a'], at: 60 }, 'api/app/routes': { agents: ['b'], at: 60 } };
  const s = spotlight(tree, graphIndex, nodes, 'a', looked);
  assert.ok(s?.lit.has('web/src/client/api.ts') && s.lit.has('web/src/client'), 'looked at: lit, with the circles round it');
  assert.ok(!s?.targets.includes('web/src/client/api.ts'), 'but the camera fits its changes');
  // An agent that only looked: lit and brought into view by what it looked at.
  const onlyLooked = spotlight(tree, graphIndex, {}, 'b', looked);
  assert.deepEqual(onlyLooked?.targets, ['api/app/routes']);
  assert.ok(onlyLooked?.lit.has('api'));
  assert.ok(!onlyLooked?.lit.has('web/src/client/api.ts'), "another agent's looks stay dim");
  assert.equal(spotlight(tree, graphIndex, {}, 'nobody', looked), null);
});
