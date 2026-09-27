import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TNode } from '../graph/tree.ts';
import type { Marks, TreeActivity } from '../graph/activity.ts';
import { type BadgeCache, BadgeSpace, curveHits, drawBadges, ringGeometry, type Rect, type Taken } from './activity.ts';

const node = (id: string) => ({ id }) as TNode;
const circle = (id: string, x: number, y: number, r: number, open = false) => ({ n: node(id), x, y, r, open });
const free = { x0: 0, x1: 1000, y0: 0, y1: 1000 };
const view = { w: 1000, h: 1000 };

type Circle = ReturnType<typeof circle>;
/** One badge on `d`, with only `d` on the map besides what's taken. */
const place = (d: Circle, taken: Omit<Taken, 'free' | 'view'>) => new BadgeSpace({ ...taken, free, view }, [d], [{ d, w: W, h: H }]).place(d, W, H);

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
  const box = place(d, { edges: [], rects: [] });
  assert.ok(box.x > d.x && box.y + box.h < d.y, 'upper right');
  const gap = Math.hypot(box.x - d.x, box.y + box.h - d.y) - ringGeometry(d.r).outer;
  assert.ok(gap > -3 && gap < 2, `touches the ring (gap ${gap.toFixed(1)})`);
});

test('a link leaving the circle at the upper right moves the badge off it', () => {
  const d = circle('a', 500, 500, 30);
  const a = -Math.PI / 4;
  const e = link(d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r, 800, 200);
  const box = place(d, { edges: [e], rects: [] });
  assert.equal(curveHits(e, box), false);
  // It would have gone there otherwise.
  const bare = place(d, { edges: [], rects: [] });
  assert.equal(curveHits(e, bare), true);
});

test('tags, tabs and other badges are kept clear too', () => {
  const d = circle('a', 500, 500, 30);
  const upper: Rect[] = [{ x: 380, y: 400, w: 240, h: 90 }];
  const space = new BadgeSpace({ edges: [], rects: upper, free, view }, [d], [{ d, w: W, h: H }]);
  const box = space.place(d, W, H);
  assert.ok(box.y >= 490, 'below the taken band');
  const again = space.place(d, W, H);
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
  const box = place(d, { edges, rects: [] });
  assert.ok(box.x + box.w <= d.x, 'on the left, the only clear side');
  assert.equal(
    edges.some((e) => curveHits(e, box)),
    false,
  );
});

test('a link that only passes near the circle still counts, however long it is', () => {
  const d = circle('a', 500, 500, 30);
  // A long link from far off that runs just past the circle's upper right.
  const e = link(-2000, 3000, 3000, -2000);
  const bare = place(d, { edges: [], rects: [] });
  assert.equal(curveHits(e, bare), true);
  const box = place(d, { edges: [e], rects: [] });
  assert.equal(curveHits(e, box), false);
});

test('other closed circles are avoided when there is room, and a crowd of badges never overlaps', () => {
  const circles = Array.from({ length: 60 }, (_, i) => circle(`c${i}`, 60 + (i % 10) * 90, 60 + Math.floor(i / 10) * 90, 22));
  const space = new BadgeSpace(
    { edges: [], rects: [], free, view },
    circles,
    circles.map((d) => ({ d, w: W, h: H })),
  );
  const boxes = circles.map((c) => space.place(c, W, H));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `badges ${i} and ${j} overlap`);
    }
});

test('badge spots are reused while nothing moves, and worked out again when something does', () => {
  // A canvas that draws nothing.
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true }) as unknown as CanvasRenderingContext2D;
  const marks: TreeActivity = new Map<string, Marks>([['a', { self: null, added: 1, modified: 2, deleted: 0, at: 0 }]]);
  const d = circle('a', 500, 500, 30);
  const taken = { edges: [], rects: [], free, view };
  const cache: BadgeCache = {};
  drawBadges(ctx, [d], marks, (t) => t.length * 6, taken, cache);
  const first = cache.boxes;
  assert.equal(first?.length, 1);
  drawBadges(ctx, [{ ...d }], marks, (t) => t.length * 6, { ...taken }, cache);
  assert.equal(cache.boxes, first, 'same geometry: same spots, not placed again');
  drawBadges(ctx, [{ ...d, x: 520 }], marks, (t) => t.length * 6, taken, cache);
  assert.notEqual(cache.boxes, first);
  assert.equal(cache.boxes![0].x - first![0].x, 20);
});

test('a wide badge still sees what is near its far end', () => {
  const d = circle('a', 500, 500, 30);
  const wide = 160;
  // A tag well past 96px from the ring, where only a badge this wide reaches, at the upper right and upper left.
  const rects: Rect[] = [
    { x: 640, y: 440, w: 30, h: 30 },
    { x: 330, y: 440, w: 30, h: 30 },
  ];
  const box = new BadgeSpace({ edges: [], rects, free, view }, [d], [{ d, w: wide, h: H }]).place(d, wide, H);
  for (const r of rects) assert.ok(!(r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h), 'clear of the far tag');
});

test('a short, strongly bent link is followed closely enough that nothing on it is missed', () => {
  const quad = (pts: number[], w: number): Taken['edges'][number] => ({
    pts,
    w,
    minX: Math.min(pts[0], pts[2], pts[4]),
    minY: Math.min(pts[1], pts[3], pts[5]),
    maxX: Math.max(pts[0], pts[2], pts[4]),
    maxY: Math.max(pts[1], pts[3], pts[5]),
  });
  // Both bow far from the straight line between their ends, over less than 144px of curve.
  const curves = [quad([540, 450, 560, 519, 580, 450], 1), quad([560, 430, 625, 470, 570, 505], 1)];
  // The truth, from 400 points along the curve: does its stroke touch the box?
  const touches = (e: Taken['edges'][number], b: Rect) => {
    const [x1, y1, cx, cy, x2, y2] = e.pts;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const u = 1 - t;
      const x = u * u * x1 + 2 * u * t * cx + t * t * x2;
      const y = u * u * y1 + 2 * u * t * cy + t * t * y2;
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      if (Math.hypot(dx, dy) <= e.w / 2) return true;
    }
    return false;
  };
  let checked = 0;
  for (const e of curves)
    for (let x = e.minX - 8; x < e.maxX + 8; x += 1)
      for (let y = e.minY - 8; y < e.maxY + 8; y += 1) {
        const box = { x, y, w: 4, h: 4 };
        if (!touches(e, box)) continue;
        checked++;
        assert.ok(curveHits(e, box), `missed the link at ${x},${y}`);
      }
  assert.ok(checked > 100);
});

test('a link running far off screen at high zoom only blocks the spots it really crosses', () => {
  const d = circle('a', 500, 500, 30);
  // Leaves the circle up and to the right, bending away over a million pixels.
  const a = -Math.PI / 4;
  const x0 = d.x + Math.cos(a) * d.r;
  const y0 = d.y + Math.sin(a) * d.r;
  const pts = [x0, y0, x0 + 5e5, y0 - 5e5, x0 + 1e6, y0];
  const e = { pts, w: 2, minX: x0, minY: y0 - 5e5, maxX: x0 + 1e6, maxY: y0 };
  // The truth near the circle, from the first 300px of the curve.
  const touches = (b: Rect) => {
    for (let i = 0; i <= 40000; i++) {
      const t = (i / 40000) * 3e-4;
      const u = 1 - t;
      const x = u * u * pts[0] + 2 * u * t * pts[2] + t * t * pts[4];
      const y = u * u * pts[1] + 2 * u * t * pts[3] + t * t * pts[5];
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      if (Math.hypot(dx, dy) <= e.w / 2) return true;
    }
    return false;
  };
  assert.equal(touches(place(d, { edges: [], rects: [] })), true, 'the usual spot is on the link');
  const box = place(d, { edges: [e], rects: [] });
  assert.equal(touches(box), false, 'the badge went somewhere clear');
  assert.equal(curveHits(e, box), false);
});
