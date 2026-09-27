// Palette and type from the prototype's "orbital" look.

import { UNLAYERED, type ChangeKind } from '@strata/shared';
import { changeColor } from './theme/tokens.ts';

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

// One hue per repository, in import order.
const REPO_HUES = ['72% 0.14 280', '74% 0.13 190', '74% 0.14 25', '78% 0.10 95', '76% 0.13 150', '74% 0.14 330', '78% 0.12 60', '74% 0.12 230'];

// Layers are per project, so hues go by position in the project's layer list
// (the roles preset reads ui, client, api, service, data, job, contract, test).
const LAYER_HUES = ['74% 0.14 330', '72% 0.14 280', '74% 0.13 190', '76% 0.13 150', '78% 0.12 60', '74% 0.14 25', '78% 0.10 95', '70% 0.07 250', '76% 0.12 115', '72% 0.13 0', '76% 0.11 215', '78% 0.09 170'];

const NEUTRAL = '80% 0 0';

const oklch = (hue: string, a?: number) => `oklch(${hue}${a == null ? '' : ` / ${a}`})`;

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
  return {
    repo: (id, a) => {
      const i = idx.get(id);
      return oklch(i == null ? NEUTRAL : REPO_HUES[i % REPO_HUES.length], a);
    },
    layer: (l, a) => {
      const i = l && l !== UNLAYERED ? layerIdx.get(l) : undefined;
      return oklch(i == null ? NEUTRAL : LAYER_HUES[i % LAYER_HUES.length], a);
    },
    neutral: (a) => oklch(NEUTRAL, a),
  };
}
