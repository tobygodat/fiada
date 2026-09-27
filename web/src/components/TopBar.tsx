// Back, the breadcrumb of the focused path, and the altitude indicator.

import { useEffect, useState, type RefObject } from 'react';
import type { Camera } from '../graph/camera.ts';
import type { TNode, View } from '../graph/tree.ts';
import type { MapRenderer } from '../render/renderer.ts';

interface Props {
  crumbs: TNode[];
  /** Zoom mode: the breadcrumb for wherever the camera is, in place of `crumbs`. */
  crumbsAt: ((cam: Camera) => TNode[]) | null;
  view: View;
  /** Depth of the deepest open level on screen, -1 at the top. */
  altitude: number;
  renderer: RefObject<MapRenderer | null>;
  /** Camera scale that fits the whole map: 100%. */
  fitK: number;
  busy: boolean;
  canGoBack: boolean;
  onBack(): void;
  onCrumb(id: string): void;
}

const ALTITUDES: Record<View, string[]> = {
  code: ['Systems', 'Modules', 'Files', 'Symbols'],
  function: ['Domains', 'Layers', 'Symbols'],
};

export function TopBar({ crumbs: given, crumbsAt, view, altitude, renderer, fitK, busy, canGoBack, onBack, onCrumb }: Props) {
  const alts = ALTITUDES[view];
  const crumbs = useCameraCrumbs(renderer, crumbsAt) ?? given;
  const idx = Math.max(0, Math.min(alts.length - 1, altitude));
  return (
    <div className="topbar">
      <nav className="crumbs">
        <button className="back" onClick={onBack} disabled={!canGoBack} title="Back (Backspace)">
          ←
        </button>
        <button onClick={() => onCrumb('root')} className={crumbs.length ? '' : 'here'}>
          workspace
        </button>
        {crumbs.map((c, i) => (
          <span key={c.id}>
            <span className="sep">/</span>
            <button onClick={() => onCrumb(c.id)} className={i === crumbs.length - 1 ? 'here' : ''}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="topbar-right">
        {busy && (
          <span className="muted mono small row gap">
            <span className="spinner" /> indexing
          </span>
        )}
        <div className="altitudes">
          {alts.map((a, i) => (
            <span key={a} className={i === idx ? 'on' : ''}>
              {a}
            </span>
          ))}
        </div>
        <Zoom renderer={renderer} fitK={fitK} />
      </div>
    </div>
  );
}

/** The breadcrumb `crumbsAt` gives for the camera, updated as it moves but re-rendering only when it changes. */
function useCameraCrumbs(renderer: RefObject<MapRenderer | null>, crumbsAt: ((cam: Camera) => TNode[]) | null) {
  const [crumbs, setCrumbs] = useState<TNode[] | null>(null);
  useEffect(() => {
    const r = renderer.current;
    if (!r || !crumbsAt) return setCrumbs(null);
    const key = (c: TNode[]) => c.at(-1)?.id ?? 'root';
    const update = () => {
      const next = crumbsAt(r.camera);
      setCrumbs((cur) => (cur && key(cur) === key(next) ? cur : next));
    };
    update();
    return r.subscribe(update);
  }, [renderer, crumbsAt]);
  return crumbs;
}

/** Zoom readout that follows the camera without re-rendering the rest of the app. */
function Zoom({ renderer, fitK }: { renderer: RefObject<MapRenderer | null>; fitK: number }) {
  const [k, setK] = useState(1);
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    let last = -1;
    const update = () => {
      const pct = Math.round((r.camera.k / fitK) * 100);
      if (pct !== last) setK((last = pct));
    };
    update();
    return r.subscribe(update);
  }, [renderer, fitK]);
  return <span className="mono small muted zoom">{k}%</span>;
}
