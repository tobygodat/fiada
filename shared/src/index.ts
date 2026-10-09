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
  | 'model'
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
  /** Who decided it ("Claude"), when a model sorted it rather than a signal in the code (source "model"). */
  inferredBy?: string;
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
 * project (fiada.grouping.json), seeded from a preset on first run.
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
  /** Claude's sort of this project, made when its repositories were imported. The user's names, rules and pins win over it. */
  sorted?: SortedGrouping;
}

/**
 * What Claude decided when the project's repositories were imported: better
 * names for the domains the classifier found, which of them are one feature,
 * and a layer and domain, with a reason, for everything the classifier left
 * Unlayered or Unsorted. It only fills gaps: code the classifier placed keeps
 * its place, and the user's own names, rules and pins win over all of it.
 */
export interface SortedGrouping {
  /** The model that sorted, e.g. "claude-haiku-5-5". */
  model: string;
  /** Who sorted, for people: the model client's label ("Claude"). */
  by?: string;
  /** ISO time. */
  at: string;
  /** Repository id → commit it sorted (empty when unknown); a new repository or commit sorts again. */
  repos: Record<string, string>;
  /** One entry per domain Claude named, merged or added. */
  domains: SortedDomain[];
  /** File or symbol id → where Claude put it. A file's entry covers its symbols that have none of their own. */
  placements: Record<string, SortedPlacement>;
}

export interface SortedDomain {
  id: string;
  name: string;
  /** The classifier's name for it, when Claude renamed it. */
  from?: string;
  /** The domain this one is the same feature as; its code moves there. */
  mergeInto?: string;
  /** True for a domain Claude added for leftovers (the classifier had no such domain). */
  added?: boolean;
  /** One line: why this name, merge or new domain. */
  reason?: string;
}

export interface SortedPlacement {
  layer?: string;
  domain?: string;
  /** One line, shown with the node: why it goes in that domain (or layer, when only a layer was decided). */
  reason: string;
  /** Why that layer, when Claude gave it its own reason. */
  layerReason?: string;
}

/** "Claude" for a Claude model id, "OpenAI" for an OpenAI one, else the id itself: who to credit when a sort doesn't say (see SortedGrouping.by). */
export const modelLabel = (model: string) => (/^claude/i.test(model) ? 'Claude' : /^(gpt|chatgpt|o\d)/i.test(model) ? 'OpenAI' : model);

/** Whether the indexer can sort a project with a model, and how the last sort went. */
export interface SortingState {
  /** The indexer has a model to sort with (an API key for one). */
  available: boolean;
  /** Where to set a key, when sorting is off (llm.ts KEY_HINT). */
  keyHint?: string;
  status: 'off' | 'idle' | 'running' | 'done' | 'error';
  /** Who sorts, for people: "OpenAI" or "Claude". */
  by?: string;
  /** The model the current sort was made with. */
  model?: string;
  /** When the current sort was made (ISO). */
  at?: string;
  /** Files and symbols Claude placed. */
  placed?: number;
  /** Domains Claude merged into another, renamed, or added. */
  merged?: number;
  renamed?: number;
  added?: number;
  error?: string;
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

/**
 * Whether an edge is proven by the code or guessed by a heuristic.
 *
 * - `evidenced`: the source names the target. An import statement resolves to
 *   it, a call or type use binds to it through one, or a request's full URL
 *   equals a route's full path once router mounts are applied.
 * - `inferred`: a heuristic linked them. A URL matched only the tail of a
 *   route (a mount prefix or base URL we couldn't see), a Python module path
 *   happened to exist in another repository, an ORM relationship named a
 *   class several entities share.
 */
export type EdgeBasis = 'evidenced' | 'inferred';

/** What a piece of edge evidence is. */
export type EdgeEvidenceSource =
  | 'import' // import / require / from … import / Go import
  | 'call' // a call or instantiation that resolved to the target
  | 'jsx' // a JSX element naming the target
  | 'type-ref' // a type annotation, base class or struct field type
  | 'reference' // any other identifier use
  | 'request' // the client code making an HTTP request
  | 'route' // the server route declaration the request matched
  | 'mount' // a router mount that adds a prefix (include_router, app.use, Group)
  | 'constant' // a constant a URL or prefix was resolved through
  | 'orm'; // an ORM relationship or foreign key

export interface EdgeEvidence {
  source: EdgeEvidenceSource;
  /** File node id the evidence sits in, e.g. "web/src/lib/api.ts". */
  file: string;
  /** 1-based line. */
  line: number;
  /** That line of code, trimmed and capped at 200 characters. */
  code?: string;
  /** What this piece shows, e.g. "prefix /api/v1" or "matched GET /api/v1/items/{id}". */
  note?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Short evidence: imported names, the matched route, etc. */
  detail?: string;
  /** Proven by the code or guessed. Absent only on graphs from older indexers. */
  basis?: EdgeBasis;
  /** 0..1: how sure the indexer is that the link is real. */
  confidence?: number;
  /** One line on how the link was made, e.g. "request matched the route's tail; the /api/v1 prefix wasn't found". */
  reason?: string;
  /** Supporting code, strongest first: the use site, then the import, route or mount it went through. */
  evidence?: EdgeEvidence[];
}

export type RepoStatus = 'queued' | 'cloning' | 'indexing' | 'ready' | 'error';

/** Where a repository's files come from: cloned, read in place, or uploaded from the map. */
export type RepoKind = 'git' | 'local' | 'upload';

export interface RepoInfo {
  id: string;
  name: string;
  /** What the user typed (a git URL or an absolute local path), or an uploaded folder's name. */
  source: string;
  kind: RepoKind;
  status: RepoStatus;
  error?: string;
  commit?: string;
  /** An uploaded folder's `origin` remote, from its .git metadata, with any credentials removed. */
  remote?: string;
  /** The branch an uploaded folder had checked out. */
  branch?: string;
  /** When the folder was last uploaded. */
  uploadedAt?: string;
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
  /** The suggestions are the signed-in person's own GitHub repositories, worth offering after the first import too. */
  ownSuggestions?: boolean;
  project: {
    id: string;
    /** Where the project's grouping is stored, e.g. a file path. */
    groupingLocation: string;
    /** Set when the stored grouping failed to validate; the last good one is still in use. */
    groupingError?: string;
  };
  /** Sorting the project's leftovers with Claude. */
  sorting: SortingState;
  /** What this indexer lets clients do. */
  access: {
    /** Local folders can be imported (only on an indexer bound to your own machine, by default). */
    localPaths: boolean;
    /** Changes (imports, grouping, agent events) need the indexer's access key. */
    keyRequired: boolean;
  };
  /** Who this project belongs to, on an indexer people sign in to. */
  account?: AccountInfo;
  /** How to upload a folder: what to send and how much. Absent from indexers that predate uploads. */
  upload?: UploadPolicy;
}

/** Someone signed in with GitHub, as the map shows them. */
export interface AccountInfo {
  login: string;
  name?: string;
  /** Their GitHub avatar's URL. */
  avatar?: string;
  /** GitHub let Fiada read their private repositories. */
  privateRepos: boolean;
}

/** GET /api/auth: whether this indexer needs a sign-in, and who is signed in. */
export interface AuthState {
  /** "github": everyone signs in and has a project of their own. "off": one shared project, no sign-in. */
  mode: 'github' | 'off';
  account?: AccountInfo;
}

/** GET /api/auth/agent: what an agent needs to report to this person's map. */
export interface AgentConnection {
  /** The indexer's URL, as agents should reach it. */
  url: string;
  /** The person's agent token; absent when the indexer needs none. */
  token?: string;
}

/**
 * What a folder upload may carry. The map sends only the files the indexer
 * reads, so an upload is the folder's source, never its build output,
 * dependencies or git history.
 */
export interface UploadPolicy {
  /** Most bytes of files in one upload, before compression. */
  maxBytes: number;
  /** Most files in one upload. */
  maxFiles: number;
  /** Regular expression (source) over a folder-relative path: the files worth sending. .gitignore files go too. */
  files: string;
  /** Folder names never sent, wherever they are. */
  skipDirs: string[];
}

// ── Agent activity ──
//
// Coding agents (Claude Code, Cursor, Codex, anything that speaks MCP) report
// what they're working on and which files they change. Events come from the
// agent's MCP server (`@fiadatech/agent`, when the agent calls its tools) and
// from its tool hooks (deterministically, after every edit). The indexer maps
// changed files to graph nodes and pushes the result to the map.

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** One coding agent in one working tree. */
export interface AgentRef {
  /** "claude-code", "cursor", "codex", or the name an MCP client gives itself. */
  client: string;
  /** The agent's own session id, when it has one. */
  session?: string;
  /** Absolute directory the agent runs in. */
  cwd: string;
  /** Git top level of `cwd`, when it's a checkout. */
  root?: string;
  /** URL of that checkout's `origin` remote. */
  remote?: string;
  /**
   * The reporting process's nearest ancestor pids, nearest first. An MCP
   * server that isn't told its session (Claude Code tells it) shares a
   * parent with that session's hooks, which tells the indexer which it is.
   */
  procs?: number[];
}

/** A 1-based inclusive line range; `[n, n - 1]` marks lines removed just before line n. */
export type LineRange = [start: number, end: number];

export interface FileChange {
  /** Absolute, or relative to the agent's root (else cwd). */
  path: string;
  /** `reverted` clears an earlier change: the file is back to what HEAD has. */
  kind: ChangeKind | 'reverted';
  /** Changed lines in the new version of the file (from `git diff`). */
  lines?: LineRange[];
  /** The same changes, as lines of the HEAD version. */
  oldLines?: LineRange[];
  additions?: number;
  deletions?: number;
  /** Unified diff against HEAD, capped. Kept by the indexer and served on request, never pushed. */
  diff?: string;
  /** Symbol names the agent says it touched, when it reports them itself. */
  symbols?: string[];
  /** The checkout the file is in, when that isn't the agent's own (an agent editing a sibling repo). */
  checkout?: { root: string; remote?: string };
  /**
   * Found by comparing the working tree rather than named by the tool that
   * wrote it, so it may be another agent's change in the same checkout.
   */
  swept?: boolean;
}

export type StepStatus = 'pending' | 'active' | 'done';

export interface AgentStep {
  /** The agent's own id for the step (Claude Code task ids), when it has one. */
  id?: string;
  text: string;
  /** What to show while the step is active, e.g. "Running tests" for "Run tests". */
  activeText?: string;
  status: StepStatus;
}

/** What the agent is doing between tool calls. */
export type AgentState = 'working' | 'waiting' | 'ended';

/** What happened, without who: the part each hook and tool fills in. */
export type AgentEventBody =
  | { type: 'session'; phase: 'start' | 'end' }
  /** The user's latest prompt: the task until the agent names its own. */
  | { type: 'prompt'; text: string }
  /** The agent's own account of its task. `steps` replaces the plan when present; `step` marks one step active. */
  | { type: 'task'; task?: string; steps?: AgentStep[]; step?: string; state?: AgentState; note?: string }
  /** The agent's own one or two lines on what it is doing right now. */
  | { type: 'status'; text: string }
  /** One step added or updated, by id (Claude Code's TaskCreate / TaskUpdate). */
  | { type: 'step'; id: string; text?: string; activeText?: string; status?: StepStatus | 'removed' }
  | { type: 'changes'; files: FileChange[] }
  | { type: 'state'; state: AgentState };

export type AgentEvent = { agent: AgentRef; at?: string } & AgentEventBody;

/** A changed file as the map sees it. */
export interface AgentFile {
  /** Repository id when the file is in an imported repository. */
  repo?: string;
  /** Repo-relative when `repo` is set, else absolute. */
  path: string;
  /** Graph node id of the file, when it's in the graph. */
  node?: string;
  kind: ChangeKind;
  additions?: number;
  deletions?: number;
  /** Symbols the change touches, with their own change kinds. Deleted symbols have ids that are no longer in the graph. */
  /**
   * `oldLines`: for a deleted symbol, the lines it had in HEAD, so its diff is the hunks that took those away.
   * `layer`: for a deleted symbol, the layer id the map had for it, since it is read on its file.
   */
  symbols: { id: string; name: string; kind: ChangeKind; oldLines?: [number, number]; layer?: string }[];
  /** ISO time of the latest change. */
  at: string;
  /** Whether the indexer holds a diff for it. */
  diff: boolean;
}

export interface AgentActivity {
  /** Stable key: client and working tree. */
  id: string;
  client: string;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Where it's working: the imported repo's id or the folder name. */
  where: string;
  cwd: string;
  state: AgentState;
  /** The agent's own summary of its task. */
  task?: string;
  /** First line of the user's latest prompt. */
  prompt?: string;
  note?: string;
  /** What it's doing right now: the headline of its entry. */
  now?: AgentNow;
  steps: AgentStep[];
  files: AgentFile[];
  startedAt: string;
  updatedAt: string;
}

/**
 * The agent's status line. `agent` is its own words (the MCP `status` tool);
 * when it hasn't said, or its plan moved on since, the line is derived from
 * the active step of its plan, else from the user's prompt.
 */
export interface AgentNow {
  /** One or two short lines, joined by "\n". */
  text: string;
  from: 'agent' | 'plan' | 'prompt';
  /** ISO time the line was said or the step started. */
  at: string;
}

/** A node the overlay marks, directly changed or standing in for a deleted one. */
export interface NodeChange {
  kind: ChangeKind;
  /** Agent ids. */
  agents: string[];
  /** Epoch ms of the latest change, for the pulse. */
  at: number;
  /** For nodes that aren't in the graph (deleted, or not indexed yet): the nearest ancestor that is. */
  anchor?: string;
  /** 'file' or 'symbol'. */
  unit: 'file' | 'symbol';
}

export interface ActivityState {
  /** Bumps on every change. */
  version: number;
  /** The graph these node ids refer to; when it moves past the one the map has, refetch it (changed files were re-indexed). */
  graphVersion: number;
  agents: AgentActivity[];
  /** Graph node id → change: files and symbols agents touched. */
  nodes: Record<string, NodeChange>;
}

// ── Node summaries ──
//
// What a node does, at the top of its panel. Every node gets a line built
// from what the indexer knows (or the code's own doc comment), so nothing is
// ever blank; with a model key set on the indexer, a generated summary is
// written from the node's code and its neighbours, cached per project.

export type SummaryStatus =
  /** The generated summary is in `generated`. */
  | 'ready'
  /** Being written now; ask again shortly. */
  | 'pending'
  /** No model key on the indexer, so only the line. */
  | 'off'
  /** Writing it failed; `error` says why. */
  | 'error';

export interface NodeSummary {
  node: string;
  /** Always present: a sentence or two built from the graph (routes, what it defines, calls and who uses it). */
  line: string;
  /** First sentence of the code's own docstring or doc comment, when it has one. */
  doc?: string;
  /** One or two plain sentences a model wrote from the node's code and neighbours. */
  generated?: { text: string; model: string; at: string };
  status: SummaryStatus;
  error?: string;
  /** With status `off`: what turns generated summaries on, e.g. "Set ANTHROPIC_API_KEY on the indexer…". */
  off?: string;
}
