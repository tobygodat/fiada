import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRows, hunksFor } from './diff.ts';

const diff = [
  'diff --git a/items.py b/items.py',
  '--- a/items.py',
  '+++ b/items.py',
  '@@ -1,3 +1,4 @@',
  ' import uuid',
  '+import csv',
  ' from typing import Any',
  '@@ -40,3 +41,3 @@ def read_items(',
  '-    return items',
  '+    return list(items)',
  ' ',
  '',
].join('\n');

test('a symbol sees only the hunks that touch its lines; a file sees them all', () => {
  assert.deepEqual(hunksFor(diff, [41, 45])[0], '@@ -40,3 +41,3 @@ def read_items(');
  assert.equal(hunksFor(diff, [41, 45]).length, 4);
  assert.equal(hunksFor(diff).length, 8, 'the header lines above the first hunk are dropped');
});

test('with the lines of the changed symbols, a symbol also sees the hunks none of them touches', () => {
  // The import hunk at line 1 touches no changed symbol: it comes along.
  assert.equal(hunksFor(diff, [41, 45], [[41, 45]]).length, 8);
  // When another changed symbol covers it, it stays with that symbol.
  assert.equal(hunksFor(diff, [41, 45], [[41, 45], [1, 3]]).length, 4);
});

test('diff rows: the sign in its own gutter, each hunk as the line it starts at', () => {
  const rows = diffRows(hunksFor(diff));
  assert.deepEqual(rows[0], { t: 'hunk', line: 1, context: '' });
  assert.deepEqual(rows[2], { t: 'add', sign: '+', text: 'import csv' });
  assert.deepEqual(rows[4], { t: 'hunk', line: 41, context: 'def read_items(' });
  assert.deepEqual(rows[5], { t: 'del', sign: '−', text: '    return items' });
  assert.deepEqual(rows[1], { t: 'ctx', sign: '', text: 'import uuid' });
});

test('a deleted file starts where it used to', () => {
  assert.deepEqual(diffRows(['@@ -1,2 +0,0 @@']), [{ t: 'hunk', line: 1, context: '' }]);
});
