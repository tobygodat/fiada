// What is on screen: which circles are open (showing their children), and the
// edges aggregated up to whatever is visible.
//
// Two ways to decide what's open:
//   click mode  the user opens and closes circles; zooming is pure scale.
//   zoom mode   a circle opens once it is big enough on screen.

import type { EdgeKind, GraphEdge, GraphNode } from '@strata/shared';
import type { Camera } from './camera.ts';
import type { Circle } from './layout.ts';
import { locate, type Tree, type TNode } from './tree.ts';

export type ExpandMode = 'click' | 'zoom';

/** Zoom mode: a circle opens into its children once it is this many pixels in radius. */
export const OPEN_PX = 130;

export interface Visible {
  /** Nodes to consider, parents before children. */
  list: TNode[];
  open: Set<string>;
  /** Stable key of the open set, for memoising edge aggregation. */
  key: string;
}

/** Zoom mode: open every circle that is on screen and at least OPEN_PX in radius. */
export function visibleNodes(tree: Tree, L: Map<string, Circle>, cam: Camera, w: number, h: number): Visible {
  const list: TNode[] = [];
  const open = new Set<string>(['root']);
  const margin = 200;
  const onScreen = (c: Circle) => {
    const sx = cam.tx + c.x * cam.k;
    const sy = cam.ty + c.y * cam.k;
    const sr = c.r * cam.k;
    return sx + sr > -margin && sx - sr < w + margin && sy + sr > -margin && sy - sr < h + margin;
  };
  const walk = (n: TNode) => {
    for (const c of n.children) {
      const p = L.get(c.id);
      if (!p) continue;
      list.push(c);
      // Don't descend into circles that are off screen: their contents can't be seen,
      // and edges to them can end at the closed circle.
      if (c.children.length && p.r * cam.k > OPEN_PX && onScreen(p)) {
        open.add(c.id);
        walk(c);
      }
    }
  };
  walk(tree.root);
  return { list, open, key: [...open].join('\n') };
}

/** Click mode: the children of every open node, whatever the camera shows. */
export function expandedNodes(tree: Tree, expanded: ReadonlySet<string>): Visible {
  const list: TNode[] = [];
  const open = new Set<string>(['root']);
  const walk = (n: TNode) => {
    for (const c of n.children) {
      list.push(c);
      if (c.children.length && expanded.has(c.id)) {
        open.add(c.id);
        walk(c);
      }
    }
  };
  walk(tree.root);
  return { list, open, key: [...open].sort().join('\n') };
}

/** The open set that shows `id`: every ancestor of it (and it, if it has children and `self` is set). */
export function withPathOpen(tree: Tree, expanded: ReadonlySet<string>, id: string, self: boolean): Set<string> {
  const next = new Set(expanded);
  const n = tree.nodes.get(id);
  if (n && self && n.children.length) next.add(n.id);
  let cur = n?.parent ? tree.nodes.get(n.parent) : undefined;
  while (cur && cur.id !== 'root') {
    next.add(cur.id);
    cur = cur.parent ? tree.nodes.get(cur.parent) : undefined;
  }
  return next;
}

/** Closes `id` and everything open inside it. */
export function withCollapsed(tree: Tree, expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  const walk = (n: TNode) => {
    next.delete(n.id);
    for (const c of n.children) if (next.has(c.id)) walk(c);
  };
  const n = tree.nodes.get(id);
  if (n) walk(n);
  return next;
}

export interface Contract {
  key: string;
  a: string;
  b: string;
  /** Underlying interactions, both directions. */
  items: GraphEdge[];
  kinds: Set<EdgeKind>;
  cross: boolean;
  tag: string;
}

const tagOf = (i: number) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/**
 * Edges resolved once per tree to integer node indices, so re-aggregating
 * them for a new set of visible nodes is a few array lookups per edge rather
 * than string walks. Zoom mode re-aggregates whenever a circle opens.
 */
export interface EdgeIndex {
  tree: Tree;
  edges: GraphEdge[];
  nodes: TNode[];
  index: Map<string, number>;
  parent: Int32Array;
  depth: Int32Array;
  /** Tree node index of each edge's two ends (-1 when not in this tree). */
  from: Int32Array;
  to: Int32Array;
  /** Whether the two ends are in different repositories. */
  cross: Uint8Array;
}

export function indexEdges(tree: Tree, graphIndex: Map<string, GraphNode>, edges: GraphEdge[]): EdgeIndex {
  const nodes = [...tree.nodes.values()];
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const parent = new Int32Array(nodes.length);
  const depth = new Int32Array(nodes.length);
  nodes.forEach((n, i) => {
    parent[i] = n.parent ? (index.get(n.parent) ?? -1) : -1;
    depth[i] = n.depth;
  });
  const located = new Map<string, number>();
  const at = (id: string) => {
    let i = located.get(id);
    if (i == null) {
      const t = locate(tree, graphIndex, id);
      i = t ? (index.get(t) ?? -1) : -1;
      located.set(id, i);
    }
    return i;
  };
  const from = new Int32Array(edges.length);
  const to = new Int32Array(edges.length);
  const cross = new Uint8Array(edges.length);
  edges.forEach((e, i) => {
    from[i] = at(e.from);
    to[i] = at(e.to);
    const ra = graphIndex.get(e.from)?.repo;
    const rb = graphIndex.get(e.to)?.repo;
    cross[i] = ra && rb && ra !== rb ? 1 : 0;
  });
  return { tree, edges, nodes, index, parent, depth, from, to, cross };
}

/**
 * Lift every edge to the nearest visible ancestor of each end and merge
 * both directions, so one contract covers the relationship between two
 * visible nodes. Thickness is the number of underlying interactions.
 */
export function aggregateEdges(ix: EdgeIndex, vis: Visible): Contract[] {
  const n = ix.nodes.length;
  // lifted[i]: index of the visible node standing in for node i; -2 = not computed yet.
  const lifted = new Int32Array(n).fill(-2);
  for (const v of vis.list) {
    const i = ix.index.get(v.id);
    if (i != null) lifted[i] = i;
  }
  const lift = (i: number): number => {
    if (i < 0) return -1;
    if (lifted[i] !== -2) return lifted[i];
    // Walk up to the first node whose answer is known, then fill in the path.
    const path: number[] = [];
    let cur = i;
    while (cur >= 0 && lifted[cur] === -2) {
      path.push(cur);
      cur = ix.parent[cur];
    }
    const ans = cur < 0 ? -1 : lifted[cur];
    for (const p of path) lifted[p] = ans;
    return ans;
  };
  const isAncestor = (anc: number, i: number) => {
    let cur = i;
    while (cur >= 0 && ix.depth[cur] > ix.depth[anc]) cur = ix.parent[cur];
    return cur === anc;
  };

  const pairs = new Map<number, Contract>();
  for (let e = 0; e < ix.edges.length; e++) {
    const a = lift(ix.from[e]);
    const b = lift(ix.to[e]);
    if (a < 0 || b < 0 || a === b) continue;
    // An edge from a node to its own (open) ancestor has nowhere to draw.
    if (isAncestor(a, b) || isAncestor(b, a)) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const pk = lo * n + hi;
    let p = pairs.get(pk);
    if (!p) {
      const A = ix.nodes[lo];
      const B = ix.nodes[hi];
      // Keys and ends ordered by id, so a contract keeps its key whatever the index order.
      const [x, y] = A.id < B.id ? [A, B] : [B, A];
      p = { key: `${x.id}|${y.id}`, a: x.id, b: y.id, items: [], kinds: new Set(), cross: x.repo !== y.repo, tag: '' };
      pairs.set(pk, p);
    }
    const edge = ix.edges[e];
    p.items.push(edge);
    p.kinds.add(edge.kind);
    if (ix.cross[e]) p.cross = true;
  }
  const out = [...pairs.values()].sort((p, q) => q.items.length - p.items.length || (p.key < q.key ? -1 : 1));
  out.forEach((p, i) => (p.tag = tagOf(i)));
  return out;
}
