import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode } from '@strata/shared';
import { Detail } from './components/Detail.tsx';
import { MapView } from './components/MapView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { layout, WORLD } from './graph/layout.ts';
import { ancestors, buildCodeTree, buildFunctionTree, locate, type TKind, type View } from './graph/tree.ts';
import { aggregateEdges, visibleNodes, type Camera } from './graph/view.ts';
import { palette, type ColorBy } from './theme.ts';
import { useWorkspace } from './useWorkspace.ts';

const SIDEBAR = 316;

// How far "down" an open circle of each kind takes you, per view.
const ALTITUDE: Record<View, Partial<Record<TKind, number>>> = {
  code: { root: 0, repo: 1, folder: 2, file: 3, symbol: 3 },
  function: { root: 0, domain: 1, layer: 2 },
};

export function App() {
  const ws = useWorkspace();
  const graph = ws.graph;
  const [view, setView] = useState<View>('code');
  const [colorBy, setColorBy] = useState<ColorBy>('repo');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [focus, setFocus] = useState('root');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Camera & { anim: boolean }>({ k: 1, tx: 0, ty: 0, anim: false });

  const graphIndex = useMemo(() => new Map<string, GraphNode>((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const tree = useMemo(() => (graph ? (view === 'code' ? buildCodeTree(graph) : buildFunctionTree(graph)) : null), [graph, view]);
  const L = useMemo(() => (tree ? layout(tree) : new Map()), [tree]);
  const pal = useMemo(() => palette((graph?.repos ?? []).map((r) => r.id)), [graph]);

  const vis = useMemo(() => (tree ? visibleNodes(tree, L, cam, size.w, size.h) : null), [tree, L, cam, size]);
  const contracts = useMemo(
    () => (tree && graph && vis ? aggregateEdges(tree, graphIndex, graph.edges, vis) : []),
    // Re-aggregate only when the set of open circles changes, not on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, graph, graphIndex, vis?.key],
  );

  const fit = useCallback(
    (anim: boolean) => {
      if (!size.w) return;
      // Centre in the space the floating sidebar leaves free, when there's room for that.
      const side = size.w > 900 ? SIDEBAR : 0;
      const k = (Math.min(size.w - side, size.h) * 0.46) / (WORLD / 2);
      setCam({ k, tx: side + (size.w - side) / 2, ty: size.h / 2, anim });
      setFocus('root');
    },
    [size],
  );

  const focusOn = useCallback(
    (id: string, anim = true) => {
      if (!tree || id === 'root') return fit(anim);
      const n = tree.nodes.get(id);
      const c = L.get(id);
      if (!n || !c) return;
      // Leaves zoom to their parent's scale so there's context around them.
      const frame = n.children.length ? c : (L.get(n.parent ?? 'root') ?? c);
      const k = (Math.min(size.w, size.h) * 0.36) / frame.r;
      setCam({ k, tx: size.w / 2 - c.x * k, ty: size.h / 2 - c.y * k, anim });
      setFocus(id);
    },
    [tree, L, size, fit],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedEdge(null);
      if (!id || !tree) return setSelected(null);
      const at = locate(tree, graphIndex, id);
      if (!at) return;
      setSelected(at);
      focusOn(at);
    },
    [tree, graphIndex, focusOn],
  );

  // Fit when the map first gets a size or the graph is replaced; keep the
  // selection in view when switching between Code and By function.
  const lastTree = useRef(tree);
  const sized = size.w > 0;
  useEffect(() => {
    if (!sized || !tree) return;
    const viewChanged = lastTree.current && lastTree.current.view !== tree.view;
    lastTree.current = tree;
    if (viewChanged && selected) {
      const at = locate(tree, graphIndex, selected);
      if (at) {
        setSelected(at);
        return focusOn(at);
      }
    }
    if (selected && !tree.nodes.has(selected)) setSelected(null);
    if (viewChanged || focus === 'root' || !tree.nodes.has(focus)) fit(viewChanged ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, sized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setSelectedEdge(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedVisible = useMemo(() => {
    if (!selected || !tree || !vis) return null;
    const shown = new Set(vis.list.map((n) => n.id));
    let cur: string | null = selected;
    while (cur && !shown.has(cur)) cur = tree.nodes.get(cur)?.parent ?? null;
    return cur;
  }, [selected, tree, vis]);

  const altitude = useMemo(() => {
    if (!vis || !tree) return 0;
    let a = 0;
    for (const id of vis.open) a = Math.max(a, ALTITUDE[view][tree.nodes.get(id)?.kind ?? 'root'] ?? 0);
    return a;
  }, [vis, tree, view]);

  const contract = selectedEdge ? (contracts.find((c) => c.key === selectedEdge) ?? null) : null;
  const empty = !graph || graph.nodes.length === 0;

  return (
    <div className="app">
      <TopBar
        crumbs={tree ? ancestors(tree, focus) : []}
        view={view}
        altitude={altitude}
        zoom={cam.k / ((Math.min((size.w || 1) - (size.w > 900 ? SIDEBAR : 0), size.h || 1) * 0.46) / (WORLD / 2))}
        busy={!!ws.workspace?.busy}
        onCrumb={(id) => (id === 'root' ? (setSelected(null), fit(true)) : select(id))}
      />
      <div className="main">
        {tree && vis && (
          <MapView
            tree={tree}
            L={L}
            vis={vis}
            contracts={contracts}
            cam={cam}
            size={size}
            pal={pal}
            colorBy={colorBy}
            selectedVisible={selectedVisible}
            selectedEdge={selectedEdge}
            onResize={(w, h) => setSize({ w, h })}
            onCamera={(c) => setCam({ ...c, anim: false })}
            onSelect={select}
            onSelectEdge={(key) => {
              setSelectedEdge(key);
              if (key) setSelected(null);
            }}
          />
        )}
        {empty && (
          <div className="empty">
            <div className="empty-title">Map a codebase</div>
            <p>
              Import one or more repositories from the sidebar. Strata parses them, links imports, calls and HTTP routes across repos, and
              draws one map you can zoom from systems down to symbols.
            </p>
          </div>
        )}
        <Sidebar
          workspace={ws.workspace}
          offline={ws.offline}
          tree={tree}
          view={view}
          colorBy={colorBy}
          pal={pal}
          selected={selected}
          onView={setView}
          onColorBy={setColorBy}
          onSelect={select}
          onAdd={ws.add}
          onRemove={ws.remove}
          onRefresh={ws.refresh}
        />
        {graph && tree && (selected || contract) && (
          <Detail graph={graph} graphIndex={graphIndex} tree={tree} pal={pal} selected={selected} contract={contract} onSelect={select} />
        )}
        <Legend colorBy={colorBy} pal={pal} />
      </div>
    </div>
  );
}

function Legend({ colorBy, pal }: { colorBy: ColorBy; pal: ReturnType<typeof palette> }) {
  return (
    <div className="legend">
      <span className="row gap">
        <span className="swatch-line" /> in-repo
      </span>
      <span className="row gap">
        <span className="swatch-line dashed" /> cross-repo
      </span>
      {colorBy === 'layer' &&
        (['UI', 'Client', 'API', 'Services', 'Storage', 'Pipeline', 'Contracts'] as const).map((l) => (
          <span key={l} className="row gap">
            <span className="dot small" style={{ background: pal.layer(l) }} /> {l}
          </span>
        ))}
    </div>
  );
}
