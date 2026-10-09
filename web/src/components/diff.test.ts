import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRows, pickHunks } from './diff.ts';

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
  assert.deepEqual(pickHunks(diff, { lines: [41, 45] })[0], '@@ -40,3 +41,3 @@ def read_items(');
  assert.equal(pickHunks(diff, { lines: [41, 45] }).length, 4);
  assert.equal(pickHunks(diff).length, 8, 'the header lines above the first hunk are dropped');
});

test('with the lines of the changed symbols, a symbol also sees the hunks none of them touches', () => {
  // The import hunk at line 1 touches no changed symbol: it comes along.
  assert.equal(pickHunks(diff, { lines: [41, 45] }, [{ lines: [41, 45] }]).length, 8);
  // When another changed symbol covers it, it stays with that symbol.
  assert.equal(pickHunks(diff, { lines: [41, 45] }, [{ lines: [41, 45] }, { lines: [1, 3] }]).length, 4);
});

test('a deleted symbol sees the hunks that take away a line naming it', () => {
  const gone = [
    '@@ -1,3 +1,2 @@',
    ' import uuid',
    '-import csv',
    ' from typing import Any',
    '@@ -20,4 +19,0 @@',
    '-def export_items(items):',
    '-    return csv.writer(items)',
    '-',
    '-',
    '@@ -40,1 +36,1 @@',
    '-    return items  # was export_items_old',
    '+    return list(items)',
  ].join('\n');
  assert.deepEqual(pickHunks(gone, { name: 'export_items' }), ['@@ -20,4 +19,0 @@', '-def export_items(items):', '-    return csv.writer(items)', '-', '-']);
  assert.equal(pickHunks(gone, { name: 'nowhere' }).length, 12, 'none names it: every hunk');
  // A member's stored name is qualified; its declaration names only the last part.
  assert.equal(pickHunks(gone, { name: 'Exporter.export_items' }).length, 5);
  // Only deleted functions in the file: the first also takes the import hunk none of them accounts for.
  const first = pickHunks(gone, { name: 'export_items' }, [{ name: 'export_items' }]);
  assert.ok(first.includes('-import csv') && first.includes('-def export_items(items):'));
});

test('two deleted members with one last name each see only the hunk that took their own lines away', () => {
  const gone = [
    '@@ -10,3 +10,0 @@',
    '-  get(id) {',
    '-    return users[id];',
    '-  }',
    '@@ -30,3 +27,0 @@',
    '-  get(id) {',
    '-    return items[id];',
    '-  }',
  ].join('\n');
  // By name alone both claim both hunks; by their lines in HEAD, each has its own.
  assert.equal(pickHunks(gone, { name: 'Users.get' }).length, 8);
  assert.deepEqual(pickHunks(gone, { name: 'Users.get', oldLines: [10, 12] }), gone.split('\n').slice(0, 4));
  assert.deepEqual(pickHunks(gone, { name: 'Items.get', oldLines: [30, 32] }), gone.split('\n').slice(4));
  // As the rest of a file's changes, each accounts for its own hunk only.
  const rest = [{ name: 'Users.get', oldLines: [10, 12] as const }, { name: 'Items.get', oldLines: [30, 32] as const }];
  assert.equal(pickHunks(gone, rest[0], rest).length, 4);
});

test('diff rows: the sign in its own gutter, each hunk as the line it starts at', () => {
  const rows = diffRows(pickHunks(diff));
  assert.deepEqual(rows[0], { t: 'hunk', line: 1, context: '' });
  assert.deepEqual(rows[2], { t: 'add', sign: '+', text: 'import csv' });
  assert.deepEqual(rows[4], { t: 'hunk', line: 41, context: 'def read_items(' });
  assert.deepEqual(rows[5], { t: 'del', sign: '−', text: '    return items' });
  assert.deepEqual(rows[1], { t: 'ctx', sign: '', text: 'import uuid' });
});

test('a deleted file starts where it used to', () => {
  assert.deepEqual(diffRows(['@@ -1,2 +0,0 @@']), [{ t: 'hunk', line: 1, context: '' }]);
});

test("an added file's one hunk is cut down to each function's own lines", () => {
  const added = [
    'diff --git a/x.ts b/x.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/x.ts',
    '@@ -0,0 +1,10 @@',
    "+import { z } from 'z';",
    "+import { y } from 'y';",
    '+',
    '+export function a() {',
    '+  return z;',
    '+}',
    '+',
    '+export function b() {',
    '+  return y;',
    '+}',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const a = { lines: [4, 6] } as const;
  const b = { lines: [8, 10] } as const;
  // The later function: its own three lines, with the note that ends the file.
  assert.deepEqual(pickHunks(added, b), ['@@ -0,0 +8,3 @@', '+export function b() {', '+  return y;', '+}', '\\ No newline at end of file']);
  // The first, which carries the file's other code: the imports and blank lines too, never b.
  const first = pickHunks(added, a, [a, b]);
  assert.deepEqual(first.filter((l) => l.startsWith('@@')), ['@@ -0,0 +1,7 @@']);
  assert.ok(first.includes("+import { z } from 'z';") && first.includes('+  return z;'));
  assert.ok(!first.includes('+  return y;'));
  // Each line of the hunk on exactly one of the two stops.
  const body = (l: string[]) => l.filter((x) => x[0] === '+');
  assert.equal(body(first).length + body(pickHunks(added, b, undefined)).length, 10);
  // A hunk with context or removed lines is never cut.
  assert.equal(pickHunks(diff, { lines: [41, 41] }).length, 4);
});
