import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeKind, GraphEdge } from '@fiada/shared';
import type { Circle } from '../graph/layout.ts';
import type { Contract } from '../graph/view.ts';
import { bestBend, curve, DEFAULT_BEND, EDGE_POLICIES, labelSpot, restEdges } from './edges.ts';

const REST_EDGES = EDGE_POLICIES.key.restMax;

const contract = (a: string, b: string, n: number, kind: EdgeKind = 'calls'): Contract => ({
  key: `${a}|${b}`,
  a,
  b,
  items: Array.from({ length: n }, (): GraphEdge => ({ from: a, to: b, kind })),
  kinds: new Set([kind]),
  cross: 0,
  inferred: 0,
  forward: n,
  tag: '',
});

test('at rest only the few strongest contracts are drawn', () => {
  const ids = 'abcdefghij'.split('');
  const visible = new Set(ids);
  const all = [
    contract('a', 'b', 800),
    contract('a', 'c', 54),
    contract('a', 'd', 19),
    contract('b', 'c', 5, 'http'),
    contract('c', 'd', 5),
    contract('d', 'e', 2),
    contract('e', 'f', 1),
    contract('f', 'g', 1),
  ];
  const everything = { ...EDGE_POLICIES.key, perContainer: Infinity };
  const rest = restEdges(all, visible, everything);
  assert.ok(rest.size <= REST_EDGES);
  assert.ok(rest.has('a|b') && rest.has('a|c') && rest.has('a|d'));
  // A request outranks a plain call of the same size.
  assert.ok(rest.has('b|c'));
  assert.ok(!rest.has('c|d'));
  // Single interactions are never part of the overview.
  assert.ok(!rest.has('e|f') && !rest.has('f|g'));
  // Nor is anything whose ends aren't both on the map.
  assert.ok(!restEdges(all, new Set(['a', 'c'])).has('a|b'));
  // Even spread, everything but single links fits up to the cap.
  const even = ids.slice(1).map((x) => contract('a', x, 4));
  assert.equal(restEdges(even, visible, everything).size, REST_EDGES);
  // The other presets: every link, or none until you point at a circle.
  assert.equal(restEdges(all, visible, EDGE_POLICIES.all).size, all.length);
  assert.equal(restEdges(all, visible, EDGE_POLICIES.none).size, 0);
});

test('every open circle gets its own few links, and a small one is not starved', () => {
  const visible = new Set('abcdefxy'.split(''));
  // a..f sit inside a big open repo; x and y in a small one with one request between them.
  const big = [contract('a', 'b', 900), contract('a', 'c', 700), contract('b', 'c', 500), contract('c', 'd', 400), contract('d', 'e', 300), contract('e', 'f', 200), contract('a', 'f', 100)];
  const small = contract('x', 'y', 3, 'http');
  const home = (g: Contract) => (g.a === 'x' ? 'small' : 'big');
  const rest = restEdges([...big, small], visible, EDGE_POLICIES.key, home);
  assert.ok(rest.has('x|y'), "the small repo's only link survives");
  const inBig = [...rest].filter((k) => k !== 'x|y');
  assert.equal(inBig.length, EDGE_POLICIES.key.perContainer);
  assert.deepEqual(inBig.sort(), ['a|b', 'a|c', 'b|c']);
  // Many open circles: each one's strongest link comes before any one's second, up to the overall cap.
  const many = 'pqrstuvw'.split('').map((p) => contract(`${p}1`, `${p}2`, 10));
  const each = restEdges(many, new Set(many.flatMap((g) => [g.a, g.b])), EDGE_POLICIES.key, (g) => g.a[0]);
  assert.equal(each.size, EDGE_POLICIES.key.restMax);
});

test('edges bend around circles in their way', () => {
  const A: Circle = { x: 0, y: 0, r: 10 };
  const B: Circle = { x: 200, y: 0, r: 10 };
  assert.equal(bestBend(A, B, [A, B]), DEFAULT_BEND);
  const blocker: Circle = { x: 100, y: 0, r: 30 };
  const bend = bestBend(A, B, [A, B, blocker]);
  const c = curve(A, B, bend);
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    const s = 1 - t;
    const px = s * s * c.x1 + 2 * s * t * c.mx + t * t * c.x2;
    const py = s * s * c.y1 + 2 * s * t * c.my + t * t * c.y2;
    assert.ok(Math.hypot(px - blocker.x, py - blocker.y) > blocker.r, `point ${i} is inside the blocker`);
  }
  // Neighbours that almost touch get a short, nearly straight link.
  const near = curve({ x: 0, y: 0, r: 50 }, { x: 104, y: 0, r: 50 }, DEFAULT_BEND);
  assert.ok(Math.abs(near.my) < 1);
});

test('the resting overview says what its links are; the other presets keep their own look', () => {
  assert.equal(EDGE_POLICIES.key.restLabels, true);
  assert.equal(EDGE_POLICIES.key.restTags, false, 'words, not boxed tags, at rest');
  // Every link already carries a tag, and no links means no words.
  assert.equal(EDGE_POLICIES.all.restLabels, false);
  assert.equal(EDGE_POLICIES.none.restLabels, false);
});

test('words go in a gap on a long link, beside a short one, and never where they are not clear', () => {
  const half = { w: 30, h: 9 };
  // Long and level: in the line, at its middle.
  const long = labelSpot([0, 0, 100, 0, 200, 0], 200, half, 2, () => true)!;
  assert.deepEqual([long.x, long.y, long.inline], [100, 0, true]);
  // Short: beside it, the box clear of the stroke.
  const short = labelSpot([0, 0, 25, 0, 50, 0], 50, half, 2, () => true)!;
  assert.equal(short.inline, false);
  assert.ok(Math.abs(short.y) >= half.h + 1, 'the box clears the line');
  assert.equal(short.from, undefined, 'right beside the line needs no rule');
  // An upright link puts the words to one side, by their half width.
  const upright = labelSpot([0, 0, 0, 25, 0, 50], 50, half, 2, () => true)!;
  assert.ok(Math.abs(upright.x) >= half.w + 1);
  // The middle is blocked: it moves along the line, or hangs further off on a rule.
  const offMiddle = labelSpot([0, 0, 100, 0, 200, 0], 200, half, 2, (p) => Math.abs(p.x - 100) > 15)!;
  assert.ok(offMiddle.inline && Math.abs(offMiddle.x - 100) > 15);
  const far = labelSpot([0, 0, 25, 0, 50, 0], 50, half, 2, (p) => Math.abs(p.y) > 30)!;
  assert.ok(far.from && Math.abs(far.y) > 30, 'hung from the link by a rule');
  assert.equal(labelSpot([0, 0, 25, 0, 50, 0], 50, half, 2, () => false), null);
  // The rule is checked too: a spot whose rule is blocked is passed over for one whose rule is clear.
  const ruled = labelSpot([0, 0, 25, 0, 50, 0], 50, half, 2, (p, from) => Math.abs(p.y) > 30 && (!from || from.y > 0))!;
  assert.ok(ruled.from && ruled.from.y > 0 && ruled.y > 30);
});
