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

/**
 * What a language-specific detector saw in a file or symbol, before any
 * judgment. Classification reads facts, paths and edges only, so it stays
 * language-agnostic; layer matchers are written against these.
 */
export type FactType =
  | 'import' // file: package it imports, e.g. "react", "sqlalchemy"
  | 'frontend' // file: UI framework of the package it lives in, e.g. "react"
  | 'route' // file/symbol: route it serves, e.g. "GET /items/{id}"
  | 'pageRoute' // file: framework file-system page route, e.g. "/items/[id]"
  | 'returnsJSX' // file/symbol: renders JSX
  | 'request' // file/symbol: HTTP request it makes, e.g. "GET /api/v1/items/{}"
  | 'extends' // symbol: base class, e.g. "BaseModel"
  | 'table' // symbol: ORM entity; value is the class name
  | 'typeOnly' // file: declares only types, interfaces, enums or schema classes
  | 'decorator' // symbol: decorator text, e.g. "router.get"
  | 'entrypoint' // file: "main" | "cli" | "cron"
  | 'test'; // file: a test

export interface Fact {
  type: FactType;
  value: string;
}

const FACT_TEXT: Record<FactType, (v: string) => string> = {
  import: (v) => `imports ${v}`,
  frontend: (v) => `in a ${v} package`,
  route: (v) => `serves ${v}`,
  pageRoute: (v) => `page route ${v}`,
  returnsJSX: () => 'renders JSX',
  request: (v) => `requests ${v}`,
  extends: (v) => `extends ${v}`,
  table: (v) => `ORM table ${v}`,
  typeOnly: () => 'only declares types',
  decorator: (v) => `decorated @${v}`,
  entrypoint: (v) => `${v} entry point`,
  test: () => 'is a test',
};

/** "serves GET /items/{id}", "renders JSX", … */
export const describeFact = (f: Fact) => FACT_TEXT[f.type]?.(f.value) ?? `${f.type} ${f.value}`;

/**
 * One way code can land in a layer. Every field that is set must match; the
 * highest-priority match across all of a project's layers wins.
 */
export interface LayerMatcher {
  /** A fact of this type; `value` is a regex tested against the fact's value (omitted = any). */
  fact?: { type: FactType; value?: string };
  /** Package the file imports: equal to this, or a submodule of it ("sqlalchemy" matches "sqlalchemy.orm"). */
  import?: string;
  /** Glob on "<repo>/<path>", e.g. "web/src/components/**" or "api/app/crud.py". */
  path?: string;
  /** Repository id: the whole repo lands in this layer. */
  repo?: string;
  /** Higher wins. The presets use about 300 for facts, 200 for imports, 100 for paths and 50 for repos. */
  priority: number;
}

/** A project-defined layer. Nothing in the indexer hard-codes a layer id. */
export interface LayerDef {
  /** Stable slug; never changes on rename. */
  id: string;
  name: string;
  /** Position in the request flow (lower is closer to the user). Optional. */
  rank?: number;
  match: LayerMatcher[];
}

/** Where code no matcher or neighbour places goes, so it's visible rather than guessed. */
export const UNLAYERED = 'unlayered';
/** Domains for code split evenly between several domains, and for code with no signal at all. */
export const SHARED_DOMAIN = 'shared';
export const UNSORTED_DOMAIN = 'unsorted';

export type LayerPreset = 'roles' | 'by-repo' | 'empty';

export type PlacementSource =
  | 'user-pin'
  | 'user-rule'
  | 'fact'
  | 'import'
  | 'path'
  | 'repo'
  | 'graph'
  | 'seed'
  | 'propagated'
  | 'cohesion'
  | 'fallback';

export interface Evidence {
  source: PlacementSource;
  /** Human-readable, e.g. "serves GET /items/{id}". */
  detail: string;
  weight: number;
}

/** Why a node landed in its layer or domain, so the map can show its work. */
export interface Placement {
  /** LayerDef id or domain id. */
  id: string;
  /** 0..1 */
  confidence: number;
  /** The signal that decided it. */
  source: PlacementSource;
  /** Winning evidence first, then runners-up. */
  evidence: Evidence[];
}

/** Bulk moves, stored as rules so code added later follows them. Later rules win. */
export interface GroupingRule {
  match: {
    repo?: string;
    /** Glob on "<repo>/<path>". */
    path?: string;
    /** Regex on the symbol name. */
    name?: string;
    /** Only move code currently in this layer. */
    layer?: string;
  };
  layer?: string;
  domain?: string;
}

/**
 * Everything the user owns about how one project is grouped. Persisted per
 * project (strata.grouping.json), seeded from a preset on first run.
 */
export interface Grouping {
  schema: 1;
  /** The preset the layers started from. */
  preset?: LayerPreset;
  layers: LayerDef[];
  /** Renamed, reordered or hidden domains, by id. */
  domains: { id: string; name?: string; order?: number; hidden?: boolean }[];
  rules: GroupingRule[];
  /** Single-node moves keyed by file or symbol id. */
  pins: Record<string, { layer?: string; domain?: string }>;
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
  /** What the detectors saw (files and symbols). */
  facts?: Fact[];
  /** Present on files and symbols. */
  layer?: Placement;
  /** Present on files and symbols. */
  domain?: Placement;
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
  /** The project's layers in display order (Unlayered is implied). */
  layers: { id: string; name: string; rank?: number }[];
  /** Domains that occur in this graph, in display order. */
  domains: { id: string; name: string }[];
  preset?: LayerPreset;
}

export interface Workspace {
  repos: RepoInfo[];
  /** True while any repository is cloning or indexing. */
  busy: boolean;
  /** Bumps whenever the graph is rebuilt, so clients know to refetch. */
  graphVersion: number;
  /** Sources worth offering on an empty workspace (e.g. this checkout). */
  suggestions: string[];
  project: {
    id: string;
    /** Where the project's grouping is stored, e.g. a file path. */
    groupingLocation: string;
    /** Set when the stored grouping failed to validate; the last good one is still in use. */
    groupingError?: string;
  };
}
