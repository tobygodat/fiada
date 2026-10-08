// Finds repositories, folders, files and symbols by name, for the search box in the top bar.
// Matches are ranked by how well the name fits (exact, starts with, a word in it, anywhere,
// in the path, letters in order), then repos before folders before files before symbols.

import type { GraphNode } from '@fiada/shared';
import type { Tree } from './tree.ts';

export interface SearchHit {
  id: string;
  name: string;
  kind: GraphNode['kind'];
  /** Where it lives: the repo and path above it, for telling two `index.ts` apart. */
  where: string;
  /** Lower is better. */
  score: number;
  /** [start, end) of the matched text in `name`, when the match is in the name. */
  span: [number, number] | null;
}

const KIND_ORDER: Record<string, number> = { repo: 0, folder: 1, file: 2, symbol: 3 };

/** Where a node lives, without its own name: `repo/src/pages` for `repo/src/pages/items.tsx`, `repo/a.ts:12` for a symbol. */
export function whereOf(n: GraphNode): string {
  // The real parent, not the id cut at a slash: a collapsed chain like `src/main/java` hangs straight off its repo.
  // Two repos of one name (`app` from two owners) are told apart by their ids (`app`, `app-2`).
  if (n.kind === 'repo') return n.id === n.name ? '' : n.id;
  if (n.parent === 'root') return '';
  // Symbols say their line too, so two `render` in one file (overloads, repeats) can be told apart.
  return n.kind === 'symbol' && n.lines ? `${n.parent}:${n.lines[0]}` : n.parent;
}

const isWordStart = (s: string, i: number) => i === 0 || /[^a-z0-9]/i.test(s[i - 1]) || (/[A-Z]/.test(s[i]) && /[a-z]/.test(s[i - 1]));

/** How well `q` (lowercase) matches `n`; null when it doesn't. */
function rank(n: GraphNode, q: string): { score: number; span: [number, number] | null } | null {
  const name = n.name.toLowerCase();
  if (name === q) return { score: 0, span: [0, q.length] };
  if (name.startsWith(q)) return { score: 1, span: [0, q.length] };
  let at = name.indexOf(q);
  let first = at;
  while (at > 0 && !isWordStart(n.name, at)) at = name.indexOf(q, at + 1);
  if (at > 0) return { score: 2, span: [at, at + q.length] };
  if (first > 0) return { score: 3, span: [first, first + q.length] };
  if (n.kind !== 'repo' && n.id.toLowerCase().includes(q)) return { score: 4, span: null };
  // Letters in order, as in "itsvc" for ItemsService.
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  if (i === q.length && q.length >= 2) return { score: 5, span: null };
  return null;
}

const order = (a: SearchHit, b: SearchHit) =>
  a.score - b.score ||
  (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
  a.name.length - b.name.length ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The best `limit` matches for `query` among `nodes`. Empty for a blank query. */
export function searchNodes(nodes: Iterable<GraphNode>, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q || limit <= 0) return [];
  // Keep only the best `limit` while scanning, so a one-letter query over a big project never sorts every match.
  const best: SearchHit[] = [];
  for (const n of nodes) {
    const r = rank(n, q);
    if (!r) continue;
    const hit: SearchHit = { id: n.id, name: n.name, kind: n.kind, where: '', score: r.score, span: r.span };
    if (best.length === limit && order(hit, best[limit - 1]) >= 0) continue;
    let i = best.length;
    while (i > 0 && order(hit, best[i - 1]) < 0) i--;
    best.splice(i, 0, hit);
    if (best.length > limit) best.pop();
    hit.where = whereOf(n);
  }
  return best;
}

/** The nodes the current view draws: the by-function view has no repos or folders, and files only where they hold no symbols. */
export function onMap(nodes: GraphNode[], tree: Tree): GraphNode[] {
  return nodes.filter((n) => tree.nodes.has(n.id));
}
