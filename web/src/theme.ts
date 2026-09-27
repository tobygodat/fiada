// The map's colours, from the design tokens.
//
// Colour carries three meanings, and they never share a hue (DESIGN.md, "The
// map's three palettes"; theme/tokens.test.ts checks it):
// - change state, what an agent added, modified or deleted: ink, ochre, brick
//   (the agent overlay reads these itself, through changeColor in theme/tokens.ts);
// - layers: quiet tints from the cool half of the wheel, then cool greys;
// - repositories: warm greys with no hue, told apart by name and place.
// The values live only in theme/tokens.css; this module hands them to the canvas.

import { UNLAYERED } from '@strata/shared';
import { layerColor, repoColor } from './theme/tokens.ts';

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
