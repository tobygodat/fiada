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
  const by = s.by ?? 'The model';
  const domains: string[] = [];

  for (const [verb, n] of Object.entries({ renamed: s.renamed, merged: s.merged, added: s.added })) if (n) domains.push(`${verb} ${domains.length ? n : plural(n, 'domain')}`);

  const placed = s.placed
    ? `placed ${plural(s.placed, 'file or symbol', 'files and symbols')} the classifier couldn't`
    : unsorted
      ? 'placed nothing'
      : 'found nothing the classifier left unplaced';

  const left = unsorted ? ` ${plural(unsorted, 'file or symbol is', 'files and symbols are')} still Unlayered or Unsorted.` : '';

  return `${by} ${placed}${domains.length ? `, ${domains.join(', ')}` : ''}.${s.placed ? ' Each says why in its details.' : ''}${left}`;
}
