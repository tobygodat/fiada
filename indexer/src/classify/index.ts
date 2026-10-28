// Runs classification: a layer strategy and a domain strategy, then the
// user's rules and pins on top. This is the one place to swap strategies.

import { UNSORTED_DOMAIN, type GraphEdge, type GraphNode, type Grouping, type Placement } from '@fiada/shared';
import { applyUserPlacements, domainList } from './grouping.ts';
import { projectMatchers } from './layers.ts';
import { seedAndPropagate } from './propagate.ts';
import { applySorted, sortedDomainList } from './sorted.ts';
import type { Assignments, DomainStrategy, LayerStrategy } from './types.ts';

export type { Assignments, ClassifyInput, DomainStrategy, LayerStrategy } from './types.ts';

export { defaultGrouping, presetLayers, PRESETS, rolesPreset } from './presets.ts';

export { GroupingError, normalizeGrouping } from './grouping.ts';

export { featureTokens } from './domains.ts';

export { seedAndPropagate } from './propagate.ts';

export { describeStats, leaves, leftoverFiles, sortStats, type LeftoverFile, type SortStats } from './leftovers.ts';

export { applySorted, mergeMap, normalizeSorted, sortedDomainList } from './sorted.ts';

export interface Strategies {
  layers: LayerStrategy;
  domains: DomainStrategy;
}

export const defaultStrategies = (): Strategies => ({ layers: projectMatchers, domains: seedAndPropagate() });

export interface ClassifyResult {
  layers: Assignments;
  domains: Assignments;
  domainList: { id: string; name: string }[];
  /** Files and symbols Claude's sort placed. */
  sortedPlaced: number;
}

export function classify(nodes: GraphNode[], edges: GraphEdge[], grouping: Grouping, strategies: Strategies = defaultStrategies()): ClassifyResult {
  const input = { nodes, edges, grouping };
  const layers = strategies.layers.assign(input);
  const { domains: found, assignments: domains } = strategies.domains.assign(input, layers);
  // The model's sort fills the classifier's gaps; the user's rules and pins then win over both.
  const placed = applySorted(nodes, grouping, layers, domains, new Map(found.map((d) => [d.id, d.name])));
  const proposed = sortedDomainList(grouping, found);
  applyUserPlacements(nodes, grouping, layers, domains);

  // Dissolved domains hand their code back to Unsorted.
  const hidden = new Set(grouping.domains.filter((d) => d.hidden).map((d) => d.id));

  if (hidden.size) {
    for (const [id, p] of domains) {
      if (!hidden.has(p.id)) continue;
      const moved: Placement = { id: UNSORTED_DOMAIN, confidence: 0, source: 'fallback', evidence: [{ source: 'fallback', detail: `domain "${p.id}" is hidden`, weight: 0 }] };
      domains.set(id, moved);
    }
  }

  const used = new Set([...domains.values()].map((p) => p.id));

  return { layers, domains, domainList: domainList(grouping, proposed, used), sortedPlaced: placed };
}
