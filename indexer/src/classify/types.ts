// Classification is a pure function of the graph and the project's grouping:
//
//   (file and symbol nodes with facts, edges, grouping) → a layer and a domain per node
//
// Language-specific knowledge stays in the fact detectors (../facts.ts), and
// the project's layer definitions arrive inside `grouping`, so nothing here
// hard-codes a layer. Layer and domain strategies are separate, swappable
// functions; the user's rules and pins are applied on top of whatever they return.

import type { GraphEdge, GraphNode, Grouping, Placement } from '@strata/shared';

export interface ClassifyInput {
  /** Files and symbols (other node kinds are ignored). Symbols' parent is their file. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  grouping: Grouping;
}

/** Placement per file and symbol id. */
export type Assignments = Map<string, Placement>;

export interface LayerStrategy {
  name: string;
  assign(input: ClassifyInput): Assignments;
}

export interface DomainStrategy {
  name: string;
  assign(input: ClassifyInput, layers: Assignments): { domains: { id: string; name: string }[]; assignments: Assignments };
}
