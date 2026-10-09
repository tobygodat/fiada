// A review tour: one agent's changes as a walk across the map, one stop per
// changed function (or per file, when no function in it changed), in the
// order data flows through the project: the project's layers from the user
// inwards (page, client, route, table), and inside a layer caller before
// callee along the links between the changed code, so each stop reads on
// from the one before. What you've read is remembered per stop, until the
// agent changes that code again.

import { UNLAYERED, type AgentActivity, type ChangeKind, type Graph, type GraphNode, type NodeChange } from '@fiada/shared';

export interface TourStop {
  /** The changed file or function: the stop's identity, and its read mark's. */
  id: string;
  /** What to select for it: itself, or for something deleted, the circle standing in for it. */
  target: string;
  name: string;
  /** Repo-relative path of its file. */
  path: string;
  repo: string;
  kind: ChangeKind;
  /** Layer id, or null when it has none. */
  layer: string | null;
  /** Epoch ms of the agent's latest change to it. */
  at: number;
  /**
   * On the first of a file's function stops: every changed function in that file (deleted ones
   * too), so this stop also shows the file's hunks none of them accounts for (an import, a
   * constant) and none is skipped.
   */
  rest?: string[];
  /**
   * A function's lines before the change: a deleted one's diff is the hunks that took those away,
   * and a changed one's also takes the hunk that removed it from there when it moved far.
   */
  old?: [number, number];
  /** With `rest`: the same for each function in it. */
  restOld?: Record<string, [number, number]>;
}

/**
 * Every change one agent made, as stops in reading order. Changes the map
 * can't show (outside the imported repositories) are left out.
 */
export function tourStops(
  graph: Pick<Graph, 'edges' | 'layers'>,
  graphIndex: Map<string, GraphNode>,
  agent: AgentActivity,
  nodes: Record<string, NodeChange>,
): TourStop[] {
  const out = order(collect(graphIndex, agent, nodes, new Set(graph.layers.map((l) => l.id))), graph, graphIndex);
  // The first function stop of each file carries the file's other hunks.
  const fns = new Map<string, string[]>();
  // And each one's lines before the change, gathered in the same pass.
  const olds = new Map<string, Record<string, [number, number]>>();
  const fileOf = (s: TourStop) => (s.id.includes('#') ? s.id.slice(0, s.id.indexOf('#')) : null);
  for (const s of out) {
    const f = fileOf(s);
    if (!f) continue;
    const l = fns.get(f);
    if (l) l.push(s.id);
    else fns.set(f, [s.id]);
    if (s.old) {
      const o = olds.get(f);
      if (o) o[s.id] = s.old;
      else olds.set(f, { [s.id]: s.old });
    }
  }
  const marked = new Set<string>();
  return out.map((s) => {
    const f = fileOf(s);
    if (!f || marked.has(f)) return s;
    marked.add(f);
    const old = olds.get(f);
    return { ...s, rest: fns.get(f)!, ...(old && { restOld: old }) };
  });
}

/**
 * tourStops, built again only when what it reads changes: the graph, the agent's files, or the
 * circle each of them stands on (which `filesRev` follows, so a status update compares one string).
 * An agent's prompt or status (or another agent's change) brings a new activity state, and ordering
 * a large change set takes long enough to stall the map.
 */
export function tourCache(): typeof tourStops {
  let last: { graph: object; graphIndex: object; key: string; stops: TourStop[] } | null = null;
  return (graph, graphIndex, agent, nodes) => {
    // The indexer's revision of the agent's files; an older indexer's state has none, so the files themselves.
    const key = agent.filesRev
      ? `${agent.id}\n${agent.filesRev}`
      : JSON.stringify([agent.id, agent.files, agent.files.map((f) => (f.repo ? (nodes[`${f.repo}/${f.path}`]?.anchor ?? null) : null))]);
    if (last && last.graph === graph && last.graphIndex === graphIndex && last.key === key) return last.stops;
    last = { graph, graphIndex, key, stops: tourStops(graph, graphIndex, agent, nodes) };
    return last.stops;
  };
}

/**
 * The name of a stop's layer: the project's, or Unlayered, which every project has though its
 * layers don't list it (a deleted function can keep it). Null for one the project no longer has.
 */
export const layerName = (layers: readonly { id: string; name: string }[], id: string | null): string | null =>
  id == null ? null : id === UNLAYERED ? 'Unlayered' : (layers.find((l) => l.id === id)?.name ?? null);

/**
 * Whether the agent changed anything the map can show, so a tour has somewhere to go: a stop
 * `collect` would make, found without working out its layer (which for a deleted file standing on
 * its repository tallies the whole repository). Every agent's, on every status line it sends.
 */
export function reviewable(graphIndex: Map<string, GraphNode>, agent: AgentActivity, nodes: Record<string, NodeChange>): boolean {
  return agent.files.some((f) => {
    if (!f.repo) return false;
    const file = `${f.repo}/${f.path}`;
    const anchor = nodes[file]?.anchor;
    if (graphIndex.has(file) || (f.node && graphIndex.has(f.node)) || (anchor && graphIndex.has(anchor))) return true;
    return f.kind !== 'deleted' && f.symbols.some((s) => s.kind !== 'deleted' && graphIndex.has(s.id));
  });
}

/** The stops, in the order the agent's files list them. */
function collect(graphIndex: Map<string, GraphNode>, agent: AgentActivity, nodes: Record<string, NodeChange>, layers?: Set<string>): TourStop[] {
  const stops: TourStop[] = [];
  const seen = new Set<string>();
  const add = (s: TourStop) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    stops.push(s);
  };
  // A folder or repository (standing in for a deleted file) has no layer of its own: it takes the
  // one most of its files have, by lines, as the map colours it.
  let kids: Map<string, GraphNode[]> | null = null;
  const tally = (id: string, into: Map<string, number>) => {
    if (!kids) {
      kids = new Map();
      for (const n of graphIndex.values()) if (n.kind !== 'symbol') kids.get(n.parent)?.push(n) ?? kids.set(n.parent, [n]);
    }
    for (const c of kids.get(id) ?? []) {
      if (c.kind === 'file') {
        if (c.layer && c.layer.id !== UNLAYERED) into.set(c.layer.id, (into.get(c.layer.id) ?? 0) + Math.max(1, c.loc ?? 1));
      } else tally(c.id, into);
    }
    return into;
  };
  // Once per folder: thousands of deleted files can stand on the same one.
  const most = new Map<string, string | null>();
  const layerOf = (id: string) => {
    for (let cur: string | undefined = id; cur; cur = graphIndex.get(cur)?.parent) {
      const n = graphIndex.get(cur);
      if (n?.layer) return n.layer.id;
    }
    const n = graphIndex.get(id);
    if (n?.kind !== 'folder' && n?.kind !== 'repo') return null;
    if (!most.has(id)) most.set(id, [...tally(id, new Map())].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null);
    return most.get(id)!;
  };
  for (const f of agent.files) {
    if (!f.repo) continue;
    // The file's own id, even when the indexer stands it on a folder (deleted, or not indexed yet).
    const file = `${f.repo}/${f.path}`;
    // This agent's own latest change to the file: another agent's later edit doesn't unread it.
    const at = Date.parse(f.at);
    // Something gone from the map is read on the nearest circle that's left, where its diff is.
    // (Only a circle the map still has: a removed repository leaves an anchor that isn't.)
    const anchor = nodes[file]?.anchor;
    const stand = graphIndex.has(file) ? file : f.node && graphIndex.has(f.node) ? f.node : anchor && graphIndex.has(anchor) ? anchor : null;
    const base = { path: f.path, repo: f.repo };
    if (f.symbols.length && f.kind !== 'deleted') {
      for (const s of innermost(f.symbols, graphIndex)) {
        const live = s.kind !== 'deleted' && graphIndex.has(s.id);
        const target = live ? s.id : stand;
        if (!target) continue;
        // A deleted function is read on its file but keeps its own layer, which may not be the file's,
        // while the project still has that layer (Unlayered it always has, though it isn't listed).
        const kept = !live && s.layer && (s.layer === UNLAYERED || layers?.has(s.layer)) ? s.layer : null;
        const layer = kept ?? layerOf(target);
        add({ ...base, id: s.id, target, name: s.name, kind: s.kind, layer, at, ...(s.kind !== 'added' && s.oldLines && { old: s.oldLines }) });
      }
    } else if (stand) {
      add({ ...base, id: file, target: stand, name: f.path.slice(f.path.lastIndexOf('/') + 1), kind: f.kind, layer: layerOf(stand), at });
    }
  }
  return stops;
}

/**
 * A file's changed symbols less each one whose lines hold another changed one: a class whose
 * method changed (Java, C#, Kotlin and the like list both) is read at the method, and the class's
 * own other changed lines go with the file's other hunks. Live symbols are compared by their lines
 * now, and every symbol whose lines in HEAD are known by those too, so a class that lost a method
 * is read at the deleted method. One range the same as another's keeps the longer name.
 */
function innermost<T extends { id: string; kind: ChangeKind; oldLines?: [number, number] }>(symbols: T[], graphIndex: Map<string, GraphNode>): T[] {
  if (symbols.length < 2) return symbols;
  const drop = new Set<string>();
  for (const head of [false, true]) {
    const spans: { id: string; from: number; to: number }[] = [];
    for (const s of symbols) {
      const l = head ? s.oldLines : s.kind === 'deleted' ? undefined : graphIndex.get(s.id)?.lines;
      if (l && l[0] > 0) spans.push({ id: s.id, from: l[0], to: l[1] });
    }
    // Outer before inner: by start, then the longer span, then the shorter id. A stack holds the
    // spans still open, so each span is checked only against the one it may sit in.
    spans.sort((x, y) => x.from - y.from || y.to - x.to || x.id.length - y.id.length || (x.id < y.id ? -1 : 1));
    const open: { id: string; from: number; to: number }[] = [];
    for (const s of spans) {
      while (open.length && open[open.length - 1].to < s.from) open.pop();
      const outer = open[open.length - 1];
      if (outer && outer.to >= s.to) drop.add(outer.id);
      open.push(s);
    }
  }
  return drop.size ? symbols.filter((s) => !drop.has(s.id)) : symbols;
}

/** The most links one graph link makes between the stops it stands for, before it is linked in a line instead. */
const PAIRS = 4096;

/**
 * Layers first, from the user inwards; inside a layer, a stop waits for the
 * changed code that calls it, and after a stop its own callees come next.
 * Code that calls itself round in a loop is read as one: the whole loop
 * before anything it calls. Links that point back up the layers (a
 * callback, a shared type) don't hold anything back. Ties go by repository,
 * path and line, so the order is stable.
 */
function order(stops: TourStop[], graph: Pick<Graph, 'edges' | 'layers'>, graphIndex: Map<string, GraphNode>): TourStop[] {
  if (stops.length < 2) return stops;
  // The layers' own order, as the legend shows them: ranks can be partial and collide with positions.
  const rank = new Map(graph.layers.map((l, i) => [l.id, i]));
  const layerRank = (s: TourStop) => (s.layer != null ? (rank.get(s.layer) ?? graph.layers.length) : graph.layers.length + 1);
  // A deleted function stands on its file, which has no lines: its own were where HEAD had them.
  const line = (s: TourStop) => (s.kind === 'deleted' ? s.old?.[0] : undefined) ?? graphIndex.get(s.target)?.lines?.[0] ?? 0;
  const before = (a: number, b: number) => {
    const x = stops[a];
    const y = stops[b];
    return (
      layerRank(x) - layerRank(y) ||
      (x.repo < y.repo ? -1 : x.repo > y.repo ? 1 : 0) ||
      (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) ||
      line(x) - line(y) ||
      (x.id < y.id ? -1 : 1)
    );
  };

  // Which stops a graph node speaks for: its own, or a file's for the functions in it and the other way round.
  // (Each stop goes in once under its own id and at most once under its file, which is never a
  // stop's id as well: no list holds a stop twice, so none is searched.)
  const byId = new Map<string, number[]>();
  const put = (id: string, i: number) => {
    const l = byId.get(id);
    if (!l) byId.set(id, [i]);
    else l.push(i);
  };
  stops.forEach((s, i) => put(s.id, i));
  // Every function stop answers for its file's own links, unless the file is a stop itself. A
  // deleted function is gone from the graph: its file is the part of its id before the '#'.
  const own = new Set(stops.map((s) => s.id));
  stops.forEach((s, i) => {
    const n = graphIndex.get(s.id);
    const parent = n ? (n.kind === 'symbol' ? n.parent : null) : s.id.includes('#') ? s.id.slice(0, s.id.indexOf('#')) : null;
    if (parent && !own.has(parent)) put(parent, i);
  });
  // An unchanged function speaks through its file only when the file is a stop itself: its
  // changed siblings didn't write its links.
  const stopsOf = (id: string): number[] => {
    const mine = byId.get(id);
    if (mine) return mine;
    const n = graphIndex.get(id);
    return n?.kind === 'symbol' && own.has(n.parent) ? (byId.get(n.parent) ?? []) : [];
  };

  const next = stops.map(() => new Set<number>());
  const waits = stops.map(() => new Set<number>());
  const link = (a: number, b: number) => {
    if (a === b || layerRank(stops[a]) > layerRank(stops[b])) return;
    next[a].add(b);
    waits[b].add(a);
  };
  // Two files with many changed functions each: rather than a link for every pair, one gate that
  // opens once every caller is read and holds back every callee until then.
  const gates: { from: number[]; to: number[]; left: number }[] = [];
  const connect = (as: number[], bs: number[]) => {
    if (as.length * bs.length <= PAIRS) {
      for (const a of as) for (const b of bs) link(a, b);
      return;
    }
    // A link never points back up the layers: each layer of callers gates only the callees in its layer or later.
    const by = (l: number[]) => {
      const m = new Map<number, number[]>();
      for (const i of l) m.get(layerRank(stops[i]))?.push(i) ?? m.set(layerRank(stops[i]), [i]);
      return m;
    };
    const ins = by(as);
    const outs = by(bs);
    for (const [ra, from] of ins) {
      const callers = new Set(from);
      const to = [...outs].flatMap(([rb, l]) => (rb >= ra ? l : []));
      const rest = to.filter((b) => !callers.has(b));
      if (rest.length) gates.push({ from, to: rest, left: from.length });
      // A stop on both sides waits on every other caller, as a link for each pair would have it,
      // but not on itself: one gate from the callers on one side only, and those on both wait on
      // each other (a loop, read whole, as the links would make it).
      const both = to.filter((b) => callers.has(b));
      if (!both.length) continue;
      const mutual = new Set(both);
      const others = from.filter((a) => !mutual.has(a));
      if (others.length) gates.push({ from: others, to: both, left: others.length });
      if (both.length > 1) gates.push({ from: both, to: both, left: both.length });
    }
  };
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const key = `${e.from}\n${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const as = stopsOf(e.from);
    const bs = stopsOf(e.to);
    if (as.length && bs.length) connect(as, bs);
  }

  // Each gate is one more node in the walk for loops: callers link to it, it links to the callees.
  const gatesOf = stops.map(() => [] as number[]);
  gates.forEach((g, k) => g.from.forEach((a) => gatesOf[a].push(k)));
  const comp = loops([...next.map((n, i) => (gatesOf[i].length ? new Set([...n, ...gatesOf[i].map((k) => stops.length + k)]) : n)), ...gates.map((g) => new Set(g.to))]);
  const loop = comp.slice(0, stops.length);
  const gateLoop = (k: number) => comp[stops.length + k];
  // Counted once and kept up as stops are read, so each step looks at each stop once: how many
  // changed callers (or gates) each stop still waits on, and how many from outside each loop still wait on it.
  const waiting = waits.map((w) => w.size);
  const outside = new Map<number, number>();
  const leftIn = new Map<number, number>();
  stops.forEach((_, j) => {
    leftIn.set(loop[j], (leftIn.get(loop[j]) ?? 0) + 1);
    for (const w of waits[j]) if (loop[w] !== loop[j]) outside.set(loop[j], (outside.get(loop[j]) ?? 0) + 1);
  });
  // A gate in a loop of stops (a callee that calls a caller back) is a way into that loop for the
  // callers outside it, as much as the loop's own way out to the callees.
  const held = new Set(loop);
  const into = (k: number, a: number) => held.has(gateLoop(k)) && gateLoop(k) !== loop[a];
  gates.forEach((g, k) => {
    for (const a of g.from) if (into(k, a)) outside.set(gateLoop(k), (outside.get(gateLoop(k)) ?? 0) + 1);
    for (const b of g.to) {
      waiting[b]++;
      if (gateLoop(k) !== loop[b]) outside.set(loop[b], (outside.get(loop[b]) ?? 0) + 1);
    }
  });
  // Every stop's place in tie order (layers first), so the earliest of any set is the one that goes.
  const ranks = stops.map(layerRank);
  const pos = new Int32Array(stops.length);
  stops.map((_, i) => i).sort(before).forEach((i, k) => (pos[i] = k));
  const done = new Uint8Array(stops.length);
  // Each loop's stops in tie order, with a mark past the ones already read at its front.
  const members = new Map<number, number[]>();
  for (const i of [...pos.keys()].sort((a, b) => pos[a] - pos[b])) {
    const l = members.get(loop[i]);
    if (l) l.push(i);
    else members.set(loop[i], [i]);
  }
  const front = new Map<number, number>();
  const firstOf = (c: number) => {
    const l = members.get(c)!;
    let k = front.get(c) ?? 0;
    while (done[l[k]]) k++;
    front.set(c, k);
    return l[k];
  };
  // Kept up as stops are read, so no step looks over what's left: the stops nothing outside their
  // loop still waits on, and in each loop the stops nothing at all waits on, earliest first.
  const free = queue(pos, done);
  const ready = new Map<number, ReturnType<typeof queue>>();
  const readyIn = (c: number) => ready.get(c) ?? ready.set(c, queue(pos, done)).get(c)!;
  for (const [c, l] of members) if (!outside.get(c)) l.forEach(free.push);
  stops.forEach((_, j) => waiting[j] === 0 && readyIn(loop[j]).push(j));
  const out: number[] = [];
  let last = -1;
  // The callees of a gate the last stop opened.
  let opened: number[] = [];
  // The loop being read, until every stop in it is.
  let inLoop = -1;
  while (out.length < stops.length) {
    // Inside a loop (all of it in one layer): what's ready in it first, else any of it (only its
    // own stops wait on it). Otherwise any stop or loop of calls that nothing outside it still
    // waits on, in the earliest layer with anything left (one always is: loops called from loops
    // can't go round, and nothing waits on a later layer), a loop on a par with a single ready
    // stop, so the order decides between them; a loop's stops then all follow, before what it calls.
    let first: number;
    let fits: (i: number) => boolean;
    if (inLoop >= 0) {
      const r = readyIn(inLoop).first();
      const c = inLoop;
      first = r >= 0 ? r : firstOf(c);
      fits = r >= 0 ? (i) => loop[i] === c && waiting[i] === 0 : (i) => loop[i] === c;
    } else {
      first = free.first();
      const top = ranks[first];
      fits = (i) => ranks[i] === top && !outside.get(loop[i]);
    }
    // After a stop, what it calls comes next when it can (through a gate it opened too).
    let pick = -1;
    if (last >= 0) for (const j of next[last]) if (!done[j] && fits(j) && (pick < 0 || pos[j] < pos[pick])) pick = j;
    for (const j of opened) if (!done[j] && fits(j) && (pick < 0 || pos[j] < pos[pick])) pick = j;
    if (pick < 0) pick = first;
    done[pick] = 1;
    out.push(pick);
    last = pick;
    opened = [];
    leftIn.set(loop[pick], leftIn.get(loop[pick])! - 1);
    const enter = (c: number) => {
      if (outside.set(c, outside.get(c)! - 1).get(c) === 0) members.get(c)!.forEach(free.push);
    };
    const reach = (j: number, from: number) => {
      if (--waiting[j] === 0) readyIn(loop[j]).push(j);
      if (from !== loop[j]) enter(loop[j]);
    };
    for (const j of next[pick]) reach(j, loop[pick]);
    for (const k of gatesOf[pick]) {
      if (into(k, pick)) enter(gateLoop(k));
      if (--gates[k].left > 0) continue;
      for (const j of gates[k].to) reach(j, gateLoop(k));
      opened = opened.concat(gates[k].to);
    }
    if (inLoop >= 0 && leftIn.get(inLoop) === 0) inLoop = -1;
    if (inLoop < 0 && leftIn.get(loop[pick])! > 0) inLoop = loop[pick];
  }
  return out.map((i) => stops[i]);
}

/** A min-heap of stops by their place in tie order; a stop read meanwhile is passed over. */
function queue(pos: Int32Array, done: Uint8Array) {
  const h: number[] = [];
  const less = (a: number, b: number) => pos[h[a]] < pos[h[b]];
  const swap = (a: number, b: number) => ([h[a], h[b]] = [h[b], h[a]]);
  const push = (i: number) => {
    h.push(i);
    for (let k = h.length - 1; k > 0 && less(k, (k - 1) >> 1); k = (k - 1) >> 1) swap(k, (k - 1) >> 1);
  };
  const pop = () => {
    const end = h.pop()!;
    if (!h.length) return;
    h[0] = end;
    for (let k = 0; ; ) {
      const l = 2 * k + 1;
      const m = l + 1 < h.length && less(l + 1, l) ? l + 1 : l;
      if (l >= h.length || !less(m, k)) break;
      swap(k, m);
      k = m;
    }
  };
  /** The earliest stop not yet read, or -1. */
  const first = () => {
    while (h.length && done[h[0]]) pop();
    return h.length ? h[0] : -1;
  };
  return { push, first };
}

/**
 * Which loop of links each stop is in (Tarjan's strongly connected components); a stop in no loop is
 * in one of its own. Walked with a stack of its own, not by recursion: a chain of thousands of
 * changed functions would run past the call stack.
 */
export function loops(next: Set<number>[]): number[] {
  const comp = next.map(() => -1);
  const index = next.map(() => -1);
  const low = next.map(() => 0);
  const links = next.map((s) => [...s]);
  const stack: number[] = [];
  const on = new Uint8Array(next.length);
  // Each stop being walked, with how many of its links it has followed.
  const walk: [number, number][] = [];
  let n = 0;
  let c = 0;
  const enter = (v: number) => {
    index[v] = low[v] = n++;
    stack.push(v);
    on[v] = 1;
    walk.push([v, 0]);
  };
  for (let root = 0; root < next.length; root++) {
    if (index[root] >= 0) continue;
    enter(root);
    while (walk.length) {
      const at = walk[walk.length - 1];
      const v = at[0];
      if (at[1] < links[v].length) {
        const w = links[v][at[1]++];
        if (index[w] < 0) enter(w);
        else if (on[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      walk.pop();
      if (walk.length) {
        const u = walk[walk.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] !== index[v]) continue;
      for (let w = -1; w !== v; ) {
        w = stack.pop()!;
        on[w] = 0;
        comp[w] = c;
      }
      c++;
    }
  }
  return comp;
}

/**
 * Nothing left to review and nothing on the way: the map's graph is as new as the one the agents'
 * changes were placed on. (A file just added stands on its folder until it's indexed; then its
 * stops wait for the map to load the graph it's in.)
 */
export const tourOver = (stops: readonly TourStop[], agentGraph?: number, loadedGraph?: number) =>
  !stops.length && !(agentGraph != null && loadedGraph != null && agentGraph > loadedGraph);

/** Read marks: for each stop id, the change time it was read at. */
export type ReadMarks = Record<string, number>;

/** Read, and not changed again since. */
export const isRead = (marks: ReadMarks, s: TourStop) => (marks[s.id] ?? -1) >= s.at;

/** The tour's diff on screen: the stop id it's for and the change time it was fetched for (null while it loads). */
export interface ShownDiff {
  node: string;
  rev: number | null;
}

/** What a node's diff request left: its diffs, or (failed) the last ones it had while it says so. */
export interface FetchedDiffs<T> {
  node: string;
  rev: number;
  list: T[];
  failed?: true;
}

/** The change time of the node's diff on screen: null while it loads, or when the last request for it failed. */
export const shownRev = <T>(f: FetchedDiffs<T> | null, node: string) => (f?.node === node && !f.failed ? f.rev : null);

/**
 * Whether marking the stop read reads what was shown: not while its diff is loading, or while an
 * older diff of it stands in after the agent changed it again. With no diff of it on screen at all
 * (the map is on something else) there's nothing to wait for.
 */
export const diffShown = (shown: ShownDiff | null, s: TourStop) =>
  !shown || shown.node !== s.id || (shown.rev !== null && shown.rev >= s.at);

/** The first stop not read yet at or after `from`, wrapping round; -1 when every one is read. */
export function nextUnread(stops: readonly TourStop[], marks: ReadMarks, from = 0): number {
  for (let k = 0; k < stops.length; k++) {
    const i = (from + k) % stops.length;
    if (!isRead(marks, stops[i])) return i;
  }
  return -1;
}

const marksKey = (project: string, agent: string) => `fiada.tour.${project}.${agent}`;

export function loadMarks(project: string, agent: string): ReadMarks {
  try {
    const v = JSON.parse(localStorage.getItem(marksKey(project, agent)) ?? '{}');
    return v && typeof v === 'object' ? (v as ReadMarks) : {};
  } catch {
    return {};
  }
}

/** Forgets every review's read marks in this browser, as deleting an account forgets the project. */
export function forgetMarks(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const k of keys) if (k?.startsWith('fiada.tour.')) localStorage.removeItem(k);
  } catch {
    // nothing stored
  }
}

export function saveMarks(project: string, agent: string, marks: ReadMarks): void {
  try {
    localStorage.setItem(marksKey(project, agent), JSON.stringify(marks));
  } catch {
    // private mode: the marks last for this tab only
  }
}
