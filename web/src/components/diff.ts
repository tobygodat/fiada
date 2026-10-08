// Reading an agent's unified diff for the detail panel: the hunks that touch a symbol, and
// each line as the view draws it.

/** Hunks of a unified diff whose new side overlaps `lines`; all of them when none does. */
export function hunksFor(diff: string, lines?: [number, number], rest?: readonly [number, number][]): string[] {
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
  if (!lines) return hunks.flat();
  const touches = (h: string[], [a, b]: readonly [number, number]) => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);
    if (!m) return true;
    const s = Number(m[1]);
    const e = s + Math.max(1, m[2] == null ? 1 : Number(m[2])) - 1;
    return s <= b && e >= a;
  };
  // With `rest` (the lines of every changed symbol in the file), also the hunks none of them touches: an import, a constant.
  const hit = hunks.filter((h) => touches(h, lines) || (rest && !rest.some((r) => touches(h, r))));
  return (hit.length ? hit : hunks).flat();
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
