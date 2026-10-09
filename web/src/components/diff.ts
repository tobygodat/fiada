// Reading an agent's unified diff for the detail panel: the hunks that touch a symbol, and
// each line as the view draws it.

/** One changed symbol, as a diff can find it: by its lines, or, deleted, by the lines that take it away. */
export interface HunkOwner {
  lines?: readonly [number, number];
  /** A symbol's lines before the change: the hunks that take those away (a deleted one's, or a changed one's moved far from where it was). */
  oldLines?: readonly [number, number];
  /** A deleted symbol's name, when its old lines aren't known; for a member (`ItemController.get`) its declaration says only the last part. */
  name?: string;
}

/**
 * The hunks of a unified diff that belong to `own`, or all of them without it. With `rest` (every changed symbol in the file), also the hunks
 * none of them accounts for (an import, a constant), and from another symbol's hunks the changed lines
 * none of them covers, which that symbol's own stop cuts away. `own`'s lines come first and those others after,
 * so a long run of the file's other code never pushes them past the panel's row limit. All the hunks
 * when none matches, so nothing is hidden; unless the diff was cut short before `own`'s, which is then said instead.
 */
export function pickHunks(diff: string, own?: HunkOwner, rest?: readonly HunkOwner[]): string[] {
  const hunks = split(diff);
  if (!Array.isArray(hunks[0])) return hunks as string[];
  if (!own) return hunks.flat();
  const all = hunks as string[][];
  // The note a diff cut short ends with, taken off its last hunk while the hunks are cut up.
  const last = all[all.length - 1];
  const cut = last[last.length - 1]?.startsWith(CUT) ? last.pop() : undefined;
  const theirs = (h: string[]) => rest?.filter((r) => belongs(h, r)) ?? [];
  const hit = all.filter((h) => belongs(h, own) || (rest && !theirs(h).length));
  if (cut && !all.some((h) => belongs(h, own))) return [...hit.flat(), `${cut}, before this change`];
  if (!hit.length) return cut ? [...all.flat(), cut] : all.flat();
  // Another symbol's hunk, when every symbol it belongs to is known by its lines, so what they cover can be told apart.
  const shared = rest ? all.filter((h) => !hit.includes(h) && theirs(h).every((r) => r.lines || r.oldLines)) : [];
  const parts = all.flatMap((h) => {
    if (shared.includes(h)) return [slice(h, undefined, rest)];
    if (!hit.includes(h)) return [];
    if (own.lines || own.oldLines) return [slice(h, own, rest)];
    return [belongs(h, own) ? { own: [h], rest: [] } : { own: [], rest: [h] }];
  });
  const out = [...parts.flatMap((p) => p.own), ...parts.flatMap((p) => p.rest)].flat();
  return cut && (hit.includes(last) || shared.includes(last)) ? [...out, cut] : out;
}

/** How the agent ends a diff it cut short (agent/src/git.ts). */
const CUT = '… diff cut at ';

/**
 * A hunk cut down to the symbol's own lines (a deleted one's as they were) and, apart, with `rest`,
 * the lines none of the changed symbols covers; so each of an added file's functions shows its own
 * code, not the whole file again, and a long hunk across many functions shows this one's rows
 * before the panel's row limit. A hunk of nothing but lines added (or, for a deleted symbol,
 * removed) is cut to exactly those lines; any other keeps three lines of context around them, as
 * git would. A hunk that needs no cut stays as it is, header and all. Without `own`, only the rest.
 */
function slice(h: string[], own: HunkOwner | undefined, rest?: readonly HunkOwner[]): { own: string[][]; rest: string[][] } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h[0]);
  if (!m || (own && !own.lines && !own.oldLines)) return own ? { own: [h], rest: [] } : { own: [], rest: [] };
  const body = h.slice(1);
  const only = (c: string) => body.every((l) => l[0] === c || l[0] === '\\');
  const pad = (only('+') && own?.lines) || (only('-') && own?.oldLines) ? 0 : 3;
  const inside = (at: number, s: readonly [number, number] | undefined, p = 0) => !!s && at >= s[0] - p && at <= s[1] + p;
  // A row is a symbol's by where it stands now, or, removed or unchanged, by where it stood in HEAD
  // (so a function moved far also has the hunk that took it from there); one with only its old
  // lines (deleted) by those alone.
  const of = (r: HunkOwner, c: string, at: { old: number; new: number }, p = 0) =>
    inside(at.new, r.lines, p) || ((c !== '+' || !r.lines) && inside(at.old, r.oldLines, p));
  // Each row's place on both sides: a removed row stands where the next new line does, an added
  // one where the next old line does.
  let o = Number(m[1]) - 1;
  let n = Number(m[2]) - 1;
  const rows = body.map((l) => {
    const row = { l, o, n, mine: false, other: false };
    if (l[0] === '\\') return row;
    if (l[0] !== '+') o++;
    if (l[0] !== '-') n++;
    const at = { old: l[0] === '+' ? o + 1 : o, new: l[0] === '-' ? n + 1 : n };
    row.mine = !!own && of(own, l[0], at, pad);
    row.other = !row.mine && !!rest && !rest.some((r) => of(r, l[0], at));
    return row;
  });
  // "\ No newline at end of file" goes with the line before it.
  rows.forEach((r, i) => {
    if (r.l[0] !== '\\') return;
    r.mine = i > 0 && rows[i - 1].mine;
    r.other = i > 0 && rows[i - 1].other;
  });
  if (own && rows.every((r) => r.mine)) return { own: [h], rest: [] };
  if (rows.every((r) => r.other)) return { own: [], rest: [h] };
  // Each unbroken run of the rows kept, under its own header.
  const runs = (keep: (r: (typeof rows)[number]) => boolean) => {
    const out: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!keep(rows[i])) continue;
      let j = i;
      while (j + 1 < rows.length && keep(rows[j + 1])) j++;
      const run = rows.slice(i, j + 1).map((r) => r.l);
      const olds = run.filter((l) => l[0] === ' ' || l[0] === '-').length;
      const news = run.filter((l) => l[0] === ' ' || l[0] === '+').length;
      out.push([`@@ -${rows[i].o + 1},${olds} +${rows[i].n + 1},${news} @@`, ...run]);
      i = j;
    }
    return out;
  };
  // The other code's runs that change something: unchanged lines cut away from the symbol's say nothing.
  const out = { own: runs((r) => r.mine), rest: runs((r) => r.other).filter((run) => run.some((l) => l[0] === '+' || l[0] === '-')) };
  return out.own.length || out.rest.length || !own ? out : { own: [h], rest: [] };
}

function belongs(h: string[], o: HunkOwner): boolean {
  if (o.lines || o.oldLines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);
    if (!m) return true;
    const meets = (at: string, n: string | undefined, span?: readonly [number, number]) => {
      const s = Number(at);
      const e = s + Math.max(1, n == null ? 1 : Number(n)) - 1;
      return !!span && s <= span[1] && e >= span[0];
    };
    return meets(m[3], m[4], o.lines) || meets(m[1], m[2], o.oldLines);
  }
  if (!o.name) return false;
  const last = o.name.split(/\.|::|#/).pop()!;
  const word = new RegExp(`(^|[^\\w$])${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`);
  return h.some((l, i) => i > 0 && l[0] === '-' && word.test(l.slice(1)));
}

/** A diff's hunks, each its header line and body; the lines as they are when it has no hunk. */
function split(diff: string): string[][] | string[] {
  const out = diff.split('\n');
  const start = out.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return out;
  const hunks: string[][] = [];
  for (const l of out.slice(start)) {
    if (l.startsWith('@@')) hunks.push([l]);
    else hunks[hunks.length - 1].push(l);
  }
  const last = hunks[hunks.length - 1];
  if (last[last.length - 1] === '') last.pop();
  return hunks;
}

/** A diff line as the view draws it: the +/− in a gutter of its own, and each hunk's start in words. */
export type DiffRow = { t: 'add' | 'del' | 'ctx'; sign: string; text: string } | { t: 'hunk'; line: number; context: string };

export function diffRows(lines: string[]): DiffRow[] {
  return lines.map((l): DiffRow => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (h) return { t: 'hunk', line: Number(h[2]) || Number(h[1]), context: h[3] };
    if (l[0] === '+') return { t: 'add', sign: '+', text: l.slice(1) };
    if (l[0] === '-') return { t: 'del', sign: '−', text: l.slice(1) };
    return { t: 'ctx', sign: '', text: l[0] === ' ' ? l.slice(1) : l };
  });
}
