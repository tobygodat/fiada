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
  /** A deleted function's lines before the change, so its diff is the hunks that took those away. */
  old?: [number, number];
  /** With `rest`: the same for each deleted function in it. */
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
  const fileOf = (s: TourStop) => (s.id.includes('#') ? s.id.slice(0, s.id.indexOf('#')) : null);
  for (const s of out) {
    const f = fileOf(s);
    if (!f) continue;
    const l = fns.get(f);
    if (l) l.push(s.id);
    else fns.set(f, [s.id]);
  }
  const marked = new Set<string>();
  return out.map((s) => {
    const f = fileOf(s);
    if (!f || marked.has(f)) return s;
    marked.add(f);
    const old = Object.fromEntries(out.filter((x) => x.old && fileOf(x) === f).map((x) => [x.id, x.old!]));
    return { ...s, rest: fns.get(f)!, ...(Object.keys(old).length && { restOld: old }) };
  });
}

/** Whether the agent changed anything the map can show, so a tour has somewhere to go. */
export const reviewable = (graphIndex: Map<string, GraphNode>, agent: AgentActivity, nodes: Record<string, NodeChange>) =>
  collect(graphIndex, agent, nodes).length > 0;

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
  const layerOf = (id: string) => {
    for (let cur: string | undefined = id; cur; cur = graphIndex.get(cur)?.parent) {
      const n = graphIndex.get(cur);
      if (n?.layer) return n.layer.id;
    }
    const n = graphIndex.get(id);
    if (n?.kind !== 'folder' && n?.kind !== 'repo') return null;
    return [...tally(id, new Map())].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
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
      for (const s of f.symbols) {
        const live = s.kind !== 'deleted' && graphIndex.has(s.id);
        const target = live ? s.id : stand;
        if (!target) continue;
        // A deleted function is read on its file but keeps its own layer, which may not be the file's,
        // while the project still has that layer (Unlayered it always has, though it isn't listed).
        const kept = !live && s.layer && (s.layer === UNLAYERED || layers?.has(s.layer)) ? s.layer : null;
        const layer = kept ?? layerOf(target);
        add({ ...base, id: s.id, target, name: s.name, kind: s.kind, layer, at, ...(s.kind === 'deleted' && s.oldLines && { old: s.oldLines }) });
      }
    } else if (stand) {
      add({ ...base, id: file, target: stand, name: f.path.slice(f.path.lastIndexOf('/') + 1), kind: f.kind, layer: layerOf(stand), at });
    }
  }
  return stops;
}

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
  const line = (s: TourStop) => s.old?.[0] ?? graphIndex.get(s.target)?.lines?.[0] ?? 0;
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
  const byId = new Map<string, number[]>();
  const put = (id: string, i: number) => {
    const l = byId.get(id);
    if (!l) byId.set(id, [i]);
    else if (!l.includes(i)) l.push(i);
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
  for (const e of graph.edges) {
    for (const a of stopsOf(e.from)) {
      for (const b of stopsOf(e.to)) {
        if (a === b || layerRank(stops[a]) > layerRank(stops[b])) continue;
        next[a].add(b);
        waits[b].add(a);
      }
    }
  }

  const loop = loops(next);
  // Counted once and kept up as stops are read, so each step looks at each stop once: how many
  // changed callers each stop still waits on, and how many from outside each loop still wait on it.
  const waiting = waits.map((w) => w.size);
  const outside = new Map<number, number>();
  const leftIn = new Map<number, number>();
  stops.forEach((_, j) => {
    leftIn.set(loop[j], (leftIn.get(loop[j]) ?? 0) + 1);
    for (const w of waits[j]) if (loop[w] !== loop[j]) outside.set(loop[j], (outside.get(loop[j]) ?? 0) + 1);
  });
  // What's left, in tie order (layers first): sorted once, and each stop taken out as it's read.
  const ranks = stops.map(layerRank);
  const left = stops.map((_, i) => i).sort(before);
  const out: number[] = [];
  let last = -1;
  // The loop being read, until every stop in it is.
  let inLoop = -1;
  while (out.length < stops.length) {
    // The earliest layer with anything left goes first, whatever is ready further in.
    const top = ranks[left[0]];
    let end = 1;
    while (end < left.length && ranks[left[end]] === top) end++;
    const layer = left.slice(0, end);
    const open = layer.filter((i) => loop[i] === inLoop);
    if (!open.length) inLoop = -1;
    const pool = open.length ? open : layer;
    // Inside a loop: what's ready in it first, else any of it (only its own stops wait on it).
    // Otherwise any stop or loop of calls that nothing outside it still waits on (one always is:
    // loops called from loops can't go round), a loop on a par with a single ready stop, so the
    // order decides between them; a loop's stops then all follow, before what it calls.
    const ready = open.length ? open.filter((i) => waiting[i] === 0) : [];
    const here = ready.length ? ready : pool.filter((i) => !outside.get(loop[i]));
    const follow = last >= 0 ? here.filter((i) => next[last].has(i)) : [];
    const pick = (follow.length ? follow : here)[0];
    left.splice(left.indexOf(pick), 1);
    out.push(pick);
    last = pick;
    leftIn.set(loop[pick], leftIn.get(loop[pick])! - 1);
    for (const j of next[pick]) {
      waiting[j]--;
      if (loop[j] !== loop[pick]) outside.set(loop[j], outside.get(loop[j])! - 1);
    }
    if (inLoop < 0 && leftIn.get(loop[pick])! > 0) inLoop = loop[pick];
  }
  return out.map((i) => stops[i]);
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

/** Read marks: for each stop id, the change time it was read at. */
export type ReadMarks = Record<string, number>;

/** Read, and not changed again since. */
export const isRead = (marks: ReadMarks, s: TourStop) => (marks[s.id] ?? -1) >= s.at;

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
