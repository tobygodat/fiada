import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentActivity, AgentFile, GraphNode, NodeChange } from '@fiada/shared';
import { readWords, rollupActivity } from './activity.ts';
import { fixtureGraph } from './fixture.test-util.ts';
import { buildCodeTree } from './tree.ts';
import { agentRead, loadRead, markAllRead, markRead, saveRead, unreadIds } from './unread.ts';

const change = (kind: NodeChange['kind'], unit: NodeChange['unit'], at: number, agents = ['a'], anchor?: string): NodeChange => ({ kind, unit, at, agents, anchor });

const nodes: Record<string, NodeChange> = {
  'web/src/pages/items.tsx': change('modified', 'file', 10),
  'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 10),
  'web/src/pages/items.tsx#useTags': change('added', 'symbol', 20, ['a'], 'web/src/pages/items.tsx'),
  'web/src/pages/tags.tsx': change('added', 'file', 30, ['b'], 'web/src/pages'),
  'api/app/routes/old.py': change('deleted', 'file', 5, ['a'], 'api/app/routes'),
};

test('every change is unread until something is opened', () => {
  assert.deepEqual([...unreadIds(nodes, {})].sort(), Object.keys(nodes).sort());
});

test('opening a file reads it and the functions it changed, up to the latest change there', () => {
  const marks = markRead({}, 'web/src/pages/items.tsx', nodes);
  assert.deepEqual(marks, { 'web/src/pages/items.tsx': 20 }, 'the latest change shown there, on the indexer clock');
  const u = unreadIds(nodes, marks!);
  assert.ok(!u.has('web/src/pages/items.tsx'));
  assert.ok(!u.has('web/src/pages/items.tsx#ItemsPage'));
  assert.ok(!u.has('web/src/pages/items.tsx#useTags'));
  assert.ok(u.has('web/src/pages/tags.tsx'));
  assert.equal(markRead(marks!, 'web/src/pages/items.tsx', nodes), null, 'nothing new: no new marks');
});

test('a change after you looked is unread again', () => {
  const marks = markRead({}, 'web/src/pages/items.tsx', nodes)!;
  const later = { ...nodes, 'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 40) };
  const u = unreadIds(later, marks);
  assert.ok(u.has('web/src/pages/items.tsx#ItemsPage'));
  assert.ok(u.has('web/src/pages/items.tsx'), 'the file with an unread function in it is unread too');
});

test('opening each changed function reads the file, unless the file changed after them', () => {
  let marks = markRead({}, 'web/src/pages/items.tsx#ItemsPage', nodes)!;
  assert.ok(unreadIds(nodes, marks).has('web/src/pages/items.tsx'), 'one of two functions read');
  marks = markRead(marks, 'web/src/pages/items.tsx#useTags', nodes)!;
  assert.ok(!unreadIds(nodes, marks).has('web/src/pages/items.tsx'), 'both read: the file is read');
  const fileLater = { ...nodes, 'web/src/pages/items.tsx': change('modified', 'file', 50) };
  assert.ok(unreadIds(fileLater, marks).has('web/src/pages/items.tsx'), 'the file changed again outside them');
});

test('opening the folder that stands in for a deleted file reads it', () => {
  const marks = markRead({}, 'api/app/routes', nodes)!;
  assert.ok(!unreadIds(nodes, marks).has('api/app/routes/old.py'));
});

test('mark all read, for everyone or one agent', () => {
  const one = markAllRead({}, nodes, 'b')!;
  assert.deepEqual([...unreadIds(nodes, one)].includes('web/src/pages/tags.tsx'), false);
  assert.equal(unreadIds(nodes, one).size, Object.keys(nodes).length - 1);
  const all = markAllRead(one, nodes)!;
  assert.equal(unreadIds(nodes, all).size, 0);
  assert.equal(markAllRead(all, nodes), null, 'already read: nothing to save');
});

test('an agent says how many of its files you have read', () => {
  const file = (path: string, node?: string): AgentFile => ({ repo: 'web', path, node, kind: 'modified', symbols: [], at: '2026-10-08T10:00:00Z' }) as unknown as AgentFile;
  const a = { id: 'a', files: [file('src/pages/items.tsx', 'web/src/pages/items.tsx'), file('src/pages/tags.tsx'), file('/elsewhere.ts')] } as unknown as AgentActivity;
  a.files[2].repo = undefined;
  const u = unreadIds(nodes, markRead({}, 'web/src/pages/items.tsx', nodes)!);
  assert.deepEqual(agentRead(a, u), { read: 2, total: 3 }, 'a file off the map has nothing to read');
  assert.equal(readWords(12, 19), '12 of 19 changes read');
  assert.equal(readWords(1, 1), '1 of 1 change read');
});

test('closed circles count what is unread inside, and changed nodes say they are unread', () => {
  const graph = fixtureGraph();
  const graphIndex = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const tree = buildCodeTree(graph);
  const all = rollupActivity(tree, graphIndex, nodes, [], unreadIds(nodes, {}));
  assert.equal(all.get('web/src/pages')?.unread, 2, 'items.tsx and tags.tsx');
  assert.equal(all.get('web/src/pages/items.tsx')?.selfUnread, true);
  const marks = markRead({}, 'web/src/pages/items.tsx', nodes)!;
  const some = rollupActivity(tree, graphIndex, nodes, [], unreadIds(nodes, marks));
  assert.equal(some.get('web/src/pages')?.unread, 1);
  assert.equal(some.get('web/src/pages/items.tsx')?.selfUnread, false);
  assert.equal(some.get('web')?.unread, 1);
  const none = rollupActivity(tree, graphIndex, nodes);
  assert.equal(none.get('web/src/pages')?.unread, 0, 'no read state: nothing counted unread');
});

test('read marks are kept per project and survive bad storage', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  try {
    saveRead('p1', { 'web/src/a.ts': 10 });
    assert.deepEqual(loadRead('p1'), { 'web/src/a.ts': 10 });
    assert.deepEqual(loadRead('p2'), {}, 'another project starts unread');
    store.set('fiada.read.p3', '{"x": "nope", "y": 3}');
    assert.deepEqual(loadRead('p3'), { y: 3 });
    store.set('fiada.read.p4', 'not json');
    assert.deepEqual(loadRead('p4'), {});
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
