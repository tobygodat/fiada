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

export function drawFences(ctx: CanvasRenderingContext2D, drawn: readonly Drawn[], fenced: ReadonlyMap<string, FenceRule>, faint: number) {
  if (!fenced.size) return;
  const ink = token('--text');
  const muted = token('--muted');
  for (const d of drawn) {
    const rule = fenced.get(d.n.id);
    if (!rule || d.r < 3) continue;
    const g = fenceGeometry(d.r);
    const alpha = d.unlit ? faint : 1;
    if (rule === 'off') {
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
      const R = g.lineR;
      for (let o = -2 * R; o <= 2 * R; o += HATCH_GAP) {
        ctx.moveTo(d.x + o - R, d.y + R);
        ctx.lineTo(d.x + o + R, d.y - R);
      }
      ctx.stroke();
      ctx.restore();
    }
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
