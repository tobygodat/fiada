// What is on screen: which circles are open (showing their children), and the
// edges aggregated up to whatever is visible.
//
// Two ways to decide what's open:
//   click mode  the user opens and closes circles (select, then click again
//               to open); zooming is pure scale.
//   zoom mode   a circle opens once it is big enough on screen.

import type { EdgeKind, GraphEdge, GraphNode } from '@fiada/shared';
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

/**
 * The open set that shows all of `ids` at once: down to the symbols when that
 * opens at most `cap` more circles, else down to the files (or layers), else
 * nothing new, and the closed circles round them stand in.
 */
export function withPathsOpen(tree: Tree, expanded: ReadonlySet<string>, ids: readonly string[], cap: number): Set<string> {
  for (const deep of [true, false]) {
    let next: Set<string> = new Set(expanded);

    for (const id of ids) {
      const n = tree.nodes.get(id);

      if (!n) continue;
      next = withPathOpen(tree, next, deep || n.kind !== 'symbol' ? id : (n.parent ?? id), false);
    }

    if (next.size - expanded.size <= cap) return next;
  }

  return new Set(expanded);
}

/**
 * Click mode: what a click on a circle does. The first click selects it, so
 * the detail panel shows what it is and what it talks to; a second click on
 * the selected circle opens it in place.
 */
export function clickAction(n: TNode, selected: string | null, open: boolean): 'select' | 'open' | 'none' {
  if (selected !== n.id) return 'select';

  return n.children.length && !open ? 'open' : 'none';
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
  /**
   * How many of the interactions run between two repositories. Counted from
   * the edges themselves: the ends drawn can be domains or layers, which
   * belong to no single repository.
   */
  cross: number;
  /** How many of the interactions a heuristic guessed rather than the code proving them. */
  inferred: number;
  /** How many run from `a` to `b`; the rest run from `b` to `a`. */
  forward: number;
  /** Its label on the map, from `contractLabel`. */
  tag: string;
}

const KIND_WORD: Record<EdgeKind, [string, string]> = {
  calls: ['call', 'calls'],
  renders: ['render', 'renders'],
  imports: ['import', 'imports'],
  type: ['type use', 'type uses'],
  references: ['reference', 'references'],
  http: ['HTTP request', 'HTTP requests'],
};

// Shorter, for tags on the map.
const TAG_WORD: Record<EdgeKind, [string, string]> = { ...KIND_WORD, type: ['type', 'types'], references: ['ref', 'refs'], http: ['HTTP', 'HTTP'] };

/** "23 HTTP requests", "1 call". */
export const countKind = (kind: EdgeKind, n: number) => `${n} ${KIND_WORD[kind][n === 1 ? 0 : 1]}`;

/** How many interactions of each kind a contract carries, most first. */
export function kindCounts(c: Pick<Contract, 'items'>): [EdgeKind, number][] {
  const m = new Map<EdgeKind, number>();

  for (const e of c.items) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);

  return [...m].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1));
}

/**
 * What a link is at a glance, for its tag on the map: the main kind and how
 * many ("HTTP · 23", "552 calls +40" with 40 of other kinds). When no one
 * kind makes up two thirds, the total and the leading kinds ("159 calls &
 * renders", or "159 calls, renders…" when there are more). "?" when every
 * interaction behind it was guessed.
 */
export function contractLabel(c: Pick<Contract, 'items' | 'inferred'>): string {
  const counts = kindCounts(c);
  const [[kind, n], second] = counts;
  const total = c.items.length;
  const guessed = c.inferred === total ? '?' : '';

  if (second && n * 3 < total * 2) {
    const two = `${TAG_WORD[kind][1]}${counts.length > 2 ? ', ' : ' & '}${TAG_WORD[second[0]][1]}`;

    return `${total} ${two}${counts.length > 2 ? '…' : ''}${guessed}`;
  }

  const main = kind === 'http' ? `HTTP · ${n}` : `${n} ${TAG_WORD[kind][n === 1 ? 0 : 1]}`;

  return `${main}${total > n ? ` +${total - n}` : ''}${guessed}`;
}

// Plainer still, for the words on a resting link.
const REST_WORD: Record<EdgeKind, [string, string]> = { ...KIND_WORD, type: ['type', 'types'], http: ['request', 'requests'] };

/**
 * The words on a link at rest, before anyone points at it: how many and what
 * ("12 calls", "3 requests", "1 import"), or the total and the two leading
 * kinds when no one kind makes up two thirds ("159 calls & renders"). "?"
 * when every interaction behind it was guessed.
 */
export function restLabel(c: Pick<Contract, 'items' | 'inferred'>): string {
  const counts = kindCounts(c);

  if (!counts.length) return '';
  const [[kind, n], second] = counts;
  const total = c.items.length;
  const guessed = c.inferred === total ? '?' : '';

  if (second && n * 3 < total * 2) return `${total} ${REST_WORD[kind][1]} & ${REST_WORD[second[0]][1]}${guessed}`;

  return `${n} ${REST_WORD[kind][n === 1 ? 0 : 1]}${guessed}`;
}

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

/** Its two ends in the order the interactions run: [from, to, whether some run the other way too]. */
export function direction(c: Contract): [string, string, boolean] {
  if (c.forward === 0) return [c.b, c.a, false];

  return [c.a, c.b, c.forward < c.items.length];
}

/** The innermost circle holding both ends: where a link between them sits. */
export function meetingPoint(tree: Tree, a: string, b: string): string {
  let x = tree.nodes.get(a);
  let y = tree.nodes.get(b);

  while (x && y && x !== y) {
    const dx = x.depth;
    const dy = y.depth;

    if (dx >= dy) x = x.parent ? tree.nodes.get(x.parent) : undefined;

    if (dy >= dx) y = y.parent ? tree.nodes.get(y.parent) : undefined;
  }

  return x && x === y ? x.id : 'root';
}

/** Mostly between repositories: drawn dashed and ranked with HTTP. */
export const crossRepo = (c: Contract) => c.cross > 0 && c.cross * 2 >= c.items.length;

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
      p = { key: `${x.id}|${y.id}`, a: x.id, b: y.id, items: [], kinds: new Set(), cross: 0, inferred: 0, forward: 0, tag: '' };
      pairs.set(pk, p);
    }

    const edge = ix.edges[e];
    p.items.push(edge);
    p.kinds.add(edge.kind);

    if (edge.basis === 'inferred') p.inferred++;
    p.cross += ix.cross[e];

    if (ix.nodes[a].id === p.a) p.forward++;
  }

  const out = [...pairs.values()].sort((p, q) => q.items.length - p.items.length || (p.key < q.key ? -1 : 1));

  for (const p of out) p.tag = contractLabel(p);

  return out;
}
