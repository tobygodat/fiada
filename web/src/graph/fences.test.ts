import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fence } from '@fiada/shared';
import { collisionAt } from '../render/activity.ts';
import { fenceGeometry } from '../render/fences.ts';
import { collisionWords, encloses, fenceAround, fenceWords } from './fences.ts';

const fence = (node: string, rule: Fence['rule']): Fence => ({ node, rule, at: '' });

test('the fence round a node: off limits beats ask first, then the nearest; never the node\'s own', () => {
  const fences = [fence('api', 'ask'), fence('api/app/core', 'off'), fence('api/app/core/config.py', 'ask')];
  assert.equal(fenceAround(fences, 'api/app/main.py')?.node, 'api');
  assert.equal(fenceAround(fences, 'api/app/core/config.py')?.node, 'api/app/core');
  assert.equal(fenceAround(fences, 'api/app/core/config.py#Settings')?.node, 'api/app/core');
  assert.equal(fenceAround([fence('api', 'ask'), fence('api/app', 'ask')], 'api/app/main.py')?.node, 'api/app');
  assert.equal(fenceAround(fences, 'api'), null);
  assert.ok(!encloses(fence('api/app/core', 'off'), 'api/app/core_utils.py'));
  assert.equal(fenceAround(fences, 'web/src/app.ts'), null);
});

test('fences and meeting places in words', () => {
  assert.equal(collisionWords({ node: 'api/app/routes', unit: 'folder', agents: ['a', 'b'], files: {} }), 'two agents in api/app/routes');
  assert.equal(collisionWords({ node: 'api/app/routes', unit: 'folder', agents: ['a', 'b', 'c'], files: {} }, true), 'three agents in routes');
  assert.equal(fenceWords({ node: 'api/app/core', rule: 'off', decision: 'deny', file: 'api/app/core/config.py', at: '' }), 'stopped at the off-limits fence round api/app/core: config.py stays as it is');
  assert.equal(fenceWords({ node: 'api/main.py', rule: 'ask', decision: 'ask', file: 'api/main.py', at: '' }), 'asked you before changing main.py, for the ask-first fence on it');
});

test('a fence line sits inside the rim, and a meeting place rolls up onto the closed circle round it', () => {
  for (const r of [3, 8, 40, 400]) {
    const g = fenceGeometry(r);
    assert.ok(g.lineR < r && g.lineR > 0, `r=${r}`);
    assert.ok(g.inner >= 0 && g.inner < g.lineR);
  }
  const at = new Map([['api/app/routes', 2]]);
  assert.equal(collisionAt('api/app/routes', true, at), 2);
  assert.equal(collisionAt('api/app', false, at), 2);
  // An open circle shows it where it is, inside, not on itself.
  assert.equal(collisionAt('api/app', true, at), 0);
  assert.equal(collisionAt('api/app/core', false, at), 0);
});
