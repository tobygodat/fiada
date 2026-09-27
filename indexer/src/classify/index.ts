// Runs the classifier chains. This is the one place to swap strategies:
// reorder, remove, or add classifiers in the default chains below.

import type { Classification, Layer } from '@strata/shared';
import { configDomains, configLayers } from './config.ts';
import { featureTokens } from './domains.ts';
import { codeSignals, graphPosition, pathConventions } from './layers.ts';
import type { Classifier, DomainClassifier, FileContext, LayerClassifier, Vote } from './types.ts';

export type { Classifier, DomainClassifier, FileContext, LayerClassifier, Vote } from './types.ts';

export const defaultLayerChain = (): LayerClassifier[] => [configLayers, codeSignals, pathConventions, graphPosition];
export const defaultDomainChain = (): DomainClassifier[] => [configDomains, featureTokens()];

export interface FileClassification {
  layer: Classification<Layer>;
  domain: Classification;
  /** Aligned with file.symbols. */
  symbols: { layer: Classification<Layer>; domain: Classification }[];
}

const UNCLASSIFIED_LAYER: Classification<Layer> = { value: 'Other', confidence: 0, source: 'none', reason: 'no classifier matched' };
const UNCLASSIFIED_DOMAIN: Classification = { value: 'Shared', confidence: 0, source: 'none', reason: 'no recurring feature name' };

function best<T extends string>(chain: Classifier<T>[], vote: (c: Classifier<T>) => Vote<T> | null): Classification<T> | null {
  let win: Classification<T> | null = null;
  for (const c of chain) {
    const v = vote(c);
    if (v && (!win || v.confidence > win.confidence)) win = { ...v, source: c.name };
  }
  return win;
}

function symbolPass<T extends string>(chain: Classifier<T>[], ctx: FileContext, file: Classification<T>): Classification<T>[] {
  return ctx.file.symbols.map((sym) => {
    // An explicit config entry is authoritative for everything in the file.
    if (file.source === 'repo-config') return file;
    return best(chain, (c) => c.classifySymbol?.(sym, file, ctx) ?? null) ?? file;
  });
}

export function classifyAll(
  contexts: FileContext[],
  layerChain: LayerClassifier[] = defaultLayerChain(),
  domainChain: DomainClassifier[] = defaultDomainChain(),
): Map<string, FileClassification> {
  for (const c of [...layerChain, ...domainChain]) c.prepare?.(contexts);

  // Pass 1: each file on its own facts.
  const facts = layerChain.filter((c) => c.phase !== 'graph');
  const layers = new Map<string, Classification<Layer>>();
  for (const ctx of contexts) layers.set(ctx.id, best(facts, (c) => c.classifyFile(ctx)) ?? UNCLASSIFIED_LAYER);

  // Pass 2: whatever is still unclassified looks at its neighbours.
  const graph = layerChain.filter((c) => c.phase === 'graph');
  if (graph.length) {
    const layerOf = (id: string) => {
      const l = layers.get(id);
      return l && l.confidence > 0 ? l.value : undefined;
    };
    for (const ctx of contexts) {
      if (layers.get(ctx.id)!.confidence > 0) continue;
      const v = best(graph, (c) => c.classifyFile({ ...ctx, layerOf }));
      if (v) layers.set(ctx.id, v);
    }
  }

  const out = new Map<string, FileClassification>();
  for (const ctx of contexts) {
    const layer = layers.get(ctx.id)!;
    const domain = best(domainChain, (c) => c.classifyFile(ctx)) ?? UNCLASSIFIED_DOMAIN;
    const symLayers = symbolPass(layerChain, ctx, layer);
    const symDomains = symbolPass(domainChain, ctx, domain);
    out.set(ctx.id, { layer, domain, symbols: symLayers.map((l, i) => ({ layer: l, domain: symDomains[i] })) });
  }
  return out;
}
