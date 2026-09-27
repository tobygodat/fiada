// Which edges the map draws when nothing is in focus, and which way each
// one bends so it goes around circles rather than through them.

import type { Circle } from '../graph/layout.ts';
import type { Contract } from '../graph/view.ts';

/**
 * How much of the web the map shows. Kept in one place so the look can be
 * tuned (or switched with `?links=` in the URL) without touching the drawing.
 */
export interface EdgePolicy {
  /** Most links drawn before anyone points at anything: 0 draws none, Infinity every one. */
  restMax: number;
  /**
   * A resting link must score at least the strongest one's score to this power
   * (0 keeps everything). Weights are heavy-tailed, one contract often carrying
   * hundreds of interactions, so a linear share would leave just that one.
   */
  restPower: number;
  /** Fewest interactions a resting link carries. */
  restMinItems: number;
  /** Score multiplier for HTTP and cross-repository links: how a system hangs together outranks plain imports. */
  boost: number;
  /** Letter tags on resting links too, not just on the ones in focus. */
  restTags: boolean;
  /** Opacity of resting links while a circle or contract is in focus. */
  restFade: number;
  /** Bend links around closed circles rather than through them. */
  route: boolean;
}

export const EDGE_POLICIES = {
  /** The few strongest links at rest; a circle's own links when you point at it or select it. */
  key: { restMax: 6, restPower: 0.3, restMinItems: 2, boost: 3, restTags: false, restFade: 0.12, route: true },
  /** Every link and tag, as the map used to draw them. */
  all: { restMax: Infinity, restPower: 0, restMinItems: 1, boost: 1, restTags: true, restFade: 0.12, route: true },
  /** No links until you point at a circle. */
  none: { restMax: 0, restPower: 0, restMinItems: 1, boost: 3, restTags: false, restFade: 0, route: true },
} satisfies Record<string, EdgePolicy>;

export type EdgePreset = keyof typeof EDGE_POLICIES;
export const DEFAULT_EDGE_POLICY: EdgePolicy = EDGE_POLICIES.key;

export const edgeScore = (g: Contract, boost: number) => g.items.length * (g.kinds.has('http') || g.cross ? boost : 1);

/** The few contracts worth drawing before anyone points at anything. */
export function restEdges(contracts: Contract[], visible: ReadonlySet<string>, policy: EdgePolicy = DEFAULT_EDGE_POLICY): Set<string> {
  if (policy.restMax <= 0) return new Set();
  const top: Contract[] = [];
  for (const g of contracts) {
    if (!visible.has(g.a) || !visible.has(g.b) || g.items.length < policy.restMinItems) continue;
    top.push(g);
  }
  const score = (g: Contract) => edgeScore(g, policy.boost);
  top.sort((p, q) => score(q) - score(p) || (p.key < q.key ? -1 : 1));
  const floor = top.length ? score(top[0]) ** policy.restPower : Infinity;
  return new Set(
    top
      .slice(0, policy.restMax)
      .filter((g) => score(g) >= floor)
      .map((g) => g.key),
  );
}

/** Sideways offset of the curve's control point, as a share of the gap between the two rims. */
export const DEFAULT_BEND = 0.12;
// Wide enough to swing round a circle that sits right on the line between the two ends.
const BENDS = [DEFAULT_BEND, -DEFAULT_BEND, 0.26, -0.26, 0.42, -0.42, 0.62, -0.62, 0.85, -0.85, 0];

/** The quadratic curve drawn between two circles: rim to rim, bent sideways by `bend`. */
export function curve(A: Circle, B: Circle, bend: number) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const x1 = A.x + ux * A.r;
  const y1 = A.y + uy * A.r;
  const x2 = B.x - ux * B.r;
  const y2 = B.y - uy * B.r;
  // Bend by the gap, not the distance between centres, so neighbours that almost touch get a short straight link.
  const gap = Math.max(0, d - A.r - B.r);
  return { x1, y1, mx: (x1 + x2) / 2 - uy * gap * bend, my: (y1 + y2) / 2 + ux * gap * bend, x2, y2, d, gap };
}

/**
 * The bend that takes the curve through the fewest other circles, preferring
 * gentle ones. Works in layout space, so the answer holds at any zoom.
 */
export function bestBend(A: Circle, B: Circle, obstacles: readonly Circle[]): number {
  const { x1, y1, x2, y2, gap } = curve(A, B, 0);
  const pad = gap * 0.25;
  const minX = Math.min(x1, x2) - pad;
  const maxX = Math.max(x1, x2) + pad;
  const minY = Math.min(y1, y2) - pad;
  const maxY = Math.max(y1, y2) + pad;
  const near = obstacles.filter((c) => c !== A && c !== B && c.x + c.r > minX && c.x - c.r < maxX && c.y + c.r > minY && c.y - c.r < maxY);
  if (!near.length) return DEFAULT_BEND;
  let best = DEFAULT_BEND;
  let bestCost = Infinity;
  for (const bend of BENDS) {
    const c = curve(A, B, bend);
    let hits = 0;
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const s = 1 - t;
      const px = s * s * c.x1 + 2 * s * t * c.mx + t * t * c.x2;
      const py = s * s * c.y1 + 2 * s * t * c.my + t * t * c.y2;
      for (const o of near) if ((px - o.x) ** 2 + (py - o.y) ** 2 < (o.r * 1.08) ** 2) hits++;
    }
    // A wide arc costs about as much as grazing one circle, so arcs are only for real crossings.
    const cost = hits + 1.4 * Math.abs(bend);
    if (cost < bestCost) {
      bestCost = cost;
      best = bend;
    }
  }
  return best;
}
