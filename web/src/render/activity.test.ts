import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TNode } from '../graph/tree.ts';
import { curveHits, placeBadge, ringGeometry, type Rect, type Taken } from './activity.ts';

const node = (id: string) => ({ id }) as TNode;
const circle = (id: string, x: number, y: number, r: number, open = false) => ({ n: node(id), x, y, r, open });
const free = { x0: 0, x1: 1000, y0: 0, y1: 1000 };

/** A straight link drawn as the renderer does: a quadratic with its control point at the middle. */
function link(x1: number, y1: number, x2: number, y2: number, w = 2): Taken['edges'][number] {
  const pts = [x1, y1, (x1 + x2) / 2, (y1 + y2) / 2, x2, y2];
  return { pts, w, minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

const W = 40;
const H = 16;

test('the change ring sits outside the circle, past a dark gap', () => {
  for (const r of [3, 12, 80]) {
    const g = ringGeometry(r);
    assert.ok(g.gapR - g.gap / 2 >= r + 0.5, `gap starts past the rim at r=${r}`);
    assert.ok(g.lineR - g.line / 2 >= g.gapR + g.gap / 2 - 1e-9, `line starts past the gap at r=${r}`);
  }
});

test('with nothing around, the badge sits at the upper right, touching the ring from outside', () => {
  const d = circle('a', 500, 500, 30);
  const box = placeBadge(d, W, H, { edges: [], rects: [], free }, [d], []);
  assert.ok(box.x > d.x && box.y + box.h < d.y, 'upper right');
  const gap = Math.hypot(box.x - d.x, box.y + box.h - d.y) - ringGeometry(d.r).outer;
  assert.ok(gap > -3 && gap < 2, `touches the ring (gap ${gap.toFixed(1)})`);
});

test('a link leaving the circle at the upper right moves the badge off it', () => {
  const d = circle('a', 500, 500, 30);
  const a = -Math.PI / 4;
  const e = link(d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r, 800, 200);
  const taken = { edges: [e], rects: [], free };
  const box = placeBadge(d, W, H, taken, [d], []);
  assert.equal(curveHits(e, box), false);
  // It would have gone there otherwise.
  const bare = placeBadge(d, W, H, { edges: [], rects: [], free }, [d], []);
  assert.equal(curveHits(e, bare), true);
});

test('tags, tabs and other badges are kept clear too', () => {
  const d = circle('a', 500, 500, 30);
  const upper: Rect[] = [{ x: 380, y: 400, w: 240, h: 90 }];
  const box = placeBadge(d, W, H, { edges: [], rects: upper, free }, [d], []);
  assert.ok(box.y >= 490, 'below the taken band');
  const again = placeBadge(d, W, H, { edges: [], rects: upper, free }, [d], [box]);
  const overlap = again.x < box.x + box.w && box.x < again.x + again.w && again.y < box.y + box.h && box.y < again.y + again.h;
  assert.equal(overlap, false, 'a second badge on the same circle goes elsewhere');
});

test('when every side is taken it picks the spot that covers least', () => {
  const d = circle('a', 500, 500, 30);
  // Links out of every side but the left.
  const edges = [-90, -45, 0, 45, 90, -135, 135].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return link(d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r, d.x + Math.cos(a) * 300, d.y + Math.sin(a) * 300);
  });
  const box = placeBadge(d, W, H, { edges, rects: [], free }, [d], []);
  assert.ok(box.x + box.w <= d.x, 'on the left, the only clear side');
  assert.equal(
    edges.some((e) => curveHits(e, box)),
    false,
  );
});
