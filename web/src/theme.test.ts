import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANGE_HUES, PALETTE_SPECS, RESERVED_ARC } from './theme.ts';

const parse = (spec: string) => spec.split(' ').map((v) => parseFloat(v)) as [number, number, number];
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test('repositories, layers and change state never share a hue', () => {
  assert.deepEqual(PALETTE_SPECS.change.map((c) => parse(c)[2]), [...CHANGE_HUES]);
  for (const spec of PALETTE_SPECS.layer) {
    const [, , hue] = parse(spec);
    for (const h of CHANGE_HUES) assert.ok(apart(hue, h) >= RESERVED_ARC, `layer ${spec} is within ${RESERVED_ARC}° of change hue ${h}`);
  }
  for (const spec of PALETTE_SPECS.repo) assert.equal(parse(spec)[1], 0, `repo ${spec} has a hue`);
});
