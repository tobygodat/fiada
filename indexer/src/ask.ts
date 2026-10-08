// What a coding agent can ask the map: where a feature, symbol, file or route
// lives; who calls, imports, renders or requests something, with the code that
// proves each link; and what an edit to it reaches, following dependents
// outward across files and repositories. Answers read the same graph the map
// draws, so a link here is a link there, evidence and all.
//
// The agent package's MCP server calls these through GET /api/agent/find,
// /dependents and /impact; everything here is pure over one graph.

import {
  UNLAYERED,
  UNSORTED_DOMAIN,
  type Ambiguous,
  type Dependent,
  type DependentsAnswer,
  type FindAnswer,
  type GraphEdge,
  type GraphNode,
  type ImpactAnswer,
  type NodeRef,
  type Reached,
} from '@fiada/shared';
import type { GraphIndex } from './summaries/describe.ts';

/** Most hits, dependents and reached nodes one answer lists. */
export const MAX_LIMIT = 100;
/** How far impact follows dependents, at most. */
export const MAX_DEPTH = 6;

/** Lowercase letters and digits only: "createItem", "create_item" and "create-item" all read "createitem". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const layerName = (gi: GraphIndex, id?: string) => (id && id !== UNLAYERED ? (gi.graph.layers.find((l) => l.id === id)?.name ?? id) : 'Unlayered');
const domainName = (gi: GraphIndex, id?: string) => (id && id !== UNSORTED_DOMAIN ? (gi.graph.domains.find((d) => d.id === id)?.name ?? id) : 'Unsorted');

/** A node as answers name it. */
export function nodeRef(gi: GraphIndex, n: GraphNode): NodeRef {
  const placed = n.kind === 'file' || n.kind === 'symbol';
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    repo: n.repo,
    ...(n.path ? { path: n.path } : {}),
    ...(n.symbolKind ? { symbolKind: n.symbolKind } : {}),
    ...(n.lines ? { lines: n.lines } : {}),
    ...(placed ? { layer: layerName(gi, n.layer?.id), domain: domainName(gi, n.domain?.id) } : {}),
    ...(n.routes?.length ? { routes: n.routes } : {}),
  };
}

/** A whole number within [lo, hi], or the fallback when it isn't one. */
export function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

// ── find ──

const KIND_BONUS: Record<GraphNode['kind'], number> = { symbol: 3, file: 2, folder: 1, repo: 0 };

/**
 * How well a node matches a query, 0 for not at all. The whole query against
 * the name counts most (exact, then prefix, then inside it), then a route it
 * serves; otherwise every word must turn up in its name, path, routes, layer
 * or domain, and words in the name count more.
 */
export function matchScore(gi: GraphIndex, n: GraphNode, query: string): number {
  const q = squash(query);
  if (!q) return 0;
  const name = squash(n.name);
  const bonus = KIND_BONUS[n.kind] + (n.exported ? 1 : 0);
  if (name === q) return 100 + bonus;
  if (name.startsWith(q)) return 70 + bonus;
  if (name.includes(q)) return 50 + bonus;
  const routes = (n.routes ?? []).map((r) => r.toLowerCase());
  const lowered = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (routes.some((r) => r === lowered || r.endsWith(` ${lowered}`))) return 90 + bonus;
  if (routes.some((r) => r.includes(lowered))) return 60 + bonus;
  const words = query.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).map(squash).filter((w) => w.length > 1);
  if (!words.length) return 0;
  const placed = n.kind === 'file' || n.kind === 'symbol';
  const hay = [n.name, n.path ?? '', ...routes, placed ? layerName(gi, n.layer?.id) : '', placed ? domainName(gi, n.domain?.id) : ''].map(squash);
  let score = 0;
  for (const w of words) {
    if (name.includes(w)) score += 10;
    else if (hay.some((h) => h.includes(w))) score += 4;
    else return 0;
  }
  return score + bonus;
}

/** Where a feature, symbol, file or route lives: the best matches, best first. */
export function find(gi: GraphIndex, query: string, limit = 10, summaryOf?: (id: string) => string | undefined): FindAnswer {
  const scored: { n: GraphNode; s: number }[] = [];
  for (const n of gi.graph.nodes) {
    const s = matchScore(gi, n, query);
    if (s > 0) scored.push({ n, s });
  }
  // Ties: what more code uses first, then the shorter id.
  const used = (n: GraphNode) => gi.in.get(n.id)?.length ?? 0;
  scored.sort((a, b) => b.s - a.s || used(b.n) - used(a.n) || a.n.id.length - b.n.id.length || (a.n.id < b.n.id ? -1 : 1));
  const top = scored.slice(0, limit);
  return {
    query,
    hits: top.map(({ n }) => {
      const summary = summaryOf?.(n.id);
      return { ...nodeRef(gi, n), ...(summary ? { summary } : {}) };
    }),
    more: scored.length - top.length,
  };
}

// ── naming a target ──

/**
 * The node a target names: a node id, a repo-relative path (or the end of
 * one), `path#symbol`, or a bare name. Anything that names more than one node
 * comes back as candidates to choose from.
 */
export function resolveTarget(gi: GraphIndex, target: string): { node: GraphNode } | Ambiguous {
  const t = target.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  const ambiguous = (nodes: GraphNode[]): Ambiguous => ({ target: null, query: target, candidates: nodes.slice(0, 10).map((n) => nodeRef(gi, n)) });
  const one = (nodes: GraphNode[]) => (nodes.length === 1 ? { node: nodes[0] } : nodes.length ? ambiguous(nodes) : null);
  const exact = gi.byId.get(t);
  if (exact) return { node: exact };
  if (!t) return ambiguous([]);

  const hash = t.indexOf('#');
  const pathPart = hash >= 0 ? t.slice(0, hash) : t;
  const symbol = hash >= 0 ? t.slice(hash + 1) : '';
  // Files and folders whose path is the target, or ends with it at a folder boundary.
  const byPath = (kinds: GraphNode['kind'][]) =>
    gi.graph.nodes.filter((n) => kinds.includes(n.kind) && n.path && (n.path === pathPart || `${n.repo}/${n.path}` === pathPart || n.path.endsWith(`/${pathPart}`)));
  if (hash >= 0) {
    const files = byPath(['file']);
    const syms = files.flatMap((f) => (gi.children.get(f.id) ?? []).filter((c) => c.kind === 'symbol' && (c.name === symbol || c.id.endsWith(`#${symbol}`))));
    const hit = one(syms);
    if (hit) return hit;
  } else {
    const hit = one(byPath(['file'])) ?? one(byPath(['folder']));
    if (hit) return hit;
    const repo = gi.graph.nodes.find((n) => n.kind === 'repo' && (n.id === t || n.name === t));
    if (repo) return { node: repo };
    const named = gi.graph.nodes.filter((n) => n.kind === 'symbol' && n.name === t);
    const hitName = one(named) ?? one(gi.graph.nodes.filter((n) => n.kind === 'symbol' && n.name.toLowerCase() === t.toLowerCase()));
    if (hitName) return hitName;
  }
  // Nothing by name or path: the best search matches, when one stands out. A path#symbol says where
  // the symbol is, so one by that name somewhere else is only offered, never answered for.
  const found = find(gi, symbol || pathPart, 10);
  const nodes = found.hits.map((h) => gi.byId.get(h.id)!).filter(Boolean);
  if (hash < 0 && nodes.length && matchScore(gi, nodes[0], t) >= 100 && (nodes.length === 1 || matchScore(gi, nodes[1], t) < 100)) return { node: nodes[0] };
  return ambiguous(nodes);
}

// ── who uses it ──

/** The node and everything inside it. */
function within(gi: GraphIndex, id: string): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) for (const c of gi.children.get(stack.pop()!) ?? []) if (!out.has(c.id)) (out.add(c.id), stack.push(c.id));
  return out;
}

/** Edges into `inside` from code outside it. */
function edgesInto(gi: GraphIndex, inside: Set<string>): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const id of inside) for (const e of gi.in.get(id) ?? []) if (!inside.has(e.from)) out.push(e);
  return out;
}

const strength = (e: GraphEdge) => (e.basis === 'inferred' ? 0 : 1) + (e.confidence ?? 0.5);

/** Who calls, imports, renders or requests the target (or code inside it), each with the lines that prove it. */
export function dependents(gi: GraphIndex, target: GraphNode, limit = 25): DependentsAnswer {
  const inside = within(gi, target.id);
  const byFrom = new Map<string, GraphEdge[]>();
  for (const e of edgesInto(gi, inside)) {
    const list = byFrom.get(e.from);
    if (list) list.push(e);
    else byFrom.set(e.from, [e]);
  }
  const all: Dependent[] = [];
  for (const [from, edges] of byFrom) {
    const n = gi.byId.get(from);
    if (!n) continue;
    edges.sort((a, b) => strength(b) - strength(a));
    all.push({
      ...nodeRef(gi, n),
      links: edges.map((e) => ({
        kind: e.kind,
        to: e.to,
        ...(e.basis ? { basis: e.basis } : {}),
        ...(e.confidence != null ? { confidence: e.confidence } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        evidence: (e.evidence ?? []).slice(0, 3).map((v) => ({ file: v.file, line: v.line, ...(v.code ? { code: v.code } : {}) })),
      })),
      crossRepo: n.repo !== target.repo,
    });
  }
  // Proven links first, then the ones with more of them, then by place.
  const proven = (d: Dependent) => (d.links.some((l) => l.basis !== 'inferred') ? 1 : 0);
  all.sort((a, b) => proven(b) - proven(a) || b.links.length - a.links.length || (a.id < b.id ? -1 : 1));
  const shown = all.slice(0, limit);
  return { target: nodeRef(gi, target), dependents: shown, more: all.length - shown.length };
}

// ── what an edit reaches ──

/**
 * What an edit to the target reaches: its dependents, their dependents, and so
 * on out to `depth` links, breadth first, so each node is listed at the
 * shortest distance it is reached. A file that uses the target passes it on to
 * whatever uses that file or the code in it; a symbol passes it on to whatever
 * uses that symbol. Links cross repositories wherever the graph has them (HTTP
 * requests matched to routes, shared packages).
 */
export function impact(gi: GraphIndex, target: GraphNode, depth = 3, limit = 50): ImpactAnswer {
  const seen = new Set<string>(within(gi, target.id));
  const reached: Reached[] = [];
  let frontier = [...seen];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    // A whole frontier at once, so a node reached two ways counts at its shorter distance.
    const into = new Set<string>(frontier);
    for (const id of frontier) {
      const n = gi.byId.get(id);
      // A file passes the change on through the code inside it.
      if (n?.kind === 'file' && d > 1) for (const c of gi.children.get(id) ?? []) into.add(c.id);
    }
    for (const e of edgesInto(gi, into)) {
      if (seen.has(e.from)) continue;
      const n = gi.byId.get(e.from);
      if (!n) continue;
      seen.add(e.from);
      next.push(e.from);
      reached.push({ ...nodeRef(gi, n), depth: d, via: e.to, link: e.kind, ...(e.basis ? { basis: e.basis } : {}), crossRepo: n.repo !== target.repo });
    }
    frontier = next;
  }
  const count = (key: (r: Reached) => string) => {
    const out: Record<string, number> = {};
    for (const r of reached) out[key(r)] = (out[key(r)] ?? 0) + 1;
    return out;
  };
  // Nearest first; across repositories first within a distance, since those are the ones easiest to miss.
  reached.sort((a, b) => a.depth - b.depth || Number(b.crossRepo) - Number(a.crossRepo) || (a.id < b.id ? -1 : 1));
  const shown = reached.slice(0, limit);
  return {
    target: nodeRef(gi, target),
    depth,
    reached: shown,
    more: reached.length - shown.length,
    byRepo: count((r) => r.repo),
    byLayer: count((r) => r.layer ?? 'Unlayered'),
    byDomain: count((r) => r.domain ?? 'Unsorted'),
  };
}

// ── the routes ──

export type Question = 'find' | 'dependents' | 'impact';
export const QUESTIONS: readonly Question[] = ['find', 'dependents', 'impact'];

/**
 * One read route's answer, as a status and body: GET /api/agent/find?q=,
 * /dependents?node= and /impact?node=&depth=, each with an optional &limit=.
 * A target that names several nodes answers 200 with `target: null` and the
 * candidates; one that names none answers 404.
 */
export function answer(gi: GraphIndex, q: Question, query: Record<string, unknown>, brief?: (id: string) => string | undefined): { status: number; body: unknown } {
  if (q === 'find') {
    const text = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
    if (!text) return { status: 400, body: { error: 'Query must be ?q=<name, path, route or feature>' } };
    return { status: 200, body: find(gi, text, clampInt(query.limit, 10, 1, MAX_LIMIT), brief) };
  }
  const target = typeof query.node === 'string' ? query.node.trim().slice(0, 500) : '';
  if (!target) return { status: 400, body: { error: 'Query must be ?node=<node id, path, path#symbol or name>' } };
  const r = resolveTarget(gi, target);
  if (!('node' in r)) {
    if (!r.candidates.length) return { status: 404, body: { error: `Nothing on the map matches "${target}".`, ...r } };
    return { status: 200, body: r };
  }
  if (q === 'dependents') return { status: 200, body: dependents(gi, r.node, clampInt(query.limit, 25, 1, MAX_LIMIT)) };
  return { status: 200, body: impact(gi, r.node, clampInt(query.depth, 3, 1, MAX_DEPTH), clampInt(query.limit, 50, 1, MAX_LIMIT)) };
}
