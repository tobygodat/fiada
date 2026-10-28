// The design tokens for code that can't use CSS variables: the canvas renderer draws with
// these strings. The values live only in tokens.css; this reads them off the page, so a token
// edit or a theme switch needs no change here. Outside a browser (node tests) every token is ''.

export type Theme = 'dark' | 'light';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'working' | 'looked';

/** Layers 1–8 have a colour each; the rest, and unlayered nodes, are --layer-none. */
export const LAYER_SLOTS = 8;

/** Repos repeat after four; their names and places on the map tell them apart. */
export const REPO_SLOTS = 4;

const THEME_KEY = 'strata-theme';
const cache = new Map<string, string>();
let cachedFor: Theme | null = null;

/** A token's value, e.g. token('--accent') → '#8fd18a' in the dark theme. */
export function token(name: `--${string}`): string {
  const theme = getTheme();

  if (theme !== cachedFor) {
    cache.clear();
    cachedFor = theme;
  }

  let v = cache.get(name);

  if (v == null) {
    v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }

  return v;
}

/** The colour at opacity `a`: for canvas fills and strokes that fade a token. Takes hex, rgb() and oklch(). */
export function withAlpha(color: string, a: number): string {
  if (a >= 1) return color;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);

  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));

    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)(?:,\s*([\d.]+))?\)$/.exec(color);

  if (rgb) return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${Number(rgb[4] ?? 1) * a})`;
  const fn = /^(oklch|oklab|lab|lch|hsl)\(([^/)]+)\)$/.exec(color);

  if (fn) return `${fn[1]}(${fn[2].trim()} / ${a})`;

  return color;
}

/** Colour of the layer at `index` in the project's layer list; undefined or past the eighth is --layer-none. */
export function layerColor(index: number | undefined, a = 1): string {
  const name = index != null && index >= 0 && index < LAYER_SLOTS ? (`--layer-${index + 1}` as const) : '--layer-none';

  return withAlpha(token(name), a);
}

/** Colour of the repository at `index` in import order. */
export function repoColor(index: number, a = 1): string {
  return withAlpha(token(`--repo-${(Math.max(0, index) % REPO_SLOTS) + 1}`), a);
}

/** Colour of an agent mark: added, modified, deleted, an agent working there now, or code it looked at. */
export function changeColor(kind: ChangeKind, a = 1): string {
  return withAlpha(token(`--${kind}`), a);
}

/** Font stacks for ctx.font, e.g. `600 13px ${fonts().serif}`. */
export function fonts() {
  return { serif: token('--font-serif'), code: token('--font-code') };
}

export function getTheme(): Theme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Switches the theme and remembers it. index.html restores it before first paint. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice just won't persist */
  }
}

/** Calls back after every theme switch, once the new values can be read. Returns an unsubscribe. */
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  const observer = new MutationObserver(() => cb(getTheme()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return () => observer.disconnect();
}
