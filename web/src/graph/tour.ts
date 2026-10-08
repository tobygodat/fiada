// A review tour: one agent's changes as a walk across the map, one stop per
// changed function (or per file, when no function in it changed), in the
// order data flows through the project: the project's layers from the user
// inwards (page, client, route, table), and inside a layer caller before
// callee along the links between the changed code, so each stop reads on
// from the one before. What you've read is remembered per stop, until the
// agent changes that code again.

import type { AgentActivity, ChangeKind, Graph, GraphNode, NodeChange } from '@fiada/shared';

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
  const stops: TourStop[] = [];
  const seen = new Set<string>();
  const add = (s: TourStop) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    stops.push(s);
  };
  const layerOf = (id: string) => {
    for (let cur: string | undefined = id; cur; cur = graphIndex.get(cur)?.parent) {
      const n = graphIndex.get(cur);
      if (n?.layer) return n.layer.id;
    }
    return null;
  };
  for (const f of agent.files) {
    if (!f.repo) continue;
    // The file's own id, even when the indexer stands it on a folder (deleted, or not indexed yet).
    const file = `${f.repo}/${f.path}`;
    // This agent's own latest change to the file: another agent's later edit doesn't unread it.
    const at = Date.parse(f.at);
    // Something gone from the map is read on the nearest circle that's left, where its diff is.
    const stand = graphIndex.has(file) ? file : f.node && graphIndex.has(f.node) ? f.node : (nodes[file]?.anchor ?? null);
    const base = { path: f.path, repo: f.repo };
    if (f.symbols.length && f.kind !== 'deleted') {
      for (const s of f.symbols) {
        const live = s.kind !== 'deleted' && graphIndex.has(s.id);
        const target = live ? s.id : stand;
        if (target) add({ ...base, id: s.id, target, name: s.name, kind: s.kind, layer: layerOf(target), at });
      }
    } else if (stand) {
      add({ ...base, id: file, target: stand, name: f.path.slice(f.path.lastIndexOf('/') + 1), kind: f.kind, layer: layerOf(stand), at });
    }
  }
  return order(stops, graph, graphIndex);
}

/**
 * Layers first, from the user inwards; inside a layer, a stop waits for the
 * changed code that calls it, and after a stop its own callees come next.
 * Links that point back up the layers (a callback, a shared type) don't hold
 * anything back. Ties go by repository, path and line, so the order is stable.
 */
function order(stops: TourStop[], graph: Pick<Graph, 'edges' | 'layers'>, graphIndex: Map<string, GraphNode>): TourStop[] {
  if (stops.length < 2) return stops;
  // The layers' own order, as the legend shows them: ranks can be partial and collide with positions.
  const rank = new Map(graph.layers.map((l, i) => [l.id, i]));
  const layerRank = (s: TourStop) => (s.layer != null ? (rank.get(s.layer) ?? graph.layers.length) : graph.layers.length + 1);
  const line = (s: TourStop) => graphIndex.get(s.target)?.lines?.[0] ?? 0;
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
  // Every function stop answers for its file's own links, unless the file is a stop itself.
  const own = new Set(stops.map((s) => s.id));
  stops.forEach((s, i) => {
    const n = graphIndex.get(s.id);
    if (n?.kind === 'symbol' && !own.has(n.parent)) put(n.parent, i);
  });
  const stopsOf = (id: string): number[] => {
    const own = byId.get(id);
    if (own) return own;
    const n = graphIndex.get(id);
    return n?.kind === 'symbol' ? (byId.get(n.parent) ?? []) : [];
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

  const done = new Set<number>();
  const out: number[] = [];
  let last = -1;
  while (out.length < stops.length) {
    // The earliest layer with anything left goes first, whatever is ready further in.
    const left = stops.map((_, i) => i).filter((i) => !done.has(i));
    const top = Math.min(...left.map((i) => layerRank(stops[i])));
    const layer = left.filter((i) => layerRank(stops[i]) === top);
    const ready = layer.filter((i) => [...waits[i]].every((w) => done.has(w)));
    // A loop of calls: start it where the order would anyway.
    const here = ready.length ? ready : layer;
    const follow = last >= 0 ? here.filter((i) => next[last].has(i)) : [];
    const pick = (follow.length ? follow : here).sort(before)[0];
    done.add(pick);
    out.push(pick);
    last = pick;
  }
  return out.map((i) => stops[i]);
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

export function saveMarks(project: string, agent: string, marks: ReadMarks): void {
  try {
    localStorage.setItem(marksKey(project, agent), JSON.stringify(marks));
  } catch {
    // private mode: the marks last for this tab only
  }
}
