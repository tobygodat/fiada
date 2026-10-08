import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureGraph } from './fixture.test-util.ts';
import { searchNodes, whereOf } from './search.ts';
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
