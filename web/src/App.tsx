import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode } from '@fiada/shared';
import { canEdit } from './api.ts';
import { AgentQueue } from './components/AgentQueue.tsx';
import { Detail } from './components/Detail.tsx';
import { MapView } from './components/MapView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { TourBar } from './components/TourBar.tsx';
import { agentNodes, rollupActivity, spotlight } from './graph/activity.ts';
import { enclose, frame, freeArea, type Camera, type Viewport } from './graph/camera.ts';
import { layout, layoutExpanded, type Circle } from './graph/layout.ts';
import { loadMarks, nextUnread, saveMarks, tourStops, type ReadMarks } from './graph/tour.ts';
import { ancestors, buildCodeTree, buildFunctionTree, locate, type TKind, type Tree, type View } from './graph/tree.ts';
import {
  aggregateEdges,
  clickAction,
  expandedNodes,
  indexEdges,
  meetingPoint,
  withCollapsed,
  withPathOpen,
  withPathsOpen,
  type ExpandMode,
  type Visible,
} from './graph/view.ts';
import type { MapRenderer, Scene } from './render/renderer.ts';
import { palette, type ColorBy } from './theme.ts';
import { useAgents } from './useAgents.ts';
import { useTheme } from './useTheme.ts';
import { useWorkspace } from './useWorkspace.ts';

// What the floating panels cover, from the window's edge: the 16px inset plus
// --fiada-sidebar and --fiada-detail in styles.css.
const SIDEBAR = 16 + 312;
const DETAIL = 16 + 372;
/** Click mode never zooms past this for you (a symbol is then about 30px across); scroll goes further. */
const CLICK_MAX_K = 3.5;
/** Lighting an agent's changes opens the way down to them only while that opens at most this many circles. */
const OPEN_CAP = 16;

// How far "down" an open circle of each kind takes you, per view.
const ALTITUDE: Record<View, Partial<Record<TKind, number>>> = {
  code: { root: 0, repo: 1, folder: 2, file: 3, symbol: 3 },
  function: { root: 0, domain: 1, layer: 2 },
};

const MODE_KEY = 'strata.expandMode';
const readMode = (): ExpandMode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'zoom' ? 'zoom' : 'click';
  } catch {
    return 'click';
  }
};

/** What a new map opens with: repositories open so their top-level modules show, unless there are many. */
function defaultExpanded(tree: Tree): Set<string> {
  const repos = tree.root.children.filter((c) => c.kind === 'repo');
  return new Set(repos.length && repos.length <= 4 ? repos.map((r) => r.id) : []);
}

const NO_LAYOUT = new Map<string, Circle>();

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** One step of navigation, so Back can return to it. */
interface Place {
  view: View;
  expanded: Record<View, Set<string> | null>;
  selected: string | null;
  selectedEdge: string | null;
  focus: string;
  cam: Camera | null;
}

type CameraIntent = { focus: string; detail: boolean; from?: string | null } | { fit: string[] } | { cam: Camera };

export function App() {
  const ws = useWorkspace();
  const agents = useAgents();
  const [theme, setTheme, shownTheme] = useTheme();
  const graph = ws.graph;
  const [view, setView] = useState<View>('code');
  const [mode, setModeState] = useState<ExpandMode>(readMode);
  const [colorBy, setColorBy] = useState<ColorBy>('layer');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [focus, setFocus] = useState('root');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [expandedBy, setExpandedBy] = useState<Record<View, Set<string> | null>>({ code: null, function: null });
  const [zoomVis, setZoomVis] = useState<Visible | null>(null);
  const [from, setFrom] = useState<Map<string, Circle> | undefined>();
  const [history, setHistory] = useState<Place[]>([]);
  /** The agent whose changes are lit on the map, picked in the agents window. */
  const [litAgent, setLitAgent] = useState<string | null>(null);
  /** The review tour: whose changes, and the one you're on. */
  const [tour, setTour] = useState<{ agent: string; stop: string } | null>(null);
  const [marks, setMarks] = useState<ReadMarks>({});
  const renderer = useRef<MapRenderer | null>(null);
  const intent = useRef<CameraIntent | null>(null);

  const graphIndex = useMemo(() => new Map<string, GraphNode>((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const tree = useMemo(() => (graph ? (view === 'code' ? buildCodeTree(graph) : buildFunctionTree(graph)) : null), [graph, view]);
  const expanded = useMemo(() => (tree ? (expandedBy[view] ?? defaultExpanded(tree)) : new Set<string>()), [tree, expandedBy, view]);
  const staticL = useMemo(() => (tree && mode === 'zoom' ? layout(tree) : null), [tree, mode]);
  const clickL = useMemo(() => (tree && mode === 'click' ? layoutExpanded(tree, expanded) : null), [tree, mode, expanded]);
  const L = (mode === 'zoom' ? staticL : clickL) ?? NO_LAYOUT;
  const clickVis = useMemo(() => (tree && mode === 'click' ? expandedNodes(tree, expanded) : null), [tree, mode, expanded]);
  const vis = mode === 'click' ? clickVis : zoomVis;
  const edgeIndex = useMemo(() => (tree && graph ? indexEdges(tree, graphIndex, graph.edges) : null), [tree, graph, graphIndex]);
  const contracts = useMemo(
    () => (edgeIndex && vis ? aggregateEdges(edgeIndex, vis) : []),
    // Re-aggregate only when the set of open circles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edgeIndex, vis?.key],
  );
  const pal = useMemo(
    () =>
      palette(
        (graph?.repos ?? []).map((r) => r.id),
        (graph?.layers ?? []).map((l) => l.id),
      ),
    // A new palette on a theme switch re-renders every swatch drawn from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, shownTheme],
  );

  const lit = litAgent && agents.state?.agents.some((a) => a.id === litAgent) ? litAgent : null;
  const spot = useMemo(
    () => (tree && lit && agents.state ? spotlight(tree, graphIndex, agents.state.nodes, lit) : null),
    [tree, graphIndex, agents.state, lit],
  );
  // The tour walks the lit agent's changes; lighting another agent, or none, ends it.
  const touring = tour && tour.agent === lit && spot ? tour : null;
  const tourAgent = touring ? agents.state?.agents.find((a) => a.id === touring.agent) : undefined;
  const stops = useMemo(
    () => (graph && tourAgent && agents.state ? tourStops(graph, graphIndex, tourAgent, agents.state.nodes) : []),
    [graph, graphIndex, tourAgent, agents.state],
  );
  const tourAt = touring ? Math.max(0, stops.findIndex((s) => s.id === touring.stop)) : -1;
  const project = ws.workspace?.project.id ?? 'local';

  const activity = useMemo(() => {
    const s = agents.state;
    if (!tree || !s) return null;
    // One agent lit: the map marks only its changes.
    const nodes = spot && lit ? agentNodes(s.nodes, lit) : s.nodes;
    if (!Object.keys(nodes).length) return null;
    return rollupActivity(tree, graphIndex, nodes, spot ? s.agents.filter((a) => a.id === lit) : s.agents);
  }, [tree, graphIndex, agents.state, spot, lit]);

  // Agents' changes were re-indexed: fetch the new graph now rather than at the next poll.
  const reload = ws.reload;
  const agentGraph = agents.state?.graphVersion;
  const loadedGraph = ws.workspace?.graphVersion;
  useEffect(() => {
    if (agentGraph != null && loadedGraph != null && agentGraph > loadedGraph) void reload();
  }, [agentGraph, loadedGraph, reload]);

  const scene = useMemo<Scene | null>(
    () => (tree ? { tree, L, mode, vis: mode === 'click' ? clickVis : null, contracts, pal, colorBy, selected, selectedEdge, activity, lit: spot?.lit ?? null } : null),
    [tree, L, mode, clickVis, contracts, pal, colorBy, selected, selectedEdge, activity, spot],
  );

  // ── camera ──

  const viewport = useCallback(
    (detail: boolean): Viewport => ({ w: size.w, h: size.h, left: size.w > 900 ? SIDEBAR : 0, right: detail && size.w > 1100 ? DETAIL : 0 }),
    [size],
  );

  /**
   * Where the camera goes to show `id`. Click mode shows the whole map when
   * that leaves the node big enough, and otherwise the node and the place you
   * came from (`from`) together when they fit, so following a dependency
   * keeps both ends on screen.
   */
  const cameraFor = useCallback(
    (Lx: Map<string, Circle>, id: string, opts: { detail: boolean; from?: string | null }): Camera | null => {
      const root = Lx.get('root');
      if (!tree || !root || !size.w) return null;
      const vp = viewport(opts.detail);
      const all = frame(root, vp, 0.46);
      const n = tree.nodes.get(id);
      const c = Lx.get(id);
      if (!n || !c || id === 'root') return all;
      // Leaves are framed with their parent around them.
      const target = n.children.length ? c : (Lx.get(n.parent ?? 'root') ?? c);
      if (mode === 'zoom') return frame(target, vp, 0.36);
      if (target.r * all.k >= 0.2 * freeArea(vp).side) return all;
      const own = frame(target, vp, 0.36, CLICK_MAX_K);
      const prev = opts.from && opts.from !== id ? tree.nodes.get(opts.from) : null;
      const pc = prev && (prev.children.length ? Lx.get(prev.id) : Lx.get(prev.parent ?? ''));
      if (pc) {
        const both = frame(enclose(target, pc), vp, 0.44, CLICK_MAX_K);
        if (both.k >= own.k * 0.3) return both;
      }
      return own;
    },
    [tree, mode, size, viewport],
  );

  /** Where the camera goes to show all of `ids` at once, clear of the agents window on the right. */
  const cameraForAll = useCallback(
    (Lx: Map<string, Circle>, ids: readonly string[]): Camera | null => {
      if (!tree || !size.w) return null;
      // What stands for each on the map: itself, or the nearest circle round it that's laid out; a leaf with its parent round it.
      const around = new Set<string>();
      for (const id of ids) {
        let n = tree.nodes.get(id);
        while (n && !Lx.has(n.id)) n = n.parent ? tree.nodes.get(n.parent) : undefined;
        if (n) around.add(n.children.length || !n.parent ? n.id : n.parent);
      }
      // All in one circle: framed the way selecting it would.
      if (around.size <= 1) return around.size ? cameraFor(Lx, [...around][0], { detail: true }) : null;
      const box = [...around].map((id) => Lx.get(id)!).reduce(enclose);
      return mode === 'zoom' ? frame(box, viewport(true), 0.36) : frame(box, viewport(true), 0.44, CLICK_MAX_K);
    },
    [tree, size, mode, cameraFor, viewport],
  );

  const fitAll = useCallback(
    (anim: boolean) => {
      const r = renderer.current;
      const cam = cameraFor(L, 'root', { detail: false });
      if (!r || !cam) return;
      if (anim) r.animateTo(cam, 'smooth');
      else r.setCamera(cam);
    },
    [cameraFor, L],
  );

  // Camera moves that wait for the layout they depend on.
  useEffect(() => {
    const want = intent.current;
    const r = renderer.current;
    if (!want || !r || !size.w) return;
    intent.current = null;
    const cam = 'cam' in want ? want.cam : 'fit' in want ? cameraForAll(L, want.fit) : cameraFor(L, want.focus, want);
    if (cam) r.animateTo(cam, from ? 'direct' : 'smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L]);

  /** Pans, without zooming, just enough to bring `id` out from under the panels. */
  const reveal = useCallback(
    (id: string) => {
      const r = renderer.current;
      const c = L.get(id);
      if (!r || !c) return;
      const cam = r.camera;
      const f = freeArea(viewport(true));
      const margin = 24;
      const shift = (s: number, sr: number, lo: number, hi: number) => {
        const pad = Math.min(sr + margin, (hi - lo) / 2);
        return s < lo + pad ? lo + pad - s : s > hi - pad ? hi - pad - s : 0;
      };
      const sr = c.r * cam.k;
      const dx = shift(cam.tx + c.x * cam.k, sr, f.cx - f.w / 2, f.cx + f.w / 2);
      const dy = shift(cam.ty + c.y * cam.k, sr, 0, f.h);
      if (Math.abs(dx) + Math.abs(dy) >= 1) r.animateTo({ k: cam.k, tx: cam.tx + dx, ty: cam.ty + dy }, 'direct', 380);
    },
    [L, viewport],
  );

  // ── navigation ──

  const remember = useCallback(() => {
    const place: Place = { view, expanded: expandedBy, selected, selectedEdge, focus, cam: renderer.current?.camera ?? null };
    setHistory((h) => [...h.slice(-49), place]);
  }, [view, expandedBy, selected, selectedEdge, focus]);

  /** Open `next` (click mode), then bring `focusId` into view. */
  const go = useCallback(
    (next: Set<string> | null, focusId: string, opts: { detail: boolean; from?: string | null }) => {
      setFocus(focusId);
      if (next && !sameSet(next, expanded)) {
        setFrom(L);
        setExpandedBy((e) => ({ ...e, [view]: next }));
        intent.current = { focus: focusId, ...opts };
      } else {
        const cam = cameraFor(L, focusId, opts);
        if (cam) renderer.current?.animateTo(cam, 'smooth');
      }
    },
    [expanded, L, view, cameraFor],
  );

  /** Select something from anywhere (the map, the outline, the detail panel) and bring it into view. */
  const select = useCallback(
    (id: string | null) => {
      setSelectedEdge(null);
      if (!id || !tree) return setSelected(null);
      const at = locate(tree, graphIndex, id);
      if (!at || at === 'root') return;
      remember();
      setSelected(at);
      // Coming from a selection (a dependency or contract end in the detail panel): keep it in view too.
      const opts = { detail: true, from: selected ?? focus };
      // Click mode opens the way to it but not the node itself: that's a second click, as on the map.
      if (mode === 'click') go(withPathOpen(tree, expanded, at, false), at, opts);
      else go(null, at, opts);
    },
    [tree, graphIndex, mode, expanded, go, remember, selected, focus],
  );

  const onNodeClick = useCallback(
    (id: string, open: boolean) => {
      if (!tree) return;
      const n = tree.nodes.get(id);
      if (!n) return;
      setSelectedEdge(null);
      // Between the top-level circles is empty space, not "the workspace".
      if (id === 'root') return setSelected(null);
      if (mode === 'zoom') return select(id);
      const action = clickAction(n, selected, open);
      if (action === 'none') return;
      remember();
      if (action === 'open') return go(withPathOpen(tree, expanded, id, true), id, { detail: true });
      // First click: select it and show its details, moving the view only if the panel would cover it.
      setSelected(id);
      reveal(id);
    },
    [tree, mode, selected, expanded, go, select, remember, reveal],
  );

  const collapse = useCallback(
    (id: string) => {
      if (!tree) return;
      if (mode === 'zoom') return select(id);
      remember();
      setSelectedEdge(null);
      setSelected(id);
      go(withCollapsed(tree, expanded, id), tree.nodes.get(id)?.parent ?? 'root', { detail: true });
    },
    [tree, mode, expanded, go, select, remember],
  );

  /** Breadcrumb: back out to `id`, closing everything opened below it. */
  const crumb = useCallback(
    (id: string) => {
      if (!tree) return;
      if (id === 'root') {
        remember();
        setSelected(null);
        setSelectedEdge(null);
        if (mode === 'click') return go(defaultExpanded(tree), 'root', { detail: false });
        setFocus('root');
        return fitAll(true);
      }
      if (mode === 'zoom') return select(id);
      remember();
      setSelectedEdge(null);
      setSelected(id);
      go(withPathOpen(tree, withCollapsed(tree, expanded, id), id, true), id, { detail: true });
    },
    [tree, mode, expanded, go, select, fitAll, remember],
  );

  const back = useCallback(() => {
    const place = history[history.length - 1];
    if (!place) return;
    setHistory((h) => h.slice(0, -1));
    setView(place.view);
    setSelected(place.selected);
    setSelectedEdge(place.selectedEdge);
    setFocus(place.focus);
    if (place.view === view && place.expanded !== expandedBy) setFrom(L);
    setExpandedBy(place.expanded);
    if (place.cam) {
      if (place.view === view && place.expanded === expandedBy) renderer.current?.animateTo(place.cam, 'smooth');
      else intent.current = { cam: place.cam };
    }
  }, [history, view, expandedBy, L]);

  const setMode = (m: ExpandMode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // private mode: the choice lasts for this tab only
    }
    setFrom(undefined);
    setZoomVis(null);
    setHistory([]);
    intent.current = { focus: selected && tree?.nodes.has(selected) ? selected : 'root', detail: !!selected };
    setModeState(m);
  };

  /** From the task queue: a changed file or symbol, or for one that's gone, the circle standing in for it. */
  const selectChange = useCallback(
    (id: string, agentId: string) => {
      // Another agent's changes are lit: light this one's, so what you picked isn't the one thing dimmed.
      if (litAgent && litAgent !== agentId) setLitAgent(agentId);
      select(graphIndex.has(id) ? id : (agents.state?.nodes[id]?.anchor ?? id));
    },
    [select, graphIndex, agents.state, litAgent],
  );

  /**
   * From the agents window: light up everything one agent changed and every
   * circle round it, dim the rest, open the way down to the changes (click
   * mode, while that stays small) and bring them all into view. The same
   * agent again puts the map back.
   */
  const showAgent = useCallback(
    (id: string) => {
      if (spot && lit === id) return setLitAgent(null);
      const s = tree && agents.state ? spotlight(tree, graphIndex, agents.state.nodes, id) : null;
      if (!tree || !s) return;
      setLitAgent(id);
      remember();
      setSelected(null);
      setSelectedEdge(null);
      setFocus(s.targets.reduce((m, t) => meetingPoint(tree, m, t)));
      if (mode === 'click') {
        const next = withPathsOpen(tree, expanded, s.targets, OPEN_CAP);
        if (!sameSet(next, expanded)) {
          setFrom(L);
          setExpandedBy((e) => ({ ...e, [view]: next }));
          intent.current = { fit: s.targets };
          return;
        }
      }
      const cam = cameraForAll(L, s.targets);
      if (cam) renderer.current?.animateTo(cam, 'smooth');
    },
    [spot, lit, tree, agents.state, graphIndex, remember, mode, expanded, L, view, cameraForAll],
  );

  /** Esc and a click on empty space: end the review first, then let go of the selection, then of the lit agent. */
  const clear = useCallback(() => {
    if (touring) setTour(null);
    else if (selected || selectedEdge) {
      setSelected(null);
      setSelectedEdge(null);
    } else setLitAgent(null);
  }, [touring, selected, selectedEdge]);

  /**
   * From the agents window: walk through one agent's changes in the order
   * data flows, starting at the first you haven't read. Its changes are lit
   * and each stop is selected as you go, so the map opens the way to it and
   * the detail panel shows its summary and diff.
   */
  const startTour = useCallback(
    (id: string) => {
      const a = agents.state?.agents.find((x) => x.id === id);
      if (!graph || !a || !agents.state) return;
      const list = tourStops(graph, graphIndex, a, agents.state.nodes);
      if (!list.length) return;
      const m = loadMarks(project, id);
      const i = Math.max(0, nextUnread(list, m));
      setMarks(m);
      setLitAgent(id);
      setTour({ agent: id, stop: list[i].id });
      select(list[i].target);
    },
    [agents.state, graph, graphIndex, project, select],
  );

  const goStop = useCallback(
    (i: number) => {
      const s = stops[i];
      if (!touring || !s) return;
      setTour({ agent: touring.agent, stop: s.id });
      select(s.target);
    },
    [stops, touring, select],
  );

  /** Mark a change read (and go on to the next you haven't read) or unread again. */
  const markRead = useCallback(
    (i: number, read: boolean) => {
      const s = stops[i];
      if (!touring || !s) return;
      const next = { ...marks };
      if (read) next[s.id] = s.at;
      else delete next[s.id];
      setMarks(next);
      saveMarks(project, touring.agent, next);
      if (!read) return;
      const after = nextUnread(stops, next, i + 1);
      if (after >= 0 && after !== i) goStop(after);
    },
    [stops, touring, marks, project, goStop],
  );

  // Picking one of the tour's changes on the map or in the outline takes the tour there too.
  useEffect(() => {
    if (!touring || !selected || stops[tourAt]?.target === selected) return;
    const s = stops.find((x) => x.target === selected);
    if (s) setTour({ agent: touring.agent, stop: s.id });
  }, [selected, touring, stops, tourAt]);

  // Fit when the map first gets a size or a graph arrives; keep the selection
  // in view when switching between Code and By function.
  const lastTree = useRef(tree);
  const sized = size.w > 0;
  useEffect(() => {
    if (!sized || !tree) return;
    const prev = lastTree.current;
    lastTree.current = tree;
    setFrom(undefined);
    const viewChanged = !!prev && prev.view !== tree.view;
    if (viewChanged && selected) {
      const at = locate(tree, graphIndex, selected);
      if (at && at !== 'root') {
        setSelected(at);
        setFocus(at);
        if (mode === 'click') {
          const next = withPathOpen(tree, expanded, at, false);
          if (!sameSet(next, expanded)) {
            setExpandedBy((e) => ({ ...e, [tree.view]: next }));
            intent.current = { focus: at, detail: true };
            return;
          }
        }
        const cam = cameraFor(L, at, { detail: true });
        if (cam) renderer.current?.animateTo(cam, 'smooth');
        return;
      }
    }
    if (selected && (viewChanged || !tree.nodes.has(selected))) setSelected(null);
    if (viewChanged) setSelectedEdge(null);
    // A rebuilt graph with the same repositories (an agent's edit was re-indexed) leaves the camera where you put it.
    const reposChanged = !prev || prev.root.children.map((c) => c.id).join('\n') !== tree.root.children.map((c) => c.id).join('\n');
    if (viewChanged || !prev || (focus === 'root' && reposChanged) || !tree.nodes.has(focus)) {
      setFocus('root');
      fitAll(viewChanged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, sized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape') {
        clear();
      } else if (!typing && (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft'))) {
        e.preventDefault();
        back();
      } else if (e.key === 'Enter' && selected && !typing && !el?.closest('button, a, select')) {
        // Same as clicking the selected circle again.
        onNodeClick(selected, !!clickVis?.open.has(selected));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back, selected, onNodeClick, clickVis, clear]);

  const altitude = useMemo(() => {
    if (!vis || !tree) return 0;
    let a = 0;
    for (const id of vis.open) a = Math.max(a, ALTITUDE[view][tree.nodes.get(id)?.kind ?? 'root'] ?? 0);
    return a;
  }, [vis, tree, view]);

  const contract = selectedEdge ? (contracts.find((c) => c.key === selectedEdge) ?? null) : null;
  const empty = !graph || graph.nodes.length === 0;
  const fitK = useMemo(() => {
    const root = L.get('root');
    return root && size.w ? frame(root, viewport(false), 0.46).k : 1;
  }, [L, size.w, viewport]);

  // Zoom mode has no "opened" place: the breadcrumb follows the camera, to the
  // innermost open circle under the middle of the free area.
  const detailOpen = !!(selected || contract);
  const crumbsAt = useMemo(() => {
    if (mode !== 'zoom' || !tree || !zoomVis) return null;
    return (cam: Camera) => {
      const f = freeArea(viewport(detailOpen));
      const x = (f.cx - cam.tx) / cam.k;
      const y = (f.cy - cam.ty) / cam.k;
      // The deepest open circle under the middle that is big enough on screen to be where you are.
      const minR = (f.side * 0.3) / cam.k;
      let here = tree.root;
      for (const id of zoomVis.open) {
        const n = tree.nodes.get(id);
        const c = L.get(id);
        if (n && c && n.depth > here.depth && c.r >= minR && (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r ** 2) here = n;
      }
      return ancestors(tree, here.id);
    };
  }, [mode, tree, zoomVis, L, viewport, detailOpen]);

  return (
    <div className="app">
      <TopBar
        crumbs={tree ? ancestors(tree, focus) : []}
        crumbsAt={crumbsAt}
        view={view}
        altitude={altitude}
        renderer={renderer}
        fitK={fitK}
        busy={!!ws.workspace?.busy}
        canGoBack={history.length > 0}
        onBack={back}
        onCrumb={crumb}
      />
      <div className="main">
        <MapView
          scene={scene}
          from={from}
          renderer={renderer}
          panels={viewport(!!(selected || contract))}
          events={{
            node: onNodeClick,
            tab: collapse,
            edge: (key) => {
              remember();
              setSelectedEdge((cur) => (cur === key ? null : key));
              setSelected(null);
            },
            empty: clear,
            visible: (v) => mode === 'zoom' && setZoomVis(v),
            resize: (w, h) => setSize({ w, h }),
          }}
        />
        {empty && (
          <div className="empty">
            <div className="empty-title">map a codebase</div>
            <p>
              Import one or more repositories from the sidebar. Fiada parses them, links imports, calls and HTTP routes across repos, and
              draws one map you can open from systems down to symbols.
            </p>
          </div>
        )}
        <Sidebar
          workspace={ws.workspace}
          graph={graph}
          offline={ws.offline}
          tree={tree}
          view={view}
          mode={mode}
          colorBy={colorBy}
          theme={theme}
          pal={pal}
          selected={selected}
          onView={setView}
          onTheme={setTheme}
          onMode={setMode}
          onColorBy={setColorBy}
          onSelect={select}
          onAdd={ws.add}
          onUpload={ws.upload}
          onRemove={ws.remove}
          onRefresh={ws.refresh}
          onPreset={ws.applyPreset}
          onSortAgain={ws.sortAgain}
        />
        {graph && tree && (selected || contract) && (
          <Detail
            graph={graph}
            graphIndex={graphIndex}
            tree={tree}
            pal={pal}
            colorBy={colorBy}
            selected={selected}
            contract={contract}
            activity={agents.state}
            onSelect={select}
          />
        )}
        <AgentQueue
          state={agents.state}
          compact={!!(selected || contract)}
          lit={spot ? lit : null}
          reviewing={touring?.agent ?? null}
          onShow={showAgent}
          onReview={startTour}
          onSelect={selectChange}
          onClear={
            canEdit(ws.workspace)
              ? (id) => {
                  if (id === litAgent) setLitAgent(null);
                  void agents.clear(id);
                }
              : undefined
          }
        />
        {touring && tourAgent && (
          <TourBar
            agent={tourAgent.name}
            stops={stops}
            at={tourAt}
            marks={marks}
            layers={graph?.layers ?? []}
            besideDetail={detailOpen}
            onGo={goStop}
            onRead={markRead}
            onEnd={() => setTour(null)}
          />
        )}
        {!empty && !touring && (
          <Legend
            colorBy={colorBy}
            pal={pal}
            layers={graph?.layers ?? []}
            mode={mode}
            besideDetail={detailOpen}
            lit={spot ? (agents.state?.agents.find((a) => a.id === lit)?.name ?? 'an agent') : null}
          />
        )}
      </div>
    </div>
  );
}

function Legend({
  colorBy,
  pal,
  layers,
  mode,
  besideDetail,
  lit,
}: {
  colorBy: ColorBy;
  pal: ReturnType<typeof palette>;
  layers: { id: string; name: string }[];
  mode: ExpandMode;
  besideDetail: boolean;
  /** Name of the agent whose changes are lit. */
  lit: string | null;
}) {
  const hint = lit
    ? `showing what ${lit} changed · esc for the whole map`
    : mode === 'click'
      ? 'point at a circle for its links · click for details, again to open it · scroll to zoom'
      : 'point at a circle for its links · scroll to zoom and open circles';
  return (
    <div className={`legend${besideDetail ? ' beside-detail' : ''}`}>
      <span>{hint}</span>
      <span className="row gap">
        <span className="swatch-line" /> in-repo
      </span>
      <span className="row gap">
        <span className="swatch-line dashed" /> cross-repo
      </span>
      <span className="row gap">
        <span className="swatch-line dotted" /> inferred
      </span>
      {colorBy === 'layer' &&
        layers.map((l) => (
          <span key={l.id} className="row gap">
            <span className="dot small" style={{ background: pal.layer(l.id) }} /> {l.name}
          </span>
        ))}
    </div>
  );
}
