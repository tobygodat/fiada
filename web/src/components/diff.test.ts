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
  // A hunk with context or removed lines that reaches no further than three lines past the symbol stays whole.
  assert.equal(pickHunks(diff, { lines: [41, 41] }).length, 4);
});

test('a long hunk across many functions is cut to the one asked for, with three lines of context', () => {
  // 600 lines with a change at line 10 and one at 410: git keeps them in one hunk when the lines between changed too.
  const rows: string[] = [];
  for (let i = 1; i <= 600; i++) rows.push(i === 10 || i === 410 ? `-old ${i}` : ` line ${i}`, ...(i === 10 || i === 410 ? [`+new ${i}`] : []));
  const long = ['@@ -1,600 +1,600 @@ module', ...rows].join('\n');
  const later = pickHunks(long, { lines: [405, 415] });
  assert.equal(later[0], '@@ -402,17 +402,17 @@');
  assert.ok(later.includes('-old 410') && later.includes('+new 410'), 'its own change, under the row limit');
  assert.ok(!later.includes('+new 10'), 'not the other function’s');
  assert.equal(later.length, 1 + 17 + 1);
  // The first function's stop also takes the lines no changed function covers, here all the rest.
  const first = pickHunks(long, { lines: [5, 15] }, [{ lines: [5, 15] }, { lines: [405, 415] }]);
  assert.ok(first.includes('+new 10') && first.includes(' line 300') && !first.includes('+new 410'));
});

test('a deleted function in a long hunk is cut to the lines that took it away, with three lines of context', () => {
  const rows: string[] = [];
  for (let i = 1; i <= 600; i++) {
    if (i === 10) rows.push('-old 10', '+new 10');
    else if (i >= 400 && i <= 405) rows.push(`-gone ${i}`);
    else rows.push(` line ${i}`);
  }
  const long = ['@@ -1,600 +1,594 @@', ...rows].join('\n');
  const gone = pickHunks(long, { name: 'gone', oldLines: [400, 405] });
  assert.equal(gone[0], '@@ -397,12 +397,6 @@');
  assert.ok(gone.includes('-gone 400') && gone.includes('-gone 405') && !gone.includes('+new 10'));
  assert.equal(gone.length, 13);
});

test('a diff cut short before a change says so, never showing other hunks in its place', () => {
  const cut = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '… diff cut at 64 KB'].join('\n');
  assert.deepEqual(pickHunks(cut, { lines: [200, 210] }), ['… diff cut at 64 KB, before this change']);
  // A change in the part that was kept shows, with the note at the end.
  assert.deepEqual(pickHunks(cut, { lines: [2, 2] }), ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '… diff cut at 64 KB']);
});
