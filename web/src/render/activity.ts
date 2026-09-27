// The agent overlay, drawn over the map's circles: a ring just outside
// anything an agent added, modified or deleted, a pulse for a few seconds
// after each change, and on closed circles a small count of the changes
// inside. It stays quiet on purpose: thin rings, one small badge, and no
// motion once the agent stops. The colours mean a change and nothing else
// (theme.ts CHANGE); a thin dark gap keeps a ring apart from the circle's own
// layer colour, and a badge sits wherever it covers no link, tag or name tab.

import { changeCount, type Marks, type TreeActivity } from '../graph/activity.ts';
import type { TNode } from '../graph/tree.ts';
import { BG, CHANGE, MONO } from '../theme.ts';

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

/** Rings and pulses. Returns whether anything is still pulsing, so the caller keeps animating. */
export function drawRings(ctx: CanvasRenderingContext2D, drawn: Drawn[], marks: TreeActivity, now: number): boolean {
  let pulsing = false;
  for (const d of drawn) {
    const m = marks.get(d.n.id);
    if (!m) continue;
    const age = now - m.at;
    const recent = age >= 0 && age < PULSE_MS;
    const g = ringGeometry(d.r);
    if (m.self) {
      const color = CHANGE[m.self];
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = BG;
      ctx.lineWidth = g.gap;
      ctx.beginPath();
      ctx.arc(d.x, d.y, g.gapR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = color;
      ctx.lineWidth = g.line;
      ctx.setLineDash(m.self === 'deleted' ? [3, 3] : []);
      ctx.beginPath();
      ctx.arc(d.x, d.y, g.lineR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (recent) {
        halo(ctx, d.x, d.y, g.outer, color, age, 0.7);
        pulsing = true;
      }
    } else if (!d.open && recent && changeCount(m)) {
      // Something inside a closed circle just changed.
      halo(ctx, d.x, d.y, d.r, CHANGE[dominant(m)], age, 0.45);
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
  // On a diagonal the box meets the ring at a corner, which the pill rounds off: tuck it in to touch.
  const at = Math.abs(c) > 0.3 && Math.abs(s) > 0.3 ? out - 2.5 : out;
  const px = d.x + c * at;
  const py = d.y + s * at;
  const x = c > 0.3 ? px : c < -0.3 ? px - w : px - w / 2;
  const y = s > 0.3 ? py : s < -0.3 ? py - h : py - h / 2;
  return { x, y, w, h };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether the segment from (x1, y1) to (x2, y2) passes through the box (Liang–Barsky). */
function segmentHits(x1: number, y1: number, x2: number, y2: number, b: Rect): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x1 - b.x],
    [dx, b.x + b.w - x1],
    [-dy, y1 - b.y],
    [dy, b.y + b.h - y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

const STEPS = 16;

/** Whether a drawn link passes through the box, with its width and a little air around it. */
export function curveHits(e: Taken['edges'][number], box: Rect): boolean {
  const pad = e.w / 2 + 2;
  const b = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  if (e.maxX < b.x || e.minX > b.x + b.w || e.maxY < b.y || e.minY > b.y + b.h) return false;
  const [x1, y1, cx, cy, x2, y2] = e.pts;
  let px = x1;
  let py = y1;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    const x = u * u * x1 + 2 * u * t * cx + t * t * x2;
    const y = u * u * y1 + 2 * u * t * cy + t * t * y2;
    if (segmentHits(px, py, x, y, b)) return true;
    px = x;
    py = y;
  }
  return false;
}

/**
 * The best spot for a badge of this size on this circle: the first angle that
 * covers nothing, else the one that covers least. Links, tags, tabs and other
 * badges count heavily; other closed circles and leaving the free area a little.
 */
export function placeBadge(d: Drawn, w: number, h: number, taken: Taken, others: readonly Drawn[], placed: readonly Rect[]): Rect {
  const out = ringGeometry(d.r).outer + 1;
  let best: Rect | null = null;
  let bestScore = Infinity;
  for (const a of ANGLES) {
    const box = boxAt(d, a, w, h, out);
    let score = 0;
    for (const e of taken.edges) if (curveHits(e, box)) score += 10;
    for (const r of taken.rects) if (overlaps(r, box)) score += 10;
    for (const r of placed) if (overlaps(r, box)) score += 10;
    if (score >= bestScore) continue;
    const f = taken.free;
    if (box.x < f.x0 || box.x + box.w > f.x1 || box.y < f.y0 || box.y + box.h > f.y1) score += 3;
    for (const o of others) {
      if (o === d || o.open) continue;
      const nx = Math.max(box.x, Math.min(o.x, box.x + box.w));
      const ny = Math.max(box.y, Math.min(o.y, box.y + box.h));
      if (Math.hypot(nx - o.x, ny - o.y) < o.r) score += 1;
    }
    if (score < bestScore) {
      best = box;
      bestScore = score;
      if (!score) break;
    }
  }
  return best!;
}

/** Count badges on closed circles, "+2 ~1 −1", placed clear of links, tags and name tabs. */
export function drawBadges(ctx: CanvasRenderingContext2D, drawn: Drawn[], marks: TreeActivity, textWidth: (s: string) => number, taken: Taken) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const placed: Rect[] = [];
  for (const d of drawn) {
    if (d.open) continue;
    const m = marks.get(d.n.id);
    if (!m || !changeCount(m)) continue;
    const main = CHANGE[dominant(m)];
    if (d.r < 9) {
      const box = placeBadge(d, 5, 5, taken, drawn, placed);
      placed.push(box);
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.arc(box.x + 2.5, box.y + 2.5, 2.5, 0, Math.PI * 2);
      ctx.fill();
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
      .map(([k, sign]) => ({ text: `${sign}${m[k]}`, color: CHANGE[k] }));
    const gap = 5;
    const widths = parts.map((p) => textWidth(p.text));
    const w = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 12;
    const h = 16;
    const box = placeBadge(d, w, h, taken, drawn, placed);
    placed.push(box);
    ctx.fillStyle = BG;
    ctx.strokeStyle = main;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, w, h, h / 2);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = `500 10px ${MONO}`;
    let tx = box.x + 6;
    parts.forEach((p, i) => {
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, tx, box.y + h / 2 + 0.5);
      tx += widths[i] + gap;
    });
  }
  ctx.textAlign = 'center';
}
