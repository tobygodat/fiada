// Nested circle packing, two ways:
//
//   layout          every node gets a circle in one shared coordinate space;
//                   zooming the camera is what changes altitude (zoom mode).
//   layoutExpanded  only the children of open nodes are packed. Closed nodes
//                   get a compact radius from their size, so an open node grows
//                   to fit its contents while its neighbours stay small and on
//                   screen (click mode).

import { hierarchy, pack } from 'd3-hierarchy';
import type { Tree, TNode } from './tree.ts';

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export const WORLD = 1000;

// Breathing room inside each circle, by depth, so parents stay visible (and
// labelled) around their children.
const PADDING = [40, 18, 10, 6, 4, 3, 2];

export function layout(tree: Tree): Map<string, Circle> {
  const h = hierarchy<TNode>(tree.root, (n) => n.children)
    .sum((n) => (n.children.length ? 0 : Math.max(n.size, 1)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const packed = pack<TNode>()
    .size([WORLD, WORLD])
    .padding((n) => PADDING[Math.min(n.depth, PADDING.length - 1)])(h);

  const out = new Map<string, Circle>();
  packed.each((n) => out.set(n.data.id, { x: n.x - WORLD / 2, y: n.y - WORLD / 2, r: n.r }));

  return out;
}

/**
 * Radius of a closed node in click mode. Compressed hard (a repository is
 * about ten times a one-line symbol, not a thousand) so that every closed
 * node, at any depth, is big enough to label and click at the same zoom.
 */
export const closedRadius = (n: TNode) => 4 + 3.2 * Math.pow(n.weight, 0.3);

// Gap between siblings and inside each open circle, in the same units as
// closedRadius. Wider at the top so repositories and domains read as regions.
const OPEN_PADDING = (n: TNode) => (n.kind === 'root' ? 28 : n.kind === 'repo' || n.kind === 'domain' ? 14 : 7);

/**
 * Packs the open part of the tree: the children of every node in `open`
 * (root is always open). Nodes keep their absolute size between calls and
 * siblings keep their order (by static weight), so opening a node pushes its
 * neighbours aside rather than reshuffling them.
 */
export function layoutExpanded(tree: Tree, open: ReadonlySet<string>): Map<string, Circle> {
  const h = hierarchy<TNode>(tree.root, (n) => (n.id === 'root' || open.has(n.id) ? n.children : null)).sort(
    (a, b) => b.data.weight - a.data.weight || (a.data.id < b.data.id ? -1 : 1),
  );

  const packed = pack<TNode>()
    .size([0, 0])
    .radius((n) => closedRadius(n.data))
    .padding((n) => OPEN_PADDING(n.data))(h);

  const out = new Map<string, Circle>();
  packed.each((n) => out.set(n.data.id, { x: n.x, y: n.y, r: n.r }));

  return out;
}
