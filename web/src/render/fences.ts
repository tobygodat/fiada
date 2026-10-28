// Fences on the map: a circle marked "ask first" gets a dashed ink line just
// inside its rim; one marked "off limits" gets the same line closed up, with a
// band of hatching inside it. Both are lines in ink, never a fill or a colour,
// so they stay apart from the layers and from the agent overlay's change
// colours; the detail panel says which fence it is in words.

import type { FenceRule } from '@fiada/shared';
import type { TNode } from '../graph/tree.ts';
import { token } from '../theme/tokens.ts';

interface Drawn {
  n: TNode;
  x: number;
  y: number;
  r: number;
  unlit?: boolean;
}

/** Hatching: lines this far apart, in a band this deep inside the rim (a small circle is hatched right through). */
const HATCH_GAP = 6;
const BAND = 10;

/** Where the fence line sits inside a circle of radius r: clear of the rim, never past the middle. */
export function fenceGeometry(r: number) {
  const inset = Math.min(3, r * 0.25);
  const lineR = Math.max(0.5, r - inset);
  const band = Math.min(BAND, lineR);

  return { lineR, inner: lineR - band, dash: r < 10 ? [2, 2] : [6, 4] };
}

/** Nearest and farthest a point in the w×h view lies from (x, y). */
function reach(x: number, y: number, view: { w: number; h: number }) {
  const nx = Math.max(0, Math.min(x, view.w)) - x;
  const ny = Math.max(0, Math.min(y, view.h)) - y;
  const fx = Math.max(Math.abs(x), Math.abs(view.w - x));
  const fy = Math.max(Math.abs(y), Math.abs(view.h - y));

  return { near: Math.hypot(nx, ny), far: Math.hypot(fx, fy) };
}

/**
 * The hatch lines of a fenced circle that cross the view, as offsets along x + y from its centre,
 * every HATCH_GAP from the centre so they stay put as the map pans. None when the band is off
 * screen or the view sits wholly inside it, so a circle zoomed far past the screen costs nothing.
 */
export function hatchOffsets(x: number, y: number, outer: number, inner: number, view: { w: number; h: number }): number[] {
  const { near, far } = reach(x, y, view);

  if (near > outer || far < inner) return [];
  const lo = Math.max(-2 * outer, -(x + y)) - HATCH_GAP;
  const hi = Math.min(2 * outer, view.w + view.h - (x + y)) + HATCH_GAP;
  const out: number[] = [];

  for (let o = Math.ceil(lo / HATCH_GAP) * HATCH_GAP; o <= hi; o += HATCH_GAP) out.push(o);

  return out;
}

export function drawFences(ctx: CanvasRenderingContext2D, drawn: readonly Drawn[], fenced: ReadonlyMap<string, FenceRule>, faint: number, view: { w: number; h: number }) {
  if (!fenced.size) return;
  const ink = token('--text');
  const muted = token('--muted');

  for (const d of drawn) {
    const rule = fenced.get(d.n.id);

    if (!rule || d.r < 3) continue;
    const g = fenceGeometry(d.r);
    // A fence line wholly outside the view, or round it, draws nothing.
    const { near, far } = reach(d.x, d.y, view);

    if (near > g.lineR + 2 || far < g.inner - 2) continue;
    const alpha = d.unlit ? faint : 1;
    const hatch = rule === 'off' ? hatchOffsets(d.x, d.y, g.lineR, g.inner, view) : [];

    if (hatch.length) {
      // The hatched band: diagonal lines clipped to the ring between the fence line and `inner`.
      ctx.save();
      ctx.beginPath();
      ctx.arc(d.x, d.y, g.lineR, 0, Math.PI * 2);

      if (g.inner > 1) ctx.arc(d.x, d.y, g.inner, 0, Math.PI * 2, true);
      ctx.clip('evenodd');
      ctx.globalAlpha = 0.7 * alpha;
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();

      // Each line runs x + y = c right across the view; the clip keeps it to the band.
      for (const o of hatch) {
        const c = d.x + d.y + o;
        ctx.moveTo(c + 2, -2);
        ctx.lineTo(c - view.h - 2, view.h + 2);
      }

      ctx.stroke();
      ctx.restore();
    }

    if (far < g.lineR - 2) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(rule === 'off' ? [] : g.dash);
    ctx.beginPath();
    ctx.arc(d.x, d.y, g.lineR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 1;
}
