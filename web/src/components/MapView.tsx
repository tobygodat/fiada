// The map: nested circles, aggregated contract edges, labels and edge tags.
// Purely presentational; the camera and selection live in App.

import { useEffect, useRef, type ReactElement } from 'react';
import type { Circle } from '../graph/layout.ts';
import type { TNode, Tree } from '../graph/tree.ts';
import type { Camera, Contract, Visible } from '../graph/view.ts';
import { BG, INK, type ColorBy, type Palette } from '../theme.ts';

const EASE = 'cubic-bezier(.2,.7,.2,1)';
const MAX_EDGES = 220;
const MAX_TAGS = 40;

interface Props {
  tree: Tree;
  L: Map<string, Circle>;
  vis: Visible;
  contracts: Contract[];
  cam: Camera & { anim: boolean };
  size: { w: number; h: number };
  pal: Palette;
  colorBy: ColorBy;
  /** Visible node standing in for the selection (the selection itself, or its nearest visible ancestor). */
  selectedVisible: string | null;
  selectedEdge: string | null;
  onResize(w: number, h: number): void;
  onCamera(cam: Camera): void;
  onSelect(id: string | null): void;
  onSelectEdge(key: string | null): void;
}

export function MapView(p: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const camRef = useRef(p.cam);
  camRef.current = p.cam;
  const onCamera = useRef(p.onCamera);
  onCamera.current = p.onCamera;

  useEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      p.onResize(r.width, r.height);
    });
    ro.observe(el);
    // Wheel must be non-passive to stop the page from scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const { k, tx, ty } = camRef.current;
      const nk = Math.max(0.05, Math.min(5000, k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))));
      onCamera.current({ k: nk, tx: mx - (mx - tx) * (nk / k), ty: my - (my - ty) * (nk / k) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { tree, L, vis, contracts, cam, size, pal, colorBy } = p;
  const { k, tx, ty } = cam;
  const tr = cam.anim ? `left .75s ${EASE}, top .75s ${EASE}` : 'none';

  const colorOf = (n: TNode) => {
    if (colorBy === 'layer') return (a?: number) => (n.layer ? pal.layer(n.layer, a) : pal.neutral(a));
    return (a?: number) => (n.repo ? pal.repo(n.repo, a) : pal.neutral(a));
  };

  // ── nodes ──
  const circles: ReactElement[] = [];
  const labels: ReactElement[] = [];
  for (const n of vis.list) {
    const c = L.get(n.id)!;
    const sr = c.r * k;
    const sx = tx + c.x * k;
    const sy = ty + c.y * k;
    if (sr < 0.6 || sx + sr < 0 || sx - sr > size.w || sy + sr < 0 || sy - sr > size.h) continue;
    const isOpen = vis.open.has(n.id);
    const col = colorOf(n);
    const leaf = n.kind === 'symbol' || (n.kind === 'file' && !n.children.length);
    const sel = n.id === p.selectedVisible;
    circles.push(
      <circle
        key={n.id}
        cx={c.x}
        cy={c.y}
        r={c.r}
        className="node"
        vectorEffect="non-scaling-stroke"
        style={{
          fill: isOpen ? col(0.035) : leaf ? col(0.5) : col(0.12),
          stroke: sel ? INK : isOpen ? col(0.35) : col(0.65),
          strokeWidth: sel ? 2 : 1,
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!moved.current) p.onSelect(n.id);
        }}
      />,
    );

    const big = n.kind === 'repo' || n.kind === 'domain';
    if (isOpen) {
      labels.push(
        <div key={n.id} className={`tab${big ? ' big' : ''}`} style={{ left: sx, top: sy - sr, transition: tr, background: BG, borderColor: col(0.45) }}>
          {n.name}
        </div>,
      );
    } else if (sr > 16) {
      const font = Math.max(10, Math.min(big ? 26 : 20, sr * (big ? 0.24 : 0.2)));
      const sub = big && sr > 48 ? subtitle(n) : null;
      labels.push(
        <div
          key={n.id}
          className={`label${big ? ' big' : ''}`}
          style={{ left: sx, top: sy, fontSize: font, maxWidth: sr * 1.8, transition: tr }}
        >
          <div className="label-name">{n.name}</div>
          {sub && <div className="label-sub">{sub}</div>}
        </div>,
      );
    }
  }

  // ── edges ──
  const selKey = p.selectedEdge;
  const anyEdgeSel = !!selKey && contracts.some((c) => c.key === selKey);
  const sv = p.selectedVisible;
  const paths: ReactElement[] = [];
  const tags: ReactElement[] = [];
  const onScreen = (c: Circle) => {
    const sx = tx + c.x * k;
    const sy = ty + c.y * k;
    const sr = c.r * k;
    return sx + sr > 0 && sx - sr < size.w && sy + sr > 0 && sy - sr < size.h;
  };
  // With a container selected, its internal wiring counts as "touching" it too.
  const withinMemo = new Map<string, boolean>();
  const within = (id: string): boolean => {
    if (!sv) return false;
    let hit = withinMemo.get(id);
    if (hit == null) {
      let cur: string | null = id;
      while (cur && cur !== sv) cur = tree.nodes.get(cur)?.parent ?? null;
      withinMemo.set(id, (hit = cur === sv));
    }
    return hit;
  };
  // Heaviest contracts first, but anything touching the selection always makes the cut.
  const drawn = contracts
    .filter((g) => {
      const A = L.get(g.a);
      const B = L.get(g.b);
      return A && B && (onScreen(A) || onScreen(B));
    })
    .sort((x, y) => Number(within(y.a) || within(y.b) || y.key === selKey) - Number(within(x.a) || within(x.b) || x.key === selKey))
    .slice(0, MAX_EDGES);
  // Thin the web out as it gets denser, so a zoomed-in map doesn't turn into a hairball.
  const density = Math.max(0.3, Math.min(1, 60 / Math.max(1, drawn.length)));
  drawn.forEach((g, i) => {
    const A = L.get(g.a)!;
    const B = L.get(g.b)!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const x1 = A.x + ux * A.r;
    const y1 = A.y + uy * A.r;
    const x2 = B.x - ux * B.r;
    const y2 = B.y - uy * B.r;
    const mx = (x1 + x2) / 2 - uy * d * 0.12;
    const my = (y1 + y2) / 2 + ux * d * 0.12;
    const touches = !!sv && (within(g.a) || within(g.b));
    const isSel = g.key === selKey;
    const n = g.items.length;
    const A0 = tree.nodes.get(g.a)!;
    let stroke = colorBy === 'layer' ? (A0.layer ? pal.layer(A0.layer) : pal.neutral()) : A0.repo ? pal.repo(A0.repo) : pal.neutral();
    if (isSel) stroke = INK;
    const op = sv ? (touches ? 0.95 : 0.08) : anyEdgeSel ? (isSel ? 1 : 0.08) : (g.cross ? 0.6 : 0.42) * density;
    const sw = Math.min(14, 1 + (n - 1) * 0.9);
    const dPath = `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`;
    paths.push(
      <g key={g.key}>
        <path d={dPath} vectorEffect="non-scaling-stroke" className="edge" style={{ stroke, strokeWidth: sw, opacity: op, strokeDasharray: g.cross ? '6 5' : undefined }} />
        <path
          d={dPath}
          vectorEffect="non-scaling-stroke"
          className="edge-hit"
          style={{ strokeWidth: Math.max(12, sw + 8) }}
          onClick={(e) => {
            e.stopPropagation();
            if (!moved.current) p.onSelectEdge(isSel ? null : g.key);
          }}
        />
      </g>,
    );
    if ((i < MAX_TAGS || isSel || touches) && d * k > 90) {
      const qx = 0.25 * x1 + 0.5 * mx + 0.25 * x2;
      const qy = 0.25 * y1 + 0.5 * my + 0.25 * y2;
      tags.push(
        <button
          key={g.key}
          className={`tag${isSel ? ' sel' : ''}`}
          style={{ left: tx + qx * k, top: ty + qy * k, opacity: sv && !touches ? 0.25 : anyEdgeSel && !isSel ? 0.3 : 1, transition: tr }}
          onClick={(e) => {
            e.stopPropagation();
            p.onSelectEdge(isSel ? null : g.key);
          }}
        >
          {g.tag}
        </button>,
      );
    }
  });

  return (
    <div
      ref={stage}
      className="stage"
      onMouseDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
        moved.current = false;
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = moved.current = true;
        if (d.moved) p.onCamera({ k, tx: d.tx + dx, ty: d.ty + dy });
      }}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
      onClick={() => {
        if (!moved.current) {
          p.onSelect(null);
          p.onSelectEdge(null);
        }
      }}
      style={{ cursor: drag.current?.moved ? 'grabbing' : 'grab' }}
    >
      <svg width={size.w} height={size.h} className="svg">
        <g style={{ transform: `translate(${tx}px, ${ty}px) scale(${k})`, transformOrigin: '0 0', transition: cam.anim ? `transform .75s ${EASE}` : 'none' }}>
          {paths}
          {circles}
        </g>
      </svg>
      <div className="overlay">{labels}</div>
      <div className="overlay">{tags}</div>
    </div>
  );
}

function subtitle(n: TNode): string | null {
  if (n.kind === 'repo') {
    const files = n.data ? countFiles(n) : 0;
    return `${files} files · ${n.symbols} symbols`;
  }
  if (n.kind === 'domain') {
    const repos = new Set<string>();
    const walk = (x: TNode) => (x.repo ? repos.add(x.repo) : x.children.forEach(walk));
    walk(n);
    return `${n.symbols} symbols · ${repos.size} repo${repos.size === 1 ? '' : 's'}`;
  }
  return null;
}

function countFiles(n: TNode): number {
  if (n.kind === 'file') return 1;
  let c = 0;
  for (const ch of n.children) c += countFiles(ch);
  return c;
}
