// What is on screen at the current zoom: which circles are open (showing
// their children), and the edges aggregated up to whatever is visible.

import type { EdgeKind, GraphEdge, GraphNode } from '@strata/shared';
import type { Circle } from './layout.ts';
import { locate, type Tree, type TNode } from './tree.ts';

/** A circle opens into its children once it is this many pixels in radius. */
export const OPEN_PX = 130;

export interface Camera {
  k: number;
  tx: number;
  ty: number;
}

export interface Visible {
  /** Nodes to consider, parents before children. */
  list: TNode[];
  open: Set<string>;
  /** Stable key of the open set, for memoising edge aggregation. */
  key: string;
}

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
 * Lift every edge to the nearest visible ancestor of each end and merge
 * both directions, so one contract covers the relationship between two
 * visible nodes. Thickness is the number of underlying interactions.
 */
export function aggregateEdges(
  tree: Tree,
  graphIndex: Map<string, GraphNode>,
  edges: GraphEdge[],
  vis: Visible,
): Contract[] {
  const visible = new Set(vis.list.map((n) => n.id));
  const memo = new Map<string, string | null>();
  const lift = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    let cur = locate(tree, graphIndex, id);
    while (cur && !visible.has(cur)) cur = tree.nodes.get(cur)?.parent ?? null;
    memo.set(id, cur);
    return cur;
  };

  const pairs = new Map<string, Contract>();
  for (const e of edges) {
    const a = lift(e.from);
    const b = lift(e.to);
    if (!a || !b || a === b) continue;
    // An edge from a node to its own (open) ancestor has nowhere to draw.
    if (isAncestor(tree, a, b) || isAncestor(tree, b, a)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let p = pairs.get(key);
    if (!p) {
      const [x, y] = a < b ? [a, b] : [b, a];
      p = { key, a: x, b: y, items: [], kinds: new Set(), cross: tree.nodes.get(x)?.repo !== tree.nodes.get(y)?.repo, tag: '' };
      pairs.set(key, p);
    }
    p.items.push(e);
    p.kinds.add(e.kind);
    const ra = graphIndex.get(e.from)?.repo;
    const rb = graphIndex.get(e.to)?.repo;
    if (ra && rb && ra !== rb) p.cross = true;
  }
  const out = [...pairs.values()].sort((p, q) => q.items.length - p.items.length);
  out.forEach((p, i) => (p.tag = tagOf(i)));
  return out;
}

function isAncestor(tree: Tree, anc: string, id: string): boolean {
  let n = tree.nodes.get(id);
  while (n?.parent) {
    if (n.parent === anc) return true;
    n = tree.nodes.get(n.parent);
  }
  return false;
}
