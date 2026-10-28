import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeKind, GraphNode } from '@fiada/shared';
import { directZoom, enclose, frame, freeArea, smoothZoom, zoomAt, type Camera } from './camera.ts';
import { fixtureGraph } from './fixture.test-util.ts';
import { closedRadius, layoutExpanded, type Circle } from './layout.ts';
import { buildCodeTree, buildFunctionTree, locate, type Tree } from './tree.ts';
import { aggregateEdges, clickAction, contractLabel, crossRepo, direction, expandedNodes, indexEdges, meetingPoint, restLabel, withCollapsed, withPathOpen, withPathsOpen, type Visible } from './view.ts';

const graph = fixtureGraph();
const graphIndex = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
const code = buildCodeTree(graph);

/** The straightforward version of edge lifting, to check the indexed one against. */
function naiveContracts(tree: Tree, vis: Visible) {
  const visible = new Set(vis.list.map((n) => n.id));
  const lift = (id: string) => {
    let cur = locate(tree, graphIndex, id);
    while (cur && !visible.has(cur)) cur = tree.nodes.get(cur)?.parent ?? null;
    return cur;
  };
  const isAncestor = (anc: string, id: string) => {
    for (let n = tree.nodes.get(id); n?.parent; n = tree.nodes.get(n.parent)) if (n.parent === anc) return true;
    return false;
  };
  const out = new Map<string, number>();
  for (const e of graph.edges) {
    const a = lift(e.from);
    const b = lift(e.to);
    if (!a || !b || a === b || isAncestor(a, b) || isAncestor(b, a)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

test('opening and closing circles', () => {
  let open = new Set<string>();
  assert.deepEqual(
    expandedNodes(code, open).list.map((n) => n.id),
    ['web', 'api'],
  );
  open = withPathOpen(code, open, 'web/src/pages/items.tsx', true);
  assert.deepEqual([...open].sort(), ['web', 'web/src', 'web/src/pages', 'web/src/pages/items.tsx']);
  const vis = expandedNodes(code, open);
  assert.ok(vis.list.some((n) => n.id === 'web/src/pages/items.tsx#ItemsPage'));
  assert.ok(!vis.list.some((n) => n.id === 'web/src/client/api.ts'), 'a closed folder hides its contents');
  // Revealing a symbol opens its ancestors but a leaf has nothing to open.
  assert.deepEqual([...withPathOpen(code, new Set(), 'api/app/models.py#Item', true)].sort(), ['api', 'api/app', 'api/app/models.py']);
  // Closing a folder closes everything opened inside it.
  assert.deepEqual([...withCollapsed(code, open, 'web/src')].sort(), ['web']);
});

test('opening the way to several changes at once, down to their functions while that stays small', () => {
  const ids = ['web/src/pages/items.tsx#ItemsPage', 'api/app/models.py#Item'];
  // Deep: each function's file opens, so the functions show.
  assert.deepEqual([...withPathsOpen(code, new Set(), ids, 16)].sort(), ['api', 'api/app', 'api/app/models.py', 'web', 'web/src', 'web/src/pages', 'web/src/pages/items.tsx']);
  // Too many for that: down to the files, which stay closed.
  assert.deepEqual([...withPathsOpen(code, new Set(), ids, 5)].sort(), ['api', 'api/app', 'web', 'web/src', 'web/src/pages']);
  // Too many even then: nothing new opens, and what was open stays open.
  assert.deepEqual([...withPathsOpen(code, new Set(['api']), ids, 2)], ['api']);
});

test('click mode: the first click selects, a second click on the selection opens', () => {
  const file = code.nodes.get('web/src/pages/items.tsx')!;
  const symbol = code.nodes.get('web/src/pages/items.tsx#ItemsPage')!;
  assert.equal(clickAction(file, null, false), 'select');
  assert.equal(clickAction(file, 'web/src/client/api.ts', false), 'select');
  assert.equal(clickAction(file, file.id, false), 'open');
  // Already open, or nothing inside: a second click has nothing to do.
  assert.equal(clickAction(file, file.id, true), 'none');
  assert.equal(clickAction(symbol, null, false), 'select');
  assert.equal(clickAction(symbol, symbol.id, false), 'none');
});

test('indexed edge lifting matches the straightforward version', () => {
  const ix = indexEdges(code, graphIndex, graph.edges);
  const ids = [...code.nodes.keys()].filter((id) => code.nodes.get(id)!.children.length && id !== 'root');
  // Every combination of open containers (there are few enough).
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const open = new Set(ids.filter((_, i) => mask & (1 << i)));
    const vis = expandedNodes(code, open);
    const got = new Map(aggregateEdges(ix, vis).map((c) => [c.key, c.items.length]));
    assert.deepEqual(got, naiveContracts(code, vis), `open: ${[...open].join(', ')}`);
  }
});

test('edges reattach to the inner component that is responsible', () => {
  const ix = indexEdges(code, graphIndex, graph.edges);
  const closed = aggregateEdges(ix, expandedNodes(code, new Set()));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].key, 'api|web');
  assert.equal(closed[0].cross, 2);
  assert.equal(closed[0].items.length, 2);
  assert.equal(closed[0].inferred, 1);
  // Both requests run from web to api, and the tag says what they are.
  assert.deepEqual(direction(closed[0]), ['web', 'api', false]);
  assert.equal(closed[0].tag, 'HTTP · 2');

  const open = withPathOpen(code, withPathOpen(code, new Set(), 'web/src/client/api.ts', true), 'api/app/routes/items.py', true);
  const opened = aggregateEdges(ix, expandedNodes(code, open));
  const http = opened.find((c) => c.kinds.has('http'))!;
  assert.equal(http.key, 'api/app/routes/items.py#create_item|web/src/client/api.ts#ItemsService');
  // Opened up, the guessed request is a contract of its own, drawn as inferred; the proven one isn't.
  assert.equal(http.inferred, http.items.length);
  assert.equal(opened.find((c) => c.key === 'api/app/routes/items.py#read_items|web/src/client/api.ts#ItemsService')?.inferred, 0);
});

test('a link is cross-repo only when the interactions behind it are', () => {
  // Domains and layers belong to no one repository, so this can't come from the ends drawn:
  // with the UI layer open and Client closed, useItems → Client stays inside web.
  const layered = fixtureGraph();
  layered.layers.push({ id: 'client', name: 'Client' }, { id: 'api', name: 'API' });
  for (const n of layered.nodes) {
    const layer = n.id.startsWith('web/src/client') ? 'client' : n.repo === 'api' ? 'api' : null;
    if (layer && n.layer) n.layer = { ...n.layer, id: layer };
  }
  const fn = buildFunctionTree(layered);
  const index = new Map<string, GraphNode>(layered.nodes.map((n) => [n.id, n]));
  const ix = indexEdges(fn, index, layered.edges);
  const repoOf = (id: string) => index.get(id)?.repo;
  let mixedEnds = 0;
  for (const id of fn.nodes.keys()) {
    for (const vis of [expandedNodes(fn, withPathOpen(fn, new Set(), id, true)), expandedNodes(fn, withPathOpen(fn, new Set(), id, false))]) {
      for (const c of aggregateEdges(ix, vis)) {
        const cross = c.items.filter((e) => repoOf(e.from) !== repoOf(e.to)).length;
        assert.equal(c.cross, cross, `${c.key} with ${id} open`);
        assert.equal(crossRepo(c), cross * 2 >= c.items.length && cross > 0);
        if (!cross && fn.nodes.get(c.a)!.repo !== fn.nodes.get(c.b)!.repo) mixedEnds++;
      }
    }
  }
  assert.ok(mixedEnds > 0, 'some same-repo links run between a symbol and a layer');
});

test('link labels say what the link is', () => {
  const e = (kind: EdgeKind, basis?: 'inferred') => ({ from: 'a', to: 'b', kind, basis });
  const label = (items: ReturnType<typeof e>[]) => contractLabel({ items, inferred: items.filter((x) => x.basis).length });
  assert.equal(label([e('calls')]), '1 call');
  assert.equal(label([e('calls'), e('calls'), e('imports')]), '2 calls +1');
  assert.equal(label([e('http', 'inferred')]), 'HTTP · 1?');
  assert.equal(label([e('type'), e('type')]), '2 types');
  // No one kind makes up two thirds: name the leading ones.
  assert.equal(label([e('calls'), e('calls'), e('type'), e('type')]), '4 calls & types');
  assert.equal(label([e('calls'), e('calls'), e('type'), e('type'), e('http')]), '5 calls, types…');
});

test('resting links say how many and what, in plain words', () => {
  const e = (kind: EdgeKind, basis?: 'inferred') => ({ from: 'a', to: 'b', kind, basis });
  const label = (items: ReturnType<typeof e>[]) => restLabel({ items, inferred: items.filter((x) => x.basis).length });
  assert.equal(label([e('calls')]), '1 call');
  assert.equal(label(Array.from({ length: 12 }, () => e('calls'))), '12 calls');
  assert.equal(label([e('http'), e('http'), e('http')]), '3 requests');
  assert.equal(label([e('imports'), e('imports')]), '2 imports');
  // A few of another kind don't crowd the words: the main kind only, no "+1".
  assert.equal(label([e('calls'), e('calls'), e('calls'), e('imports')]), '3 calls');
  assert.equal(label([e('calls'), e('calls'), e('type'), e('type')]), '4 calls & types');
  assert.equal(label([e('http', 'inferred'), e('http', 'inferred')]), '2 requests?');
  assert.equal(label([]), '');
});

test('a link sits in the innermost circle holding both ends', () => {
  assert.equal(meetingPoint(code, 'web/src/pages/items.tsx', 'web/src/client/api.ts'), 'web/src');
  assert.equal(meetingPoint(code, 'web/src/pages', 'api/app'), 'root');
  assert.equal(meetingPoint(code, 'web/src/pages/items.tsx#ItemsPage', 'web/src/pages'), 'web/src/pages');
});

test('by-function tree keeps symbol ids, so edges resolve the same way', () => {
  const fn = buildFunctionTree(graph);
  const ix = indexEdges(fn, graphIndex, graph.edges);
  const all = new Set([...fn.nodes.keys()].filter((id) => fn.nodes.get(id)!.children.length));
  const got = aggregateEdges(ix, expandedNodes(fn, all));
  assert.ok(got.some((c) => c.key === 'api/app/routes/items.py#read_items|web/src/client/api.ts#ItemsService'));
});

const inside = (c: Circle, p: Circle) => Math.hypot(c.x - p.x, c.y - p.y) + c.r <= p.r + 1e-6;

test('click-mode layout: children inside parents, siblings apart, closed sizes stable', () => {
  const closed = layoutExpanded(code, new Set());
  const open = withPathOpen(code, new Set(), 'web/src/pages/items.tsx', true);
  const L = layoutExpanded(code, open);
  const vis = expandedNodes(code, open);
  for (const n of vis.list) {
    const c = L.get(n.id)!;
    assert.ok(c, `${n.id} has a circle`);
    assert.ok(inside(c, L.get(n.parent!)!), `${n.id} sits inside its parent`);
    if (!vis.open.has(n.id)) assert.ok(Math.abs(c.r - closedRadius(n)) < 1e-9, `${n.id} keeps its closed radius`);
    for (const m of vis.list)
      if (m !== n && m.parent === n.parent) {
        const d = L.get(m.id)!;
        assert.ok(Math.hypot(c.x - d.x, c.y - d.y) >= c.r + d.r - 1e-6, `${n.id} and ${m.id} don't overlap`);
      }
  }
  // Nothing inside a closed circle is laid out, and a closed neighbour is the same size either way.
  assert.equal(L.has('web/src/client/api.ts'), false);
  assert.equal(L.get('api')!.r, closed.get('api')!.r);
  assert.ok(L.get('web')!.r > closed.get('web')!.r, 'an open circle grows to fit its contents');
});

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const sameCam = (a: Camera, b: Camera) => near(a.k, b.k) && near(a.tx, b.tx) && near(a.ty, b.ty);

test('camera framing avoids panels while there is room', () => {
  const c = { x: 10, y: -20, r: 50 };
  const vp = { w: 1440, h: 852, left: 316, right: 356 };
  const f = freeArea(vp);
  assert.equal(f.w, 1440 - 316 - 356);
  const cam = frame(c, vp, 0.4);
  assert.ok(near(cam.tx + c.x * cam.k, f.cx) && near(cam.ty + c.y * cam.k, f.cy), 'centred in the free area');
  assert.ok(near(c.r * cam.k, f.side * 0.4));
  assert.equal(frame(c, vp, 0.4, 2).k, 2, 'respects a zoom cap');
  // On a narrow stage the panels are ignored rather than squeezing the map to nothing.
  assert.equal(freeArea({ w: 700, h: 600, left: 316, right: 356 }).w, 700);
});

test('camera helpers', () => {
  const a = { x: 0, y: 0, r: 10 };
  const b = { x: 100, y: 0, r: 20 };
  const e = enclose(a, b);
  assert.ok(inside(a, e) && inside(b, e));
  assert.ok(near(e.r, 65));
  assert.deepEqual(enclose(a, { x: 1, y: 0, r: 2 }), a);

  const cam = { k: 2, tx: 30, ty: -40 };
  const z = zoomAt(cam, 3, 200, 100);
  assert.ok(near((200 - z.tx) / z.k, (200 - cam.tx) / cam.k), 'the point under the pointer stays put');

  const target = { k: 0.5, tx: 700, ty: 300 };
  const anchor = { x: 720, y: 426 };
  const s = smoothZoom(cam, target, anchor, 852);
  assert.ok(sameCam(s.interpolate(0), cam) && sameCam(s.interpolate(1), target));
  assert.ok(s.duration > 0);
  const d = directZoom(cam, target, anchor);
  assert.ok(sameCam(d(0), cam) && sameCam(d(1), target));
});
