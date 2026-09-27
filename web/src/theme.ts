// Palette and type from the prototype's "orbital" look.
//
// Colour carries three meanings, and they never share a hue:
// - change state, what an agent added, modified or deleted, owns saturated
//   green, amber and red, and no other colour on the map comes within 30° of
//   them (roughly 355° round to 180°);
// - layers fill circles from the cool half of the wheel, the request flow
//   running pink UI → violet Client → blue API → azure Service → teal Data;
// - repositories take no hue at all: a light-to-dark neutral step, and their
//   names on the map.

import { UNLAYERED, type ChangeKind } from '@strata/shared';

export const INK = '#e6e3da';
export const BG = '#0c0d10';
export const MONO = "'Geist Mono', ui-monospace, monospace";
export const SANS = "'Geist', system-ui, sans-serif";

/**
 * What a coding agent did to a file or symbol: the rings and badges on the
 * map and the +/~/− marks in the task queue. These hues mean a change and
 * nothing else; an agent's own state (working, waiting) is drawn in ink.
 * styles.css repeats them as --added, --modified and --deleted.
 */
export const CHANGE = {
  added: 'oklch(85% 0.17 150)',
  modified: 'oklch(82% 0.16 80)',
  deleted: 'oklch(72% 0.15 25)',
} as const satisfies Record<ChangeKind, string>;
/** The hues above; repo and layer colours stay at least `RESERVED_ARC` degrees from each. */
export const CHANGE_HUES = [150, 80, 25] as const;
export const RESERVED_ARC = 30;

// Repositories are told apart by name and by lightness, never by hue.
const REPO_TONES = ['88% 0 0', '66% 0 0', '78% 0 0', '58% 0 0', '94% 0 0', '72% 0 0'];

// Layers are per project, so colours go by position in the project's layer list.
// The roles preset reads ui, client, api, service, data, job, contract, test:
// the five flow layers get clear hues, the rest near-greys.
const LAYER_HUES = [
  '74% 0.13 345',
  '70% 0.13 305',
  '70% 0.12 268',
  '78% 0.11 233',
  '80% 0.10 200',
  '70% 0.04 285',
  '82% 0.035 220',
  '64% 0.035 320',
  '86% 0.03 255',
  '74% 0.035 190',
];

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
      return oklch(i == null ? NEUTRAL : REPO_TONES[i % REPO_TONES.length], a);
    },
    layer: (l, a) => {
      const i = l && l !== UNLAYERED ? layerIdx.get(l) : undefined;
      return oklch(i == null ? NEUTRAL : LAYER_HUES[i % LAYER_HUES.length], a);
    },
    neutral: (a) => oklch(NEUTRAL, a),
  };
}

/** Every colour the palettes hand out, as [lightness, chroma, hue], for tests. */
export const PALETTE_SPECS = {
  repo: REPO_TONES,
  layer: LAYER_HUES,
  change: Object.values(CHANGE).map((c) => c.slice(6, -1)),
};
