// The camera maps world coordinates to screen pixels: screen = t + world * k.

import type { Circle } from './layout.ts';

export interface Camera {
  k: number;
  tx: number;
  ty: number;
}

export const MIN_K = 1e-4;
export const MAX_K = 5e4;

/** The stage, and how much of it floating panels cover on each side. */
export interface Viewport {
  w: number;
  h: number;
  /** Pixels covered on the left (the sidebar). */
  left: number;
  /** Pixels covered on the right (the detail panel). */
  right: number;
}

/** The part of the stage the map can use: panels are avoided while that leaves enough room. */
export function freeArea(v: Viewport) {
  const left = v.w - v.left > 480 ? v.left : 0;
  const right = v.w - left - v.right > 480 ? v.right : 0;
  const w = v.w - left - right;

  return { cx: left + w / 2, cy: v.h / 2, w, h: v.h, side: Math.min(w, v.h) };
}

/** Camera that shows `c` with its radius at `fraction` of the free area's smaller side. */
export function frame(c: Circle, v: Viewport, fraction: number, maxK = MAX_K): Camera {
  const f = freeArea(v);
  const k = Math.min(maxK, clampK((f.side * fraction) / Math.max(c.r, 1e-6)));

  return { k, tx: f.cx - c.x * k, ty: f.cy - c.y * k };
}

/** Smallest circle containing both. */
export function enclose(a: Circle, b: Circle): Circle {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);

  if (d + b.r <= a.r) return a;

  if (d + a.r <= b.r) return b;
  const r = (d + a.r + b.r) / 2;
  const t = (r - a.r) / d;

  return { x: a.x + dx * t, y: a.y + dy * t, r };
}

/** Radius on screen of `c` under camera `cam`. */
export const screenR = (c: Circle, cam: Camera) => c.r * cam.k;

export const clampK = (k: number) => Math.max(MIN_K, Math.min(MAX_K, k));

/** Zoom by `factor` keeping the world point under (mx, my) fixed. */
export function zoomAt(cam: Camera, factor: number, mx: number, my: number): Camera {
  const k = clampK(cam.k * factor);
  const f = k / cam.k;

  return { k, tx: mx - (mx - cam.tx) * f, ty: my - (my - cam.ty) * f };
}

/**
 * Smooth zoom between two cameras (van Wijk and Nuij, "Smooth and efficient
 * zooming and panning"): long moves zoom out, travel, and zoom back in, so
 * the destination's surroundings stay in view. `anchor` is the screen point
 * both views are centred on. Returns the interpolator and a natural duration.
 */
export function smoothZoom(a: Camera, b: Camera, anchor: { x: number; y: number }, size: number) {
  const view = (c: Camera) => [(anchor.x - c.tx) / c.k, (anchor.y - c.ty) / c.k, size / c.k] as const;
  const [ux0, uy0, w0] = view(a);
  const [ux1, uy1, w1] = view(b);
  const rho = Math.SQRT2;
  const rho2 = 2;
  const rho4 = 4;
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  let at: (t: number) => [number, number, number];
  let S: number;

  if (d2 < 1e-12 * w0 * w0) {
    S = Math.log(w1 / w0) / rho;
    at = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)];
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / rho;
    at = (t) => {
      const s = t * S;
      const coshr0 = Math.cosh(r0);
      const u = (w0 / (rho2 * d1)) * (coshr0 * Math.tanh(rho * s + r0) - Math.sinh(r0));

      return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(rho * s + r0)];
    };
  }

  const interpolate = (t: number): Camera => {
    if (t >= 1) return b;
    const [x, y, w] = at(t);
    const k = size / w;

    return { k, tx: anchor.x - x * k, ty: anchor.y - y * k };
  };

  return { interpolate, duration: Math.abs(S) * 1000 * (rho / Math.SQRT2) };
}

/** Straight interpolation: centre linearly, scale in log space. For moves that happen while the layout itself animates. */
export function directZoom(a: Camera, b: Camera, anchor: { x: number; y: number }) {
  const ax = (anchor.x - a.tx) / a.k;
  const ay = (anchor.y - a.ty) / a.k;
  const bx = (anchor.x - b.tx) / b.k;
  const by = (anchor.y - b.ty) / b.k;
  const lk = Math.log(b.k / a.k);

  return (t: number): Camera => {
    if (t >= 1) return b;
    const k = a.k * Math.exp(lk * t);
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;

    return { k, tx: anchor.x - x * k, ty: anchor.y - y * k };
  };
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
