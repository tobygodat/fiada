// The graph contract between the indexer and the map.
//
// The indexer emits a flat list of nodes (each pointing at its parent) and a
// flat list of edges between them. The web app rebuilds the tree, lays it out
// and aggregates edges up to whatever altitude is visible.

export type NodeKind = 'repo' | 'folder' | 'file' | 'symbol';

export type SymbolKind =
  | 'function'
  | 'component'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

/**
 * What one edge means. Every edge is one underlying interaction; the map
 * draws aggregated edges whose thickness is the number of interactions.
 */
export type EdgeKind =
  | 'imports' // file-level import with no finer-grained use we could resolve
  | 'calls' // symbol calls or instantiates another symbol
  | 'renders' // JSX element usage
  | 'type' // symbol refers to a type, interface or class in a type position
  | 'references' // any other resolved identifier use
  | 'http'; // client request matched to a server route

/** The fixed layer taxonomy used by the By-function view. */
export const LAYERS = ['UI', 'Client', 'API', 'Services', 'Storage', 'Pipeline', 'Contracts', 'Other'] as const;
export type Layer = (typeof LAYERS)[number];

/** Why a node landed in its layer or domain, so the map can show its work. */
export interface Classification<T extends string = string> {
  value: T;
  /** 0..1, how sure the winning classifier was. */
  confidence: number;
  /** Name of the classifier that won, e.g. "code-signals". */
  source: string;
  /** Human-readable evidence, e.g. "declares route GET /items/{id}". */
  reason: string;
}

export interface GraphNode {
  /** `${repoId}` | `${repoId}/${path}` | `${repoId}/${path}#${symbol}` */
  id: string;
  kind: NodeKind;
  name: string;
  /** Parent node id; repositories hang off the implicit "root". */
  parent: string;
  repo: string;
  /** Repo-relative path for folders and files; the containing file for symbols. */
  path?: string;
  lang?: string;
  symbolKind?: SymbolKind;
  exported?: boolean;
  /** Lines of code (files) or lines spanned (symbols). Drives circle size. */
  loc?: number;
  /** 1-based inclusive line range for symbols. */
  lines?: [number, number];
  /** Present on files and symbols. */
  layer?: Classification<Layer>;
  /** Present on files and symbols. */
  domain?: Classification;
  /** HTTP routes this file or symbol serves, e.g. "GET /items/{id}". */
  routes?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Short evidence: imported names, the matched route, etc. */
  detail?: string;
}

export type RepoStatus = 'queued' | 'cloning' | 'indexing' | 'ready' | 'error';

export interface RepoInfo {
  id: string;
  name: string;
  /** What the user typed: a git URL or an absolute local path. */
  source: string;
  kind: 'git' | 'local';
  status: RepoStatus;
  error?: string;
  commit?: string;
  indexedAt?: string;
  fileCount?: number;
  symbolCount?: number;
  /** File counts by language. */
  languages?: Record<string, number>;
  /** Frameworks detected from manifests, e.g. ["react", "fastapi"]. */
  frameworks?: string[];
  /** Files skipped because the repo exceeded the indexing budget. */
  truncated?: number;
}

export interface Graph {
  version: 1;
  generatedAt: string;
  repos: RepoInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Which classifier chains produced layer and domain assignments. */
  classifiers: { layer: string[]; domain: string[] };
}

export interface Workspace {
  repos: RepoInfo[];
  /** True while any repository is cloning or indexing. */
  busy: boolean;
  /** Bumps whenever the graph is rebuilt, so clients know to refetch. */
  graphVersion: number;
  /** Sources worth offering on an empty workspace (e.g. this checkout). */
  suggestions: string[];
}
