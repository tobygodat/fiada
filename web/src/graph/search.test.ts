import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphNode } from '@fiada/shared';
import { fixtureGraph } from './fixture.test-util.ts';
import { onMap, searchNodes, whereOf } from './search.ts';
import { buildCodeTree, buildFunctionTree, locate } from './tree.ts';

const graph = fixtureGraph();
const ids = (q: string, limit?: number) => searchNodes(graph.nodes, q, limit).map((h) => h.id);

test('a blank query finds nothing', () => {
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('   '), []);
});

test('exact names come first, then names that start with the query', () => {
  assert.deepEqual(ids('item').slice(0, 3), ['api/app/models.py#Item', 'api/app/routes/items.py', 'web/src/pages/items.tsx']);
  assert.equal(ids('itemspage')[0], 'web/src/pages/items.tsx#ItemsPage');
});

test('repos, folders, files and symbols are all found', () => {
  assert.equal(ids('web')[0], 'web');
  assert.equal(ids('client')[0], 'web/src/client');
  assert.equal(ids('about')[0], 'web/src/pages/about.tsx');
  assert.equal(ids('usersservice')[0], 'web/src/client/api.ts#UsersService');
});

test('a word inside a name beats the same letters elsewhere', () => {
  // "Service" starts a word in ItemsService and UsersService.
  const hits = searchNodes(graph.nodes, 'service');
  assert.deepEqual(hits.map((h) => h.id).slice(0, 2), ['web/src/client/api.ts#ItemsService', 'web/src/client/api.ts#UsersService']);
  assert.deepEqual(hits[0].span, [5, 12]);
});

test('matches in the path and letters in order are found last', () => {
  // read_items's own name doesn't contain "routes"; its path does.
  assert.ok(ids('routes', 20).includes('api/app/routes/items.py#read_items'));
  assert.equal(ids('itsvc')[0], 'web/src/client/api.ts#ItemsService');
  assert.deepEqual(ids('zzz'), []);
});

test('the limit caps the list', () => {
  assert.equal(ids('i', 3).length, 3);
});

test('each hit says where it lives', () => {
  const at = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(whereOf(at.get('web')!), '');
  assert.equal(whereOf(at.get('web/src/pages/items.tsx')!), 'web/src/pages');
  assert.equal(whereOf(at.get('web/src/pages/items.tsx#useItems')!), 'web/src/pages/items.tsx');
});

test('every hit can be found on the map in both views', () => {
  const index = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const tree of [buildCodeTree(graph), buildFunctionTree(graph)]) {
    for (const h of searchNodes(graph.nodes, 'i', 100)) assert.ok(locate(tree, index, h.id), h.id);
  }
});

test('a collapsed folder chain says where it really hangs', () => {
  const n = { id: 'svc/src/main/java', kind: 'folder', name: 'src/main/java', parent: 'svc', repo: 'svc' } as const;
  assert.equal(whereOf(n), 'svc');
  assert.equal(searchNodes([n], 'java')[0].where, 'svc');
});

test('two symbols with one name in one file say their lines', () => {
  const at = (line: number, suffix = '') => ({ id: `r/a.ts#render${suffix}`, kind: 'symbol', name: 'render', parent: 'r/a.ts', repo: 'r', lines: [line, line + 4] as [number, number] }) as const;
  const hits = searchNodes([at(3), at(20, '~2')], 'render');
  assert.deepEqual(hits.map((h) => h.where), ['r/a.ts:3', 'r/a.ts:20']);
});

test('two repos of one name say their ids', () => {
  const repo = (id: string) => ({ id, kind: 'repo', name: 'app', parent: 'root', repo: id }) as const;
  assert.deepEqual(searchNodes([repo('app'), repo('app-2')], 'app').map((h) => h.where), ['', 'app-2']);
  // Past the first 12 of one name, the id still finds it.
  const many = Array.from({ length: 14 }, (_, i) => repo(i ? `app-${i + 1}` : 'app'));
  assert.deepEqual(searchNodes(many, 'app-13').map((h) => h.id), ['app-13']);
});

test('keeping only the best while scanning gives the same order as sorting everything', () => {
  // A big made-up project: the top 12 must match a full sort of every hit.
  const nodes: GraphNode[] = [];

  for (let i = 0; i < 3000; i++) nodes.push({ id: `r/f${i % 97}.ts#s${i}`, kind: 'symbol', name: `${['item', 'items', 'getItem', 'x'][i % 4]}${i % 7 ? i : ''}`, parent: `r/f${i % 97}.ts`, repo: 'r' });

  for (const q of ['i', 'item', 'it', 'x1', 'gi']) {
    const all = searchNodes(nodes, q, nodes.length).map((h) => h.id);
    assert.deepEqual(searchNodes(nodes, q, 12).map((h) => h.id), all.slice(0, 12), q);
  }
});

test('the by-function view searches only what it draws', () => {
  const code = onMap(graph.nodes, buildCodeTree(graph)).map((n) => n.id);
  assert.equal(code.length, graph.nodes.length);
  const fn = onMap(graph.nodes, buildFunctionTree(graph)).map((n) => n.id);
  // No repos or folders, and files only where they hold no symbols.
  assert.ok(!fn.includes('web'));
  assert.ok(!fn.includes('web/src/client'));
  assert.ok(!fn.includes('web/src/pages/items.tsx'));
  assert.ok(fn.includes('web/src/pages/about.tsx'));
  assert.ok(fn.includes('web/src/client/api.ts#ItemsService'));
});
