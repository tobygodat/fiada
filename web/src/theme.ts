// Palette and type from the prototype's "orbital" look.

import type { Layer } from '@strata/shared';

export const INK = '#e6e3da';
export const BG = '#0c0d10';
export const MINT = 'oklch(85% 0.17 150)';
export const AMBER = 'oklch(82% 0.16 80)';
export const MONO = "'Geist Mono', ui-monospace, monospace";
export const SANS = "'Geist', system-ui, sans-serif";

// One hue per repository, in import order.
const REPO_HUES = ['72% 0.14 280', '74% 0.13 190', '74% 0.14 25', '78% 0.10 95', '76% 0.13 150', '74% 0.14 330', '78% 0.12 60', '74% 0.12 230'];

const LAYER_HUES: Record<Layer, string> = {
  UI: '74% 0.14 330',
  Client: '72% 0.14 280',
  API: '74% 0.13 190',
  Services: '76% 0.13 150',
  Storage: '78% 0.12 60',
  Pipeline: '74% 0.14 25',
  Contracts: '78% 0.10 95',
  Other: '70% 0 0',
};

const NEUTRAL = '80% 0 0';

const oklch = (hue: string, a?: number) => `oklch(${hue}${a == null ? '' : ` / ${a}`})`;

export type ColorBy = 'repo' | 'layer';

export interface Palette {
  repo(repoId: string, alpha?: number): string;
  layer(layer: Layer | undefined, alpha?: number): string;
  neutral(alpha?: number): string;
}

export function palette(repoIds: string[]): Palette {
  const idx = new Map(repoIds.map((id, i) => [id, i]));
  return {
    repo: (id, a) => {
      const i = idx.get(id);
      return oklch(i == null ? NEUTRAL : REPO_HUES[i % REPO_HUES.length], a);
    },
    layer: (l, a) => oklch(l ? LAYER_HUES[l] : NEUTRAL, a),
    neutral: (a) => oklch(NEUTRAL, a),
  };
}
