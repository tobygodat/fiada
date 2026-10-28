// Guards the map's three palettes while several people restyle at once: change state, layers
// and repos never share a hue, and every map colour shows on the paper in both themes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));

  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const dark = block(":root,\n:root[data-theme='dark']");
const light = block(":root[data-theme='light']");

const theme = (t: 'dark' | 'light') => (name: string): string => {
  const v = (t === 'light' && light.get(name)) || dark.get(name);
  assert.ok(v, `${name} is not defined`);
  const alias = /^var\((--[\w-]+)\)$/.exec(v);

  return alias ? theme(t)(alias[1]) : v;
};

// sRGB hex → linear RGB → OKLCH, and WCAG contrast.
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function oklch(hex: string) {
  const [r, g, b] = rgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return { c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI + (B < 0 ? 360 : 0) };
}

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);

  return (x + 0.05) / (y + 0.05);
};

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

const CHANGE = ['--added', '--modified', '--deleted', '--working', '--looked'];
const TINTS = [1, 2, 3, 4, 5].map((i) => `--layer-${i}`);
const GREYS = [6, 7, 8].map((i) => `--layer-${i}`);
const REPOS = [1, 2, 3, 4].map((i) => `--repo-${i}`);

for (const t of ['dark', 'light'] as const) {
  const get = theme(t);

  test(`${t}: every colour the dark theme defines, the light theme redefines`, () => {
    for (const [name, v] of dark) if (/^#|^rgba?\(/.test(v)) assert.ok(light.has(name), `${name} has no light value`);
  });

  test(`${t}: the change states are all different colours`, () => {
    assert.equal(new Set(CHANGE.map(get)).size, CHANGE.length);
  });

  test(`${t}: layer tints stay 30° from each other and from every change-state hue`, () => {
    const change = CHANGE.map(get).map(oklch).filter((c) => c.c > 0.04);
    const tints = TINTS.map(get).map(oklch);
    tints.forEach((a, i) => {
      for (const b of change) assert.ok(hueGap(a.h, b.h) >= 30, `${TINTS[i]} ${a.h.toFixed(0)}° is near a change-state hue ${b.h.toFixed(0)}°`);
      tints.slice(i + 1).forEach((b, j) => assert.ok(hueGap(a.h, b.h) >= 30, `${TINTS[i]} and ${TINTS[i + j + 1]} share a hue`));
    });
  });

  test(`${t}: repos and the last three layers are greys, so they carry no hue`, () => {
    for (const name of [...REPOS, ...GREYS]) assert.ok(oklch(get(name)).c < 0.03, `${name} is not a grey`);
  });

  test(`${t}: every map colour shows on the paper (3:1)`, () => {
    const ground = get('--ground');

    for (const name of [...CHANGE, ...TINTS, ...GREYS, ...REPOS, '--layer-none']) {
      const ratio = contrast(get(name), ground);
      assert.ok(ratio >= 3, `${name} is ${ratio.toFixed(2)}:1 on --ground`);
    }
  });
}
