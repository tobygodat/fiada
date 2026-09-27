// The agent overlay, drawn over the map's circles: a ring on anything an
// agent added (mint), modified (amber) or deleted, a pulse for a few seconds
// after each change, and on closed circles a small count of the changes
// inside. It stays quiet on purpose: thin rings, one small badge, and no
// motion once the agent stops.

import { changeCount, type Marks, type TreeActivity } from '../graph/activity.ts';
import type { TNode } from '../graph/tree.ts';
import { AMBER, BG, DANGER, MINT, MONO } from '../theme.ts';

/** How long a change keeps pulsing. */
export const PULSE_MS = 8000;
const PERIOD = 1400;

const COLOR = { added: MINT, modified: AMBER, deleted: DANGER } as const;

interface Drawn {
  n: TNode;
  x: number;
  y: number;
  r: number;
  open: boolean;
}

const dominant = (m: Marks) => (m.added >= m.modified && m.added >= m.deleted ? 'added' : m.modified >= m.deleted ? 'modified' : 'deleted');

function halo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, age: number, strength: number) {
  const phase = (age % PERIOD) / PERIOD;
  ctx.globalAlpha = (1 - phase) * strength * (1 - age / PULSE_MS);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r + 3 + phase * Math.min(14, 4 + r * 0.25), 0, Math.PI * 2);
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
    if (m.self) {
      const color = COLOR[m.self];
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = color;
      ctx.lineWidth = d.r > 6 ? 1.75 : 1.25;
      ctx.setLineDash(m.self === 'deleted' ? [3, 3] : []);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r + (d.open ? 0 : 2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (recent) {
        halo(ctx, d.x, d.y, d.r, color, age, 0.7);
        pulsing = true;
      }
    } else if (!d.open && recent && changeCount(m)) {
      // Something inside a closed circle just changed.
      halo(ctx, d.x, d.y, d.r, COLOR[dominant(m)], age, 0.45);
      pulsing = true;
    }
  }
  ctx.globalAlpha = 1;
  return pulsing;
}

/** Count badges on closed circles: "+2 ~1 −1" at the upper right of the circle. */
export function drawBadges(ctx: CanvasRenderingContext2D, drawn: Drawn[], marks: TreeActivity, textWidth: (s: string) => number) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const d of drawn) {
    if (d.open) continue;
    const m = marks.get(d.n.id);
    if (!m || !changeCount(m)) continue;
    const x = d.x + d.r * 0.7071;
    const y = d.y - d.r * 0.7071;
    const main = COLOR[dominant(m)];
    if (d.r < 9) {
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
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
      .map(([k, sign]) => ({ text: `${sign}${m[k]}`, color: COLOR[k] }));
    const gap = 5;
    const widths = parts.map((p) => textWidth(p.text));
    const w = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 12;
    const h = 16;
    const bx = x - 4;
    const by = y - h / 2;
    ctx.fillStyle = BG;
    ctx.strokeStyle = main;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, h / 2);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = `500 10px ${MONO}`;
    let tx = bx + 6;
    parts.forEach((p, i) => {
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, tx, y + 0.5);
      tx += widths[i] + gap;
    });
  }
  ctx.textAlign = 'center';
}
