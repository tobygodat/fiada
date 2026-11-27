import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SortingState } from '@fiada/shared';
import { fixtureGraph } from '../graph/fixture.test-util.ts';
import { sortSummary, stillUnsorted } from './sorting.ts';

const done: SortingState = { available: true, status: 'done', by: 'Claude', placed: 0 };

test('a sort that placed nothing, with nothing left, says the classifier left nothing unplaced', () => {
  assert.equal(stillUnsorted(fixtureGraph()), 0);
  assert.equal(sortSummary(done, 0), 'Claude found nothing the classifier left unplaced.');
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
  assert.equal(sortSummary(done, 2), 'Claude placed nothing. 2 files and symbols are still Unlayered or Unsorted.');
  assert.equal(sortSummary({ ...done, renamed: 1, added: 5 }, 1), 'Claude placed nothing, renamed 1 domain, added 5. 1 file or symbol is still Unlayered or Unsorted.');
  assert.equal(sortSummary({ ...done, added: 5 }, 2), 'Claude placed nothing, added 5 domains. 2 files and symbols are still Unlayered or Unsorted.');
});

test('a sort that placed code says so, and what is still left', () => {
  assert.equal(sortSummary({ ...done, placed: 12, merged: 2 }, 0), "Claude placed 12 files and symbols the classifier couldn't, merged 2 domains. Each says why in its details.");
  assert.equal(
    sortSummary({ ...done, placed: 1 }, 3),
    "Claude placed 1 file or symbol the classifier couldn't. Each says why in its details. 3 files and symbols are still Unlayered or Unsorted.",
  );
});
