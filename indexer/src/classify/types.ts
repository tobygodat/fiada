// The classification step is a chain of small, independent classifiers.
// Each looks at one file (and optionally its symbols) and either abstains or
// casts a vote with a confidence and a human-readable reason. The highest
// confidence wins; ties go to whichever classifier comes first in the chain.
//
// To try a different strategy, write a classifier and put it in the chain in
// classify/index.ts. Nothing else in the indexer needs to change.

import type { Classification, Layer } from '@strata/shared';
import type { ParsedFile, ParsedRepo, ParsedSymbol } from '../model.ts';

export interface FileContext {
  repo: ParsedRepo;
  file: ParsedFile;
  /** Graph node id of the file. */
  id: string;
  /** Top-level names of packages this file imports that are not in any indexed repo. */
  externalImports: string[];
  /** True when the nearest package.json depends on a UI framework. */
  frontend: boolean;
  /** Files that call into this one, and files this one calls into. */
  callers: string[];
  callees: string[];
  /**
   * Layers already assigned by earlier passes, by file id. Only filled for
   * classifiers with phase "graph", which run after the first pass.
   */
  layerOf?: (fileId: string) => Layer | undefined;
}

export interface Vote<T extends string = string> {
  value: T;
  confidence: number;
  reason: string;
}

export interface Classifier<T extends string = string> {
  name: string;
  /**
   * "facts" classifiers see only the file's own facts. "graph" classifiers run
   * afterwards and can read the first-pass result for neighbouring files.
   */
  phase?: 'facts' | 'graph';
  /** Optional hook that sees every file first, for classifiers that need corpus-wide statistics. */
  prepare?(all: FileContext[]): void;
  classifyFile(ctx: FileContext): Vote<T> | null;
  /** Optional per-symbol override; symbols otherwise inherit the file's result. */
  classifySymbol?(sym: ParsedSymbol, file: Classification<T>, ctx: FileContext): Vote<T> | null;
}

export type LayerClassifier = Classifier<Layer>;
export type DomainClassifier = Classifier<string>;
