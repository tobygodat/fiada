import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph } from '@fiada/shared';
import { GraphSync } from './graphSync.ts';

const g = (n: number) => ({ nodes: [], edges: [], layers: [], domains: [], generatedAt: String(n) }) as unknown as Graph;

test('the graph comes with the version it was fetched for, once', async () => {
  const s = new GraphSync();
  const got = await s.sync(3, async () => g(3));
  assert.equal(got?.version, 3);
  assert.equal(got?.graph.generatedAt, '3');
  assert.equal(await s.sync(3, async () => g(3)), null);
});

test('a failed fetch is asked for again on the next poll', async () => {
  const s = new GraphSync();
  await assert.rejects(s.sync(4, async () => Promise.reject(new Error('offline'))));
  assert.equal((await s.sync(4, async () => g(4)))?.version, 4);
});

test('a slow fetch of an older graph does not replace a newer one', async () => {
  const s = new GraphSync();
  let release!: () => void;
  const slow = s.sync(5, () => new Promise<Graph>((r) => (release = () => r(g(5)))));
  assert.equal((await s.sync(6, async () => g(6)))?.version, 6);
  release();
  assert.equal(await slow, null);
});

test('a restarted indexer counting from 0 again still sends its graph', async () => {
  const s = new GraphSync();
  await s.sync(9, async () => g(9));
  assert.equal((await s.sync(0, async () => g(0)))?.version, 0);
});
