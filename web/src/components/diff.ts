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
 * A changed symbol as a diff finds it, from its lines on the map and in HEAD. The same two mean
 * the map hasn't read the file since the change (another checkout's, never), so they are HEAD's
 * alone and even its added rows are placed by where HEAD had it.
 */
export const ownerOf = (lines?: readonly [number, number], oldLines?: readonly [number, number]): HunkOwner =>
  lines && oldLines && lines[0] === oldLines[0] && lines[1] === oldLines[1] ? { oldLines } : { lines, oldLines };

/**
 * The hunks of a unified diff that belong to `own`, or all of them without it. With `rest` (every changed symbol in the file), also the hunks
 * none of them accounts for (an import, a constant), and from another symbol's hunks the changed lines
 * none of them covers, which that symbol's own stop cuts away. `own`'s lines come first and those others after,
 * so a long run of the file's other code never pushes them past the panel's row limit. All the hunks
 * when none matches, so nothing is hidden; unless the diff was cut short before `own`'s, which is then said instead.
 * With `peer`, another agent's rows are taken out first, whoever's stop it is.
 */
export function pickHunks(diff: string, own?: HunkOwner, rest?: readonly HunkOwner[], peer?: Theirs): string[] {
  const hunks = split(diff);

  if (!Array.isArray(hunks[0])) return hunks as string[];
  let all = hunks as string[][];
  // The note a diff cut short ends with, taken off its last hunk while the hunks are cut up.
  const end = all[all.length - 1];
  const cut = end[end.length - 1]?.startsWith(CUT) ? end.pop() : undefined;

  if (peer) all = without(all, peer, [...(own ? [own] : []), ...(rest ?? [])]);

  if (!own || !all.length) return [...all.flat(), ...(cut ? [cut] : [])];
  const last = all[all.length - 1];
  // Its header still counts every line git gave it: whose it is goes by the lines it kept.
  const kept = cut ? [keptHeader(last), ...last.slice(1)] : last;
  const seen = (h: string[]) => (h === last ? kept : h);
  const cover = rest && covers(rest);
  // Which of the changed symbols each hunk belongs to: by their lines, or (deleted, lines unknown) by name.
  const theirs = all.map((h) => (cover ? { lines: cover.meets(seen(h)), named: cover.named.some((r) => belongs(h, r)) } : null));
  const hit = new Set(all.filter((h, i) => belongs(seen(h), own) || (theirs[i] && !theirs[i].lines && !theirs[i].named)));

  if (cut && !all.some((h) => belongs(seen(h), own))) return [...all.filter((h) => hit.has(h)).flat(), `${cut}, before this change`];

  if (!hit.size) return cut ? [...all.flat(), cut] : all.flat();
  // Another symbol's hunk, when every symbol it belongs to is known by its lines, so what they cover can be told apart.
  const shared = new Set(all.filter((h, i) => !hit.has(h) && theirs[i] && !theirs[i].named));

  const parts = all.flatMap((h) => {
    if (shared.has(h)) return [slice(h, undefined, cover)];

    if (!hit.has(h)) return [];

    if (own.lines || own.oldLines) return [slice(h, own, cover)];

    return [belongs(seen(h), own) ? { own: [h], rest: [] } : { own: [], rest: [h] }];
  });

  const out = [...parts.flatMap((p) => p.own), ...parts.flatMap((p) => p.rest)].flat();

  return cut && (hit.has(last) || shared.has(last)) ? [...out, cut] : out;
}

/** Another agent's changes in the file: its symbols, and `top` when the file's code outside every symbol is its too. */
export interface Theirs {
  owners: readonly HunkOwner[];
  top: boolean;
  /**
   * This agent's own changed symbols that no stop is read at (a class left out for a method in it),
   * so `top` doesn't take their rows (a field) for the other agent's code outside every symbol.
   */
  mine?: readonly HunkOwner[];
}

/**
 * The hunks less the rows of another agent's changes, which git's diff of the whole file has
 * too: those in its symbols, and with `top`, those no changed symbol holds (an import it added).
 * Each hunk left whole stays as it is; one cut keeps each run that still changes something.
 */
function without(all: string[][], theirs: Theirs, stops: readonly HunkOwner[]): string[][] {
  const mine = [...stops, ...(theirs.mine ?? [])];
  const t = covers(theirs.owners);
  const m = covers(mine);
  const any = theirs.top ? covers([...mine, ...theirs.owners]) : null;

  // A row both hold (this agent's method in a class whose field the other agent changed, or the
  // other way round) is the innermost one's: the one that holds it in the fewest lines. At the same
  // size, the one holding it on its own side: a removed row is a deleted symbol's, not that of the
  // one added in its place (which holds it only by where it stands), and an added row the other way round.
  const spanOf = (r: HunkOwner, c: string, at: { old: number; new: number }) => {
    if ((c !== '-' || !r.oldLines) && r.lines && at.new >= r.lines[0] && at.new <= r.lines[1]) return r.lines[1] - r.lines[0] + (c === '-' ? 0.5 : 0);

    if ((c !== '+' || !r.lines) && r.oldLines && at.old >= r.oldLines[0] && at.old <= r.oldLines[1]) return r.oldLines[1] - r.oldLines[0] + (c === '+' ? 0.5 : 0);

    return Infinity;
  };

  const inner = (owners: readonly HunkOwner[], c: string, at: { old: number; new: number }) => Math.min(...owners.map((r) => spanOf(r, c, at)));
  const theirsRow = (c: string, at: { old: number; new: number }) => t.holds(c, at) && (!m.holds(c, at) || inner(theirs.owners, c, at) < inner(mine, c, at));

  return all.flatMap((h) => {
    const rows = place(h);

    if (!rows) return [h];
    const keep = rows.map((r) => r.l[0] === '\\' || (!theirsRow(r.l[0], r.at) && (!any || any.holds(r.l[0], r.at))));
    // "\ No newline at end of file" goes with the line before it.
    keep.forEach((_, i) => rows[i].l[0] === '\\' && (keep[i] = i > 0 && keep[i - 1]));

    if (keep.every(Boolean)) return [h];

    return runsOf(rows, (_, i) => keep[i]).filter((run) => run.some((l) => l[0] === '+' || l[0] === '-'));
  });
}

/**
 * Each row of a hunk with its place on both sides: a removed row stands where the next new line
 * does, an added one where the next old line does. Null for a hunk with no header to place it by.
 */
function place(h: string[]) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h[0]);

  if (!m) return null;
  let o = Number(m[1]) - 1;
  let n = Number(m[2]) - 1;

  return h.slice(1).map((l) => {
    const row = { l, o, n, at: { old: o, new: n } };

    if (l[0] === '\\') return row;

    if (l[0] !== '+') o++;

    if (l[0] !== '-') n++;
    row.at = { old: l[0] === '+' ? o + 1 : o, new: l[0] === '-' ? n + 1 : n };

    return row;
  });
}

/** Each unbroken run of the rows kept, under its own header. */
function runsOf<R extends { l: string; o: number; n: number }>(rows: R[], keep: (r: R, i: number) => boolean): string[][] {
  const out: string[][] = [];

  for (let i = 0; i < rows.length; i++) {
    if (!keep(rows[i], i)) continue;
    let j = i;

    while (j + 1 < rows.length && keep(rows[j + 1], j + 1)) j++;
    const run = rows.slice(i, j + 1).map((r) => r.l);
    const olds = run.filter((l) => l[0] === ' ' || l[0] === '-').length;
    const news = run.filter((l) => l[0] === ' ' || l[0] === '+').length;
    out.push([`@@ -${rows[i].o + 1},${olds} +${rows[i].n + 1},${news} @@`, ...run]);
    i = j;
  }

  return out;
}

/**
 * The changed symbols of a file, indexed so whether any of them holds a row or meets a hunk is a
 * binary search, not a check of every symbol: a generated file can have thousands of both.
 */
function covers(rest: readonly HunkOwner[]) {
  const index = (spans: (readonly [number, number] | undefined)[]) => {
    const s = spans.filter((x): x is readonly [number, number] => !!x).sort((a, b) => a[0] - b[0]);
    // The furthest any span up to each one reaches.
    const reach: number[] = [];
    s.forEach((x, i) => reach.push(Math.max(x[1], i ? reach[i - 1] : -Infinity)));

    return (from: number, to: number) => {
      let lo = 0;
      let hi = s.length - 1;
      let k = -1;

      while (lo <= hi) {
        const m = (lo + hi) >> 1;

        if (s[m][0] <= to) (k = m), (lo = m + 1);
        else hi = m - 1;
      }

      return k >= 0 && reach[k] >= from;
    };
  };

  const now = index(rest.map((r) => r.lines));
  const old = index(rest.map((r) => r.oldLines));
  // An added row stands only where it is now, unless all a symbol has are its old lines; a removed
  // one only where it was, unless all a symbol has are its lines now.
  const oldOnly = index(rest.map((r) => (r.lines ? undefined : r.oldLines)));
  const nowOnly = index(rest.map((r) => (r.oldLines ? undefined : r.lines)));
  const spanned = rest.some((r) => r.lines || r.oldLines);

  return {
    /** Symbols known only by name. */
    named: rest.filter((r) => !r.lines && !r.oldLines),
    /** Whether a hunk meets any symbol's lines, on either side. */
    meets(h: string[]) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);

      if (!m) return spanned;
      const range = (at: string, n?: string) => [Number(at), Number(at) + Math.max(1, n == null ? 1 : Number(n)) - 1] as const;

      return now(...range(m[3], m[4])) || old(...range(m[1], m[2]));
    },
    /** Whether any symbol holds a row, as `of` places it. */
    holds: (c: string, at: { old: number; new: number }) =>
      (c !== '-' ? now : nowOnly)(at.new, at.new) || (c !== '+' ? old : oldOnly)(at.old, at.old),
  };
}

/** A hunk's header with the lines its body has on each side, for one a cut ended early. */
function keptHeader(h: string[]): string {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(h[0]);

  if (!m) return h[0];
  const body = h.slice(1);
  const olds = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const news = body.filter((l) => l[0] === ' ' || l[0] === '+').length;

  // Cut right after its header: it holds no line of anything.
  if (!olds && !news) return `@@ -0,0 +0,0 @@${m[3]}`;

  return `@@ -${m[1]},${olds} +${m[2]},${news} @@${m[3]}`;
}

/** How the agent ends a diff it cut short (agent/src/git.ts). */
const CUT = '… diff cut at ';

/**
 * The lines an agent added and took away in a file, as its diff's header says them. The hook's
 * counts are git's for the whole file, so with another agent's rows in it (`peer`) they're counted
 * from what's left once those are taken out, and left unsaid when the diff was cut short.
 */
export function ownCounts(
  d: { diff?: string; additions?: number; deletions?: number },
  peer?: Theirs,
  mine: readonly HunkOwner[] = [],
): { additions?: number; deletions?: number } | null {
  if (!peer || !d.diff) return { additions: d.additions, deletions: d.deletions };
  const rows = pickHunks(d.diff, undefined, mine, peer);

  if (cutShort(rows)) return null;
  const n = (c: string) => rows.filter((l) => l[0] === c).length;

  return { additions: n('+'), deletions: n('-') };
}

/** A diff from before the agent's latest change to the file: that change came without one. */
export const behind = (d: { diff?: string; diffAt?: string; at: string }) => !!d.diff && !!d.diffAt && Date.parse(d.diffAt) < Date.parse(d.at);

/** Picked rows that end where the agent cut the diff short: some of the change isn't in them. */
export const cutShort = (rows: readonly string[]) => rows.length > 0 && rows[rows.length - 1].startsWith(CUT);

/**
 * A hunk cut down to the symbol's own lines (a deleted one's as they were) and, apart, with `rest`,
 * the lines none of the changed symbols covers; so each of an added file's functions shows its own
 * code, not the whole file again, and a long hunk across many functions shows this one's rows
 * before the panel's row limit. A hunk of nothing but lines added (or, for a deleted symbol,
 * removed) is cut to exactly those lines; any other keeps three lines of context around them, as
 * git would. A hunk that needs no cut stays as it is, header and all. Without `own`, only the rest.
 */
/** A hunk cut into the lines the symbol's agent changed and the rest. */
type Sliced = { own: string[][]; rest: string[][] };

function slice(h: string[], own: HunkOwner | undefined, rest?: ReturnType<typeof covers>): Sliced {
  const placed = place(h);

  if (!placed || (own && !own.lines && !own.oldLines)) return own ? { own: [h], rest: [] } : { own: [], rest: [] };
  const body = h.slice(1);
  const only = (c: string) => body.every((l) => l[0] === c || l[0] === '\\');
  const pad = (only('+') && own?.lines) || (only('-') && own?.oldLines) ? 0 : 3;
  const inside = (at: number, s: readonly [number, number] | undefined, p = 0) => !!s && at >= s[0] - p && at <= s[1] + p;

  // A row is a symbol's by where it stands now, or, removed or unchanged, by where it stood in HEAD
  // (so a function moved far also has the hunk that took it from there); one with only its old
  // lines (deleted) by those alone. A removed row stands now only where the next line does, so
  // with the symbol's old lines known it goes by those: the code taken away just above a function
  // isn't that function's.
  const of = (r: HunkOwner, c: string, at: { old: number; new: number }, p = 0) =>
    ((c !== '-' || !r.oldLines) && inside(at.new, r.lines, p)) || ((c !== '+' || !r.lines) && inside(at.old, r.oldLines, p));

  const rows = placed.map(({ l, o, n, at }) => {
    const row = { l, o, n, mine: false, other: false };

    if (l[0] === '\\') return row;
    row.mine = !!own && of(own, l[0], at, pad);
    row.other = !row.mine && !!rest && !rest.holds(l[0], at);

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
  const runs = (keep: (r: (typeof rows)[number]) => boolean) => runsOf(rows, keep);
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
