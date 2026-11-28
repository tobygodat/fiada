import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SortingState } from '@fiada/shared';
import { fixtureGraph } from '../graph/fixture.test-util.ts';
import { sortSummary, sortTag, stillUnsorted } from './sorting.ts';

const done: SortingState = { available: true, status: 'done', by: 'Claude', placed: 0 };

test('a sort that placed nothing, with nothing left, says all sorted by rules', () => {
  assert.equal(stillUnsorted(fixtureGraph()), 0);
  assert.equal(sortSummary(done, 0), 'All sorted by rules');
  assert.equal(sortSummary({ ...done, renamed: 1 }, 0), 'Claude placed 0, renamed 1 domain');
});

test('a sort that placed nothing while code is still unsorted says how much is left', () => {
  const graph = fixtureGraph();
  const about = graph.nodes.find((n) => n.id === 'web/src/pages/about.tsx')!;
  const user = graph.nodes.find((n) => n.id === 'api/app/models.py#User')!;
  const models = graph.nodes.find((n) => n.id === 'api/app/models.py')!;
  delete about.layer;
  delete user.domain;
  delete models.domain;

  assert.equal(stillUnsorted(graph), 2, 'a file with symbols is not a leaf; its symbols count instead');
  assert.equal(sortSummary(done, 2), 'Claude placed 0 · 2 unsorted');
  assert.equal(sortSummary({ ...done, renamed: 1, added: 5 }, 1), 'Claude placed 0, renamed 1 domain, added 5 · 1 unsorted');
  assert.equal(sortSummary({ ...done, added: 5 }, 2), 'Claude placed 0, added 5 domains · 2 unsorted');
});

test('a sort that placed code says so, and what is still left', () => {
  assert.equal(sortSummary({ ...done, placed: 12, merged: 2 }, 0), 'Claude placed 12, merged 2 domains');
  assert.equal(sortSummary({ ...done, placed: 1 }, 3), 'Claude placed 1 · 3 unsorted');
});

test('the layers header tag compresses sort status to a short label', () => {
  assert.equal(sortTag(done, 0), 'rules');
  assert.equal(sortTag({ ...done, renamed: 1 }, 0), 'Claude');
  assert.equal(sortTag(done, 2), '2 unsorted');
  assert.equal(sortTag({ ...done, placed: 12, merged: 2 }, 0), 'placed 12');
  assert.equal(sortTag({ ...done, placed: 1 }, 3), 'placed 1');
});
