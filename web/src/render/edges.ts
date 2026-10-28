// Which edges the map draws when nothing is in focus, and which way each
// one bends so it goes around circles rather than through them.

import type { Circle } from '../graph/layout.ts';
import { crossRepo, type Contract } from '../graph/view.ts';

/**
 * How much of the web the map shows. Kept in one place so the look can be
 * tuned (or switched with `?links=` in the URL) without touching the drawing.
 */
export interface EdgePolicy {
  /** Most links drawn before anyone points at anything: 0 draws none, Infinity every one. */
  restMax: number;
  /**
   * Most resting links inside any one open circle (or between the top-level
   * circles). Every open circle gets its strongest links first, so opening one
   * shows its own few key links rather than a tangle, and a small repository
   * isn't starved by a big one.
   */
  perContainer: number;
  /** Most links drawn for the circle you point at or select, strongest first; its panel lists the rest. */
  focusMax: number;
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
  /**
   * Plain words on resting links that have room for them ("12 calls",
   * "3 requests"): no box, set in a gap cut from the line, and gone the
   * moment anything is in focus.
   */
  restLabels: boolean;
  /** Opacity of resting links while a circle or contract is in focus. */
  restFade: number;
  /** Bend links around closed circles rather than through them. */
  route: boolean;
}

export const EDGE_POLICIES = {
  /** The few strongest links at rest; a circle's own links when you point at it or select it. */
  key: { restMax: 6, perContainer: 3, focusMax: 8, restPower: 0.3, restMinItems: 2, boost: 3, restTags: false, restLabels: true, restFade: 0.12, route: true },
  /** Every link and tag, as the map used to draw them. */
  all: { restMax: Infinity, perContainer: Infinity, focusMax: Infinity, restPower: 0, restMinItems: 1, boost: 1, restTags: true, restLabels: false, restFade: 0.12, route: true },
  /** No links until you point at a circle. */
  none: { restMax: 0, perContainer: 0, focusMax: 8, restPower: 0, restMinItems: 1, boost: 3, restTags: false, restLabels: false, restFade: 0, route: true },
} satisfies Record<string, EdgePolicy>;

export type EdgePreset = keyof typeof EDGE_POLICIES;

export const DEFAULT_EDGE_POLICY: EdgePolicy = EDGE_POLICIES.key;

export const edgeScore = (g: Contract, boost: number) => g.items.length * (g.kinds.has('http') || crossRepo(g) ? boost : 1);

/**
 * The few contracts worth drawing before anyone points at anything. `home`
 * names the open circle a contract sits in (see `meetingPoint`); each one
 * gets its own few strongest links, and the places take turns up to the cap.
 */
export function restEdges(
  contracts: Contract[],
  visible: ReadonlySet<string>,
  policy: EdgePolicy = DEFAULT_EDGE_POLICY,
  home: (g: Contract) => string = () => '',
): Set<string> {
  if (policy.restMax <= 0 || policy.perContainer <= 0) return new Set();
  const score = (g: Contract) => edgeScore(g, policy.boost);
  const byScore = (p: Contract, q: Contract) => score(q) - score(p) || (p.key < q.key ? -1 : 1);
  const places = new Map<string, Contract[]>();

  for (const g of contracts) {
    if (!visible.has(g.a) || !visible.has(g.b) || g.items.length < policy.restMinItems) continue;
    const h = home(g);
    const list = places.get(h);

    if (list) list.push(g);
    else places.set(h, [g]);
  }

  const picks: Contract[][] = [];

  for (const list of places.values()) {
    list.sort(byScore);
    const floor = score(list[0]) ** policy.restPower;
    picks.push(list.slice(0, policy.perContainer).filter((g) => score(g) >= floor));
  }

  // Every place's strongest link first, then every place's second, and so on.
  picks.sort((p, q) => byScore(p[0], q[0]));
  const out = new Set<string>();

  for (let round = 0; out.size < policy.restMax; round++) {
    let more = false;

    for (const list of picks) {
      if (round >= list.length || out.size >= policy.restMax) continue;
      out.add(list[round].key);
      more = true;
    }

    if (!more) break;
  }

  return out;
}

/**
 * Whether a straight rule from `a` to `z` runs over a ring round (`x`, `y`)
 * between radii `inner` and `outer`, such as the marks on an open circle's
 * rim: it comes within `outer` of the centre and has an end out past `inner`.
 * A rule wholly inside the ring's hole, or wholly clear of it, doesn't.
 */
export function ruleCrossesRing(a: { x: number; y: number }, z: { x: number; y: number }, ring: { x: number; y: number; inner: number; outer: number }): boolean {
  const dx = z.x - a.x;
  const dy = z.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((ring.x - a.x) * dx + (ring.y - a.y) * dy) / l2)) : 0;
  const near = Math.hypot(ring.x - (a.x + t * dx), ring.y - (a.y + t * dy));
  const far = Math.max(Math.hypot(a.x - ring.x, a.y - ring.y), Math.hypot(z.x - ring.x, z.y - ring.y));

  return near < ring.outer && far > ring.inner;
}

/**
 * Where a resting link's words go: in a gap cut from the line near its middle
 * when the link is long enough to keep a stretch of line either side, else
 * just beside the line, above or below it, hung from it by a short rule
 * when neighbouring circles push the words further off. Points nearer the
 * middle win.
 * `half` is half the words' box; `ok` says whether a box centred there is
 * clear (of the view's edges, tags, names and closed circles), and for words
 * on a rule, whether the rule from `from` is clear too. Null when nothing fits.
 */
export function labelSpot(
  [x1, y1, cx, cy, x2, y2]: readonly number[],
  gap: number,
  half: { w: number; h: number },
  lineWidth: number,
  ok: (p: { x: number; y: number }, from?: { x: number; y: number }) => boolean,
): { x: number; y: number; inline: boolean; from?: { x: number; y: number } } | null {
  const ts = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];

  const point = (t: number) => {
    const u = 1 - t;

    return { x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * y1 + 2 * u * t * cy + t * t * y2 };
  };

  if (gap >= half.w * 2 + 48) {
    for (const t of ts) {
      const p = point(t);

      if (ok(p)) return { ...p, inline: true };
    }
  }

  // Beside the line: along its normal, far enough that the box clears the stroke whichever way the line runs.
  const clear = lineWidth / 2 + 3;

  for (const more of [0, 12, 26, 42, 60]) {
    for (const t of ts) {
      const { x, y } = point(t);
      const u = 1 - t;
      const tx = 2 * u * (cx - x1) + 2 * t * (x2 - cx);
      const ty = 2 * u * (cy - y1) + 2 * t * (y2 - cy);
      const d = Math.hypot(tx, ty) || 1;
      const nx = -ty / d;
      const ny = tx / d;
      // The box's reach along the normal: its half height across a level line, its half width beside an upright one.
      const off = Math.abs(nx) * half.w + Math.abs(ny) * half.h + clear + more;

      for (const side of [-1, 1]) {
        const p = { x: x + nx * off * side, y: y + ny * off * side };
        // Further off only where circles crowd the line; the words then hang from it by a short rule.
        const from = more ? { x: x + nx * (clear - 1) * side, y: y + ny * (clear - 1) * side } : undefined;

        if (ok(p, from)) return { ...p, inline: false, from };
      }
    }
  }

  return null;
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
