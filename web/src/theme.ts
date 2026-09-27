// The map's colours, from the design tokens.
//
// Colour carries three meanings, and they never share a hue (DESIGN.md, "The
// map's three palettes"; theme/tokens.test.ts checks it):
// - change state, what an agent added, modified or deleted: ink, ochre, brick;
// - layers: quiet tints from the cool half of the wheel, then cool greys;
// - repositories: warm greys with no hue, told apart by name and place.
// The values live only in theme/tokens.css; this module hands them to the canvas.

import { UNLAYERED, type ChangeKind } from '@strata/shared';
import { changeColor, layerColor, repoColor } from './theme/tokens.ts';

/**
 * Stand-ins for the agent overlay (render/activity.ts) until it reads the
 * tokens itself: BG only ever backs up token('--ground'), which a browser
 * always has. Nothing new may use them. Colours live in theme/tokens.css.
 * @deprecated use token('--ground') and fonts() from theme/tokens.ts
 */
export const BG = '';
/** @deprecated see BG */
export const MONO = "'Geist Mono', ui-monospace, monospace";

/**
 * What a coding agent did to a file or symbol: the rings and badges on the
 * map and the +/~/− marks in the task queue. These colours mean a change and
 * nothing else: the design tokens --added, --modified and --deleted.
 */
export const CHANGE: Readonly<Record<ChangeKind, string>> = {
  get added() {
    return changeColor('added');
  },
  get modified() {
    return changeColor('modified');
  },
  get deleted() {
    return changeColor('deleted');
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
