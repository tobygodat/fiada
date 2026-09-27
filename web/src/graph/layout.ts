// Nested circle packing. Every node gets a circle in one shared coordinate
// space; zooming the camera is what changes altitude.

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
