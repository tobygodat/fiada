// Reading an agent's unified diff for the detail panel: the hunks that touch a symbol, and
// each line as the view draws it.

/** One changed symbol, as a diff can find it: by its lines, or, deleted, by the lines that take it away. */
export interface HunkOwner {
  lines?: readonly [number, number];
  /** A deleted symbol's lines before the change: the hunks that take those away. */
  oldLines?: readonly [number, number];
  /** A deleted symbol's name, when its old lines aren't known; for a member (`ItemController.get`) its declaration says only the last part. */
  name?: string;
}

/**
 * The hunks of a unified diff that belong to `own`, or all of them without it. With `rest` (every changed symbol in the file), also the hunks
 * none of them accounts for: an import, a constant. All the hunks when none matches, so nothing
 * is hidden; unless the diff was cut short before `own`'s, which is then said instead.
 */
export function pickHunks(diff: string, own?: HunkOwner, rest?: readonly HunkOwner[]): string[] {
  const hunks = split(diff);
  if (!Array.isArray(hunks[0])) return hunks as string[];
  if (!own) return hunks.flat();
  const all = hunks as string[][];
  // The note a diff cut short ends with, taken off its last hunk while the hunks are cut up.
  const last = all[all.length - 1];
  const cut = last[last.length - 1]?.startsWith(CUT) ? last.pop() : undefined;
  const hit = all.filter((h) => belongs(h, own) || (rest && !rest.some((r) => belongs(h, r))));
  if (cut && !all.some((h) => belongs(h, own))) return [...hit.flat(), `${cut}, before this change`];
  if (!hit.length) return cut ? [...all.flat(), cut] : all.flat();
  const out = (own.lines || own.oldLines ? hit.flatMap((h) => slice(h, own, rest)) : hit).flat();
  return cut && hit.includes(last) ? [...out, cut] : out;
}

/** How the agent ends a diff it cut short (agent/src/git.ts). */
const CUT = '… diff cut at ';

/**
 * A hunk cut down to the symbol's own lines (a deleted one's as they were) and, with `rest`, the
 * lines none of the changed symbols covers; so each of an added file's functions shows its own
 * code, not the whole file again, and a long hunk across many functions shows this one's rows
 * before the panel's row limit. A hunk of nothing but lines added (or, for a deleted symbol,
 * removed) is cut to exactly those lines; any other keeps three lines of context around them, as
 * git would. A hunk that needs no cut stays as it is, header and all.
 */
function slice(h: string[], own: HunkOwner, rest?: readonly HunkOwner[]): string[][] {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h[0]);
  const span = own.lines ?? own.oldLines;
  if (!m || !span) return [h];
  const body = h.slice(1);
  const sign = own.lines ? '+' : '-';
  const pad = body.every((l) => l[0] === sign || l[0] === '\\') ? 0 : 3;
  const inside = (at: number, s: readonly [number, number], p = 0) => at >= s[0] - p && at <= s[1] + p;
  // Each row's place on both sides: a removed row stands where the next new line does, an added
  // one where the next old line does.
  let o = Number(m[1]) - 1;
  let n = Number(m[2]) - 1;
  const rows = body.map((l) => {
    const row = { l, o, n, keep: false };
    if (l[0] === '\\') return row;
    if (l[0] !== '+') o++;
    if (l[0] !== '-') n++;
    const at = { old: l[0] === '+' ? o + 1 : o, new: l[0] === '-' ? n + 1 : n };
    const covers = (r: HunkOwner) => (r.lines ? inside(at.new, r.lines) : !!r.oldLines && inside(at.old, r.oldLines));
    row.keep = inside(own.lines ? at.new : at.old, span, pad) || (!!rest && !rest.some(covers));
    return row;
  });
  // "\ No newline at end of file" goes with the line before it.
  rows.forEach((r, i) => r.l[0] === '\\' && (r.keep = i > 0 && rows[i - 1].keep));
  if (rows.every((r) => r.keep)) return [h];
  const out: string[][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].keep) continue;
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].keep) j++;
    const run = rows.slice(i, j + 1).map((r) => r.l);
    const olds = run.filter((l) => l[0] === ' ' || l[0] === '-').length;
    const news = run.filter((l) => l[0] === ' ' || l[0] === '+').length;
    out.push([`@@ -${rows[i].o + 1},${olds} +${rows[i].n + 1},${news} @@`, ...run]);
    i = j;
  }
  return out.length ? out : [h];
}

function belongs(h: string[], o: HunkOwner): boolean {
  if (o.lines || o.oldLines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);
    if (!m) return true;
    const [at, n, span] = o.lines ? [m[3], m[4], o.lines] : [m[1], m[2], o.oldLines!];
    const s = Number(at);
    const e = s + Math.max(1, n == null ? 1 : Number(n)) - 1;
    return s <= span[1] && e >= span[0];
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
