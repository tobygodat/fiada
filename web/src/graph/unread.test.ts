import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentActivity, AgentFile, GraphNode, NodeChange } from '@fiada/shared';
import { readWords, rollupActivity } from './activity.ts';
import { fixtureGraph } from './fixture.test-util.ts';
import { buildCodeTree } from './tree.ts';
import { agentRead, agentUnreadIds, forgetRead, loadRead, markAgentRead, markAllRead, markRead, saveRead, unreadIds } from './unread.ts';

const change = (kind: NodeChange['kind'], unit: NodeChange['unit'], at: number, agents = ['a'], anchor?: string): NodeChange => ({ kind, unit, at, agents, anchor });

const nodes = {
  'web/src/pages/items.tsx': change('modified', 'file', 10),
  'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 10),
  'web/src/pages/items.tsx#useTags': change('added', 'symbol', 20, ['a'], 'web/src/pages/items.tsx'),
  'web/src/pages/tags.tsx': change('added', 'file', 30, ['b'], 'web/src/pages'),
  'api/app/routes/old.py': change('deleted', 'file', 5, ['a'], 'api/app/routes'),
} satisfies Record<string, NodeChange>;

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

test("opening each changed function doesn't read the file: its change can reach outside them", () => {
  let marks = markRead({}, 'web/src/pages/items.tsx#ItemsPage', nodes)!;
  marks = markRead(marks, 'web/src/pages/items.tsx#useTags', nodes)!;
  const u = unreadIds(nodes, marks);
  assert.ok(!u.has('web/src/pages/items.tsx#ItemsPage') && !u.has('web/src/pages/items.tsx#useTags'));
  assert.ok(u.has('web/src/pages/items.tsx'), 'the file itself still to open');
});

test('opening the folder that stands in for a deleted file reads it', () => {
  const marks = markRead({}, 'api/app/routes', nodes)!;
  assert.ok(!unreadIds(nodes, marks).has('api/app/routes/old.py'));
});

test('mark all read', () => {
  const all = markAllRead({}, nodes)!;
  assert.equal(unreadIds(nodes, all).size, 0);
  assert.equal(markAllRead(all, nodes), null, 'already read: nothing to save');
});

test("marking one agent read leaves another agent's later change to the same file unread", () => {
  // Agent a changed items.tsx at 10; agent b changed it again at 20. The node keeps the newest time.
  const shared = {
    'web/src/pages/items.tsx': change('modified', 'file', 20, ['a', 'b']),
    'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 20, ['a', 'b']),
    'web/src/pages/tags.tsx': change('added', 'file', 15, ['a']),
  } satisfies Record<string, NodeChange>;

  const iso = (ms: number) => new Date(ms).toISOString();

  const a = {
    id: 'a',
    files: [
      { repo: 'web', path: 'src/pages/items.tsx', node: 'web/src/pages/items.tsx', kind: 'modified', symbols: [{ id: 'web/src/pages/items.tsx#ItemsPage', name: 'ItemsPage', kind: 'modified' }], at: iso(10) },
      { repo: 'web', path: 'src/pages/tags.tsx', node: 'web/src/pages/tags.tsx', kind: 'added', symbols: [], at: iso(15) },
    ],
  } as AgentActivity;

  const marks = markAgentRead({}, a)!;
  const u = unreadIds(shared, marks);
  assert.ok(!u.has('web/src/pages/tags.tsx'), "a's own change is read");
  assert.ok(u.has('web/src/pages/items.tsx'), "b's later change is still unread");
  assert.ok(u.has('web/src/pages/items.tsx#ItemsPage'));
  assert.equal(markAgentRead(marks, a), null, 'nothing new to mark');
  assert.deepEqual(agentRead(a, u, marks, shared), { read: 2, total: 2 }, "a counts its own changes read; b's is b's to read");
  const b = { id: 'b', files: [{ ...a.files[0], at: iso(20) }] } as AgentActivity;
  assert.deepEqual(agentRead(b, u, marks, shared), { read: 0, total: 1 });
  // Lit on the map, each agent shows only what is unread for it.
  assert.deepEqual([...agentUnreadIds(a, u, marks, shared)], []);
  assert.deepEqual([...agentUnreadIds(b, u, marks, shared)].sort(), ['web/src/pages/items.tsx', 'web/src/pages/items.tsx#ItemsPage']);
});

test("a lit agent's function you opened stays read when another agent changes it later", () => {
  // a changed ItemsPage and useTags at 10; you opened ItemsPage; b changed ItemsPage at 20.
  const two = {
    'web/src/pages/items.tsx': change('modified', 'file', 20, ['a', 'b']),
    'web/src/pages/items.tsx#ItemsPage': change('modified', 'symbol', 20, ['a', 'b']),
    'web/src/pages/items.tsx#useTags': change('added', 'symbol', 10, ['a']),
  } satisfies Record<string, NodeChange>;

  const a = {
    id: 'a',
    files: [
      {
        repo: 'web',
        path: 'src/pages/items.tsx',
        node: 'web/src/pages/items.tsx',
        kind: 'modified',
        symbols: [
          { id: 'web/src/pages/items.tsx#ItemsPage', name: 'ItemsPage', kind: 'modified' },
          { id: 'web/src/pages/items.tsx#useTags', name: 'useTags', kind: 'added' },
        ],
        at: new Date(10).toISOString(),
      },
    ],
  } as AgentActivity;

  const marks = { 'web/src/pages/items.tsx#ItemsPage': 10 };
  const u = unreadIds(two, marks);
  assert.ok(u.has('web/src/pages/items.tsx#ItemsPage'), "b's change is unread overall");
  assert.deepEqual([...agentUnreadIds(a, u, marks, two)].sort(), ['web/src/pages/items.tsx', 'web/src/pages/items.tsx#useTags']);
});

test('an agent says how many of its files you have read', () => {
  const file = (path: string, node?: string): AgentFile => ({ repo: 'web', path, node, kind: 'modified', symbols: [], at: '2026-10-08T10:00:00Z', diff: false });
  const a = { id: 'a', files: [file('src/pages/items.tsx', 'web/src/pages/items.tsx'), file('src/pages/tags.tsx'), file('/elsewhere.ts')] } as AgentActivity;
  a.files[2].repo = undefined;
  const marks = markRead({}, 'web/src/pages/items.tsx', nodes)!;
  const u = unreadIds(nodes, marks);
  assert.deepEqual(agentRead(a, u, marks, nodes), { read: 2, total: 3 }, 'a file off the map has nothing to read');
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
    removeItem: (k: string) => store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };

  try {
    saveRead('p1', { 'web/src/a.ts': 10 });
    assert.deepEqual(loadRead('p1'), { 'web/src/a.ts': 10 });
    assert.deepEqual(loadRead('p2'), {}, 'another project starts unread');
    store.set('fiada.read.p3', '{"x": "nope", "y": 3}');
    assert.deepEqual(loadRead('p3'), { y: 3 });
    store.set('fiada.read.p4', 'not json');
    assert.deepEqual(loadRead('p4'), {});
    store.set('strata-theme', 'dark');
    forgetRead();
    assert.deepEqual([...store.keys()], ['strata-theme'], 'deleting the account forgets every read mark, nothing else');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("a lit agent's functions go by its own change time to each, not its latest to the file", () => {
  // a changed foo at 10; b changed foo at 20; a changed bar at 30. You opened foo at 20.
  const three = {
    'web/src/pages/items.tsx': change('modified', 'file', 30, ['a', 'b']),
    'web/src/pages/items.tsx#foo': change('modified', 'symbol', 20, ['a', 'b']),
    'web/src/pages/items.tsx#bar': change('modified', 'symbol', 30, ['a']),
  } satisfies Record<string, NodeChange>;

  const iso = (ms: number) => new Date(ms).toISOString();

  const a = {
    id: 'a',
    files: [
      {
        repo: 'web',
        path: 'src/pages/items.tsx',
        node: 'web/src/pages/items.tsx',
        kind: 'modified',
        symbols: [
          { id: 'web/src/pages/items.tsx#foo', name: 'foo', kind: 'modified', at: iso(10) },
          { id: 'web/src/pages/items.tsx#bar', name: 'bar', kind: 'modified', at: iso(30) },
        ],
        at: iso(30),
      },
    ],
  } as AgentActivity;

  const opened = { 'web/src/pages/items.tsx#foo': 20 };
  const u = unreadIds(three, opened);
  // Lit, a shows bar unread, not foo: its change to foo came before you opened it.
  assert.deepEqual([...agentUnreadIds(a, u, opened, three)].sort(), ['web/src/pages/items.tsx', 'web/src/pages/items.tsx#bar']);
  // Marking a read marks each function at a's own time for it, not its latest change to the file.
  const marks = markAgentRead({}, a)!;
  assert.equal(marks['web/src/pages/items.tsx#foo'], 10);
  assert.equal(marks['web/src/pages/items.tsx#bar'], 30);
});
