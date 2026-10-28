import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TYPE, typeSize } from './renderer.ts';

test('map labels use only the design system sizes, never under 13px', () => {
  assert.deepEqual([...TYPE], [13, 15, 17, 20, 24]);

  for (let px = 0; px <= 60; px += 0.5) {
    const s = typeSize(px);
    assert.ok((TYPE as readonly number[]).includes(s), `${px}px → ${s}px`);
    assert.ok(s >= 13 && s <= 24);

    if (px >= 13) assert.ok(s <= px, `${px}px grew to ${s}px`);
  }

  assert.equal(typeSize(16.9), 15);
  assert.equal(typeSize(17), 17);
  assert.equal(typeSize(100), 24);
});
