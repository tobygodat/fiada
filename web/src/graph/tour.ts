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
   * With `rest`: the file's other code and when the agent last changed it. Its read mark is kept
   * under the file's own id, so it stays read (or unread) whichever function stop shows it.
   */
  top?: { id: string; at: number };
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
  // It's new again too when the agent changes that code (an import, a constant) since.
  const top = new Map(agent.files.filter((f) => f.repo && f.topAt).map((f) => [`${f.repo}/${f.path}`, Date.parse(f.topAt!)]));
  const marked = new Set<string>();
  return out.map((s) => {
    const f = fileOf(s);
    if (!f || marked.has(f)) return s;
    marked.add(f);
    const at = top.get(f);
    const old = Object.fromEntries(out.filter((x) => x.old && fileOf(x) === f).map((x) => [x.id, x.old!]));
    return { ...s, rest: fns.get(f)!, ...(at != null && { top: { id: f, at } }), ...(Object.keys(old).length && { restOld: old }) };
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
        // while the project still has that layer.
        const layer = (!live && s.layer && layers?.has(s.layer) && s.layer) || layerOf(target);
        // The function's own change time, so editing another function in the file doesn't unread it.
        add({ ...base, id: s.id, target, name: s.name, kind: s.kind, layer, at: s.at ? Date.parse(s.at) : at, ...(s.kind === 'deleted' && s.oldLines && { old: s.oldLines }) });
      }
    } else if (stand) {
      // Only the file's other code left changed (an import): its own time, not the file's latest.
      add({ ...base, id: file, target: stand, name: f.path.slice(f.path.lastIndexOf('/') + 1), kind: f.kind, layer: layerOf(stand), at: f.topAt ? Date.parse(f.topAt) : at });
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
  const done = new Set<number>();
  const out: number[] = [];
  let last = -1;
  // The loop being read, until every stop in it is.
  let inLoop = -1;
  while (out.length < stops.length) {
    // The earliest layer with anything left goes first, whatever is ready further in.
    const left = stops.map((_, i) => i).filter((i) => !done.has(i));
    const top = Math.min(...left.map((i) => layerRank(stops[i])));
    const layer = left.filter((i) => layerRank(stops[i]) === top);
    const open = layer.filter((i) => loop[i] === inLoop);
    if (!open.length) inLoop = -1;
    const pool = open.length ? open : layer;
    // Inside a loop: what's ready in it first, else any of it (only its own stops wait on it).
    // Otherwise any stop or loop of calls that nothing outside it still waits on (one always is:
    // loops called from loops can't go round), a loop on a par with a single ready stop, so the
    // order decides between them; a loop's stops then all follow, before what it calls.
    const ready = open.length ? open.filter((i) => [...waits[i]].every((w) => done.has(w))) : [];
    const free = (c: number) => left.every((j) => loop[j] !== c || [...waits[j]].every((w) => done.has(w) || loop[w] === c));
    const here = ready.length ? ready : pool.filter((i) => free(loop[i]));
    const follow = last >= 0 ? here.filter((i) => next[last].has(i)) : [];
    const pick = (follow.length ? follow : here).sort(before)[0];
    done.add(pick);
    out.push(pick);
    last = pick;
    if (inLoop < 0 && left.some((i) => i !== pick && loop[i] === loop[pick])) inLoop = loop[pick];
  }
  return out.map((i) => stops[i]);
}

/** Which loop of links each stop is in (Tarjan's strongly connected components); a stop in no loop is in one of its own. */
function loops(next: Set<number>[]): number[] {
  const comp = next.map(() => -1);
  const index = next.map(() => -1);
  const low = next.map(() => 0);
  const stack: number[] = [];
  const on = new Set<number>();
  let n = 0;
  let c = 0;
  const visit = (v: number) => {
    index[v] = low[v] = n++;
    stack.push(v);
    on.add(v);
    for (const w of next[v]) {
      if (index[w] < 0) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (on.has(w)) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] !== index[v]) return;
    for (let w = -1; w !== v; ) {
      w = stack.pop()!;
      on.delete(w);
      comp[w] = c;
    }
    c++;
  };
  next.forEach((_, v) => index[v] < 0 && visit(v));
  return comp;
}

/** Read marks: for each stop id, the change time it was read at. */
export type ReadMarks = Record<string, number>;

/** Read, and not changed again since: the stop's own code, and the file's other code it shows. */
export const isRead = (marks: ReadMarks, s: TourStop) => (marks[s.id] ?? -1) >= s.at && (!s.top || (marks[s.top.id] ?? -1) >= s.top.at);

/** The marks with a stop read (as it is now) or unread again, the file's other code it shows with it. */
export function markStop(marks: ReadMarks, s: TourStop, read: boolean): ReadMarks {
  const next = { ...marks };
  for (const [id, at] of [[s.id, s.at], ...(s.top ? [[s.top.id, s.top.at]] : [])] as [string, number][]) {
    if (read) next[id] = at;
    else delete next[id];
  }
  return next;
}

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

export function saveMarks(project: string, agent: string, marks: ReadMarks): void {
  try {
    localStorage.setItem(marksKey(project, agent), JSON.stringify(marks));
  } catch {
    // private mode: the marks last for this tab only
  }
}
