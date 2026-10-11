// The agent overlay, drawn over the map's circles: a ring just outside
// anything an agent added, modified or deleted, a pulse for a few seconds
// after each change, a green ring where an agent is working right now, and on
// closed circles a small count of the changes inside. It stays quiet on
// purpose: thin rings, one small badge, and no motion once the agent stops.
// Change colours mean a change and nothing else (ink, ochre, brick); the one
// green means "an agent is here now". A gap cut from the paper keeps a ring
// apart from the circle's own colour, and a badge sits wherever it covers no
// link, tag or name tab. A change you haven't opened since it was made has a
// small ink dot on its ring, and a badge says how many inside are unread.
// Every colour and the type come from the design tokens.

import { changeCount, type Marks, type TreeActivity } from '../graph/activity.ts';
import type { TNode } from '../graph/tree.ts';
import { changeColor, fonts, token } from '../theme/tokens.ts';

/** The map's paper: the gap round a ring is cut from it. */
const paper = () => token('--ground');

/** How long a change keeps pulsing. */
export const PULSE_MS = 8000;
const PERIOD = 1400;

interface Drawn {
  n: TNode;
  x: number;
  y: number;
  r: number;
  open: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What's already on the map that a badge mustn't cover. */
export interface Taken {
  /** Links as drawn: a quadratic curve [x1, y1, cx, cy, x2, y2], its width and bounding box. */
  edges: readonly { pts: number[]; w: number; minX: number; minY: number; maxX: number; maxY: number }[];
  /** Link tags and name tabs. */
  rects: readonly Rect[];
  /** The part of the canvas that isn't under a panel. */
  free: { x0: number; x1: number; y0: number; y1: number };
  /** The canvas size in CSS pixels. */
  view: { w: number; h: number };
}

const dominant = (m: Marks) => (m.added >= m.modified && m.added >= m.deleted ? 'added' : m.modified >= m.deleted ? 'modified' : 'deleted');

/** Where the ring sits: a dark gap, then the coloured line, both outside the circle's own edge. */
export function ringGeometry(r: number) {
  const small = r < 6;
  const gap = small ? 2 : 3;
  const line = small ? 1.5 : 2;
  const gapR = r + 0.5 + gap / 2;
  const lineR = r + 0.5 + gap + line / 2;
  return { gap, line, gapR, lineR, outer: lineR + line / 2 };
}

function halo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, age: number, strength: number) {
  const phase = (age % PERIOD) / PERIOD;
  ctx.globalAlpha = (1 - phase) * strength * (1 - age / PULSE_MS);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r + 2 + phase * Math.min(14, 4 + r * 0.25), 0, Math.PI * 2);
  ctx.stroke();
}

/** Where the green "working here" ring sits: past the change ring when there is one, else in its place. */
export function hereGeometry(r: number, changed: boolean) {
  const g = ringGeometry(r);
  const line = 1.5;
  if (!changed) return { gap: g.gap, line, gapR: g.gapR, lineR: g.lineR, outer: g.lineR + line / 2 };
  const gap = r < 6 ? 1.5 : 2;
  const gapR = g.outer + gap / 2;
  const lineR = g.outer + gap + line / 2;
  return { gap, line, gapR, lineR, outer: lineR + line / 2 };
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, g: { gap: number; line: number; gapR: number; lineR: number }, color: string, dash: number[]) {
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = paper();
  ctx.lineWidth = g.gap;
  ctx.beginPath();
  ctx.arc(x, y, g.gapR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = g.line;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(x, y, g.lineR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Where the unread dot sits: on the upper left of the outermost ring, a gap of paper round it. */
export function unreadGeometry(x: number, y: number, outer: number, r: number) {
  const dot = r < 6 ? 2 : 3;
  const a = (-135 * Math.PI) / 180;
  return { x: x + Math.cos(a) * outer, y: y + Math.sin(a) * outer, dot, gap: dot + 1.5 };
}

function unreadDot(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number, r: number) {
  const u = unreadGeometry(x, y, outer, r);
  ctx.globalAlpha = 1;
  ctx.fillStyle = paper();
  ctx.beginPath();
  ctx.arc(u.x, u.y, u.gap, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = token('--unread');
  ctx.beginPath();
  ctx.arc(u.x, u.y, u.dot, 0, Math.PI * 2);
  ctx.fill();
}

/** Rings and pulses. Returns whether anything is still pulsing, so the caller keeps animating. */
export function drawRings(ctx: CanvasRenderingContext2D, drawn: Drawn[], marks: TreeActivity, now: number): boolean {
  let pulsing = false;
  for (const d of drawn) {
    const m = marks.get(d.n.id);
    if (!m) continue;
    const age = now - m.at;
    const recent = age >= 0 && age < PULSE_MS;
    const g = ringGeometry(d.r);
    // An agent working here now: on the node itself, or on the closed circle it's inside.
    const here = m.here === 'self' || (m.here === 'inside' && !d.open) ? hereGeometry(d.r, !!m.self) : null;
    if (here) ring(ctx, d.x, d.y, here, changeColor('working'), []);
    if (m.self) {
      const color = changeColor(m.self);
      ring(ctx, d.x, d.y, g, color, m.self === 'deleted' ? [3, 3] : []);
      if (recent) {
        halo(ctx, d.x, d.y, here?.outer ?? g.outer, color, age, 0.7);
        pulsing = true;
      }
      if (m.selfUnread) unreadDot(ctx, d.x, d.y, here?.outer ?? g.outer, d.r);
    } else if (!d.open && recent && changeCount(m)) {
      // Something inside a closed circle just changed.
      halo(ctx, d.x, d.y, d.r, changeColor(dominant(m)), age, 0.45);
      pulsing = true;
    }
  }
  ctx.globalAlpha = 1;
  return pulsing;
}

// Where a badge may go, best first: the upper right, then the other diagonals,
// then round the rest of the rim. Angles on screen, so -45° is up and right.
const ANGLES = [-45, -135, 45, 135, -90, 90, 0, 180, -20, -70, -110, -160, 20, 70, 110, 160].map((a) => (a * Math.PI) / 180);

/** The badge's box at one angle: touching the ring from outside, growing away from the circle. */
function boxAt(d: Drawn, angle: number, w: number, h: number, out: number): Rect {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // On a diagonal the box meets the ring at its corner, which is square: it touches as it is.
  const px = d.x + c * out;
  const py = d.y + s * out;
  const x = c > 0.3 ? px : c < -0.3 ? px - w : px - w / 2;
  const y = s > 0.3 ? py : s < -0.3 ? py - h : py - h / 2;
  return { x, y, w, h };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether the segment from (x1, y1) to (x2, y2) passes through the box, grown by `pad` on every side (Liang–Barsky). */
function segmentHits(x1: number, y1: number, x2: number, y2: number, b: Rect, pad: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  // Clip against each side in turn: left, right, top, bottom.
  for (let side = 0; side < 4; side++) {
    const p = side === 0 ? -dx : side === 1 ? dx : side === 2 ? -dy : dy;
    const q = side === 0 ? x1 - (b.x - pad) : side === 1 ? b.x + b.w + pad - x1 : side === 2 ? y1 - (b.y - pad) : b.y + b.h + pad - y1;
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t0) t0 = t;
    } else if (t < t1) t1 = t;
    if (t0 > t1) return false;
  }
  return true;
}

type Edge = Taken['edges'][number];

/** How far a straight piece may stray from the curve it stands for. */
const STRAY = 0.5;
/** Pieces longer than this are split anyway, so each one lands in few cells. */
const PIECE = 96;

/**
 * The part of a link inside `region` as straight pieces, each with how far it
 * can stray from the curve. The quadratic is halved (de Casteljau) until a
 * piece strays under half a pixel (a quadratic's chord strays at most
 * |P0 − 2P1 + P2| / 4) and is short; halves whose control points, grown by
 * `grow`, miss the region are dropped. So a link that runs a million pixels off
 * screen at high zoom costs only the few pieces near what's on screen.
 */
function sample(e: Edge, region: Rect, grow: number, each: (x1: number, y1: number, x2: number, y2: number, stray: number) => void) {
  const rx0 = region.x - grow;
  const ry0 = region.y - grow;
  const rx1 = region.x + region.w + grow;
  const ry1 = region.y + region.h + grow;
  const split = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, depth: number) => {
    // The curve lies inside its control points' box.
    if (Math.max(x0, x1, x2) < rx0 || Math.min(x0, x1, x2) > rx1 || Math.max(y0, y1, y2) < ry0 || Math.min(y0, y1, y2) > ry1) return;
    const stray = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2) / 4;
    if (depth >= 40 || (stray <= STRAY && Math.hypot(x2 - x0, y2 - y0) <= PIECE)) return each(x0, y0, x2, y2, stray);
    const ax = (x0 + x1) / 2;
    const ay = (y0 + y1) / 2;
    const bx = (x1 + x2) / 2;
    const by = (y1 + y2) / 2;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    split(x0, y0, ax, ay, mx, my, depth + 1);
    split(mx, my, bx, by, x2, y2, depth + 1);
  };
  const [x0, y0, cx, cy, x2, y2] = e.pts;
  split(x0, y0, cx, cy, x2, y2, 0);
}

/** Room left round a link: half its width and a little air. */
const edgePad = (e: Edge) => e.w / 2 + 2;

/** Whether a drawn link passes through the box, with its width and a little air around it. */
export function curveHits(e: Edge, box: Rect): boolean {
  const pad = edgePad(e);
  if (e.maxX < box.x - pad || e.minX > box.x + box.w + pad || e.maxY < box.y - pad || e.minY > box.y + box.h + pad) return false;
  let hit = false;
  sample(e, box, pad + STRAY, (ax, ay, bx, by, stray) => {
    hit ||= segmentHits(ax, ay, bx, by, box, pad + stray);
  });
  return hit;
}

// Screen cells for looking up what's near a spot. Each item is visited once per
// look (`seen`), and a link counts once however many of its pieces are hit (`hit`).
const CELL = 64;
type Item = { seen: number } & (
  | { k: 'seg'; link: { hit: number }; x1: number; y1: number; x2: number; y2: number; pad: number }
  | { k: 'rect'; r: Rect }
  | { k: 'circle'; d: Drawn }
);

/**
 * Everything a badge must keep clear of, bucketed into screen cells so each
 * spot a badge might take only checks what's near it. Only cells around the
 * circles that get a badge are filled, so a big map with a few badges stays cheap.
 */
export class BadgeSpace {
  private cells = new Map<number, Item[]>();
  private near = new Set<number>();
  private stamp = 0;
  // Cell bounds: off-screen parts can't meet a badge that's on screen, and the clamp bounds a huge circle's cells.
  private lo = -4;
  private hiX: number;
  private hiY: number;

  /** `badges` are the circles that will get one and each badge's size: a badge placed later must be no bigger. */
  constructor(
    private taken: Taken,
    drawn: readonly Drawn[],
    badges: readonly { d: Drawn; w: number; h: number }[],
  ) {
    this.hiX = Math.ceil(taken.view.w / CELL) + 4;
    this.hiY = Math.ceil(taken.view.h / CELL) + 4;
    // The farthest a badge reaches from its circle: past the ring by its longer side, whichever way it grows.
    // Everything a badge can reach, as one box too, to cut links down to the part that matters.
    const reach = { x: Infinity, y: Infinity, w: 0, h: 0 };
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const { d, w, h } of badges) {
      const r = ringGeometry(d.r).outer + 2 + Math.max(w, h);
      const [cx0, cx1, cy0, cy1] = this.span(d.x - r, d.y - r, d.x + r, d.y + r);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) this.near.add(key(cx, cy));
      reach.x = Math.min(reach.x, d.x - r);
      reach.y = Math.min(reach.y, d.y - r);
      x1 = Math.max(x1, d.x + r);
      y1 = Math.max(y1, d.y + r);
    }
    reach.w = x1 - reach.x;
    reach.h = y1 - reach.y;
    for (const e of taken.edges) {
      const link = { hit: 0 };
      const base = edgePad(e);
      sample(e, reach, base + STRAY, (ax, ay, bx, by, stray) => {
        const pad = base + stray;
        this.add({ k: 'seg', link, x1: ax, y1: ay, x2: bx, y2: by, pad, seen: 0 }, Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad);
      });
    }
    for (const r of taken.rects) this.add({ k: 'rect', r, seen: 0 }, r.x, r.y, r.x + r.w, r.y + r.h);
    for (const d of drawn) if (!d.open) this.add({ k: 'circle', d, seen: 0 }, d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r);
  }

  private span(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [
      Math.max(this.lo, Math.floor(x0 / CELL)),
      Math.min(this.hiX, Math.floor(x1 / CELL)),
      Math.max(this.lo, Math.floor(y0 / CELL)),
      Math.min(this.hiY, Math.floor(y1 / CELL)),
    ];
  }

  private add(item: Item, x0: number, y0: number, x1: number, y1: number) {
    const [cx0, cx1, cy0, cy1] = this.span(x0, y0, x1, y1);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        if (!this.near.has(k)) continue;
        const cell = this.cells.get(k);
        if (cell) cell.push(item);
        else this.cells.set(k, [item]);
      }
  }

  /** What covering `box` costs, stopping once it reaches `limit`. */
  private cost(box: Rect, self: Drawn, limit: number): number {
    const f = this.taken.free;
    let score = box.x < f.x0 || box.x + box.w > f.x1 || box.y < f.y0 || box.y + box.h > f.y1 ? 3 : 0;
    const stamp = ++this.stamp;
    const [cx0, cx1, cy0, cy1] = this.span(box.x, box.y, box.x + box.w, box.y + box.h);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = this.cells.get(key(cx, cy));
        if (!cell) continue;
        for (const it of cell) {
          if (it.seen === stamp) continue;
          it.seen = stamp;
          if (it.k === 'rect') {
            if (overlaps(it.r, box)) score += 10;
          } else if (it.k === 'seg') {
            if (it.link.hit !== stamp && segmentHits(it.x1, it.y1, it.x2, it.y2, box, it.pad)) {
              it.link.hit = stamp;
              score += 10;
            }
          } else if (it.d !== self) {
            const o = it.d;
            const nx = Math.max(box.x, Math.min(o.x, box.x + box.w));
            const ny = Math.max(box.y, Math.min(o.y, box.y + box.h));
            if ((nx - o.x) ** 2 + (ny - o.y) ** 2 < o.r * o.r) score += 1;
          }
          if (score >= limit) return score;
        }
      }
    return score;
  }

  /**
   * The best spot for a badge of this size on this circle: the first angle that
   * covers nothing, else the one that covers least. Links, tags, tabs and other
   * badges count heavily; other closed circles and leaving the free area a little.
   * The spot is then taken, so the next badge keeps clear of it.
   */
  place(d: Drawn, w: number, h: number): Rect {
    const out = ringGeometry(d.r).outer + 1;
    let best = boxAt(d, ANGLES[0], w, h, out);
    let bestScore = Infinity;
    for (const a of ANGLES) {
      const box = boxAt(d, a, w, h, out);
      const score = this.cost(box, d, bestScore);
      if (score < bestScore) {
        best = box;
        bestScore = score;
        if (!score) break;
      }
    }
    this.add({ k: 'rect', r: best, seen: 0 }, best.x, best.y, best.x + best.w, best.y + best.h);
    return best;
  }
}

const key = (cx: number, cy: number) => (cx + 64) * 4096 + (cy + 64);

/**
 * The last frame's badge spots, reused while nothing they depend on has moved:
 * the pulse after a change redraws every frame for seconds with the same geometry.
 */
export interface BadgeCache {
  key?: Float64Array;
  boxes?: Rect[];
}

/** Every number the badge spots depend on, in order, to compare with the last frame's. */
function geometryKey(taken: Taken, drawn: readonly Drawn[], badged: readonly { d: Drawn; w: number; h: number }[]): Float64Array {
  const out: number[] = [taken.view.w, taken.view.h, taken.free.x0, taken.free.x1, taken.free.y0, taken.free.y1, taken.edges.length];
  for (const e of taken.edges) out.push(e.w, ...e.pts);
  out.push(taken.rects.length);
  for (const r of taken.rects) out.push(r.x, r.y, r.w, r.h);
  out.push(drawn.length);
  for (const d of drawn) if (!d.open) out.push(d.x, d.y, d.r);
  out.push(badged.length);
  for (const b of badged) out.push(b.d.x, b.d.y, b.d.r, b.w, b.h);
  return Float64Array.from(out);
}

const sameKey = (a: Float64Array | undefined, b: Float64Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

// Badge type: `fine` Literata, the floor of the scale.
const BADGE_SIZE = 13;
const BADGE_H = 20;
const BADGE_PAD = 6;
const BADGE_GAP = 6;
const badgeFont = () => `400 ${BADGE_SIZE}px ${fonts().serif || 'serif'}`;

// Widths by font and text: a badge reads a few short strings, so each is measured once.
// The web font can arrive after the first frame; measure again when it does.
const widths = new Map<string, number>();
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => widths.clear());
function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}|${text}`;
  let w = widths.get(key);
  if (w == null) widths.set(key, (w = ctx.measureText(text).width));
  return w;
}

/**
 * Count badges on closed circles, "+2 ~1 −1 2 unread" in `fine` Literata, each count in its change's colour,
 * in a small square-cornered box on the raised surface. Placed clear of links, tags and name tabs.
 */
export function drawBadges(ctx: CanvasRenderingContext2D, drawn: Drawn[], marks: TreeActivity, taken: Taken, cache: BadgeCache = {}) {
  const font = badgeFont();
  ctx.font = font;
  const badges: { d: Drawn; m: Marks; w: number; h: number; parts: { text: string; color: string; w: number }[] }[] = [];
  for (const d of drawn) {
    const m = !d.open && marks.get(d.n.id);
    if (!m || !changeCount(m)) continue;
    // Small circles get a dot, the rest the counts.
    if (d.r < 9) {
      badges.push({ d, m, w: 5, h: 5, parts: [] });
      continue;
    }
    const parts = (
      [
        ['added', '+'],
        ['modified', '~'],
        ['deleted', '−'],
      ] as const
    )
      .filter(([k]) => m[k])
      .map(([k, sign]) => ({ text: `${sign}${m[k]}`, color: changeColor(k), w: measure(ctx, font, `${sign}${m[k]}`) }));
    // How many of those you haven't opened since they changed, in words.
    if (m.unread) parts.push({ text: `${m.unread} unread`, color: token('--unread'), w: measure(ctx, font, `${m.unread} unread`) });
    const w = Math.ceil(parts.reduce((a, p) => a + p.w, 0) + BADGE_GAP * (parts.length - 1) + BADGE_PAD * 2);
    badges.push({ d, m, w, h: BADGE_H, parts });
  }
  if (!badges.length) return;

  const k = geometryKey(taken, drawn, badges);
  let boxes = cache.boxes;
  if (!boxes || !sameKey(cache.key, k)) {
    const space = new BadgeSpace(taken, drawn, badges);
    boxes = badges.map((b) => space.place(b.d, b.w, b.h));
    cache.key = k;
    cache.boxes = boxes;
  }

  const raised = token('--ground-raised');
  const border = token('--hairline-strong');
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  badges.forEach((b, i) => {
    const box = boxes[i];
    if (!b.parts.length) {
      ctx.fillStyle = changeColor(dominant(b.m));
      ctx.beginPath();
      ctx.arc(box.x + 2.5, box.y + 2.5, 2.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Whole pixels, so the 1px border stays crisp.
    const x = Math.round(box.x) + 0.5;
    const y = Math.round(box.y) + 0.5;
    ctx.fillStyle = raised;
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.roundRect(x, y, b.w - 1, b.h - 1, 2);
    ctx.fill();
    ctx.stroke();
    let tx = x - 0.5 + BADGE_PAD;
    for (const p of b.parts) {
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, tx, y - 0.5 + b.h / 2 + 0.5);
      tx += p.w + BADGE_GAP;
    }
  });
  ctx.textAlign = 'center';
}

const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five'];

/**
 * How many agents meet at a circle: where they meet, or for a closed circle,
 * anywhere inside it (ids nest as "repo/folder/file"), as change badges roll up.
 */
export function collisionAt(id: string, open: boolean, at: ReadonlyMap<string, number>): number {
  let n = at.get(id) ?? 0;
  if (!open) for (const [c, k] of at) if (k > n && (c.startsWith(`${id}/`) || c.startsWith(`${id}#`))) n = k;
  return n;
}

/**
 * Where two or more agents' changes meet: "two agents" in ink at the foot of
 * the circle, in a gap cut from its rim, as an open circle's name sits at its
 * top. Returns the boxes it drew, for the badges to keep clear of.
 */
export function drawCollisions(ctx: CanvasRenderingContext2D, drawn: Drawn[], at: ReadonlyMap<string, number>): Rect[] {
  const out: Rect[] = [];
  if (!at.size) return out;
  const size = 13;
  ctx.font = `600 ${size}px ${fonts().serif}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 1;
  for (const d of drawn) {
    const n = collisionAt(d.n.id, d.open, at);
    if (!n || d.r < 4) continue;
    const text = `${COUNT_WORDS[n] ?? n} agents`;
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    const h = Math.round(size * 1.3) + 4;
    const x = Math.round(d.x - w / 2);
    // On the rim of a circle big enough to hold it there, else just under it.
    const y = Math.round(d.r > 24 ? d.y + d.r - h / 2 : d.y + d.r + 3);
    ctx.fillStyle = paper();
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = token('--text');
    ctx.fillText(text, d.x, y + h / 2 + 0.5);
    out.push({ x, y, w, h });
  }
  return out;
}
