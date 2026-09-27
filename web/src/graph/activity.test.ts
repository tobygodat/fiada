import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphNode, NodeChange } from '@strata/shared';
import { rollupActivity } from './activity.ts';
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

const pick = (m: ReturnType<ReturnType<typeof rollupActivity>['get']>) => m && { self: m.self, added: m.added, modified: m.modified, deleted: m.deleted, at: m.at };
