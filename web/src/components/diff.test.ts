import assert from 'node:assert/strict';
import { test } from 'node:test';
import { behind, cutShort, diffRows, ownerOf, pickHunks } from './diff.ts';

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
  // The first, which carries the file's other code: its own lines, then the imports and blank line, never b.
  const first = pickHunks(added, a, [a, b]);
  assert.deepEqual(first.filter((l) => l.startsWith('@@')), ['@@ -0,0 +4,3 @@', '@@ -0,0 +1,3 @@', '@@ -0,0 +7,1 @@']);
  assert.equal(first[1], '+export function a() {');
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
  // The first function's stop would also take the changed lines no changed function covers: here
  // there are none, only unchanged ones, which it leaves out.
  const first = pickHunks(long, { lines: [5, 15] }, [{ lines: [5, 15] }, { lines: [405, 415] }]);
  assert.ok(first.includes('+new 10') && !first.includes(' line 300') && !first.includes('+new 410'));
  assert.equal(first.length, 1 + 17 + 1);
});

test("a stop's own lines come before the file's other code it carries, so the row limit never hides them", () => {
  // 600 constants added above the function, in one hunk with it, and a hunk of other code before that.
  const consts = Array.from({ length: 600 }, (_, i) => `+const C${i} = ${i};`);
  const long = [
    '@@ -1,1 +1,2 @@',
    ' // top',
    "+import { z } from 'z';",
    '@@ -5,2 +6,604 @@',
    ' x',
    ...consts,
    '+export function f() {',
    '+  return z;',
    '+}',
    ' y',
  ].join('\n');
  const own = { lines: [607, 609] } as const;
  const rows = pickHunks(long, own, [own]);
  assert.deepEqual(rows.slice(0, 6), ['@@ -6,1 +604,7 @@', '+const C597 = 597;', '+const C598 = 598;', '+const C599 = 599;', '+export function f() {', '+  return z;']);
  // The rest after: the hunk before, then the constants above the function's context.
  assert.ok(rows.indexOf('@@ -1,1 +1,2 @@') > rows.indexOf('+}'));
  assert.ok(rows.includes('+const C0 = 0;') && rows.includes("+import { z } from 'z';"));
  // Every row shows once.
  assert.equal(rows.filter((l) => l[0] === '+').length, 600 + 3 + 1);
  // Unchanged lines left over from the function's hunk aren't a hunk of their own.
  const mixed = ['@@ -1,8 +1,9 @@', ' a', ' b', ' c', ' d', ' e', '+export function g() {}', ' f', ' h', ' i'].join('\n');
  assert.deepEqual(pickHunks(mixed, { lines: [6, 6] }, [{ lines: [6, 6] }]), ['@@ -3,6 +3,7 @@', ' c', ' d', ' e', '+export function g() {}', ' f', ' h', ' i']);
});

test("the file's other code in another function's hunk still shows, on the stop that carries it", () => {
  // A constant changed at line 32, in one hunk with b's change at 41: more than three lines from b.
  const rows: string[] = [];
  for (let i = 30; i <= 45; i++) {
    if (i === 32) rows.push('-const LIMIT = 10;', '+const LIMIT = 20;');
    else if (i === 41) rows.push('-  return 1;', '+  return 2;');
    else rows.push(` line ${i}`);
  }
  const mixed = ['@@ -5,1 +5,1 @@', '-  return a;', '+  return a + 1;', '@@ -30,16 +30,16 @@', ...rows].join('\n');
  const a = { lines: [4, 6] } as const;
  const b = { lines: [40, 42] } as const;
  const first = pickHunks(mixed, a, [a, b]);
  assert.ok(first.includes('+  return a + 1;'));
  assert.ok(first.includes('-const LIMIT = 10;') && first.includes('+const LIMIT = 20;'), 'the constant shows on the stop that carries the rest');
  assert.ok(!first.includes('+  return 2;'), "not b's own change");
  assert.ok(first.indexOf('+  return a + 1;') < first.indexOf('+const LIMIT = 20;'), 'its own lines first');
  // b's own stop is cut to b, without the constant.
  const own = pickHunks(mixed, b);
  assert.ok(own.includes('+  return 2;') && !own.includes('+const LIMIT = 20;'));
});

test('a function moved far away sees both its removal and its addition, and the stop carrying the rest neither', () => {
  const moved = [
    '@@ -1,2 +1,3 @@',
    ' import a',
    '+import b',
    ' x = 1',
    '@@ -10,3 +10,0 @@',
    '-def moved():',
    '-    return 1',
    '-',
    '@@ -27,1 +24,1 @@',
    '-    return f',
    '+    return f + 1',
    '@@ -40,1 +37,4 @@',
    ' y = 2',
    '+def moved():',
    '+    return 2',
    '+',
  ].join('\n');
  const f = { lines: [23, 24] } as const;
  const m = { lines: [38, 40], oldLines: [10, 12] } as const;
  const own = pickHunks(moved, m);
  assert.ok(own.includes('-def moved():') && own.includes('+def moved():'), 'both sides of the move');
  assert.ok(!own.includes('+import b') && !own.includes('+    return f + 1'));
  const first = pickHunks(moved, f, [f, m]);
  assert.ok(first.includes('+    return f + 1') && first.includes('+import b'));
  assert.ok(!first.includes('-def moved():') && !first.includes('+def moved():'), 'the move is the moved function’s');
  // An addition where the function used to be is the file's, not the moved function's.
  const at = ['@@ -10,3 +10,1 @@', '-def moved():', '-    return 1', '-', '+import c'].join('\n');
  assert.deepEqual(pickHunks(at, m), ['@@ -10,3 +10,0 @@', '-def moved():', '-    return 1', '-']);
});

test("a file with thousands of changed functions and hunks is cut up without checking every function against every hunk", () => {
  const N = 4000;
  // One changed line in each function, each its own hunk.
  const hunks: string[] = [];
  const owners: { lines: [number, number]; oldLines: [number, number] }[] = [];
  for (let i = 0; i < N; i++) {
    const at = i * 10 + 2;
    hunks.push(`@@ -${at},1 +${at},1 @@`, `-  return ${i};`, `+  return ${i + 1};`);
    owners.push({ lines: [at - 1, at + 1], oldLines: [at - 1, at + 1] });
  }
  hunks.push('@@ -40001,0 +40001,1 @@', '+export const LAST = 1;');
  const diff = hunks.join('\n');
  const t = performance.now();
  const first = pickHunks(diff, owners[0], owners);
  const took = performance.now() - t;
  assert.ok(took < 1000, `cut up in ${Math.round(took)} ms`);
  assert.deepEqual(first, ['@@ -2,1 +2,1 @@', '-  return 0;', '+  return 1;', '@@ -40001,0 +40001,1 @@', '+export const LAST = 1;']);
});

test("a function the map still has where HEAD had it is placed by HEAD's lines, even its added rows", () => {
  // Thirty lines added above moved it from 10 to 40; the map (another checkout's) still says 10.
  const moved = [
    '@@ -1,1 +1,31 @@',
    ' import a',
    ...Array.from({ length: 30 }, (_, i) => `+const C${i} = ${i};`),
    '@@ -11,1 +41,2 @@',
    '-  return 1',
    '+  return 2',
    '+  // and then',
  ].join('\n');
  const own = ownerOf([10, 12], [10, 12]);
  assert.deepEqual(pickHunks(moved, own), ['@@ -11,1 +41,2 @@', '-  return 1', '+  return 2', '+  // and then']);
  // Re-read since: the two differ, and both are kept.
  assert.deepEqual(ownerOf([40, 43], [10, 12]), { lines: [40, 43], oldLines: [10, 12] });
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

test('a diff cut short inside a long hunk, before the change, says so too', () => {
  // git's header counts the hunk's 400 lines; the cut kept its first three.
  const cut = ['@@ -1,400 +1,401 @@', ' a', '-b', '+c', '… diff cut at 64 KB'].join('\n');
  assert.deepEqual(pickHunks(cut, { lines: [300, 310] }), ['… diff cut at 64 KB, before this change']);
  assert.deepEqual(pickHunks(cut, { oldLines: [300, 310] }), ['… diff cut at 64 KB, before this change']);
  // With the file's other changes to tell apart, too.
  assert.deepEqual(pickHunks(cut, { lines: [300, 310] }, [{ lines: [1, 2] }, { lines: [300, 310] }]), ['… diff cut at 64 KB, before this change']);
  // One that starts in the lines kept shows them, with the note.
  assert.deepEqual(pickHunks(cut, { lines: [2, 50] }), ['@@ -1,400 +1,401 @@', ' a', '-b', '+c', '… diff cut at 64 KB']);
  // Cut right after the header: nothing of it is anyone's.
  assert.deepEqual(pickHunks(['@@ -1,2 +1,2 @@', ' a', '@@ -10,400 +10,401 @@', '… diff cut at 64 KB'].join('\n'), { lines: [10, 12] }), ['… diff cut at 64 KB, before this change']);
});

test("another agent's changes in the file are left out of this agent's diff, whoever's stop shows it", () => {
  const diff = [
    // An import the other agent added.
    '@@ -1,1 +1,2 @@', ' import a', '+import b',
    // This agent's function, lines 11-13 now.
    '@@ -10,3 +11,3 @@', ' function mine() {', '-  x', '+  y',
    // One hunk across both: this agent's lines 21-22, the other's function at 23-25.
    '@@ -20,7 +21,7 @@', '-  old', '+  new', ' }', ' function theirs() {', '-  p', '+  q', ' }',
  ].join('\n');
  const mine = { lines: [11, 13] as const };
  const ours = { lines: [21, 22] as const };
  const peer = { owners: [{ lines: [23, 25] as const }], top: true };
  // Without: the import and the other function show as this file's other code.
  assert.ok(pickHunks(diff, mine, [mine, ours]).includes('+import b'));
  assert.ok(pickHunks(diff, mine, [mine, ours]).includes('+  q'));
  const shown = pickHunks(diff, mine, [mine, ours], peer);
  assert.deepEqual(shown, ['@@ -10,3 +11,3 @@', ' function mine() {', '-  x', '+  y']);
  // The hunk shared with the other agent's function is cut to this agent's rows.
  assert.deepEqual(pickHunks(diff, ours, [mine, ours], peer), ['@@ -20,2 +21,2 @@', '-  old', '+  new', ' }']);
  // The file's other code is this agent's: the import stays.
  assert.ok(pickHunks(diff, mine, [mine, ours], { ...peer, top: false }).includes('+import b'));
  assert.ok(!pickHunks(diff, mine, [mine, ours], { ...peer, top: false }).includes('+  q'));
  // A stop for the file itself: everything but the other agent's.
  assert.deepEqual(pickHunks(diff, undefined, undefined, { ...peer, top: false }), ['@@ -1,1 +1,2 @@', ' import a', '+import b', '@@ -10,3 +11,3 @@', ' function mine() {', '-  x', '+  y', '@@ -20,2 +21,2 @@', '-  old', '+  new', ' }']);
  // A deleted function of the other agent's, known by its lines in HEAD.
  const gone = ['@@ -30,3 +30,0 @@', '-function was() {', '-  r', '-}', '@@ -40,1 +37,1 @@', '-a', '+b'].join('\n');
  assert.deepEqual(pickHunks(gone, { lines: [37, 37] }, [{ lines: [37, 37] }], { owners: [{ oldLines: [30, 32] }], top: false }), ['@@ -40,1 +37,1 @@', '-a', '+b']);
});

test("a class this agent changed, left out for its method, keeps its rows when the other agent's are the file's other code", () => {
  // The other agent's import at line 2; this agent's class field (line 4) and method (7-9).
  const diff = ['@@ -1,1 +1,2 @@', ' import a', '+import b', '@@ -2,7 +3,7 @@', ' class Store {', '-  int size = 1;', '+  int size = 2;', ' ', '   int get() {', '-    return 1;', '+    return 10;', '   }'].join('\n');
  const method = { lines: [7, 9] as const };
  const cls = { lines: [3, 10] as const };
  const lost = pickHunks(diff, method, [method], { owners: [], top: true });
  assert.ok(!lost.includes('+  int size = 2;'), 'without it, the field reads as the other agent\u2019s other code');
  const shown = pickHunks(diff, method, [method], { owners: [], top: true, mine: [cls] });
  assert.ok(shown.includes('+  int size = 2;'), 'the class\u2019s field is this agent\u2019s');
  assert.ok(shown.includes('+    return 10;'));
  assert.ok(!shown.includes('+import b'), 'the import is still the other agent\u2019s');
});

test("a row both agents' changes hold is the innermost one's: a method in a class whose field the other agent changed", () => {
  // A class at lines 1-8: the other agent changed its field (line 2), this agent its method (5-7).
  const diff = ['@@ -1,7 +1,7 @@', ' class Store {', '-  int size = 1;', '+  int size = 2;', ' ', '   int get() {', '-    return 1;', '+    return 10;', '   }'].join('\n');
  const method = { lines: [5, 7] as const };
  const cls = { lines: [1, 8] as const };
  const shown = pickHunks(diff, method, [method], { owners: [cls], top: false });
  assert.ok(shown.includes('+    return 10;'), 'the method is this agent\u2019s');
  assert.ok(!shown.includes('+  int size = 2;'), 'the field is the other agent\u2019s');
  // The other way round: this agent's field, the other agent's method.
  const mineToo = pickHunks(diff, cls, [cls], { owners: [method], top: false });
  assert.ok(mineToo.includes('+  int size = 2;'));
  assert.ok(!mineToo.includes('+    return 10;'));
});

test("a file two agents added shows each one's functions without the other's", () => {
  const diff = ['@@ -0,0 +1,7 @@', '+export function mine() {', '+  return 1;', '+}', '+', '+export function theirs() {', '+  return 2;', '+}'].join('\n');
  const mine = { lines: [1, 3] as const };
  // (The blank line between them, no function's, is the file's other code, after the function.)
  assert.deepEqual(pickHunks(diff, mine, [mine], { owners: [{ lines: [5, 7] }], top: false }), ['@@ -0,0 +1,3 @@', '+export function mine() {', '+  return 1;', '+}', '@@ -0,0 +4,1 @@', '+']);
  // A stop for the whole file: everything but theirs.
  assert.deepEqual(pickHunks(diff, undefined, undefined, { owners: [{ lines: [5, 7] }], top: false }), ['@@ -0,0 +1,4 @@', '+export function mine() {', '+  return 1;', '+}', '+']);
});

test('rows that end where the agent cut the diff short say so, wherever the cut lands', () => {
  const cut = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '… diff cut at 64 KB'].join('\n');
  // Inside the function's own hunk, and before it.
  assert.equal(cutShort(pickHunks(cut, { lines: [2, 2] })), true);
  assert.equal(cutShort(pickHunks(cut, { lines: [200, 210] })), true);
  assert.equal(cutShort(pickHunks(cut)), true);
  assert.equal(cutShort(pickHunks(['@@ -1,3 +1,3 @@', ' a', '-b', '+c'].join('\n'), { lines: [2, 2] })), false);
  assert.equal(cutShort([]), false);
});

test("a diff from before the agent's latest change says so", () => {
  const d = { diff: '@@ -1 +1 @@\n-a\n+b', diffAt: '2026-10-09T06:00:00.000Z', at: '2026-10-09T06:05:00.000Z' };
  assert.equal(behind(d), true);
  assert.equal(behind({ ...d, diffAt: d.at }), false);
  // No diff at all, or from an indexer that doesn't say when it came: nothing to compare.
  assert.equal(behind({ ...d, diff: undefined }), false);
  assert.equal(behind({ ...d, diffAt: undefined }), false);
});

test("the file's other code taken away right above a changed function shows on the stop that carries it, not as that function's", () => {
  // HEAD: a constant at 32 (changed), another at 35 (taken away), b at 36–38 (changed), now at 35–37.
  const hunk = [
    '@@ -30,12 +30,11 @@',
    ' line 30',
    ' line 31',
    '-const LIMIT = 10;',
    '+const LIMIT = 20;',
    ' line 33',
    ' line 34',
    '-const OLD = 1;',
    ' function b() {',
    '-  return 1;',
    '+  return 2;',
    ' }',
    ' line 39',
    ' line 40',
    ' line 41',
  ];
  const mixed = ['@@ -5,1 +5,1 @@', '-  return a;', '+  return a + 1;', ...hunk].join('\n');
  const a = { lines: [4, 6], oldLines: [4, 6] } as const;
  const b = { lines: [35, 37], oldLines: [36, 38] } as const;
  const first = pickHunks(mixed, a, [a, b]);
  assert.ok(first.includes('+const LIMIT = 20;'));
  assert.ok(first.includes('-const OLD = 1;'), 'the constant taken away shows on the stop that carries the rest');
  assert.ok(!first.includes('+  return 2;'), "not b's own change");
  // The diff cut right after the constant was taken away: b's stop says so, and the constant still shows on the carrying stop.
  const cut = [...mixed.split('\n').slice(0, 3 + 8), '… diff cut at 64 KB'].join('\n');
  assert.ok(pickHunks(cut, b).at(-1)!.startsWith('… diff cut at'));
  assert.ok(pickHunks(cut, a, [a, b]).includes('-const OLD = 1;'));
});
