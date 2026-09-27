// What classification left undecided: code in Unlayered or Unsorted. The
// counts are how Strata measures a fresh import, and the list is what the
// model sort is asked to place.

import { SHARED_DOMAIN, UNLAYERED, UNSORTED_DOMAIN, type Graph, type GraphNode } from '@strata/shared';

export interface SortStats {
  /** What the By-function view draws: symbols, and files that have no symbols. */
  leaves: number;
  /** Leaves in Unsorted, in Unlayered, and in either. */
  unsorted: number;
  unlayered: number;
  leftover: number;
  /** Leaves in Shared (used across features: placed, but not in one feature). */
  shared: number;
  /** The Code view: files with no layer. */
  files: number;
  filesUnlayered: number;
  /** Named domains (not Shared or Unsorted), and how many of them hold code from a single file. */
  domains: number;
  oneFileDomains: number;
  /** Leaves the model's sort placed. */
  sortedByModel: number;
}

/** The nodes the By-function view draws as leaves. */
export function leaves(nodes: GraphNode[]): GraphNode[] {
  const hasSymbols = new Set(nodes.filter((n) => n.kind === 'symbol').map((n) => n.parent));
  return nodes.filter((n) => n.kind === 'symbol' || (n.kind === 'file' && !hasSymbols.has(n.id)));
}

export function sortStats(graph: Graph): SortStats {
  const ls = leaves(graph.nodes);
  const files = graph.nodes.filter((n) => n.kind === 'file');
  const filesOf = new Map<string, Set<string>>();
  let unsorted = 0;
  let unlayered = 0;
  let leftover = 0;
  let shared = 0;
  let sortedByModel = 0;
  for (const n of ls) {
    const d = n.domain?.id ?? UNSORTED_DOMAIN;
    const u = d === UNSORTED_DOMAIN;
    const l = (n.layer?.id ?? UNLAYERED) === UNLAYERED;
    if (u) unsorted++;
    if (l) unlayered++;
    if (u || l) leftover++;
    if (d === SHARED_DOMAIN) shared++;
    if (n.domain?.source === 'model' || n.layer?.source === 'model') sortedByModel++;
    if (!u && d !== SHARED_DOMAIN) (filesOf.get(d) ?? filesOf.set(d, new Set()).get(d)!).add(n.kind === 'file' ? n.id : n.parent);
  }
  return {
    leaves: ls.length,
    unsorted,
    unlayered,
    leftover,
    shared,
    files: files.length,
    filesUnlayered: files.filter((f) => (f.layer?.id ?? UNLAYERED) === UNLAYERED).length,
    domains: filesOf.size,
    oneFileDomains: [...filesOf.values()].filter((s) => s.size === 1).length,
    sortedByModel,
  };
}

export const describeStats = (s: SortStats) =>
  `${s.leftover} of ${s.leaves} unsorted (${s.unsorted} with no domain, ${s.unlayered} with no layer; ${s.filesUnlayered} of ${s.files} files unlayered) · ` +
  `${s.shared} shared · ${s.domains} domains, ${s.oneFileDomains} from one file` +
  (s.sortedByModel ? ` · ${s.sortedByModel} placed by the model` : '');

/** One file with something left to decide: its own layer, or a domain for it or some of its symbols. */
export interface LeftoverFile {
  file: GraphNode;
  needsLayer: boolean;
  /** The file itself (when it has no symbols) or its symbols, with no domain. */
  needsDomain: GraphNode[];
  /** Symbols in the file that do have a domain, for context. */
  placed: GraphNode[];
}

export function leftoverFiles(graph: Graph): LeftoverFile[] {
  const symbolsOf = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) if (n.kind === 'symbol') (symbolsOf.get(n.parent) ?? symbolsOf.set(n.parent, []).get(n.parent)!).push(n);
  const out: LeftoverFile[] = [];
  for (const f of graph.nodes) {
    if (f.kind !== 'file') continue;
    const syms = symbolsOf.get(f.id) ?? [];
    const noDomain = (n: GraphNode) => (n.domain?.id ?? UNSORTED_DOMAIN) === UNSORTED_DOMAIN;
    const needsLayer = (f.layer?.id ?? UNLAYERED) === UNLAYERED || syms.some((s) => (s.layer?.id ?? UNLAYERED) === UNLAYERED);
    const needsDomain = syms.length ? syms.filter(noDomain) : noDomain(f) ? [f] : [];
    if (!needsLayer && !needsDomain.length) continue;
    out.push({ file: f, needsLayer, needsDomain, placed: syms.filter((s) => !noDomain(s)) });
  }
  return out;
}
