// The line under the layers heading once the model's sort is done: what it
// placed, what it did to domains, and how much is still Unlayered or Unsorted.

import { UNLAYERED, UNSORTED_DOMAIN, type Graph, type SortingState } from '@fiada/shared';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Leaves of the By-function view (symbols, and files with no symbols) still in Unlayered or Unsorted. */
export function stillUnsorted(graph: Graph): number {
  const hasSymbols = new Set(graph.nodes.flatMap((n) => (n.kind === 'symbol' ? [n.parent] : [])));

  return graph.nodes.filter(
    (n) =>
      (n.kind === 'symbol' || (n.kind === 'file' && !hasSymbols.has(n.id))) &&
      ((n.layer?.id ?? UNLAYERED) === UNLAYERED || (n.domain?.id ?? UNSORTED_DOMAIN) === UNSORTED_DOMAIN),
  ).length;
}

export function sortSummary(s: SortingState, unsorted: number): string {
  const by = s.by ?? 'Model';
  const domains: string[] = [];

  for (const [verb, n] of Object.entries({ renamed: s.renamed, merged: s.merged, added: s.added })) {
    if (n) domains.push(`${verb} ${domains.length ? n : plural(n, 'domain')}`);
  }

  const head = s.placed || unsorted || domains.length ? `${by} placed ${s.placed ?? 0}` : 'All sorted by rules';
  const parts = [[head, ...domains].join(', '), ...(unsorted ? [`${unsorted} unsorted`] : [])];

  return parts.join(' · ');
}

/** Short label for the layers header tag; `sortSummary` gives the full tooltip. */
export function sortTag(s: SortingState, unsorted: number): string {
  if (s.placed) return unsorted ? `placed ${s.placed} · ${unsorted} unsorted` : `placed ${s.placed}`;

  if (unsorted) return `${unsorted} unsorted`;

  if (s.renamed || s.merged || s.added) return s.by ?? 'model';

  return 'rules';
}
