// Reading an agent's unified diff for the detail panel: the hunks that touch a symbol, and
// each line as the view draws it.

/** One changed symbol, as a diff can find it: by its lines, or, deleted, by the lines that take it away. */
export interface HunkOwner {
  lines?: readonly [number, number];
  /** A deleted symbol's name; for a member (`ItemController.get`) its declaration says only the last part. */
  name?: string;
}

/**
 * The hunks of a unified diff that belong to `own`, or all of them without it. With `rest` (every changed symbol in the file), also the hunks
 * none of them accounts for: an import, a constant. All the hunks when none matches, so nothing
 * is hidden.
 */
export function pickHunks(diff: string, own?: HunkOwner, rest?: readonly HunkOwner[]): string[] {
  const hunks = split(diff);
  if (!Array.isArray(hunks[0])) return hunks as string[];
  if (!own) return hunks.flat();
  const hit = (hunks as string[][]).filter((h) => belongs(h, own) || (rest && !rest.some((r) => belongs(h, r))));
  return (hit.length ? hit : hunks).flat();
}

function belongs(h: string[], o: HunkOwner): boolean {
  if (o.lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);
    if (!m) return true;
    const s = Number(m[1]);
    const e = s + Math.max(1, m[2] == null ? 1 : Number(m[2])) - 1;
    return s <= o.lines[1] && e >= o.lines[0];
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
