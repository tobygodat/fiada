// Claude's sort of a project (grouping.sorted), applied between the classifier
// and the user: it renames and merges the classifier's domains and fills the
// gaps the classifier left (Unlayered, Unsorted). It never moves code the
// classifier placed, and the user's names, rules and pins still win over it.

import { modelLabel, UNLAYERED, UNSORTED_DOMAIN, type GraphNode, type Grouping, type Placement, type SortedDomain, type SortedGrouping, type SortedPlacement } from '@strata/shared';
import type { Assignments } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Reads a stored sort, dropping whatever doesn't parse (it's machine-written, so a bad piece is skipped rather than failing the grouping). */
export function normalizeSorted(raw: unknown): SortedGrouping | undefined {
  if (!isObj(raw) || !str(raw.model) || !str(raw.at)) return undefined;
  const repos: Record<string, string> = {};
  if (isObj(raw.repos)) for (const [id, c] of Object.entries(raw.repos)) if (typeof c === 'string') repos[id] = c;
  const domains: SortedDomain[] = (Array.isArray(raw.domains) ? raw.domains : []).filter(isObj).flatMap((d) => {
    if (!str(d.id) || !str(d.name)) return [];
    const out: SortedDomain = { id: d.id as string, name: d.name as string };
    if (str(d.from) && d.from !== d.name) out.from = d.from as string;
    if (str(d.mergeInto) && d.mergeInto !== d.id) out.mergeInto = d.mergeInto as string;
    if (d.added === true) out.added = true;
    if (str(d.reason)) out.reason = d.reason as string;
    return [out];
  });
  const placements: Record<string, SortedPlacement> = {};
  if (isObj(raw.placements)) {
    for (const [id, p] of Object.entries(raw.placements)) {
      if (!isObj(p) || !str(p.reason) || (!str(p.layer) && !str(p.domain))) continue;
      placements[id] = {
        ...(str(p.layer) ? { layer: p.layer as string } : {}),
        ...(str(p.domain) ? { domain: p.domain as string } : {}),
        reason: p.reason as string,
        ...(str(p.layer) && str(p.layerReason) ? { layerReason: p.layerReason as string } : {}),
      };
    }
  }
  return { model: raw.model as string, ...(str(raw.by) ? { by: raw.by as string } : {}), at: raw.at as string, repos, domains, placements };
}

/**
 * Domain id → the domain its code moves to. Chains are followed ("a" into "b"
 * into "c" sends "a" to "c"), cycles are dropped, and a domain the user has
 * named, ordered or hidden stays itself.
 */
export function mergeMap(grouping: Grouping): Map<string, string> {
  const userOwned = new Set(grouping.domains.map((d) => d.id));
  const into = new Map<string, string>();
  for (const d of grouping.sorted?.domains ?? []) if (d.mergeInto && !userOwned.has(d.id)) into.set(d.id, d.mergeInto);
  const out = new Map<string, string>();
  for (const id of into.keys()) {
    const seen = new Set([id]);
    let cur = into.get(id)!;
    while (into.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = into.get(cur)!;
    }
    if (!seen.has(cur)) out.set(id, cur);
  }
  return out;
}

const modelPlacement = (id: string, detail: string, by: string): Placement => ({
  id,
  confidence: 0.6,
  source: 'model',
  evidence: [{ source: 'model', detail, weight: 1 }],
  inferredBy: by,
});

/**
 * Applies a stored sort to the classifier's assignments, in place: merges
 * first, then placements for whatever is still Unlayered or Unsorted.
 * `found` is the classifier's domain names. Returns how many files and
 * symbols it placed.
 */
export function applySorted(nodes: GraphNode[], grouping: Grouping, layers: Assignments, domains: Assignments, found: Map<string, string>): number {
  const sorted = grouping.sorted;
  if (!sorted) return 0;
  const by = sorted.by ?? modelLabel(sorted.model);
  const merges = mergeMap(grouping);
  if (merges.size) {
    const named = new Map(sorted.domains.map((d) => [d.id, d]));
    const was = (id: string) => named.get(id)?.from ?? found.get(id) ?? named.get(id)?.name ?? id;
    const now = (id: string) => named.get(id)?.name ?? found.get(id) ?? id;
    for (const [id, p] of domains) {
      const to = merges.get(p.id);
      if (!to) continue;
      const why = named.get(p.id)?.reason;
      const what = was(p.id) === now(to) ? `folded a second ${now(to)} domain into this one` : `merged ${was(p.id)} into ${now(to)}`;
      domains.set(id, {
        ...p,
        id: to,
        evidence: [...p.evidence, { source: 'model', detail: `${by} ${what}${why ? `: ${why}` : ''}`, weight: 0 }],
      });
    }
  }

  const layerIds = new Set(grouping.layers.map((l) => l.id));
  let placed = 0;
  for (const n of nodes) {
    if (n.kind !== 'file' && n.kind !== 'symbol') continue;
    const own = sorted.placements[n.id];
    const file = n.kind === 'symbol' ? sorted.placements[n.parent] : undefined;
    let changed = false;
    if (layers.get(n.id)?.id === UNLAYERED) {
      const p = own?.layer && layerIds.has(own.layer) ? own : file?.layer && layerIds.has(file.layer) ? file : null;
      if (p) {
        const why = p.layerReason ?? p.reason;
        layers.set(n.id, modelPlacement(p.layer!, p === own ? why : `its file: ${why}`, by));
        changed = true;
      }
    }
    if ((domains.get(n.id)?.id ?? UNSORTED_DOMAIN) === UNSORTED_DOMAIN) {
      const p = own?.domain ? own : file?.domain ? file : null;
      if (p) {
        const to = merges.get(p.domain!) ?? p.domain!;
        domains.set(n.id, modelPlacement(to, p === own ? p.reason : `its file: ${p.reason}`, by));
        changed = true;
      }
    }
    if (changed) placed++;
  }
  return placed;
}

/**
 * The classifier's domains with Claude's names, minus the ones merged away,
 * then the domains Claude added. Order is the classifier's, so the map
 * doesn't reshuffle when a sort lands.
 */
export function sortedDomainList(grouping: Grouping, proposed: { id: string; name: string }[]): { id: string; name: string }[] {
  const sorted = grouping.sorted;
  if (!sorted) return proposed;
  const merges = mergeMap(grouping);
  const byId = new Map(sorted.domains.map((d) => [d.id, d]));
  const out = proposed.filter((d) => !merges.has(d.id)).map((d) => ({ id: d.id, name: byId.get(d.id)?.name ?? d.name }));
  const have = new Set(out.map((d) => d.id));
  for (const d of sorted.domains) if (d.added && !have.has(d.id) && !merges.has(d.id)) out.push({ id: d.id, name: d.name });
  return out;
}
