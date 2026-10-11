import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentActivity, AgentFile, GraphEdge, GraphNode, NodeChange } from '@fiada/shared';
import { agentLooked, agentNodes, describeMarks, reachSentences, rollupActivity, spotlight } from './activity.ts';
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

// ── The ripple: what depends on a change ──

const edges = graph.edges;
const only = (ids: Record<string, NodeChange>) => ids;
const ripple = (m: ReturnType<ReturnType<typeof rollupActivity>['get']>) => m && { reached: m.reached, ripple: m.ripple };

test('a changed route ripples to the client requesting it, across repositories, rolled up by file in Code view', () => {
  const a = rollupActivity(
    buildCodeTree(graph),
    graphIndex,
    only({ 'api/app/routes/items.py': change('modified', 'file', 10), 'api/app/routes/items.py#read_items': change('modified', 'symbol', 10) }),
    [],
    null,
    {},
    edges,
  );
  // The request to read_items is proven; the guessed one goes to create_item, which didn't change.
  assert.deepEqual(ripple(a.get('web/src/client/api.ts#ItemsService')), { reached: 'evidenced', ripple: 0 });
  assert.deepEqual(ripple(a.get('web/src/client/api.ts')), { reached: 'evidenced', ripple: 0 });
  for (const id of ['web/src/client', 'web/src', 'web']) assert.deepEqual(ripple(a.get(id)), { reached: 'evidenced', ripple: 1 }, id);
  // The change itself, and what it calls, aren't dependents.
  assert.equal(a.get('api/app/routes/items.py#read_items')?.reached, null);
  assert.equal(a.get('api/app/models.py#Item'), undefined);
  // Nothing else in the change's own repository depends on it.
  assert.equal(a.get('api')?.ripple, 0);
});

test('a deleted symbol ripples through the links the indexer kept for it', () => {
  // The graph no longer has the symbol; the activity state still marks it, and a kept link points at it.
  const gone = { 'api/app/models.py#Gone': { ...change('deleted', 'symbol', 10), anchor: 'api/app/models.py' } };
  const kept: GraphEdge = { from: 'web/src/client/api.ts#ItemsService', to: 'api/app/models.py#Gone', kind: 'calls', basis: 'evidenced' };
  const a = rollupActivity(buildCodeTree(graph), graphIndex, gone, [], null, {}, [...edges, kept]);
  assert.equal(a.get('web/src/client/api.ts#ItemsService')?.reached, 'evidenced');
  assert.equal(a.get('web')?.ripple, 1);
});

test('a dependent reached only by guessed links says so', () => {
  const a = rollupActivity(buildCodeTree(graph), graphIndex, only({ 'api/app/routes/items.py#create_item': change('modified', 'symbol', 10) }), [], null, {}, edges);
  assert.equal(a.get('web/src/client/api.ts#ItemsService')?.reached, 'inferred');
  assert.deepEqual(ripple(a.get('web')), { reached: 'inferred', ripple: 1 });
});

test('a file changed as a whole reaches everything that uses its symbols; its own symbols are marked, not counted', () => {
  const a = rollupActivity(buildCodeTree(graph), graphIndex, only({ 'api/app/models.py': change('modified', 'file', 10) }), [], null, {}, edges);
  assert.equal(a.get('api/app/routes/items.py#read_items')?.reached, 'evidenced');
  assert.equal(a.get('api/app/routes/items.py#create_item')?.reached, 'evidenced');
  // Item uses User inside the changed file: marked, but the changed file isn't counted as its own dependent.
  assert.equal(a.get('api/app/models.py#Item')?.reached, 'evidenced');
  assert.equal(a.get('api/app/models.py')?.reached, null);
  // items.py is one file: counted once however many of its symbols depend on the change.
  assert.equal(a.get('api/app/routes')?.ripple, 1);
  assert.equal(a.get('api/app')?.ripple, 1);
  assert.equal(a.get('api')?.ripple, 1);
});

test('a dependent the agent changed too is marked as a change, not as a dependent', () => {
  const a = rollupActivity(
    buildCodeTree(graph),
    graphIndex,
    only({
      'web/src/pages/items.tsx': change('modified', 'file', 10),
      'web/src/pages/items.tsx#useItems': change('modified', 'symbol', 10),
      'web/src/client/api.ts#ItemsService': change('modified', 'symbol', 10),
    }),
    [],
    null,
    {},
    edges,
  );
  assert.equal(a.get('web/src/pages/items.tsx#useItems')?.reached, null);
  // ItemsPage calls the changed useItems: inside a changed file, so marked but not counted above it.
  assert.equal(a.get('web/src/pages/items.tsx#ItemsPage')?.reached, 'evidenced');
  assert.equal(a.get('web/src/pages')?.ripple, 0);
});

test('By function counts dependent symbols under their layer and domain', () => {
  const tree = buildFunctionTree(graph);
  const a = rollupActivity(tree, graphIndex, only({ 'api/app/models.py#Item': change('modified', 'symbol', 10) }), [], null, {}, edges);
  assert.equal(a.get('api/app/routes/items.py#read_items')?.reached, 'evidenced');
  assert.equal(a.get('domain:items')?.ripple, 2);
  assert.equal(a.get('domain:items/ui')?.ripple, 2);
});

test('a file that imports a change is a dependent itself, not only the circle round one', () => {
  const a = rollupActivity(buildCodeTree(graph), graphIndex, only({ 'web/src/client/api.ts': change('modified', 'file', 10) }), [], null, {}, edges);
  // about.tsx imports the changed file directly; items.tsx only holds useItems, which calls into it.
  assert.equal(a.get('web/src/pages/about.tsx')?.direct, true);
  assert.equal(a.get('web/src/pages/items.tsx#useItems')?.direct, true);
  assert.equal(a.get('web/src/pages/items.tsx')?.reached, 'evidenced');
  assert.equal(a.get('web/src/pages/items.tsx')?.direct, false);
});

test('a file another agent changed at its top level stays whole, however narrowly a second agent changed it', () => {
  const by = (kind: NodeChange['kind'], unit: NodeChange['unit'], agents: string[]): NodeChange => ({ kind, unit, at: 10, agents });
  const both = {
    'api/app/routes/items.py': by('modified', 'file', ['a', 'b']),
    'api/app/routes/items.py#read_items': by('modified', 'symbol', ['b']),
  };
  // Agent a touched only the top level, so the guessed request to create_item is reached too.
  const a = rollupActivity(buildCodeTree(graph), graphIndex, both, [], null, {}, edges);
  assert.equal(a.get('web/src/client/api.ts#ItemsService')?.reached, 'evidenced');
  assert.deepEqual(reachSentences(graphIndex.get('api/app/routes/items.py')!, edges, graphIndex, both), ['2 requests from web call these routes, 1 of them inferred.']);
  // With agent a's change gone, b's is narrowed to read_items.
  const onlyB = { ...both, 'api/app/routes/items.py': by('modified', 'file', ['b']) };
  assert.deepEqual(reachSentences(graphIndex.get('api/app/routes/items.py')!, edges, graphIndex, onlyB), ['1 request from web calls this route.']);
  // Spotlighting b leaves only b's part of the shared file, so it narrows the same way.
  const spotB = agentNodes(both, 'b');
  assert.deepEqual(spotB['api/app/routes/items.py'].agents, ['b']);
  assert.deepEqual(reachSentences(graphIndex.get('api/app/routes/items.py')!, edges, graphIndex, spotB), ['1 request from web calls this route.']);
  // One agent that changed read_items and also the file's top level (an import, say) changed the whole file.
  const mixed = { ...onlyB, 'api/app/routes/items.py': { ...by('modified', 'file', ['b']), whole: ['b'] } };
  assert.deepEqual(reachSentences(graphIndex.get('api/app/routes/items.py')!, edges, graphIndex, mixed), ['2 requests from web call these routes, 1 of them inferred.']);
  // Spotlit, an agent keeps its own top-level edit and drops the other's.
  const twoWhole = { ...both, 'api/app/routes/items.py': { ...by('modified', 'file', ['a', 'b']), whole: ['a'] } };
  assert.equal(agentNodes(twoWhole, 'b')['api/app/routes/items.py'].whole, undefined);
  assert.deepEqual(agentNodes(mixed, 'b')['api/app/routes/items.py'].whole, ['b']);
  assert.deepEqual(reachSentences(graphIndex.get('api/app/routes/items.py')!, edges, graphIndex, agentNodes(twoWhole, 'b')), ['1 request from web calls this route.']);
});

test('without edges there is no ripple', () => {
  const a = rollupActivity(buildCodeTree(graph), graphIndex, only({ 'api/app/models.py': change('modified', 'file', 10) }));
  assert.ok([...a.values()].every((m) => m.reached === null && m.ripple === 0));
});

test('what reaches a changed route, type or file, in a sentence', () => {
  const node = (id: string, extra: Partial<GraphNode> = {}) => ({ ...graphIndex.get(id)!, ...extra });
  assert.deepEqual(reachSentences(node('api/app/routes/items.py#read_items'), edges, graphIndex), ['1 request from web calls this route.']);
  assert.deepEqual(reachSentences(node('api/app/routes/items.py#create_item'), edges, graphIndex), ['1 request from web calls this route, inferred.']);
  assert.deepEqual(reachSentences(node('api/app/models.py#Item', { symbolKind: 'class' }), edges, graphIndex), ['2 functions in api use this class.']);
  assert.deepEqual(reachSentences(node('api/app/models.py'), edges, graphIndex), ['2 functions in api use this file.']);
  // A file serving routes: requests to any of them, and calls to its symbols from outside it.
  assert.deepEqual(reachSentences(node('api/app/routes/items.py'), edges, graphIndex), ['2 requests from web call these routes, 1 of them inferred.']);
  // Narrowed to read_items, the file counts only what reaches it, as the map does.
  const narrowed = { 'api/app/routes/items.py': change('modified', 'file', 10), 'api/app/routes/items.py#read_items': change('modified', 'symbol', 10) };
  assert.deepEqual(reachSentences(node('api/app/routes/items.py'), edges, graphIndex, narrowed), ['1 request from web calls this route.']);
  // An exported file nothing reaches says so; an unexported one says nothing.
  assert.deepEqual(reachSentences(node('web/src/pages/about.tsx', { exported: true }), edges, graphIndex), ['Nothing in the imported repositories reaches this file yet.']);
  assert.deepEqual(reachSentences(node('web/src/pages/about.tsx'), edges, graphIndex), []);
});

test('requests from several repositories are counted by repository, most first', () => {
  const route = 'api/app/routes/items.py#read_items';
  const req = (from: string): GraphEdge => ({ from, to: route, kind: 'http', basis: 'evidenced' });
  const many = [req('web/a.ts#a'), req('mobile/b.ts#b'), req('web/c.ts#c'), req('web/d.ts#d')];
  assert.deepEqual(reachSentences({ ...graphIndex.get(route)!, routes: ['GET /items/'] }, many, graphIndex), ['3 requests from web and 1 from mobile call this route.']);
  const three = [...many, req('jobs/e.py#e')];
  assert.deepEqual(reachSentences(graphIndex.get(route)!, three, graphIndex), ['3 requests from web, 1 from jobs and 1 from mobile call this route.']);
});

test('a handler serving several routes says "these routes" only when requests reach more than one', () => {
  const route = 'api/app/routes/items.py#read_items';
  const g = { ...graphIndex.get(route)!, routes: ['GET /items/', 'GET /items/all'] };
  const req = (from: string, detail: string): GraphEdge => ({ from, to: route, kind: 'http', basis: 'evidenced', detail });
  assert.deepEqual(reachSentences(g, [req('web/a.ts#a', 'GET /items/')], graphIndex), ['1 request from web calls this route.']);
  assert.deepEqual(reachSentences(g, [req('web/a.ts#a', 'GET /items/'), req('web/b.ts#b', 'GET /items/all')], graphIndex), ['2 requests from web call these routes.']);
});

test('dependents that reach a node in different ways use it', () => {
  const target = 'api/app/models.py#Item';
  const g = { ...graphIndex.get(target)!, symbolKind: 'class' as const };
  const link = (from: string, kind: GraphEdge['kind']): GraphEdge => ({ from, to: target, kind, basis: 'evidenced' });
  assert.deepEqual(reachSentences(g, [link('web/a.ts#a', 'calls'), link('web/b.ts#b', 'calls')], graphIndex), ['2 places in web call this class.']);
  assert.deepEqual(reachSentences(g, [link('web/a.ts#a', 'calls'), link('web/b.ts#b', 'calls'), link('web/c.ts#c', 'type')], graphIndex), ['3 places in web use this class.']);
});

test('what an agent looked at marks the node, and every circle round it as looked inside', () => {
  const looked = { 'web/src/pages/items.tsx#useItems': { agents: ['a'], at: 40 }, 'api/app/routes/old.py': { agents: ['b'], at: 50 } };
  const tree = buildCodeTree(graph);
  const a = rollupActivity(tree, graphIndex, {}, [], null, looked);
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
  const byFunction = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], null, { 'web/src/pages/items.tsx': { agents: ['a'], at: 40 } });
  assert.equal(byFunction.get('web/src/pages/items.tsx#ItemsPage')?.looked, 'self');
  assert.equal(byFunction.get('web/src/pages/items.tsx#useItems')?.looked, 'self');
  assert.equal(byFunction.get('domain:items')?.looked, 'inside');

  // By function draws no folders: a look at one marks what it holds that the view draws.
  const folder = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], null, { 'web/src': { agents: ['a'], at: 40 } });
  assert.equal(folder.get('web/src/pages/items.tsx#useItems')?.looked, 'self');
  assert.equal(folder.get('domain:items')?.looked, 'inside');
  // A whole repository marks nothing By function, rather than every symbol in it.
  const repo = rollupActivity(buildFunctionTree(graph), graphIndex, {}, [], null, { web: { agents: ['a'], at: 40 } });
  assert.equal([...repo.values()].filter((m) => m.looked).length, 0);
  assert.equal(rollupActivity(tree, graphIndex, {}, [], null, { web: { agents: ['a'], at: 40 } }).get('web')?.looked, 'self');

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
