// Type from the prototype, and the map's colours from the design tokens.
//
// Colour carries three meanings, and they never share a hue (DESIGN.md, "The
// map's three palettes"; theme/tokens.test.ts checks it):
// - change state, what an agent added, modified or deleted: ink, ochre, brick;
// - layers: quiet tints from the cool half of the wheel, then cool greys;
// - repositories: warm greys with no hue, told apart by name and place.
// The values live only in theme/tokens.css; this module hands them to the canvas.

import { UNLAYERED, type ChangeKind } from '@strata/shared';
import { changeColor, layerColor, repoColor } from './theme/tokens.ts';

export const INK = '#e6e3da';
export const BG = '#0c0d10';
export const MINT = 'oklch(85% 0.17 150)';
export const AMBER = 'oklch(82% 0.16 80)';
export const DANGER = 'oklch(72% 0.15 25)';
export const MONO = "'Geist Mono', ui-monospace, monospace";
export const SANS = "'Geist', system-ui, sans-serif";

/**
 * What a coding agent did to a file or symbol: the rings and badges on the
 * map and the +/~/− marks in the task queue. These colours mean a change and
 * nothing else. The values are the design tokens --added, --modified and
 * --deleted (theme/tokens.css); the literals only stand in outside a browser.
 */
export const CHANGE: Readonly<Record<ChangeKind, string>> = {
  get added() {
    return changeColor('added') || MINT;
  },
  get modified() {
    return changeColor('modified') || AMBER;
  },
  get deleted() {
    return changeColor('deleted') || DANGER;
  },
};

export type ColorBy = 'repo' | 'layer';

export interface Palette {
  repo(repoId: string, alpha?: number): string;
  /** Unlayered and unknown layers are neutral. */
  layer(layerId: string | undefined, alpha?: number): string;
  neutral(alpha?: number): string;
}

export function palette(repoIds: string[], layerIds: string[] = []): Palette {
  const idx = new Map(repoIds.map((id, i) => [id, i]));
  const layerIdx = new Map(layerIds.map((id, i) => [id, i]));
  const none = (a?: number) => layerColor(undefined, a);
  return {
    repo: (id, a) => {
      const i = idx.get(id);
      return i == null ? none(a) : repoColor(i, a);
    },
    layer: (l, a) => layerColor(l && l !== UNLAYERED ? layerIdx.get(l) : undefined, a),
    neutral: none,
  };
}
