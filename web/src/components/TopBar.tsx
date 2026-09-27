// Breadcrumb of the focused path and the altitude indicator.

import type { TNode, View } from '../graph/tree.ts';

interface Props {
  crumbs: TNode[];
  view: View;
  /** Depth of the deepest open level on screen, -1 at the top. */
  altitude: number;
  zoom: number;
  busy: boolean;
  onCrumb(id: string): void;
}

const ALTITUDES: Record<View, string[]> = {
  code: ['Systems', 'Modules', 'Files', 'Symbols'],
  function: ['Domains', 'Layers', 'Symbols'],
};

export function TopBar({ crumbs, view, altitude, zoom, busy, onCrumb }: Props) {
  const alts = ALTITUDES[view];
  const idx = Math.max(0, Math.min(alts.length - 1, altitude));
  return (
    <div className="topbar">
      <nav className="crumbs">
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
        <span className="mono small muted zoom">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
