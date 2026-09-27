// Floating sidebar: repository import, the Code / By-function toggle, the
// project's layers, and an outline of whichever hierarchy the map is showing.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { UNLAYERED, type Graph, type LayerPreset, type RepoInfo, type Workspace } from '@strata/shared';
import { canEdit } from '../api.ts';
import { ancestors, type TNode, type Tree, type View } from '../graph/tree.ts';
import type { ExpandMode } from '../graph/view.ts';
import type { ColorBy, Palette } from '../theme.ts';
import type { ThemeChoice } from '../useTheme.ts';
import { Chevron } from './Icon.tsx';

interface Props {
  workspace: Workspace | null;
  graph: Graph | null;
  /** Why the indexer can't be reached; null while it answers. */
  offline: string | null;
  tree: Tree | null;
  view: View;
  mode: ExpandMode;
  colorBy: ColorBy;
  theme: ThemeChoice;
  pal: Palette;
  selected: string | null;
  onView(v: View): void;
  onMode(m: ExpandMode): void;
  onColorBy(c: ColorBy): void;
  onTheme(t: ThemeChoice): void;
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
        strata <Chevron dir="right" />
      </button>
    );
  }
  return (
    <aside className="panel sidebar">
      <header className="sidebar-head">
        <span className="brand">strata</span>
        <span className="muted small">codebase cartography</span>
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Hide sidebar" aria-label="Hide sidebar">
          <Chevron dir="left" />
        </button>
      </header>
      <Repos {...p} />
      <section className="section">
        <div className="section-title">view</div>
        <Choice
          label="view"
          value={p.view}
          options={[
            ['code', 'code', 'The code as it is: repositories, folders, files, symbols. Read-only.'],
            ['function', 'by function', 'The same symbols grouped by domain, then by layer.'],
          ]}
          onChange={p.onView}
        />
        <div className="setting">
          <span className="setting-name small">colour by</span>
          <Choice
            label="colour by"
            value={p.colorBy}
            options={[
              ['repo', 'repository'],
              ['layer', 'layer'],
            ]}
            onChange={p.onColorBy}
          />
        </div>
        <div className="setting" title="On click: the first click on a circle shows its details, a second click opens it, and scrolling only zooms. On zoom: circles open as you zoom into them.">
          <span className="setting-name small">open</span>
          <Choice
            label="open circles"
            value={p.mode}
            options={[
              ['click', 'on click'],
              ['zoom', 'on zoom'],
            ]}
            onChange={p.onMode}
          />
        </div>
        <div className="setting">
          <span className="setting-name small">theme</span>
          <Choice
            label="theme"
            value={p.theme}
            options={[
              ['system', 'system', "Follow the system's light or dark setting"],
              ['dark', 'dark'],
              ['light', 'light'],
            ]}
            onChange={p.onTheme}
          />
        </div>
      </section>
      {p.graph && p.workspace && <Layers {...p} graph={p.graph} workspace={p.workspace} />}
      {p.tree && p.tree.root.children.length > 0 && <Outline {...p} tree={p.tree} />}
    </aside>
  );
}

/** One of a few, as a row of words: the chosen one is ink over a green line. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string, string?][]; onChange(v: T): void }) {
  return (
    <div className="choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} title={title} onClick={() => v !== value && onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** A sentence about something that went wrong: its first words in brick, the rest muted. */
function Problem({ text }: { text: string }) {
  const m = /^(.+?[.!?:])\s+(.+)$/s.exec(text);
  return (
    <div className="notice" role="alert">
      <span className="lead">{m ? m[1] : text}</span>
      {m && <> {m[2]}</>}
    </div>
  );
}

const PRESET_LABEL: Record<LayerPreset, string> = { roles: 'roles', 'by-repo': 'by repo', empty: 'empty' };

const LAYERS_OPEN = 'strata.layersOpen';

/**
 * The project's own layers: how much code each holds, the preset they started from, and where to
 * edit them. Folded by default so the outline keeps its room; the map's legend has the colours.
 */
function Layers({ graph, workspace, pal, onPreset }: Props & { graph: Graph; workspace: Workspace }) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LAYERS_OPEN) === '1';
    } catch {
      return false;
    }
  });
  const fold = () => {
    setOpen(!open);
    try {
      localStorage.setItem(LAYERS_OPEN, open ? '0' : '1');
    } catch {
      // private mode: remembered for this tab only
    }
  };
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
  const problems = (
    <>
      {workspace.project.groupingError && <Problem text={`Grouping not applied: ${workspace.project.groupingError}`} />}
      {error && <Problem text={error} />}
    </>
  );
  const heading = (
    <button className="section-title fold" onClick={fold} aria-expanded={open}>
      layers <span className="muted num">· {graph.layers.length}</span>
      <Chevron dir={open ? 'down' : 'right'} size={16} />
    </button>
  );
  if (!open) {
    return (
      <section className="section">
        {heading}
        {problems}
      </section>
    );
  }
  return (
    <section className="section">
      {heading}
      {canEdit(workspace) && (
        <div className="setting layer-choice">
          <span className="setting-name small">preset</span>
          <Choice label="layer preset" value={graph.preset ?? ('' as LayerPreset)} options={Object.entries(PRESET_LABEL) as [LayerPreset, string][]} onChange={choose} />
        </div>
      )}
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
      {canEdit(workspace) && (
        <div className="layer-file" title={file}>
          Rename layers and add rules in {file.split(/[\\/]/).pop()}; edits apply live.
        </div>
      )}
      {problems}
    </section>
  );
}

const STATUS: Record<RepoInfo['status'], string> = {
  queued: 'queued…',
  cloning: 'cloning…',
  indexing: 'indexing…',
  ready: '',
  error: "couldn't index it",
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
  const editable = canEdit(workspace);
  const suggestions = editable && !repos.length ? (workspace?.suggestions ?? []) : [];
  return (
    <section className="section">
      <div className="section-title">repositories</div>
      {offline && <Problem text={offline} />}
      {!!repos.length && (
        <div className="repo-list">
          {repos.map((r) => {
            const working = r.status === 'queued' || r.status === 'cloning' || r.status === 'indexing';
            return (
              <div key={r.id} className="repo-row" title={r.source}>
                <span className="dot" style={{ background: pal.repo(r.id) }} />
                <div className="repo-main">
                  <div className="repo-name">{r.name}</div>
                  <div className="repo-meta">
                    {r.status === 'ready' ? (
                      <span>
                        {r.fileCount} files · {r.symbolCount} symbols{r.truncated ? ` · ${r.truncated} skipped` : ''}
                      </span>
                    ) : (
                      <span className={r.status === 'error' ? 'err-lead' : working ? 'busy' : ''}>{STATUS[r.status]}</span>
                    )}
                    {editable && (
                      <>
                        <button className="link" title="Pull and re-index" disabled={working} onClick={() => onRefresh(r.id).catch((err: Error) => setError(err.message))}>
                          refresh
                        </button>
                        <button className="link danger" title="Remove from this project" onClick={() => onRemove(r.id).catch((err: Error) => setError(err.message))}>
                          remove
                        </button>
                      </>
                    )}
                  </div>
                  {r.status === 'error' && r.error && <div className="repo-error">{r.error}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editable && (
        <form className="import" onSubmit={submit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={workspace?.access?.localPaths === false ? 'org/repo or git URL' : 'org/repo, URL or path'}
            aria-label="Repository to import: org/repo, a git URL, or a local path"
            spellCheck={false}
          />
          <button type="submit" disabled={pending || !input.trim()}>
            {pending ? 'importing…' : 'import'}
          </button>
        </form>
      )}
      {error && <Problem text={error} />}
      {!!suggestions.length && (
        <div className="suggestions">
          try{' '}
          {suggestions.map((s, i) => (
            <span key={s}>
              {i > 0 && ' · '}
              <button className="link" onClick={() => add(s)} title={s}>
                {s.startsWith('/') ? 'this checkout' : s}
              </button>
            </span>
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

  const title = tree.view === 'code' ? 'structure' : 'domains';
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
              style={{ paddingLeft: 8 + level * 16 }}
            >
              <button
                className="chev"
                style={{ visibility: n.children.length ? 'visible' : 'hidden' }}
                onClick={() => toggle(n.id)}
                aria-label={expanded.has(n.id) ? `Fold ${n.name}` : `Unfold ${n.name}`}
                aria-expanded={expanded.has(n.id)}
              >
                <Chevron dir={expanded.has(n.id) ? 'down' : 'right'} size={16} />
              </button>
              <button className="outline-name" onClick={() => onSelect(n.id)}>
                {color && <span className="dot small" style={{ background: color }} />}
                <span>{n.name}</span>
              </button>
              <span className="count">{n.children.length ? n.symbols || n.children.length : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
