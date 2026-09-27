// Right-hand panel: what the selected node is (including why it landed in its
// layer and domain), what it depends on, or the contract behind an edge.

import { useEffect, useMemo, useState } from 'react';
import { describeFact, UNLAYERED, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type Placement, type PlacementSource, type RepoInfo } from '@strata/shared';
import { api, type SourceText } from '../api.ts';
import type { TNode, Tree } from '../graph/tree.ts';
import type { Contract } from '../graph/view.ts';
import type { Palette } from '../theme.ts';

const KIND_LABEL: Record<TNode['kind'], string> = {
  root: 'Workspace',
  repo: 'Repository',
  folder: 'Module',
  file: 'File',
  symbol: 'Symbol',
  domain: 'Domain',
  layer: 'Layer',
};

const EDGE_VERB: Record<EdgeKind, string> = {
  imports: 'imports',
  calls: 'calls',
  renders: 'renders',
  type: 'uses type',
  references: 'refers to',
  http: 'requests',
};

interface Props {
  graph: Graph;
  graphIndex: Map<string, GraphNode>;
  tree: Tree;
  pal: Palette;
  selected: string | null;
  contract: Contract | null;
  onSelect(id: string): void;
}

export function Detail(p: Props) {
  if (p.contract) return <ContractDetail {...p} contract={p.contract} />;
  const n = p.selected ? p.tree.nodes.get(p.selected) : null;
  if (!n) return null;
  return <NodeDetail {...p} n={n} />;
}

const short = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1) : id.slice(id.lastIndexOf('/') + 1));

function NodeDetail({ graph, graphIndex, tree, pal, n, onSelect }: Props & { n: TNode }) {
  const g = n.data;
  const { uses, usedBy } = useMemo(() => dependencies(tree, graph.edges, n), [tree, graph, n]);
  const repo = g?.kind === 'repo' ? graph.repos.find((r) => r.id === g.id) : null;
  const color = n.repo ? pal.repo(n.repo) : n.layer ? pal.layer(n.layer) : pal.neutral();
  const path = g?.kind === 'symbol' ? `${g.path}${g.lines ? `:${g.lines[0]}` : ''}` : (g?.path ?? (n.kind === 'layer' ? `${tree.nodes.get(n.parent!)?.name} · ${n.name}` : ''));

  return (
    <aside className="panel detail">
      <div className="detail-head">
        <div className="kicker">
          <span className="dot" style={{ background: color }} />
          {KIND_LABEL[n.kind]}
          {g?.symbolKind && <span className="muted">· {g.symbolKind}</span>}
        </div>
        <div className="detail-title">{n.name}</div>
        {path && <div className="detail-path">{path}</div>}
      </div>

      {repo && (
        <div className="detail-block">
          <Facts
            rows={[
              ['source', repo.source],
              ['commit', repo.commit ?? '—'],
              ['files', `${repo.fileCount ?? 0}${repo.truncated ? ` (${repo.truncated} skipped)` : ''}`],
              ['symbols', String(repo.symbolCount ?? 0)],
              ['languages', Object.entries(repo.languages ?? {}).map(([l, c]) => `${l} ${c}`).join(', ') || '—'],
              ['frameworks', repo.frameworks?.join(', ') || '—'],
            ]}
          />
        </div>
      )}

      {(n.kind === 'domain' || n.kind === 'layer' || n.kind === 'folder') && (
        <div className="detail-block muted">{summary(n)}</div>
      )}

      {g?.layer && g.domain && <WhyHere graph={graph} g={g} layer={g.layer} domain={g.domain} />}

      {!!g?.routes?.length && (
        <div className="detail-block">
          <div className="block-title">Serves</div>
          {g.routes.map((r) => (
            <div key={r} className="mono small">
              {r}
            </div>
          ))}
        </div>
      )}

      <div className="detail-block deps">
        <DepList title="Uses" items={uses} graphIndex={graphIndex} self={n} onSelect={onSelect} />
        <DepList title="Used by" items={usedBy} graphIndex={graphIndex} self={n} onSelect={onSelect} />
      </div>

      {g?.path && (g.kind === 'file' || g.kind === 'symbol') && <Code g={g} repo={graph.repos.find((r) => r.id === g.repo)} />}
    </aside>
  );
}

const MAX_LINES = 400;
const sources = new Map<string, Promise<SourceText>>();

/** The node's code: a symbol's lines, or the top of a file, read from the indexer's checkout. */
function Code({ g, repo }: { g: GraphNode; repo?: RepoInfo }) {
  const key = `${g.repo}|${g.path}|${repo?.commit ?? ''}`;
  const [state, setState] = useState<{ key: string; text?: string; error?: string } | null>(null);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    let live = true;
    let p = sources.get(key);
    if (!p) {
      p = api.source(g.repo, g.path!);
      sources.set(key, p);
      p.catch(() => sources.delete(key));
    }
    p.then(
      (s) => live && setState({ key, text: s.text }),
      (err: Error) => live && setState({ key, error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [key, g.repo, g.path]);
  useEffect(() => setWhole(false), [g.id]);

  const all = state?.key === key && state.text != null ? state.text.split('\n') : null;
  const [a, b] = g.kind === 'symbol' && g.lines && !whole ? g.lines : [1, all?.length ?? 1];
  const shown = all ? all.slice(a - 1, Math.min(b, a - 1 + MAX_LINES)) : [];
  const web = repo && webUrl(repo, g.path!, g.kind === 'symbol' && g.lines ? g.lines : null);

  return (
    <div className="detail-block code-block">
      <div className="block-title row gap">
        <span>Code</span>
        <span className="grow" />
        {g.kind === 'symbol' && all && (
          <button className="link" onClick={() => setWhole((w) => !w)}>
            {whole ? 'just this symbol' : 'whole file'}
          </button>
        )}
        {web && (
          <a className="link" href={web} target="_blank" rel="noreferrer">
            open on GitHub ↗
          </a>
        )}
      </div>
      {state?.key === key && state.error && <div className="muted small">Couldn't load the source: {state.error}</div>}
      {!all && !(state?.key === key && state.error) && <div className="muted small">Loading…</div>}
      {all && (
        <pre className="code">
          {shown.map((line, i) => (
            <div key={i} className={g.kind === 'symbol' && whole && g.lines && a + i >= g.lines[0] && a + i <= g.lines[1] ? 'hl' : ''}>
              <span className="ln">{a + i}</span>
              {line || ' '}
            </div>
          ))}
          {b - a + 1 > MAX_LINES && <div className="muted">… {b - a + 1 - MAX_LINES} more lines</div>}
        </pre>
      )}
    </div>
  );
}

/** Link to the file at the indexed commit, for repositories cloned from GitHub. */
function webUrl(repo: RepoInfo, path: string, lines: [number, number] | null): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(repo.source);
  if (!m) return null;
  const at = lines ? `#L${lines[0]}-L${lines[1]}` : '';
  return `https://github.com/${m[1]}/blob/${repo.commit ?? 'HEAD'}/${path.split('/').map(encodeURIComponent).join('/')}${at}`;
}

const SOURCE: Record<PlacementSource, string> = {
  'user-pin': 'your pin',
  'user-rule': 'your rule',
  fact: 'code',
  import: 'import',
  path: 'path',
  repo: 'repository',
  graph: 'neighbours',
  seed: 'seed',
  propagated: 'neighbours',
  cohesion: 'file',
  fallback: 'no signal',
};

const explain = (p: Placement) =>
  [p.evidence[0]?.detail, ...p.evidence.slice(1).map((e) => `also ${e.detail}`), `${SOURCE[p.source]} · ${p.confidence.toFixed(2)}`].filter(Boolean).join(' · ');

/** "Why is this here?": the winning evidence for its layer and domain, and what the detectors saw. */
function WhyHere({ graph, g, layer, domain }: { graph: Graph; g: GraphNode; layer: Placement; domain: Placement }) {
  const layerName = layer.id === UNLAYERED ? 'Unlayered' : (graph.layers.find((l) => l.id === layer.id)?.name ?? layer.id);
  const domainName = graph.domains.find((d) => d.id === domain.id)?.name ?? domain.id;
  const facts = g.facts ?? [];
  const imports = facts.filter((f) => f.type === 'import').map((f) => f.value);
  const seen = facts.filter((f) => f.type !== 'import').map(describeFact);
  if (imports.length) seen.push(`imports ${imports.slice(0, 6).join(', ')}${imports.length > 6 ? ` +${imports.length - 6}` : ''}`);
  return (
    <div className="detail-block">
      <div className="block-title">Why it's here</div>
      <Facts
        rows={[
          ['layer', layerName, explain(layer)],
          ['domain', domainName, explain(domain)],
          ...(seen.length ? [['detected', seen.join(' · ')] as [string, string]] : []),
        ]}
      />
    </div>
  );
}

function Facts({ rows }: { rows: [string, string, string?][] }) {
  return (
    <div className="facts">
      {rows.map(([k, v, note]) => (
        <div key={k} className="fact">
          <span className="fact-k">{k}</span>
          <span className="fact-v">
            {v}
            {note && <span className="fact-note">{note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Dep {
  id: string;
  kind: EdgeKind;
}

function DepList({ title, items, graphIndex, self, onSelect }: { title: string; items: Dep[]; graphIndex: Map<string, GraphNode>; self: TNode; onSelect(id: string): void }) {
  return (
    <div className="dep-col">
      <div className="block-title">
        {title} {items.length ? <span className="muted">· {items.length}</span> : null}
      </div>
      {items.slice(0, 40).map((d) => {
        const other = graphIndex.get(d.id);
        const crossRepo = other && self.repo && other.repo !== self.repo;
        return (
          <button key={d.id + d.kind} className="dep" onClick={() => onSelect(d.id)} title={d.id}>
            <span className="muted">{EDGE_VERB[d.kind]}</span>
            <span className="dep-name">
              {short(d.id)}
              {crossRepo ? <span className="muted"> · {other!.repo}</span> : null}
            </span>
          </button>
        );
      })}
      {items.length > 40 && <div className="muted small">and {items.length - 40} more</div>}
    </div>
  );
}

/** Edges that cross the boundary of this node's subtree, deduplicated by the node on the other side. */
function dependencies(tree: Tree, edges: GraphEdge[], n: TNode) {
  const inside = new Set<string>();
  const walk = (x: TNode) => {
    inside.add(x.id);
    x.children.forEach(walk);
  };
  walk(n);
  // In the code view a file's symbols are inside it; in both views a symbol owns nothing else.
  const has = (id: string) => inside.has(id) || (n.kind === 'file' && id.startsWith(n.id + '#'));
  const uses = new Map<string, Dep>();
  const usedBy = new Map<string, Dep>();
  // One row per node on the other side, under its strongest kind of use.
  const keep = (m: Map<string, Dep>, id: string, kind: EdgeKind) => {
    const cur = m.get(id);
    if (!cur || KIND_RANK[kind] < KIND_RANK[cur.kind]) m.set(id, { id, kind });
  };
  for (const e of edges) {
    const a = has(e.from);
    const b = has(e.to);
    if (a && !b) keep(uses, e.to, e.kind);
    else if (b && !a) keep(usedBy, e.from, e.kind);
  }
  // Requests first: following them is how you get from a page to its backend.
  const order = (m: Map<string, Dep>) => [...m.values()].sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]);
  return { uses: order(uses), usedBy: order(usedBy) };
}

const KIND_RANK: Record<EdgeKind, number> = { http: 0, calls: 1, renders: 2, references: 3, type: 4, imports: 5 };

function summary(n: TNode): string {
  const repos = new Set<string>();
  const walk = (x: TNode) => (x.kind === 'symbol' || x.kind === 'file' ? repos.add(x.repo) : x.children.forEach(walk));
  walk(n);
  const where = repos.size === 1 ? `in ${[...repos][0]}` : `across ${repos.size} repositories`;
  if (n.kind === 'domain') return `${n.symbols} symbols ${where}, in ${n.children.length} layer${n.children.length === 1 ? '' : 's'}.`;
  if (n.kind === 'layer') return `${n.children.length} ${n.name} symbol${n.children.length === 1 ? '' : 's'} ${where}.`;
  return `${n.children.length} entries, ${n.symbols} symbols.`;
}

function ContractDetail({ tree, contract: c, onSelect }: Props & { contract: Contract }) {
  const A = tree.nodes.get(c.a)!;
  const B = tree.nodes.get(c.b)!;
  const http = c.items.filter((e) => e.kind === 'http');
  const types = c.items.filter((e) => e.kind === 'type');
  const code = c.items.filter((e) => e.kind !== 'http' && e.kind !== 'type');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const call: string[] = [];
  if (http.length) call.push(`${plural(http.length, 'HTTP request')} (${[...new Set(http.map((e) => e.detail))].slice(0, 3).join(', ')}${http.length > 3 ? ', …' : ''})`);
  if (code.length) call.push(`${code.length} direct ${[...new Set(code.map((e) => EDGE_VERB[e.kind]))].join(' / ')}`);
  if (types.length) call.push(plural(types.length, 'shared type'));
  const response = http.length
    ? 'JSON from the matched route handlers.'
    : types.length && !code.length
      ? 'Compile-time only, no runtime traffic.'
      : 'Return values of the called symbols; exceptions propagate to the caller.';

  return (
    <aside className="panel detail">
      <div className="detail-head">
        <div className="kicker">
          <span className="tag sel static">{c.tag}</span>
          Contract · {plural(c.items.length, 'interaction')}
          {c.cross ? ' · cross-repo' : ''}
        </div>
        <div className="contract-ends">
          <button onClick={() => onSelect(A.id)}>{A.name}</button>
          <span className="muted">⇄</span>
          <button onClick={() => onSelect(B.id)}>{B.name}</button>
        </div>
      </div>
      <div className="call-grid">
        <span className="block-title">Call</span>
        <span>{call.join('; ')}.</span>
        <span className="block-title">Response</span>
        <span>{response}</span>
      </div>
      <div className="detail-block">
        <div className="block-title">Interactions</div>
        {c.items.slice(0, 80).map((e, i) => (
          <div key={i} className="interaction" title={`${e.from} → ${e.to}`}>
            <span className="muted">{EDGE_VERB[e.kind]}</span>
            <span className="dep-name">
              {/* Each end opens the exact file or symbol responsible, not just the circle the contract is drawn to. */}
              <button className="end" onClick={() => onSelect(e.from)}>
                {short(e.from)}
              </button>{' '}
              →{' '}
              <button className="end" onClick={() => onSelect(e.to)}>
                {short(e.to)}
              </button>
              {e.detail && <span className="muted"> · {e.detail}</span>}
            </span>
          </div>
        ))}
        {c.items.length > 80 && <div className="muted small">and {c.items.length - 80} more</div>}
      </div>
    </aside>
  );
}
