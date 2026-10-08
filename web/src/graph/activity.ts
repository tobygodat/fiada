// Agents' changes placed on the tree the map is drawing: which nodes changed
// themselves, how many changes sit under each node, so a closed circle can say
// what's inside it, where an agent is working right now, and the ripple: what
// depends on a change (its callers, importers and the requests to a changed
// route), so a review can see what an edit reaches, across repositories.

import type { AgentActivity, AgentFile, ChangeKind, EdgeKind, GraphEdge, GraphNode, NodeChange } from '@fiada/shared';
import { locate, type Tree } from './tree.ts';

export interface Marks {
  /** The node itself was added, modified or deleted. */
  self: ChangeKind | null;
  /** Changes underneath, counted in the view's unit: files in Code, symbols in By function. */
  added: number;
  modified: number;
  deleted: number;
  /** Latest change at or under the node, epoch ms. */
  at: number;
  /** A working agent's latest change is this node ('self') or somewhere under it ('inside'). */
  here: 'self' | 'inside' | null;
  /**
   * Something at or under this node depends on a change it isn't part of: calls,
   * imports, renders, uses or requests a changed node. 'inferred' when every link
   * that reaches it was guessed rather than proven by the code.
   */
  reached: 'evidenced' | 'inferred' | null;
  /** How many dependents sit underneath, in the view's unit like the change counts. */
  ripple: number;
}

export type TreeActivity = Map<string, Marks>;

export const changeCount = (m: Marks) => m.added + m.modified + m.deleted;

export function rollupActivity(
  tree: Tree,
  graphIndex: Map<string, GraphNode>,
  nodes: Record<string, NodeChange>,
  agents: readonly AgentActivity[] = [],
  edges: readonly GraphEdge[] = [],
): TreeActivity {
  const out: TreeActivity = new Map();
  const get = (id: string) => {
    let m = out.get(id);
    if (!m) out.set(id, (m = { self: null, added: 0, modified: 0, deleted: 0, at: 0, here: null, reached: null, ripple: 0 }));
    return m;
  };
  const unit = tree.view === 'code' ? 'file' : 'symbol';
  for (const [id, c] of Object.entries(nodes)) {
    const own = tree.nodes.get(id);
    // A node that isn't in this tree (deleted, not re-indexed yet, or a file By function
    // shows as its symbols) counts at the nearest ancestor that is.
    const at = own ? id : locate(tree, graphIndex, c.anchor ?? id);
    if (!at) continue;
    if (own) {
      const m = get(id);
      m.self = c.kind;
      m.at = Math.max(m.at, c.at);
    }
    // Symbols in Code view mark themselves but aren't counted: the file they're in is.
    const counted = c.unit === unit || (unit === 'symbol' && !!own && !own.children.length);
    for (let cur: string | null = own ? own.parent : at; cur; cur = tree.nodes.get(cur)?.parent ?? null) {
      const m = get(cur);
      if (counted) m[c.kind]++;
      m.at = Math.max(m.at, c.at);
    }
  }

  // Where each working agent is: the file it changed last (in By function, that file's changed
  // symbols), and every circle it's inside, so a closed one can show it too.
  for (const a of agents) {
    if (a.state !== 'working' || !a.files.length) continue;
    const last = Math.max(...a.files.map((f) => Date.parse(f.at)));
    for (const f of a.files) {
      if (Date.parse(f.at) !== last) continue;
      for (const id of hereIds(f, tree)) {
        const at = tree.nodes.has(id) ? id : locate(tree, graphIndex, nodes[id]?.anchor ?? id);
        if (!at || at === tree.root.id) continue;
        get(at).here = 'self';
        for (let cur = tree.nodes.get(at)?.parent ?? null; cur && cur !== tree.root.id; cur = tree.nodes.get(cur)?.parent ?? null) {
          const m = get(cur);
          m.here ??= 'inside';
        }
      }
    }
  }

  if (edges.length) addRipple(out, get, tree, graphIndex, nodes, edges);
  return out;
}

/**
 * Whether an edge lands on something an agent changed: the node itself, or a
 * symbol in a changed file the change wasn't narrowed to symbols in (a change
 * to a file's top level reaches everything that uses the file).
 */
function changedTarget(graphIndex: Map<string, GraphNode>, nodes: Record<string, NodeChange>) {
  const narrowed = new Set<string>();
  for (const [id, c] of Object.entries(nodes)) if (c.unit === 'symbol') narrowed.add(graphIndex.get(id)?.parent ?? id.slice(0, id.indexOf('#')));
  return (id: string) => {
    if (nodes[id]) return true;
    const g = graphIndex.get(id);
    return g?.kind === 'symbol' && !!nodes[g.parent] && !narrowed.has(g.parent);
  };
}

/**
 * The ripple: every node with a link into a change marks itself `reached`, and
 * so does the file round it in Code view (where files are the unit); each
 * circle above counts the dependents inside it once. A dependent the agent
 * changed itself is already marked, so it isn't counted again, nor is a symbol
 * in a changed file counted above that file.
 */
function addRipple(
  out: TreeActivity,
  get: (id: string) => Marks,
  tree: Tree,
  graphIndex: Map<string, GraphNode>,
  nodes: Record<string, NodeChange>,
  edges: readonly GraphEdge[],
) {
  const changed = changedTarget(graphIndex, nodes);
  const isChanged = (id: string) => !!out.get(id)?.self;
  // Tree id of each dependent → whether some link proving it reaches a change.
  const dependents = new Map<string, boolean>();
  const located = new Map<string, string | null>();
  for (const e of edges) {
    if (!changed(e.to) || nodes[e.from]) continue;
    let at = located.get(e.from);
    if (at === undefined) located.set(e.from, (at = locate(tree, graphIndex, e.from)));
    if (!at || at === tree.root.id || isChanged(at)) continue;
    dependents.set(at, dependents.get(at) || e.basis !== 'inferred');
  }
  const mark = (m: Marks, sure: boolean) => {
    if (sure) m.reached = 'evidenced';
    else m.reached ??= 'inferred';
  };
  // The unit each dependent is counted as: its file in Code view, itself in By function.
  const units = new Map<string, boolean>();
  for (const [id, sure] of dependents) {
    mark(get(id), sure);
    const n = tree.nodes.get(id)!;
    const unit = tree.view === 'code' && n.kind === 'symbol' ? n.parent : id;
    if (!unit || unit === tree.root.id || isChanged(unit)) continue;
    units.set(unit, units.get(unit) || sure);
  }
  for (const [id, sure] of units) {
    if (id !== tree.root.id) mark(get(id), sure);
    for (let cur = tree.nodes.get(id)?.parent ?? null; cur && cur !== tree.root.id; cur = tree.nodes.get(cur)?.parent ?? null) {
      const m = get(cur);
      m.ripple++;
      mark(m, sure);
    }
  }
}

/** The changes one agent made, out of every agent's. */
export function agentNodes(nodes: Record<string, NodeChange>, agentId: string): Record<string, NodeChange> {
  const out: Record<string, NodeChange> = {};
  for (const [id, c] of Object.entries(nodes)) if (c.agents.includes(agentId)) out[id] = c;
  return out;
}

/** One agent's changes on the map: the circles that stand for them, and those plus every circle round them. */
export interface Spotlight {
  /** Tree ids of the changed nodes (for a deleted one, the nearest circle that's left), parents before children. */
  targets: string[];
  /** The targets and all their ancestors: what stays lit while the rest of the map dims. */
  lit: Set<string>;
}

export function spotlight(tree: Tree, graphIndex: Map<string, GraphNode>, nodes: Record<string, NodeChange>, agentId: string): Spotlight | null {
  const targets = new Set<string>();
  for (const [id, c] of Object.entries(nodes)) {
    if (!c.agents.includes(agentId)) continue;
    const at = tree.nodes.has(id) ? id : locate(tree, graphIndex, c.anchor ?? id);
    if (at && at !== tree.root.id) targets.add(at);
  }
  if (!targets.size) return null;
  const lit = new Set<string>();
  for (const id of targets) {
    for (let cur: string | null = id; cur && !lit.has(cur); cur = tree.nodes.get(cur)?.parent ?? null) lit.add(cur);
  }
  const depth = (id: string) => tree.nodes.get(id)?.depth ?? 0;
  return { targets: [...targets].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1)), lit };
}

/** The ids that stand for a changed file in this view. */
function hereIds(f: AgentFile, tree: Tree): string[] {
  const file = f.node ?? (f.repo ? `${f.repo}/${f.path}` : null);
  if (tree.view !== 'code') {
    const symbols = f.symbols.map((s) => s.id).filter((id) => tree.nodes.has(id));
    if (symbols.length) return symbols;
  }
  return file ? [file] : [];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "2 files changed: 1 added, 1 modified" for a tooltip. */
export function describeMarks(m: Marks, view: Tree['view']): string {
  const parts: string[] = [];
  if (m.here) parts.push(m.here === 'self' ? 'an agent is working here' : 'an agent is working inside');
  if (m.self) parts.push(m.self);
  const n = changeCount(m);
  if (n) {
    const kinds = (['added', 'modified', 'deleted'] as const).filter((k) => m[k]).map((k) => `${m[k]} ${k}`);
    parts.push(`${plural(n, view === 'code' ? 'file' : 'symbol')} changed inside: ${kinds.join(', ')}`);
  }
  return parts.join(' · ');
}

const KIND_VERB: Record<EdgeKind, [string, string]> = {
  calls: ['calls', 'call'],
  renders: ['renders', 'render'],
  imports: ['imports', 'import'],
  type: ['uses', 'use'],
  references: ['uses', 'use'],
  http: ['calls', 'call'],
};

/** What a changed node is, as the last word of its sentence: "this route", "this type". */
function thing(g: GraphNode): string {
  if (g.kind === 'file') return 'file';
  switch (g.symbolKind) {
    case 'interface':
    case 'type':
      return 'type';
    case 'class':
    case 'component':
    case 'enum':
      return g.symbolKind;
    case 'variable':
      return 'value';
    default:
      return 'function';
  }
}

/** "web", "web and api", "web, api and jobs". */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Who reaches a node, in a sentence or two for its panel: "23 requests from
 * web call this route", "6 functions in api and 2 in jobs use this type". It
 * counts the links into the node (into a file, also into its symbols) from
 * outside it, by repository; requests one per request, everything else one
 * per node on the other side. For a file whose change `nodes` narrows to some
 * of its symbols, only links to the file and those symbols count, as on the
 * map. Says how many were guessed. Empty when nothing
 * reaches it and it isn't a contract (a route, or an exported symbol or file).
 */
export function reachSentences(g: GraphNode, edges: readonly GraphEdge[], graphIndex: Map<string, GraphNode>, nodes: Record<string, NodeChange> = {}): string[] {
  const inside = (id: string) => id === g.id || (g.kind === 'file' && id.startsWith(`${g.id}#`));
  // A file whose change was narrowed to some of its symbols reaches what the map rings: links to
  // the file itself and to those symbols, not to the symbols the agent left alone.
  const touched = g.kind === 'file' ? Object.keys(nodes).filter((id) => nodes[id].unit === 'symbol' && id.startsWith(`${g.id}#`)) : [];
  const target = touched.length ? (id: string) => id === g.id || touched.includes(id) : inside;
  const requests: GraphEdge[] = [];
  // One per dependent: its strongest link, and whether any link from it is proven.
  const users = new Map<string, { kind: EdgeKind; sure: boolean }>();
  for (const e of edges) {
    if (!target(e.to) || inside(e.from)) continue;
    if (e.kind === 'http') {
      requests.push(e);
      continue;
    }
    const u = users.get(e.from);
    if (!u) users.set(e.from, { kind: e.kind, sure: e.basis !== 'inferred' });
    else {
      if (RANK[e.kind] < RANK[u.kind]) u.kind = e.kind;
      u.sure ||= e.basis !== 'inferred';
    }
  }
  const repoName = (id: string) => {
    const r = graphIndex.get(id)?.repo ?? id.split('/')[0];
    return graphIndex.get(r)?.name ?? r;
  };
  /** "23 from web and 4 from api", most first. */
  const byRepo = (ids: string[], noun: [string, string], prep: string) => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(repoName(id), (counts.get(repoName(id)) ?? 0) + 1);
    const groups = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return andList(groups.map(([repo, n], i) => `${n}${i ? '' : ` ${noun[n === 1 ? 0 : 1]}`} ${prep} ${repo}`));
  };
  const guessed = (n: number, total: number) => (n ? (n === total ? (total === 1 ? ', inferred' : ', all inferred') : `, ${n} of them inferred`) : '');

  const out: string[] = [];
  if (requests.length) {
    // The routes the requests reach: in a file, the symbols serving them; a symbol may serve several.
    const routes = g.kind === 'file' ? new Set(requests.map((e) => e.to)).size : (g.routes?.length ?? 1);
    const verb = requests.length === 1 ? 'calls' : 'call';
    const what = routes > 1 ? 'these routes' : 'this route';
    out.push(`${byRepo(requests.map((e) => e.from), ['request', 'requests'], 'from')} ${verb} ${what}${guessed(requests.filter((e) => e.basis === 'inferred').length, requests.length)}.`);
  }
  if (users.size) {
    const ids = [...users.keys()];
    const kinds = ids.map((id) => graphIndex.get(id));
    const noun: [string, string] = kinds.every((n) => n?.kind === 'file')
      ? ['file', 'files']
      : kinds.every((n) => n?.kind === 'symbol' && (n.symbolKind === 'function' || n.symbolKind === undefined))
        ? ['function', 'functions']
        : kinds.every((n) => n?.kind === 'symbol' && n.symbolKind === 'component')
          ? ['component', 'components']
          : ['place', 'places'];
    // The verb of the strongest kind most of them share.
    const tally = new Map<EdgeKind, number>();
    for (const u of users.values()) tally.set(u.kind, (tally.get(u.kind) ?? 0) + 1);
    const kind = [...tally].sort((a, b) => b[1] - a[1] || RANK[a[0]] - RANK[b[0]])[0][0];
    // A file's symbols are called, but the file itself is used or imported.
    const verb = KIND_VERB[g.kind === 'file' && kind !== 'imports' ? 'references' : kind][users.size === 1 ? 0 : 1];
    const unsure = [...users.values()].filter((u) => !u.sure).length;
    out.push(`${byRepo(ids, noun, 'in')} ${verb} this ${thing(g)}${guessed(unsure, users.size)}.`);
  }
  if (!out.length && (g.routes?.length || g.exported)) out.push(`Nothing in the imported repositories reaches this ${g.routes?.length ? 'route' : thing(g)} yet.`);
  // Sentences start with a capital.
  return out.map((s) => s[0].toUpperCase() + s.slice(1));
}

/** Strongest kind of link first, as the detail panel lists them. */
const RANK: Record<EdgeKind, number> = { http: 0, calls: 1, renders: 2, references: 3, type: 4, imports: 5 };
