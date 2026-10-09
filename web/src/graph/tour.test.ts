import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentActivity, AgentFile, GraphNode, NodeChange } from '@fiada/shared';
import { fixtureGraph } from './fixture.test-util.ts';
import { isRead, markStop, nextUnread, reviewable, tourStops, type ReadMarks } from './tour.ts';

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

test("a function's own change time is its read mark's: editing another function in its file doesn't unread it", () => {
  const t = '2026-09-27T10:00:00Z';
  const later = '2026-09-27T10:05:00Z';
  const a = agent([
    {
      ...file('web', 'src/client/api.ts', [
        { ...sym('web/src/client/api.ts#ItemsService'), at: t },
        { ...sym('web/src/client/api.ts#UsersService'), at: later },
      ]),
      at: later,
    },
  ]);
  const stops = Object.fromEntries(tourStops(graph, graphIndex, a, NO_NODES).map((s) => [s.id, s]));
  const marks: ReadMarks = { 'web/src/client/api.ts#ItemsService': Date.parse(t), 'web/src/client/api.ts#UsersService': Date.parse(t) };
  assert.equal(isRead(marks, stops['web/src/client/api.ts#ItemsService']), true);
  assert.equal(isRead(marks, stops['web/src/client/api.ts#UsersService']), false);
  // From an indexer without per-function times, the file's time counts for each.
  const old = agent([{ ...file('web', 'src/client/api.ts', [sym('web/src/client/api.ts#ItemsService')]), at: later }]);
  assert.equal(isRead(marks, tourStops(graph, graphIndex, old, NO_NODES)[0]), false);
});

test("a change to the file's other code (an import) unreads the stop that shows it, and only that one", () => {
  const t = '2026-09-27T10:00:00Z';
  const later = '2026-09-27T10:05:00Z';
  const fns = [
    { ...sym('web/src/client/api.ts#ItemsService'), at: t },
    { ...sym('web/src/client/api.ts#UsersService'), at: t },
  ];
  const stops = (topAt: string, symbols = fns) => tourStops(graph, graphIndex, agent([{ ...file('web', 'src/client/api.ts', symbols), at: topAt, topAt }]), NO_NODES);
  let marks: ReadMarks = {};
  for (const s of stops(t)) marks = markStop(marks, s, true);
  const read = (topAt: string, symbols = fns) => stops(topAt, symbols).map((s) => [s.id, !!s.rest, isRead(marks, s)]);
  assert.deepEqual(read(t), [
    ['web/src/client/api.ts#ItemsService', true, true],
    ['web/src/client/api.ts#UsersService', false, true],
  ]);
  // The agent changes an import since: the first stop, which carries the file's other hunks, is new again.
  assert.deepEqual(read(later), [
    ['web/src/client/api.ts#ItemsService', true, false],
    ['web/src/client/api.ts#UsersService', false, true],
  ]);
  // The new import read on ItemsService, then the agent takes ItemsService back: UsersService, read
  // before the import changed, now shows it, and both stay read, since the import's mark is the file's.
  marks = markStop(marks, stops(later)[0], true);
  assert.deepEqual(read(later, fns.slice(1)), [['web/src/client/api.ts#UsersService', true, true]]);
  // Read on UsersService, a later import is new on whichever stop shows it.
  marks = markStop({}, stops(t, fns.slice(1))[0], true);
  assert.deepEqual(read(t), [
    ['web/src/client/api.ts#ItemsService', true, false],
    ['web/src/client/api.ts#UsersService', false, true],
  ]);
  marks = markStop(marks, stops(t)[0], true);
  assert.deepEqual(read(later).map((r) => r[2]), [false, true]);
  // Unmarking the stop unmarks the import it shows too.
  marks = markStop(marks, stops(t)[0], false);
  assert.equal(marks['web/src/client/api.ts'], undefined);
});
