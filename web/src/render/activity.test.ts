import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TNode } from '../graph/tree.ts';
import type { Marks, TreeActivity } from '../graph/activity.ts';
import { type BadgeCache, BadgeSpace, curveHits, drawBadges, drawRings, hereGeometry, LOOKED_ALPHA, marksReach, ringGeometry, rippleRing, type Rect, type Taken, unreadGeometry, visibleArc } from './activity.ts';

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

test('the working ring sits past the change ring, or in its place when nothing changed', () => {
  for (const r of [3, 12, 80]) {
    const g = ringGeometry(r);
    const past = hereGeometry(r, true);
    assert.ok(past.gapR - past.gap / 2 >= g.outer - 1e-9, `clear of the change ring at r=${r}`);
    assert.ok(past.lineR - past.line / 2 >= past.gapR + past.gap / 2 - 1e-9, `line past its gap at r=${r}`);
    assert.equal(hereGeometry(r, false).lineR, g.lineR);
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
  // A canvas that draws nothing and measures every character 6px wide.
  const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 6 }) : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D;
  const marks: TreeActivity = new Map<string, Marks>([['a', { self: null, added: 1, modified: 2, deleted: 0, at: 0, here: null, selfUnread: false, unread: 0, reached: null, direct: false, ripple: 0, looked: null }]]);
  const d = circle('a', 500, 500, 30);
  const taken = { edges: [], rects: [], free, view };
  const cache: BadgeCache = {};
  drawBadges(ctx, [d], marks, taken, cache);
  const first = cache.boxes;
  assert.equal(first?.length, 1);
  drawBadges(ctx, [{ ...d }], marks, { ...taken }, cache);
  assert.equal(cache.boxes, first, 'same geometry: same spots, not placed again');
  drawBadges(ctx, [{ ...d, x: 520 }], marks, taken, cache);
  assert.notEqual(cache.boxes, first);
  assert.equal(cache.boxes![0].x - first![0].x, 20);
});

test('a badge says how many changes inside are unread, in words', () => {
  const drawn: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 6 }) : k === 'fillText' ? (t: string) => drawn.push(t) : () => {}),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  const mark = (unread: number): Marks => ({ self: null, added: 1, modified: 2, deleted: 0, at: 0, here: null, selfUnread: false, unread, reached: null, direct: false, ripple: 0, looked: null });
  const d = circle('a', 500, 500, 30);
  const taken = { edges: [], rects: [], free, view };
  const read: BadgeCache = {};
  drawBadges(ctx, [d], new Map([['a', mark(0)]]), taken, read);
  assert.deepEqual(drawn, ['+1', '~2']);
  drawn.length = 0;
  const some: BadgeCache = {};
  drawBadges(ctx, [d], new Map([['a', mark(2)]]), taken, some);
  assert.deepEqual(drawn, ['+1', '~2', '2 unread']);
  assert.ok(some.boxes![0].w > read.boxes![0].w, 'the badge grows to say it');
});

test('the unread dot sits on the upper left of the ring', () => {
  const u = unreadGeometry(100, 100, 20, 16);
  assert.ok(u.x < 100 && u.y < 100);
  assert.ok(Math.abs(Math.hypot(u.x - 100, u.y - 100) - 20) < 1e-9, 'on the outer ring');
  assert.ok(u.gap > u.dot, 'a gap of paper round it');
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

const marks = (m: Partial<Marks>): Marks => ({ self: null, added: 0, modified: 0, deleted: 0, at: 0, here: null, selfUnread: false, unread: 0, reached: null, direct: false, ripple: 0, looked: null, ...m });

test('the dotted ripple ring goes only on closed circles that depend on a change and show none of their own', () => {
  assert.equal(rippleRing(marks({ reached: 'evidenced' }), false), true);
  assert.equal(rippleRing(marks({ reached: 'inferred', ripple: 3 }), false), true);
  // Open: the circles inside carry it, unless the circle itself links into a change.
  assert.equal(rippleRing(marks({ reached: 'evidenced', ripple: 3 }), true), false);
  assert.equal(rippleRing(marks({ reached: 'evidenced', direct: true }), true), true);
  // Changed itself: its change ring says more.
  assert.equal(rippleRing(marks({ reached: 'evidenced', self: 'modified' }), false), false);
  // Holding changes: its badge counts the ripple beside them.
  assert.equal(rippleRing(marks({ reached: 'evidenced', ripple: 2, modified: 1 }), false), false);
  assert.equal(rippleRing(marks({}), false), false);
});

test('a closed circle holding dependents gets a badge with their count; a small one only its ring', () => {
  const texts: string[] = [];
  const ctx = new Proxy(
    {},
    { get: (_, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 6 }) : k === 'fillText' ? (t: string) => texts.push(t) : () => {}), set: () => true },
  ) as unknown as CanvasRenderingContext2D;
  const taken = { edges: [], rects: [], free, view };
  const cache: BadgeCache = {};
  drawBadges(ctx, [circle('a', 300, 300, 30), circle('b', 600, 600, 6)], new Map([['a', marks({ reached: 'evidenced', ripple: 4 })], ['b', marks({ reached: 'evidenced', ripple: 2 })]]), taken, cache);
  assert.deepEqual(texts, ['4']);
  assert.equal(cache.boxes?.length, 1);
  texts.length = 0;
  drawBadges(ctx, [circle('a', 300, 300, 30)], new Map([['a', marks({ modified: 1, ripple: 4 })]]), taken, {});
  assert.deepEqual(texts, ['~1', '4']);
});

test('a ring far bigger than the screen is drawn only where it crosses it', () => {
  // Small rings on screen: whole.
  assert.deepEqual(visibleArc(500, 500, 30, 1000, 800), [0, Math.PI * 2]);
  // Off screen, or reaching past every corner of it: nothing.
  assert.equal(visibleArc(-200, 400, 50, 1000, 800), null);
  assert.equal(visibleArc(500, 400, 5000, 1000, 800), null);
  // A huge ring whose centre is far to the left: a sliver of a turn, round the direction of the screen.
  const arc = visibleArc(-5000, 400, 5400, 1000, 800)!;
  assert.ok(arc[1] - arc[0] < 0.4, `${arc[1] - arc[0]} rad`);
  for (const a of [arc[0], (arc[0] + arc[1]) / 2, arc[1]]) assert.ok(Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.3);
  // Every point of the ring on screen is inside the arc.
  for (let i = 0; i < 2000; i++) {
    const t = (i / 2000) * Math.PI * 2;
    const x = -5000 + 5400 * Math.cos(t);
    const y = 400 + 5400 * Math.sin(t);
    if (x < 0 || x > 1000 || y < 0 || y > 800) continue;
    const rel = Math.atan2(Math.sin(t - arc[0]), Math.cos(t - arc[0]));
    assert.ok(rel >= -1e-9 && rel <= arc[1] - arc[0] + 1e-9, `point at ${t} is drawn`);
  }
});

test('marks reach out to the outermost ring and the unread dot', () => {
  const m = marks;
  const r = 40;
  assert.equal(marksReach(r, undefined, false), null);
  // Changes only underneath draw no ring, just a badge (which keeps clear of words itself).
  assert.equal(marksReach(r, m({ added: 3 }), false), null);
  assert.equal(marksReach(r, m({ self: 'modified' }), false), ringGeometry(r).outer);
  const here = hereGeometry(r, true).outer;
  assert.equal(marksReach(r, m({ self: 'added', here: 'self' }), false), here);
  assert.equal(marksReach(r, m({ self: 'added', here: 'self', selfUnread: true }), false), here + unreadGeometry(0, 0, here, r).gap);
  // An agent working inside an open circle rings its children, not the open rim.
  assert.equal(marksReach(r, m({ here: 'inside' }), true), null);
  assert.ok(marksReach(r, m({ here: 'inside' }), false)! > r);
  // The looked-at ring sits on the change ring's line, so it reaches as far.
  assert.equal(marksReach(r, m({ looked: 'self' }), false), ringGeometry(r).outer);
  assert.equal(marksReach(r, m({ looked: 'inside' }), true), null);
  assert.equal(marksReach(r, m({ looked: 'inside', modified: 2 }), false), null);
  // So does the ripple ring, and it pushes an agent's working ring out as a change ring does.
  assert.equal(marksReach(r, m({ reached: 'evidenced' }), false), ringGeometry(r).outer);
  assert.equal(marksReach(r, m({ reached: 'evidenced', here: 'self' }), false), hereGeometry(r, true).outer);
  assert.equal(marksReach(r, m({ reached: 'evidenced', modified: 1 }), false), null, 'a badge counts it instead');
  assert.equal(marksReach(3, m({ reached: 'evidenced' }), false), null, 'too small to hold the dots');
});

/** A canvas that keeps the rings it is asked to stroke: radius, dash and opacity. */
function ringsCanvas() {
  const rings: { r: number; dash: number[]; alpha: number }[] = [];
  let r = 0;
  let dash: number[] = [];
  const ctx: Record<string, unknown> = {
    globalAlpha: 1,
    arc: (_x: number, _y: number, radius: number) => (r = radius),
    setLineDash: (d: number[]) => (dash = d),
    stroke: () => rings.push({ r, dash, alpha: ctx.globalAlpha as number }),
    beginPath: () => {},
    fillRect: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rings };
}

test('looked at: one faint dotted ring where the change ring would be, never with a change or the working ring', () => {
  const at = (m: Partial<Marks>, open = false) => {
    const { ctx, rings } = ringsCanvas();
    drawRings(ctx, [circle('a', 100, 100, 20, open)], new Map([['a', marks(m)]]), 1e12);
    return rings;
  };
  const [own] = at({ looked: 'self' });
  assert.equal(own.r, ringGeometry(20).lineR);
  assert.ok(own.dash.length === 2 && own.dash[0] < own.dash[1], 'dotted');
  assert.equal(own.alpha, LOOKED_ALPHA.self);
  // Inside a closed circle it shows, fainter; an open one shows its own marks inside it instead.
  assert.equal(at({ looked: 'inside' })[0].alpha, LOOKED_ALPHA.inside);
  assert.ok(LOOKED_ALPHA.inside < LOOKED_ALPHA.self);
  assert.deepEqual(at({ looked: 'inside' }, true), []);
  // A change, or an agent working here, says more: no looked ring with either.
  assert.ok(at({ looked: 'self', self: 'modified' }).every((r) => r.dash.length === 0));
  assert.ok(at({ looked: 'self', here: 'self' }).every((r) => r.dash.length === 0));
  assert.deepEqual(at({ looked: 'inside', modified: 2 }), []);
  // Depending on a change says more too: the ripple's dots, not the looked ring.
  assert.deepEqual(at({ looked: 'self', reached: 'evidenced' }), []);
});
