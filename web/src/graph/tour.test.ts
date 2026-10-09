import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNLAYERED, type AgentActivity, type AgentFile, type GraphNode, type NodeChange } from '@fiada/shared';
import { fixtureGraph } from './fixture.test-util.ts';
import { forgetMarks, isRead, loops, nextUnread, reviewable, tourStops, type ReadMarks } from './tour.ts';

// The fixture with a layer per kind of code: page, client, route, model.
const graph = fixtureGraph();
graph.layers = [
  { id: 'ui', name: 'UI' },
  { id: 'client', name: 'Client' },
  { id: 'api', name: 'API' },
  { id: 'data', name: 'Data' },
];
const LAYER: [string, string][] = [
  ['web/src/client', 'client'],
  ['api/app/routes', 'api'],
  ['api/app/models.py', 'data'],
];
for (const n of graph.nodes) {
  const hit = LAYER.find(([p]) => n.id.startsWith(p));
  if (hit && n.layer) n.layer = { ...n.layer, id: hit[1] };
}
const graphIndex = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));

const sym = (id: string, kind: NodeChange['kind'] = 'modified') => ({ id, name: id.slice(id.indexOf('#') + 1), kind });
const file = (repo: string, path: string, symbols: AgentFile['symbols'] = [], kind: AgentFile['kind'] = 'modified'): AgentFile => ({
  repo,
  path,
  node: kind === 'deleted' ? undefined : `${repo}/${path}`,
  kind,
  symbols,
  at: '2026-09-27T10:00:00Z',
  diff: true,
});
const agent = (files: AgentFile[]): AgentActivity => ({
  id: 'a',
  client: 'claude-code',
  name: 'Claude Code',
  where: 'web',
  cwd: '/w',
  state: 'ended',
  steps: [],
  files,
  startedAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:30Z',
});
const NO_NODES: Record<string, NodeChange> = {};

test('stops follow the data flow: page, client, route, model, whatever order the agent touched them in', () => {
  // Listed backwards, the way an agent working from the database up would touch them.
  const a = agent([
    file('api', 'app/models.py', [sym('api/app/models.py#Item')]),
    file('api', 'app/routes/items.py', [sym('api/app/routes/items.py#create_item'), sym('api/app/routes/items.py#read_items')]),
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#ItemsService')]),
    file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#useItems'), sym('web/src/pages/items.tsx#ItemsPage')]),
  ]);
  const ids = tourStops(graph, graphIndex, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, [
    // The page calls its hook, so the page comes first though the hook was listed first.
    'web/src/pages/items.tsx#ItemsPage',
    'web/src/pages/items.tsx#useItems',
    'web/src/client/api.ts#ItemsService',
    'api/app/routes/items.py#create_item',
    'api/app/routes/items.py#read_items',
    'api/app/models.py#Item',
  ]);
});

test('inside one layer, a stop waits for the changed code that calls it', () => {
  // All in one layer: Item is used by both routes, so both come before it; create_item before read_items by name.
  const flat = { ...graph, layers: [{ id: 'ui', name: 'UI' }] };
  const idx = new Map(graph.nodes.map((n) => [n.id, { ...n, layer: n.layer && { ...n.layer, id: 'ui' } }]));
  const a = agent([
    file('api', 'app/models.py', [sym('api/app/models.py#User'), sym('api/app/models.py#Item')]),
    file('api', 'app/routes/items.py', [sym('api/app/routes/items.py#read_items')]),
  ]);
  const ids = tourStops(flat, idx, a, NO_NODES).map((s) => s.id);
  // read_items → Item → User (Item refers to User as a type).
  assert.deepEqual(ids, ['api/app/routes/items.py#read_items', 'api/app/models.py#Item', 'api/app/models.py#User']);
});

test('a file with no changed functions is one stop; deleted code stands on what is left', () => {
  const nodes: Record<string, NodeChange> = {
    'api/app/routes/old.py': { kind: 'deleted', unit: 'file', at: 5, agents: ['a'], anchor: 'api/app/routes' },
    'web/src/pages/about.tsx': { kind: 'modified', unit: 'file', at: 9, agents: ['a'] },
  };
  const a = agent([
    file('web', 'src/pages/about.tsx'),
    file('api', 'app/routes/old.py', [], 'deleted'),
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#OldService', 'deleted')]),
    // Outside the imported repositories: not on the map, so not on the tour.
    { ...file('x', '/tmp/notes.md'), repo: undefined },
  ]);
  const stops = tourStops(graph, graphIndex, a, nodes);
  assert.deepEqual(
    stops.map((s) => [s.id, s.target, s.kind]),
    [
      ['web/src/pages/about.tsx', 'web/src/pages/about.tsx', 'modified'],
      ['web/src/client/api.ts#OldService', 'web/src/client/api.ts', 'deleted'],
      ['api/app/routes/old.py', 'api/app/routes', 'deleted'],
    ],
  );
  assert.equal(stops[0].at, Date.parse('2026-09-27T10:00:00Z'));
  assert.equal(stops[0].name, 'about.tsx');
});

test('a loop of calls still visits every stop once', () => {
  const g = { ...graph, edges: [...graph.edges, { from: 'web/src/client/api.ts#ItemsService', to: 'web/src/client/api.ts#UsersService', kind: 'calls' as const }, { from: 'web/src/client/api.ts#UsersService', to: 'web/src/client/api.ts#ItemsService', kind: 'calls' as const }] };
  const a = agent([file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#UsersService'), sym('web/src/client/api.ts#ItemsService')])]);
  const ids = tourStops(g, graphIndex, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/client/api.ts#ItemsService', 'web/src/client/api.ts#UsersService']);
});

test('read marks last until the agent changes that code again', () => {
  const a = (at: string) => agent([{ ...file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#ItemsPage'), sym('web/src/pages/items.tsx#useItems')]), at }]);
  const t = Date.parse('2026-09-27T10:00:00Z');
  const stops = tourStops(graph, graphIndex, a('2026-09-27T10:00:00Z'), NO_NODES);
  const marks: ReadMarks = { 'web/src/pages/items.tsx#ItemsPage': t };
  assert.equal(isRead(marks, stops[0]), true);
  assert.equal(nextUnread(stops, marks), 1);
  assert.equal(nextUnread(stops, { ...marks, 'web/src/pages/items.tsx#useItems': t }), -1);
  // Changed again by this agent after it was read: unread again.
  const again = tourStops(graph, graphIndex, a('2026-09-27T10:05:00Z'), NO_NODES);
  assert.equal(isRead(marks, again[0]), false);
  // Another agent's later change to the same code doesn't count against this agent's tour.
  const other: Record<string, NodeChange> = { 'web/src/pages/items.tsx#ItemsPage': { kind: 'modified', unit: 'symbol', at: t + 600_000, agents: ['b'] } };
  assert.equal(isRead(marks, tourStops(graph, graphIndex, a('2026-09-27T10:00:00Z'), other)[0]), true);
  // Wraps round to find the first unread before where you are.
  assert.equal(nextUnread(stops, { 'web/src/pages/items.tsx#useItems': t }, 1), 0);
});

test('two deleted files in one folder are two stops, each its own', () => {
  const gone = (path: string): AgentFile => ({ ...file('api', path, [], 'deleted'), node: 'api/app/routes' });
  const stops = tourStops(graph, graphIndex, agent([gone('app/routes/old.py'), gone('app/routes/older.py')]), NO_NODES);
  assert.deepEqual(
    stops.map((s) => [s.id, s.target]),
    [
      ['api/app/routes/old.py', 'api/app/routes'],
      ['api/app/routes/older.py', 'api/app/routes'],
    ],
  );
});

test('a deleted file stands in the layer of the folder left, and is read with that layer', () => {
  const nodes: Record<string, NodeChange> = { 'api/app/routes/old.py': { kind: 'deleted', unit: 'file', at: 5, agents: ['a'], anchor: 'api/app/routes' } };
  const a = agent([file('api', 'app/models.py', [sym('api/app/models.py#Item')]), file('api', 'app/routes/old.py', [], 'deleted')]);
  // As the indexer has it: only files and functions carry a layer.
  const idx = new Map([...graphIndex].map(([id, n]) => [id, n.kind === 'folder' || n.kind === 'repo' ? { ...n, layer: undefined } : n]));
  const stops = tourStops(graph, idx, a, nodes);
  assert.deepEqual(
    stops.map((s) => [s.id, s.layer]),
    [
      ['api/app/routes/old.py', 'api'],
      ['api/app/models.py#Item', 'data'],
    ],
  );
});

test('a loop of calls in an earlier layer comes before a later layer that is ready', () => {
  const g = {
    ...graph,
    edges: [
      ...graph.edges,
      { from: 'web/src/pages/items.tsx#ItemsPage', to: 'web/src/pages/items.tsx#useItems', kind: 'calls' as const },
      { from: 'web/src/pages/items.tsx#useItems', to: 'web/src/pages/items.tsx#ItemsPage', kind: 'calls' as const },
    ],
  };
  const a = agent([
    file('api', 'app/models.py', [sym('api/app/models.py#User')]),
    file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#useItems'), sym('web/src/pages/items.tsx#ItemsPage')]),
  ]);
  const ids = tourStops(g, graphIndex, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/pages/items.tsx#ItemsPage', 'web/src/pages/items.tsx#useItems', 'api/app/models.py#User']);
});

test("a file's own links hold back every changed function in it, not only the first", () => {
  // One layer for all, so only the links order them: about.tsx imports the client file.
  const flat = { ...graph, layers: [{ id: 'ui', name: 'UI' }] };
  const idx = new Map(graph.nodes.map((n) => [n.id, { ...n, layer: n.layer && { ...n.layer, id: 'ui' } }]));
  const a = agent([
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#UsersService'), sym('web/src/client/api.ts#ItemsService')]),
    file('web', 'src/pages/about.tsx'),
  ]);
  const ids = tourStops(flat, idx, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/pages/about.tsx', 'web/src/client/api.ts#ItemsService', 'web/src/client/api.ts#UsersService']);
});

test("an unchanged function's links don't hold back its file's changed functions", () => {
  // One layer. Only ItemsPage changed in items.tsx; its unchanged sibling useItems calls the changed
  // ItemsService. That call is useItems', not ItemsPage's, so path order stands: client before pages.
  const flat = { ...graph, layers: [{ id: 'ui', name: 'UI' }] };
  const idx = new Map(graph.nodes.map((n) => [n.id, { ...n, layer: n.layer && { ...n.layer, id: 'ui' } }]));
  const a = agent([
    file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#ItemsPage')]),
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#ItemsService')]),
  ]);
  const ids = tourStops(flat, idx, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/client/api.ts#ItemsService', 'web/src/pages/items.tsx#ItemsPage']);
});

test('layers go in their listed order even when a rank collides with a position', () => {
  // Data's rank 0 equals UI's position: by repository, api/ would come before web/.
  const g = { ...graph, layers: [{ id: 'ui', name: 'UI' }, { id: 'data', name: 'Data', rank: 0 }] };
  const a = agent([file('api', 'app/models.py', [sym('api/app/models.py#User')]), file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#ItemsPage')])]);
  const ids = tourStops(g, graphIndex, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/pages/items.tsx#ItemsPage', 'api/app/models.py#User']);
});

test('a loop of calls is read whole before what it calls', () => {
  // ItemsService ↔ UsersService, and ItemsService → Item: Item sorts first by repository, and comes
  // next after ItemsService, but waits until the whole loop is read.
  const flat = {
    ...graph,
    layers: [{ id: 'ui', name: 'UI' }],
    edges: [
      ...graph.edges,
      { from: 'web/src/client/api.ts#ItemsService', to: 'web/src/client/api.ts#UsersService', kind: 'calls' as const },
      { from: 'web/src/client/api.ts#UsersService', to: 'web/src/client/api.ts#ItemsService', kind: 'calls' as const },
      { from: 'web/src/client/api.ts#ItemsService', to: 'api/app/models.py#Item', kind: 'calls' as const },
    ],
  };
  const idx = new Map(graph.nodes.map((n) => [n.id, { ...n, layer: n.layer && { ...n.layer, id: 'ui' } }]));
  const a = agent([
    file('api', 'app/models.py', [sym('api/app/models.py#Item')]),
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#UsersService'), sym('web/src/client/api.ts#ItemsService')]),
  ]);
  const ids = tourStops(flat, idx, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/client/api.ts#ItemsService', 'web/src/client/api.ts#UsersService', 'api/app/models.py#Item']);
});

test('a loop called from another loop waits for it, whichever of its stops sorts first', () => {
  // up.ts: one ↔ two, and one → b1. down.ts: b1 ↔ b2, with b2 first by line. b2's only caller is
  // in its own loop, but the loop as a whole waits for up.ts's; then it starts where the order does.
  const layer: GraphNode['layer'] = { id: 'ui', source: 'path', confidence: 1, evidence: [] };
  const nodes: GraphNode[] = [
    { id: 'r', kind: 'repo', name: 'r', parent: 'root', repo: 'r' },
    ...['down.ts', 'up.ts'].map((f): GraphNode => ({ id: `r/${f}`, kind: 'file', name: f, parent: 'r', repo: 'r', path: f, layer })),
    ...([['down.ts', 'b1', 10], ['down.ts', 'b2', 1], ['up.ts', 'one', 1], ['up.ts', 'two', 10]] as const).map(
      ([f, n, at]): GraphNode => ({ id: `r/${f}#${n}`, kind: 'symbol', name: n, parent: `r/${f}`, repo: 'r', path: f, lines: [at, at + 5], layer }),
    ),
  ];
  const calls = (from: string, to: string) => ({ from: `r/${from}`, to: `r/${to}`, kind: 'calls' as const });
  const g = {
    layers: [{ id: 'ui', name: 'UI' }],
    edges: [calls('up.ts#one', 'up.ts#two'), calls('up.ts#two', 'up.ts#one'), calls('up.ts#one', 'down.ts#b1'), calls('down.ts#b1', 'down.ts#b2'), calls('down.ts#b2', 'down.ts#b1')],
  };
  const a = agent([
    file('r', 'down.ts', [sym('r/down.ts#b1'), sym('r/down.ts#b2')]),
    file('r', 'up.ts', [sym('r/up.ts#one'), sym('r/up.ts#two')]),
  ]);
  const ids = tourStops(g, new Map(nodes.map((n) => [n.id, n])), a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['r/up.ts#one', 'r/up.ts#two', 'r/down.ts#b2', 'r/down.ts#b1']);
});

test('a loop of calls and a single stop, both free to start, go in the order', () => {
  // a.ts: one ↔ two. z.ts: three, linked to neither. The loop sorts first by path, so it goes first.
  const layer: GraphNode['layer'] = { id: 'ui', source: 'path', confidence: 1, evidence: [] };
  const nodes: GraphNode[] = [
    { id: 'r', kind: 'repo', name: 'r', parent: 'root', repo: 'r' },
    ...['a.ts', 'z.ts'].map((f): GraphNode => ({ id: `r/${f}`, kind: 'file', name: f, parent: 'r', repo: 'r', path: f, layer })),
    ...([['a.ts', 'one', 1], ['a.ts', 'two', 10], ['z.ts', 'three', 1]] as const).map(
      ([f, n, at]): GraphNode => ({ id: `r/${f}#${n}`, kind: 'symbol', name: n, parent: `r/${f}`, repo: 'r', path: f, lines: [at, at + 5], layer }),
    ),
  ];
  const calls = (from: string, to: string) => ({ from: `r/${from}`, to: `r/${to}`, kind: 'calls' as const });
  const g = { layers: [{ id: 'ui', name: 'UI' }], edges: [calls('a.ts#one', 'a.ts#two'), calls('a.ts#two', 'a.ts#one')] };
  const a = agent([file('r', 'z.ts', [sym('r/z.ts#three')]), file('r', 'a.ts', [sym('r/a.ts#two'), sym('r/a.ts#one')])]);
  const ids = tourStops(g, new Map(nodes.map((n) => [n.id, n])), a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['r/a.ts#one', 'r/a.ts#two', 'r/z.ts#three']);
});

test("the first of a file's function stops also carries the file's other hunks", () => {
  const a = agent([
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#UsersService'), sym('web/src/client/api.ts#ItemsService')]),
    file('web', 'src/pages/items.tsx', [sym('web/src/pages/items.tsx#ItemsPage')]),
  ]);
  const stops = tourStops(graph, graphIndex, a, NO_NODES);
  const rest = Object.fromEntries(stops.map((s) => [s.id, s.rest]));
  assert.deepEqual(rest['web/src/client/api.ts#ItemsService'], ['web/src/client/api.ts#ItemsService', 'web/src/client/api.ts#UsersService']);
  assert.equal(rest['web/src/client/api.ts#UsersService'], undefined, 'once per file');
  assert.deepEqual(rest['web/src/pages/items.tsx#ItemsPage'], ['web/src/pages/items.tsx#ItemsPage']);
});

test('a class whose method changed is read at the method, not again as the class', () => {
  // Java and the like list a class and each method in it, the class's lines holding the method's.
  const F = 'svc/src/Items.java';
  const node = (name: string, lines: [number, number]) =>
    ({ id: `svc/${F.slice(4)}#${name}`, kind: 'symbol', name, parent: `svc/${F.slice(4)}`, repo: 'svc', lines, layer: { id: 'api' } }) as unknown as GraphNode;
  const nodes = [node('Items', [1, 30]), node('Items.add', [3, 10]), node('Items.list', [12, 20]), node('Items.Page', [22, 29]), node('Items.Page.next', [23, 28])];
  const fileNode = { id: `svc/${F.slice(4)}`, kind: 'file', name: 'Items.java', parent: 'svc', repo: 'svc', layer: { id: 'api' } } as unknown as GraphNode;
  const ix = new Map([fileNode, ...nodes].map((n) => [n.id, n]));
  const id = (name: string) => `svc/${F.slice(4)}#${name}`;
  const a = agent([
    file('svc', F.slice(4), [
      sym(id('Items')),
      sym(id('Items.add')),
      sym(id('Items.Page')),
      sym(id('Items.Page.next')),
      // A deleted class and its deleted method, by their lines in HEAD.
      { ...sym(id('Old'), 'deleted'), oldLines: [40, 60] as [number, number] },
      { ...sym(id('Old.run'), 'deleted'), oldLines: [42, 50] as [number, number] },
    ]),
  ]);
  const stops = tourStops({ edges: [], layers: graph.layers }, ix, a, NO_NODES);
  assert.deepEqual(
    stops.map((s) => s.id),
    [id('Items.add'), id('Items.Page.next'), id('Old.run')],
  );
  // The class's own other lines are the file's other hunks, on its first stop.
  assert.deepEqual(stops[0].rest, [id('Items.add'), id('Items.Page.next'), id('Old.run')]);
});

test('a class that lost a method is read at the deleted method, by their lines in HEAD', () => {
  const F = 'src/Items.java';
  const fileNode = { id: `svc/${F}`, kind: 'file', name: 'Items.java', parent: 'svc', repo: 'svc', layer: { id: 'api' } } as unknown as GraphNode;
  const cls = { id: `svc/${F}#Items`, kind: 'symbol', name: 'Items', parent: `svc/${F}`, repo: 'svc', lines: [1, 20], layer: { id: 'api' } } as unknown as GraphNode;
  const ix = new Map([fileNode, cls].map((n) => [n.id, n]));
  const a = agent([
    file('svc', F, [
      { ...sym(`svc/${F}#Items`), oldLines: [1, 30] as [number, number] },
      { ...sym(`svc/${F}#Items.gone`, 'deleted'), oldLines: [22, 28] as [number, number] },
    ]),
  ]);
  const stops = tourStops({ edges: [], layers: graph.layers }, ix, a, NO_NODES);
  assert.deepEqual(
    stops.map((s) => s.id),
    [`svc/${F}#Items.gone`],
  );
});

test("a deleted function's stop carries its lines from before, for its own hunks, and so does the file's first stop", () => {
  const a = agent([
    file('web', 'src/client/api.ts', [
      { ...sym('web/src/client/api.ts#Users.get', 'deleted'), oldLines: [10, 12] as [number, number] },
      { ...sym('web/src/client/api.ts#Items.get', 'deleted'), oldLines: [30, 32] as [number, number] },
    ]),
  ]);
  const stops = tourStops(graph, graphIndex, a, NO_NODES);
  // In the order they stood in the file, not by name.
  assert.deepEqual(
    stops.map((s) => [s.id, s.old]),
    [
      ['web/src/client/api.ts#Users.get', [10, 12]],
      ['web/src/client/api.ts#Items.get', [30, 32]],
    ],
  );
  assert.deepEqual(stops[0].restOld, { 'web/src/client/api.ts#Users.get': [10, 12], 'web/src/client/api.ts#Items.get': [30, 32] });
  assert.equal(stops[1].restOld, undefined);
});

test("a deleted function keeps the layer the map had for it, not its file's", () => {
  // ItemSchema was a Data class in the client file: it is read with the data layer, after the client.
  const a = agent([
    file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#ItemsService'), { ...sym('web/src/client/api.ts#ItemSchema', 'deleted'), layer: 'data' }]),
    file('api', 'app/models.py', [sym('api/app/models.py#Item')]),
  ]);
  const stops = tourStops(graph, graphIndex, a, NO_NODES);
  assert.deepEqual(
    stops.map((s) => [s.id, s.layer]),
    [
      ['web/src/client/api.ts#ItemsService', 'client'],
      ['api/app/models.py#Item', 'data'],
      ['web/src/client/api.ts#ItemSchema', 'data'],
    ],
  );
  // A layer the project no longer has (its grouping changed since): the file's, as for any other.
  const gone = agent([file('web', 'src/client/api.ts', [{ ...sym('web/src/client/api.ts#ItemSchema', 'deleted'), layer: 'schemas' }])]);
  assert.equal(tourStops(graph, graphIndex, gone, NO_NODES)[0].layer, 'client');
  // Unlayered isn't listed among the layers, but the project always has it.
  const loose = agent([file('web', 'src/client/api.ts', [{ ...sym('web/src/client/api.ts#ItemSchema', 'deleted'), layer: UNLAYERED }])]);
  assert.equal(tourStops(graph, graphIndex, loose, NO_NODES)[0].layer, UNLAYERED);
});

test('a tour of thousands of changes is ordered without rescanning every stop at every step', () => {
  // One file, 30,000 changed functions in one layer: every tenth calls the next, the rest stand alone.
  const N = 30000;
  const placed = (id: string): GraphNode['layer'] => ({ id, confidence: 1, source: 'path', evidence: [] });
  const nodes: GraphNode[] = [
    { id: 'r', kind: 'repo', name: 'r', parent: 'root', repo: 'r' },
    { id: 'r/a.ts', kind: 'file', name: 'a.ts', parent: 'r', repo: 'r', path: 'a.ts', layer: placed('ui') },
  ];
  for (let i = 0; i < N; i++) nodes.push({ id: `r/a.ts#f${i}`, kind: 'symbol', name: `f${i}`, parent: 'r/a.ts', repo: 'r', path: 'a.ts', lines: [N - i, N - i], layer: placed('ui') });
  const edges = Array.from({ length: N / 10 }, (_, k) => ({ from: `r/a.ts#f${k * 10}`, to: `r/a.ts#f${k * 10 + 1}`, kind: 'calls' as const }));
  const idx = new Map(nodes.map((n) => [n.id, n]));
  const a = agent([file('r', 'a.ts', nodes.slice(2).map((n) => sym(n.id)))]);
  const t = performance.now();
  const stops = tourStops({ edges, layers: [{ id: 'ui', name: 'UI' }] }, idx, a, NO_NODES);
  const took = performance.now() - t;
  assert.ok(took < 2000, `ordered in ${Math.round(took)} ms`);
  assert.equal(stops.length, N);
  // A caller still comes straight before what it calls.
  const at = new Map(stops.map((s, i) => [s.id, i]));
  for (const e of edges) assert.equal(at.get(e.to)! - at.get(e.from)!, 1);
});

test('a tour of one change in each of thousands of files is built without a pass over every stop per file', () => {
  const N = 60000;
  const placed = (id: string): GraphNode['layer'] => ({ id, confidence: 1, source: 'path', evidence: [] });
  const nodes: GraphNode[] = [{ id: 'r', kind: 'repo', name: 'r', parent: 'root', repo: 'r' }];
  for (let i = 0; i < N; i++) {
    nodes.push({ id: `r/f${i}.ts`, kind: 'file', name: `f${i}.ts`, parent: 'r', repo: 'r', path: `f${i}.ts`, layer: placed('ui') });
    nodes.push({ id: `r/f${i}.ts#g`, kind: 'symbol', name: 'g', parent: `r/f${i}.ts`, repo: 'r', path: `f${i}.ts`, lines: [1, 3], layer: placed('ui') });
  }
  const idx = new Map(nodes.map((n) => [n.id, n]));
  const a = agent(Array.from({ length: N }, (_, i) => file('r', `f${i}.ts`, [sym(`r/f${i}.ts#g`)])));
  const t = performance.now();
  const stops = tourStops({ edges: [], layers: [{ id: 'ui', name: 'UI' }] }, idx, a, NO_NODES);
  const took = performance.now() - t;
  assert.ok(took < 2000, `built in ${Math.round(took)} ms`);
  assert.equal(stops.length, N);
  assert.ok(stops.every((s) => s.rest?.length === 1 && !s.restOld), 'each file’s one function carries its file');
});

test('a link between two files with thousands of changed functions each is not one link per pair', () => {
  const N = 10000;
  const placed = (id: string): GraphNode['layer'] => ({ id, confidence: 1, source: 'path', evidence: [] });
  const nodes: GraphNode[] = [{ id: 'r', kind: 'repo', name: 'r', parent: 'root', repo: 'r' }];
  // The caller sorts after the callee by path, so only the link puts it first.
  for (const f of ['a.ts', 'z.ts']) {
    nodes.push({ id: `r/${f}`, kind: 'file', name: f, parent: 'r', repo: 'r', path: f, layer: placed('ui') });
    for (let i = 0; i < N; i++) nodes.push({ id: `r/${f}#f${i}`, kind: 'symbol', name: `f${i}`, parent: `r/${f}`, repo: 'r', path: f, lines: [i + 1, i + 1], layer: placed('ui') });
  }
  const idx = new Map(nodes.map((n) => [n.id, n]));
  const syms = (f: string) => Array.from({ length: N }, (_, i) => sym(`r/${f}#f${i}`));
  const a = agent([file('r', 'a.ts', syms('a.ts')), file('r', 'z.ts', syms('z.ts'))]);
  const t = performance.now();
  const stops = tourStops({ edges: [{ from: 'r/z.ts', to: 'r/a.ts', kind: 'imports' }], layers: [{ id: 'ui', name: 'UI' }] }, idx, a, NO_NODES);
  const took = performance.now() - t;
  assert.ok(took < 2000, `ordered in ${Math.round(took)} ms`);
  assert.equal(stops.length, 2 * N);
  // Every caller still comes before the callee file's first function.
  const at = new Map(stops.map((s, i) => [s.id, i]));
  const lastCaller = Math.max(...Array.from({ length: N }, (_, i) => at.get(`r/z.ts#f${i}`)!));
  assert.ok(lastCaller < at.get('r/a.ts#f0')!);
});

test('a change whose repository is gone from the map is not on the tour', () => {
  const nodes: Record<string, NodeChange> = {
    'gone/app/x.py': { kind: 'modified', unit: 'file', at: 5, agents: ['a'], anchor: 'gone' },
  };
  const a = agent([{ ...file('gone', 'app/x.py'), node: undefined }, file('web', 'src/pages/about.tsx')]);
  assert.deepEqual(tourStops(graph, graphIndex, a, nodes).map((s) => s.id), ['web/src/pages/about.tsx']);
});

test("a file whose changed functions were all deleted still carries the file's other hunks once", () => {
  const a = agent([file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#OldA', 'deleted'), sym('web/src/client/api.ts#OldB', 'deleted')])]);
  const stops = tourStops(graph, graphIndex, a, NO_NODES);
  assert.deepEqual(
    stops.map((s) => [s.id, s.target, s.rest]),
    [
      ['web/src/client/api.ts#OldA', 'web/src/client/api.ts', ['web/src/client/api.ts#OldA', 'web/src/client/api.ts#OldB']],
      ['web/src/client/api.ts#OldB', 'web/src/client/api.ts', undefined],
    ],
  );
});

test('a deleted function waits for the changed code that uses its file', () => {
  // One layer: about.tsx imports the client file, whose OldA the agent deleted. By path OldA would come first.
  const flat = { ...graph, layers: [{ id: 'ui', name: 'UI' }] };
  const idx = new Map(graph.nodes.map((n) => [n.id, { ...n, layer: n.layer && { ...n.layer, id: 'ui' } }]));
  const a = agent([file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#OldA', 'deleted')]), file('web', 'src/pages/about.tsx')]);
  const ids = tourStops(flat, idx, a, NO_NODES).map((s) => s.id);
  assert.deepEqual(ids, ['web/src/pages/about.tsx', 'web/src/client/api.ts#OldA']);
});

test('reviewable: only when something the agent changed is on the map', () => {
  const nodes: Record<string, NodeChange> = { 'gone/app/x.py': { kind: 'modified', unit: 'file', at: 5, agents: ['a'], anchor: 'gone' } };
  assert.equal(reviewable(graphIndex, agent([{ ...file('gone', 'app/x.py'), node: undefined }]), nodes), false);
  assert.equal(reviewable(graphIndex, agent([file('web', 'src/pages/about.tsx')]), nodes), true);
});

test('loops: a long chain of stops is walked without running out of stack', () => {
  const n = 100_000;
  const next = Array.from({ length: n }, (_, i) => new Set(i + 1 < n ? [i + 1] : []));
  const comp = loops(next);
  assert.equal(new Set(comp).size, n, 'each stop on a chain is its own component');
  const cycle = [new Set([1]), new Set([2]), new Set([0]), new Set([0])];
  const c = loops(cycle);
  assert.equal(c[0], c[1]);
  assert.equal(c[1], c[2]);
  assert.notEqual(c[3], c[0], 'a stop leading into the loop is not part of it');
});

test('forgetMarks: clears every review’s read marks and nothing else', () => {
  const store = new Map<string, string>([['fiada.tour.p.a', '{}'], ['fiada.tour.q.b', '{}'], ['strata-theme', 'dark'], ['fiada.session', 's']]);
  const was = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    forgetMarks();
    assert.deepEqual([...store.keys()].sort(), ['fiada.session', 'strata-theme']);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = was;
  }
});
