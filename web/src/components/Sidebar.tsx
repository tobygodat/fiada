// Floating sidebar: repository import, the Code / By-function toggle, the
// project's layers, and an outline of whichever hierarchy the map is showing.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { UNLAYERED, type Graph, type LayerPreset, type RepoInfo, type Workspace } from '@strata/shared';
import { ancestors, type TNode, type Tree, type View } from '../graph/tree.ts';
import type { ExpandMode } from '../graph/view.ts';
import type { ColorBy, Palette } from '../theme.ts';

interface Props {
  workspace: Workspace | null;
  graph: Graph | null;
  offline: boolean;
  tree: Tree | null;
  view: View;
  mode: ExpandMode;
  colorBy: ColorBy;
  pal: Palette;
  selected: string | null;
  onView(v: View): void;
  onMode(m: ExpandMode): void;
  onColorBy(c: ColorBy): void;
  onSelect(id: string): void;
  onAdd(source: string): Promise<void>;
  onRemove(id: string): Promise<void>;
  onRefresh(id: string): Promise<void>;
  onPreset(preset: LayerPreset): Promise<void>;
}

export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button className="panel sidebar-pill" onClick={() => setCollapsed(false)} title="Show sidebar">
        Strata <span className="muted">▸</span>
      </button>
    );
  }
  return (
    <aside className="panel sidebar">
      <header className="sidebar-head">
        <span className="brand">Strata</span>
        <span className="muted mono small">codebase cartography</span>
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Hide sidebar">
          ◂
        </button>
      </header>
      <Repos {...p} />
      <section className="section">
        <div className="section-title">View</div>
        <Segmented
          value={p.view}
          options={[
            ['code', 'Code · read-only'],
            ['function', 'By function'],
          ]}
          onChange={p.onView}
        />
        <div className="row gap small muted setting">
          <span className="mono setting-name">color</span>
          <Segmented
            small
            value={p.colorBy}
            options={[
              ['repo', 'repository'],
              ['layer', 'layer'],
            ]}
            onChange={p.onColorBy}
          />
        </div>
        <div className="row gap small muted setting" title="On click: the first click on a circle shows its details, a second click opens it, and scrolling only zooms. On zoom: circles open as you zoom into them.">
          <span className="mono setting-name">open</span>
          <Segmented
            small
            value={p.mode}
            options={[
              ['click', 'on click'],
              ['zoom', 'on zoom'],
            ]}
            onChange={p.onMode}
          />
        </div>
      </section>
      {p.graph && p.workspace && <Layers {...p} graph={p.graph} workspace={p.workspace} />}
      {p.tree && p.tree.root.children.length > 0 && <Outline {...p} tree={p.tree} />}
    </aside>
  );
}

function Segmented<T extends string>({ value, options, onChange, small }: { value: T; options: [T, string][]; onChange(v: T): void; small?: boolean }) {
  return (
    <div className={`segmented${small ? ' small' : ''}`}>
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const PRESET_LABEL: Record<LayerPreset, string> = { roles: 'Roles', 'by-repo': 'By repo', empty: 'Empty' };

/** The project's own layers: how much code each holds, the preset they started from, and where to edit them. */
function Layers({ graph, workspace, pal, onPreset }: Props & { graph: Graph; workspace: Workspace }) {
  const [error, setError] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of graph.nodes) if (n.kind === 'symbol' && n.layer) m.set(n.layer.id, (m.get(n.layer.id) ?? 0) + 1);
    return m;
  }, [graph]);
  const choose = async (preset: LayerPreset) => {
    if (preset === graph.preset) return;
    if (!window.confirm(`Replace this project's layers with the ${PRESET_LABEL[preset]} preset? Your rules and pins are kept.`)) return;
    setError(null);
    await onPreset(preset).catch((err: Error) => setError(err.message));
  };
  const file = workspace.project.groupingLocation;
  const rows = [...graph.layers, ...(counts.get(UNLAYERED) ? [{ id: UNLAYERED, name: 'Unlayered' }] : [])];
  return (
    <section className="section">
      <div className="section-title row">
        <span>Layers</span>
        <span className="grow" />
        <Segmented small value={graph.preset ?? ('' as LayerPreset)} options={Object.entries(PRESET_LABEL) as [LayerPreset, string][]} onChange={choose} />
      </div>
      <div className="layer-list">
        {rows.map((l) => (
          <div key={l.id} className={`layer-row${l.id === UNLAYERED ? ' muted' : ''}`}>
            <span className="dot small" style={{ background: pal.layer(l.id) }} />
            <span className="grow">{l.name}</span>
            <span className="count">{counts.get(l.id) ?? 0}</span>
          </div>
        ))}
        {!rows.length && <div className="muted small">No layers yet. Everything is Unlayered.</div>}
      </div>
      <div className="muted small layer-file" title={file}>
        Edit <span className="mono">{file.split(/[\\/]/).pop()}</span> to rename layers or add matchers and rules; changes apply live.
      </div>
      {workspace.project.groupingError && <div className="notice err">Grouping not applied: {workspace.project.groupingError}</div>}
      {error && <div className="notice err">{error}</div>}
    </section>
  );
}

const STATUS: Record<RepoInfo['status'], string> = {
  queued: 'queued',
  cloning: 'cloning…',
  indexing: 'indexing…',
  ready: '',
  error: 'failed',
};

function Repos({ workspace, offline, pal, onAdd, onRemove, onRefresh }: Props) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const add = async (source: string) => {
    if (!source.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onAdd(source.trim());
      setInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add(input);
  };
  const repos = workspace?.repos ?? [];
  return (
    <section className="section">
      <div className="section-title">Repositories</div>
      {offline && <div className="notice">Can't reach the indexer. Start it with npm run dev.</div>}
      <div className="repo-list">
        {repos.map((r) => (
          <div key={r.id} className="repo-row" title={r.source}>
            <span className="dot" style={{ background: pal.repo(r.id) }} />
            <div className="repo-main">
              <div className="repo-name">{r.name}</div>
              <div className={`repo-meta${r.status === 'error' ? ' err' : ''}`}>
                {r.status === 'ready'
                  ? `${r.fileCount} files · ${r.symbolCount} symbols${r.truncated ? ` · ${r.truncated} skipped` : ''}`
                  : r.status === 'error'
                    ? r.error
                    : STATUS[r.status]}
              </div>
            </div>
            {(r.status === 'cloning' || r.status === 'indexing' || r.status === 'queued') && <span className="spinner" />}
            <button className="icon-btn" title="Pull and re-index" onClick={() => onRefresh(r.id)}>
              ↻
            </button>
            <button className="icon-btn" title="Remove" onClick={() => onRemove(r.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <form className="import" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="org/repo, git URL, or /local/path" spellCheck={false} />
        <button type="submit" disabled={pending || !input.trim()}>
          Add
        </button>
      </form>
      {error && <div className="notice err">{error}</div>}
      {!repos.length && !!workspace?.suggestions.length && (
        <div className="suggestions">
          <span className="muted small">Try</span>
          {workspace.suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => add(s)} title={s}>
              {s.startsWith('/') ? 'this checkout' : s}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Outline({ tree, selected, pal, colorBy, onSelect }: Props & { tree: Tree }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Follow the selection: open every ancestor so the selected row is visible.
  useEffect(() => {
    if (!selected || !tree.nodes.has(selected)) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestors(tree, selected).slice(0, -1)) next.add(a.id);
      return next;
    });
    document.getElementById(`row-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, tree]);

  const rows = useMemo(() => {
    const out: { n: TNode; level: number }[] = [];
    const walk = (n: TNode, level: number) => {
      for (const c of n.children) {
        out.push({ n: c, level });
        if (expanded.has(c.id)) walk(c, level + 1);
      }
    };
    walk(tree.root, 0);
    return out;
  }, [tree, expanded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const title = tree.view === 'code' ? 'Structure' : 'Domains';
  return (
    <section className="section outline-section">
      <div className="section-title">{title}</div>
      <div className="outline">
        {rows.map(({ n, level }) => {
          const color = colorBy === 'layer' ? (n.layer ? pal.layer(n.layer) : null) : n.repo ? pal.repo(n.repo) : null;
          const group = n.kind === 'domain' || n.kind === 'repo';
          return (
            <div
              key={n.id}
              id={`row-${n.id}`}
              className={`outline-row${n.id === selected ? ' sel' : ''}${group ? ' group' : ''}`}
              style={{ paddingLeft: 8 + level * 14 }}
            >
              <button className="chev" style={{ visibility: n.children.length ? 'visible' : 'hidden' }} onClick={() => toggle(n.id)}>
                {expanded.has(n.id) ? '▾' : '▸'}
              </button>
              <button className="outline-name" onClick={() => onSelect(n.id)}>
                {color && <span className="dot small" style={{ background: color }} />}
                <span className={n.kind === 'symbol' || n.kind === 'file' ? 'mono' : ''}>{n.name}</span>
              </button>
              <span className="count">{n.children.length ? n.symbols || n.children.length : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
