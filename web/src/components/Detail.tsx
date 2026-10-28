// Right-hand panel: what the selected node is and does (its summary, then why
// it landed in its layer and domain), whether agents may change it (its
// fence), what it depends on, or the contract behind an edge.

import { useEffect, useMemo, useState } from 'react';
import {
  describeFact,
  modelLabel,
  UNLAYERED,
  type ActivityState,
  type EdgeEvidence,
  type EdgeEvidenceSource,
  type EdgeKind,
  type Fence,
  type FenceRule,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeSummary,
  type Placement,
  type PlacementSource,
  type RepoInfo,
} from '@fiada/shared';
import { api, type SourceText } from '../api.ts';
import { AgentChange } from './AgentChange.tsx';
import { ownerOf, type HunkOwner, type Theirs } from './diff.ts';
import { ago } from './ago.ts';
import { Chevron } from './Icon.tsx';
import { Choice } from './Sidebar.tsx';
import { fenceAround } from '../graph/fences.ts';
import { reachSentences } from '../graph/activity.ts';
import { locate, type TNode, type Tree } from '../graph/tree.ts';
import { direction, type Contract } from '../graph/view.ts';
import { stopRev, type ShownDiff, type TourStop } from '../graph/tour.ts';
import type { ColorBy, Palette } from '../theme.ts';

const KIND_LABEL: Record<TNode['kind'], string> = {
  root: 'workspace',
  repo: 'repository',
  folder: 'module',
  file: 'file',
  symbol: 'symbol',
  domain: 'domain',
  layer: 'layer',
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
  colorBy: ColorBy;
  selected: string | null;
  contract: Contract | null;
  /** What agents changed, for the diff of a changed file or symbol. */
  activity?: ActivityState | null;
  /** The review tour's agent and the change it's on: its diff alone, not every agent's. */
  reviewing?: { agent: string; stop: TourStop; onShown?(shown: ShownDiff | null): void } | null;
  /** Circles marked "ask first" or "off limits". */
  fences?: readonly Fence[];
  /** Puts up or takes down a fence; absent when this browser can't change the project. */
  onFence?(node: string, rule: FenceRule | null): Promise<void>;
  /** The changes the map is showing: every agent's, or the lit agent's alone. */
  shownChanges?: ActivityState['nodes'];
  onSelect(id: string): void;
  /** Takes the map to a repository or folder, switching to the code view when the map is by function. */
  onPlace?(id: string): void;
}

export function Detail(p: Props) {
  if (p.contract) return <ContractDetail {...p} contract={p.contract} />;
  const n = p.selected ? p.tree.nodes.get(p.selected) : null;

  if (!n) return null;

  return <NodeDetail {...p} n={n} />;
}

const short = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1) : id.slice(id.lastIndexOf('/') + 1));

function NodeDetail({ graph, graphIndex, tree, pal, colorBy, n, activity, shownChanges, reviewing, fences, onFence, onSelect, onPlace }: Props & { n: TNode }) {
  const g = n.data;
  const { uses, usedBy } = useMemo(() => dependencies(tree, graph.edges, n), [tree, graph, n]);
  // Folded to their counts until asked for; an unfolded list stays open while you follow it from node to node.
  const [open, setOpen] = useState({ uses: false, usedBy: false });
  const repo = g?.kind === 'repo' ? graph.repos.find((r) => r.id === g.id) : null;
  const color = colorBy === 'layer' ? (n.layer ? pal.layer(n.layer) : pal.neutral()) : n.repo ? pal.repo(n.repo) : pal.neutral();
  const path = g?.kind === 'symbol' ? `${g.path}${g.lines ? `:${g.lines[0]}` : ''}` : (g?.path ?? (n.kind === 'layer' ? `${tree.nodes.get(n.parent!)?.name} · ${n.name}` : ''));

  return (
    <aside className="panel detail">
      <div className="detail-head">
        <div className="kicker">
          <span className="dot" style={{ background: color }} />
          {KIND_LABEL[n.kind]}
          {g?.symbolKind && <span> · {g.symbolKind}</span>}
        </div>
        <div className="detail-title">{n.name}</div>
        {path && <div className="detail-path">{path}</div>}
      </div>

      <Summary id={n.id} rev={graph.generatedAt} fallback={n.kind === 'domain' || n.kind === 'layer' || n.kind === 'folder' ? summary(n) : null} />

      {g && <Changed g={g} graph={graph} graphIndex={graphIndex} activity={activity} shown={shownChanges} reviewing={reviewing} />}
      {g && <Looked id={g.id} activity={activity} />}

      {g && <FenceBlock key={g.id} g={g} fences={fences ?? []} onFence={onFence} onSelect={onPlace ?? onSelect} />}

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

      {g?.layer && g.domain && <WhyHere graph={graph} g={g} layer={g.layer} domain={g.domain} />}

      {!!g?.routes?.length && (
        <div className="detail-block">
          <div className="block-title">serves</div>
          {g.routes.map((r) => (
            <div key={r} className="routes">
              {r}
            </div>
          ))}
        </div>
      )}

      <div className="detail-block deps">
        <DepList title="uses" items={uses} open={open.uses} onFold={() => setOpen((o) => ({ ...o, uses: !o.uses }))} graphIndex={graphIndex} self={n} onSelect={onSelect} />
        <DepList title="used by" items={usedBy} open={open.usedBy} onFold={() => setOpen((o) => ({ ...o, usedBy: !o.usedBy }))} graphIndex={graphIndex} self={n} onSelect={onSelect} />
      </div>

      {g?.path && (g.kind === 'file' || g.kind === 'symbol') && (
        <Code g={g} repo={graph.repos.find((r) => r.id === g.repo)} rev={activity?.nodes[g.kind === 'symbol' ? g.parent : g.id]?.at ?? 0} />
      )}
    </aside>
  );
}

type FenceChoice = FenceRule | 'none';

const FENCE_OPTIONS: [FenceChoice, string, string][] = [
  ['none', 'none', 'Agents change it as usual.'],
  ['ask', 'ask first', "Before an agent's file edit inside lands, you're asked."],
  ['off', 'off limits', "Agents' file edits inside are refused."],
];

const FENCE_WORDS = { ask: 'ask-first', off: 'off-limits' } as const;
const KIND_INSIDE: Record<GraphNode['kind'], string> = { repo: 'in this repository', folder: 'in this module', file: 'in this file', symbol: 'to this symbol' };

/**
 * Whether agents may change what's inside this circle: none, ask first or off
 * limits, kept for the project. The agent's hook asks the indexer before each
 * edit (agent/src/hook.ts). A fence round an ancestor is said, with the way to it.
 */
function FenceBlock({ g, fences, onFence, onSelect }: { g: GraphNode; fences: readonly Fence[]; onFence?: Props['onFence']; onSelect(id: string): void }) {
  const own = fences.find((f) => f.node === g.id);
  const around = fenceAround(fences, g.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: FenceChoice = own?.rule ?? 'none';

  const choose = async (rule: FenceChoice) => {
    if (!onFence || busy) return;
    setBusy(true);
    setError(null);

    try {
      await onFence(g.id, rule === 'none' ? null : rule);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inside = KIND_INSIDE[g.kind];

  const sentence =
    value === 'off'
      ? `Agents can't change anything ${inside} with their edit tools: the edit is refused before it lands. Shell commands aren't checked.`
      : value === 'ask'
        ? `Agents ask you before they change anything ${inside} with their edit tools. Shell commands aren't checked.`
        : 'Agents change it as usual.';

  return (
    <div className="detail-block fence-block" aria-busy={busy}>
      <div className="block-title">fence</div>
      {onFence ? (
        <Choice label="fence" value={value} options={FENCE_OPTIONS} onChange={(v) => void choose(v)} />
      ) : (
        <div className="fence-rule">{FENCE_OPTIONS.find(([v]) => v === value)![1]}</div>
      )}
      <p className={`fence-words${value === 'none' ? '' : ' ' + value}`}>{sentence}</p>
      {around && (
        <p className="fence-words">
          Inside the {FENCE_WORDS[around.rule]} fence round{' '}
          <button className="link" onClick={() => onSelect(around.node)}>
            {around.node}
          </button>
          {around.rule === 'off' && value !== 'off' ? ", so agents' edits to it are refused too." : '.'}
        </p>
      )}
      {error && (
        <p className="fence-words error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * What the node does, first thing under its name: the indexer's generated
 * summary when it has one, marked as generated, else its line from the graph
 * or the code's own doc comment. Asks again while a summary is being written.
 */
function Summary({ id, rev, fallback }: { id: string; rev: string; fallback: string | null }) {
  const [state, setState] = useState<{ id: string; s?: NodeSummary; failed?: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let tries = 0;

    const load = () =>
      api.summary(id).then(
        (s) => {
          if (!live) return;
          setState({ id, s });

          // A big import's first pass takes minutes: ask again, backing off to every ten seconds.
          if (s.status === 'pending') timer = window.setTimeout(load, Math.min(1000 * 1.5 ** tries++, 10_000));
        },
        () => live && setState({ id, failed: true }),
      );

    void load();

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id, rev]);
  const mine = state?.id === id ? state : null;

  // An indexer from before summaries (or one that's down) still gets the client's own count for groups.
  if (!mine?.s) return mine?.failed && fallback ? <div className="detail-block summary">{fallback}</div> : null;
  const s = mine.s;
  const generated = s.status === 'ready' ? s.generated : undefined;
  // The code's own first sentence leads; a short one ("Retrieve items.") keeps the graph's line after it.
  const text = generated ? generated.text : s.doc ? (s.doc.length < 90 ? `${s.doc} ${s.line}` : s.doc) : s.line;

  const note = generated ? (
    <span title={`Written ${new Date(generated.at).toLocaleString()} from the code and its neighbours`}>generated · {generated.model}</span>
  ) : s.status === 'pending' ? (
    <span className="busy">writing a summary…</span>
  ) : s.status === 'error' ? (
    <span>Couldn't write a summary: {s.error}</span>
  ) : (
    <span>
      {s.doc ? 'its doc comment and the map' : 'from the map'}
      {s.off ? ` · ${s.off}` : ''}
    </span>
  );

  return (
    <div className="detail-block node-summary">
      <p>{text}</p>
      <div className="summary-note">{note}</div>
    </div>
  );
}

/** Who looked at this node without changing it, in words, as the map's dotted ring says it. */
function Looked({ id, activity }: { id: string; activity?: ActivityState | null }) {
  const l = activity?.looked?.[id];

  if (!l) return null;
  const names = [...new Set(l.agents.map((a) => activity!.agents.find((x) => x.id === a)?.name ?? 'an agent'))];

  return (
    <p className="detail-looked">
      <span className="swatch-ring looked" aria-hidden />
      looked at by {names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} · {ago(new Date(l.at).toISOString())}
    </p>
  );
}

const MAX_LINES = 400;
const sources = new Map<string, Promise<SourceText>>();

/**
 * The agent's diff when an agent changed this file or symbol (for a symbol, the
 * hunks that touch it), led by what the change reaches: who calls, imports or
 * requests it, the same links the map rings with dots.
 */
function Changed({
  g,
  graph,
  graphIndex,
  activity,
  shown,
  reviewing,
}: {
  g: GraphNode;
  graph: Graph;
  graphIndex: Map<string, GraphNode>;
  activity?: ActivityState | null;
  shown?: ActivityState['nodes'];
  reviewing?: Props['reviewing'];
}) {
  // On a review tour, the reviewed agent's diff and its own kind of change, not the latest of any agent's.
  const tour = reviewing?.stop.target === g.id ? reviewing : null;
  const code = g.kind === 'file' || g.kind === 'symbol';
  // With one agent lit, only its changes say what they reach, as only they ripple on the map.
  const nodes = shown ?? activity?.nodes;
  const shownOwn = code ? nodes?.[g.id] : undefined;
  const reach = useMemo(() => (shownOwn && shownOwn.kind !== 'deleted' ? reachSentences(g, graph.edges, graphIndex, nodes) : []), [shownOwn, g, graph, graphIndex, nodes]);

  // Something deleted on the tour stands on what's left (a file on its folder, a function on its
  // file): its own diff under it, and for a function only the hunks that take it away.
  // The file's first function on the tour also shows the hunks none of its changed functions accounts for.
  const rest = tour?.stop.rest?.map((id): HunkOwner => {
    const n = graphIndex.get(id);
    const oldLines = tour.stop.restOld?.[id];

    return n?.kind === 'symbol' && n.lines ? ownerOf(n.lines, oldLines) : { name: id.slice(id.indexOf('#') + 1), oldLines };
  });

  // Another agent's changes in the file are left out of this one's diff.
  const p = tour?.stop.peer;

  const peer: Theirs | undefined = p && {
    owners: p.ids.map((id): HunkOwner => {
      const n = graphIndex.get(id);

      return n?.kind === 'symbol' && n.lines ? ownerOf(n.lines, p.old?.[id]) : { oldLines: p.old?.[id] };
    }),
    top: p.top,
    // A class left out for its method on this stop: its rows (a field) are this agent's, not the other agent's other code.
    mine: (tour.stop.carries ?? [])
      .filter((c) => c.id.includes('#'))
      .map((c): HunkOwner => {
        const n = graphIndex.get(c.id);
        const oldLines = tour.stop.restOld?.[c.id];

        return n?.kind === 'symbol' && n.lines ? ownerOf(n.lines, oldLines) : { oldLines };
      }),
  };

  if (tour && tour.stop.id !== g.id) {
    const fn = tour.stop.id.includes('#');

    return (
      <AgentChange
        node={tour.stop.id}
        own={fn ? { name: tour.stop.name, oldLines: tour.stop.old } : undefined}
        rest={rest}
        peer={peer}
        rev={stopRev(tour.stop)}
        kind={tour.stop.kind}
        agent={tour.agent}
        what={fn ? tour.stop.name : tour.stop.path}
        onShown={tour.onShown}
      />
    );
  }

  const own = code ? activity?.nodes[g.id] : null;
  const stop = tour?.stop.id === g.id ? tour : null;

  if (!own && !stop) return null;
  const file = g.kind === 'symbol' ? activity?.nodes[g.parent] : own;

  // Refetched when any agent changes the file; on a tour, never for less than the stop's own change.
  return (
    <AgentChange
      node={g.id}
      own={g.kind === 'symbol' && g.lines ? ownerOf(g.lines, tour?.stop.id === g.id ? tour.stop.old : undefined) : undefined}
      rest={rest}
      peer={peer}
      rev={Math.max(file?.at ?? own?.at ?? 0, stop ? stopRev(stop.stop) : 0)}
      kind={stop ? stop.stop.kind : own!.kind}
      agent={tour?.agent}
      onShown={stop?.onShown}
      reach={reach}
    />
  );
}

/**
 * A file's lines from the indexer's checkout, fetched once per file and commit.
 * `rev` moves when an agent changes the file, which a commit id wouldn't show.
 */
function useSource(repo: string, path: string, commit?: string, rev = 0) {
  const key = `${repo}|${path}|${commit ?? ''}|${rev}`;
  const [state, setState] = useState<{ key: string; text?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!repo || !path) return;
    let live = true;
    let p = sources.get(key);

    if (!p) {
      p = api.source(repo, path);
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
  }, [key, repo, path]);
  const mine = state?.key === key ? state : null;

  return { lines: mine?.text != null ? mine.text.split('\n') : null, error: mine?.error ?? null };
}

/** The node's code: a symbol's lines, or the top of a file, read from the indexer's checkout. */
function Code({ g, repo, rev }: { g: GraphNode; repo?: RepoInfo; rev: number }) {
  const { lines: all, error } = useSource(g.repo, g.path!, repo?.commit, rev);
  const [whole, setWhole] = useState(false);
  useEffect(() => setWhole(false), [g.id]);

  const [a, b] = g.kind === 'symbol' && g.lines && !whole ? g.lines : [1, all?.length ?? 1];
  const shown = all ? all.slice(a - 1, Math.min(b, a - 1 + MAX_LINES)) : [];
  const web = repo && webUrl(repo, g.path!, g.kind === 'symbol' && g.lines ? g.lines : null);

  return (
    <div className="detail-block code-block">
      <div className="code-head">
        <span className="block-title">code</span>
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
      {error && (
        <div className="small muted">
          <span className="err-lead">Couldn't load the source.</span> {error}
        </div>
      )}
      {!all && !error && <div className="muted small busy">loading…</div>}
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
  model: 'inferred by a model',
  fallback: 'no signal',
};

/** What decided a placement; a model's guess says which model, so it reads as inferred rather than found in the code. */
const decidedBy = (p: Placement) => (p.source === 'model' && p.inferredBy ? `inferred by ${modelLabel(p.inferredBy)}` : SOURCE[p.source]);

const explain = (p: Placement) =>
  [p.evidence[0]?.detail, ...p.evidence.slice(1).map((e) => `also ${e.detail}`), `${decidedBy(p)} · ${p.confidence.toFixed(2)}`].filter(Boolean).join(' · ');

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
      <div className="block-title">why it's here</div>
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
  /** Every edge behind this row was guessed, not proven by the code. */
  inferred: boolean;
  reason?: string;
}

function DepList(p: { title: string; items: Dep[]; open: boolean; onFold(): void; graphIndex: Map<string, GraphNode>; self: TNode; onSelect(id: string): void }) {
  const { title, items, graphIndex, self, onSelect } = p;

  if (!items.length) {
    return (
      <div className="dep-col">
        <div className="block-title fold-none" title="The indexer links imports, calls, renders, type uses and HTTP requests it can match to a route. Anything else won't show here.">
          {title} <span className="muted">· none found</span>
        </div>
      </div>
    );
  }

  return (
    <div className="dep-col">
      <button className="block-title fold" onClick={p.onFold} aria-expanded={p.open}>
        {title} <span className="muted num">· {items.length}</span>
        <Chevron dir={p.open ? 'down' : 'right'} size={16} />
      </button>
      {p.open && items.slice(0, 40).map((d) => {
        const other = graphIndex.get(d.id);
        const crossRepo = other && self.repo && other.repo !== self.repo;

        return (
          <button key={d.id + d.kind} className="dep" onClick={() => onSelect(d.id)} title={d.inferred && d.reason ? `${d.id}\ninferred: ${d.reason}` : d.id}>
            <span className="muted">{EDGE_VERB[d.kind]}</span>
            <span className="dep-name">
              {short(d.id)}
              {crossRepo ? <span className="muted"> · {other!.repo}</span> : null}
            </span>
            {d.inferred && <span className="guess">inferred</span>}
          </button>
        );
      })}
      {p.open && items.length > 40 && <div className="muted small">and {items.length - 40} more</div>}
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

  // One row per node on the other side, under its strongest kind of use; inferred only if nothing proves it.
  const keep = (m: Map<string, Dep>, id: string, e: GraphEdge) => {
    const guess = e.basis === 'inferred';
    const cur = m.get(id);

    if (!cur) return void m.set(id, { id, kind: e.kind, inferred: guess, reason: guess ? e.reason : undefined });

    if (KIND_RANK[e.kind] < KIND_RANK[cur.kind]) cur.kind = e.kind;

    if (!guess) cur.inferred = false;
  };

  for (const e of edges) {
    const a = has(e.from);
    const b = has(e.to);

    if (a && !b) keep(uses, e.to, e);
    else if (b && !a) keep(usedBy, e.from, e);
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

function ContractDetail({ graph, graphIndex, tree, contract: c, activity, onSelect }: Props & { contract: Contract }) {
  const [from, to, both] = direction(c);
  const A = tree.nodes.get(from)!;
  const B = tree.nodes.get(to)!;
  const unproven = c.items.filter((e) => !hasEvidence(e)).length;
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
          contract
          {c.cross === c.items.length ? ' · cross-repo' : c.cross ? ` · ${c.cross} cross-repo` : ''}
          {c.inferred ? <span className="guess">{c.inferred === c.items.length ? 'inferred' : `${c.inferred} inferred`}</span> : null}
        </div>
        <div className="contract-ends">
          <button onClick={() => onSelect(A.id)}>{A.name}</button>
          <span className="muted" title={both ? 'Interactions run both ways' : undefined}>
            {both ? '⇄' : '→'}
          </span>
          <button onClick={() => onSelect(B.id)}>{B.name}</button>
        </div>
      </div>
      <div className="call-grid">
        <span className="fact-k">call</span>
        <span>{call.join('; ')}.</span>
        <span className="fact-k">response</span>
        <span>{response}</span>
      </div>
      {unproven > 0 && (
        <div className="detail-block no-evidence">
          {unproven === c.items.length ? (
            <>
              <span className="lead">No evidence found.</span> The indexer recorded this link without the lines of code behind it, so treat it as unverified.
            </>
          ) : (
            <>
              <span className="lead">No evidence found</span> for {unproven} of these {c.items.length} interactions; they are marked below.
            </>
          )}
        </div>
      )}
      <div className="detail-block">
        <div className="block-title">
          interactions <span className="muted num">· {c.items.length}</span>
        </div>
        {c.items.slice(0, 80).map((e, i) => (
          // Rows are marked only when the contract mixes proven and guessed interactions; otherwise the header says it.
          <Interaction
            key={`${c.key}|${i}`}
            e={e}
            graph={graph}
            graphIndex={graphIndex}
            tree={tree}
            open={c.items.length === 1}
            mark={c.inferred > 0 && c.inferred < c.items.length}
            markUnproven={unproven > 0 && unproven < c.items.length}
            activity={activity}
            onSelect={onSelect}
          />
        ))}
        {c.items.length > 80 && <div className="muted small">and {c.items.length - 80} more</div>}
      </div>
    </aside>
  );
}

const EVIDENCE_LABEL: Record<EdgeEvidenceSource, string> = {
  import: 'import',
  call: 'call',
  jsx: 'renders',
  'type-ref': 'type',
  reference: 'use',
  request: 'request',
  route: 'route',
  mount: 'mount',
  constant: 'constant',
  orm: 'orm',
};

/** Evidence means lines of code; a reason on its own is the indexer's prose, not proof. */
const hasEvidence = (e: GraphEdge) => !!e.evidence?.length;

/** One underlying edge: its two ends, and on demand how the indexer knows about it. */
function Interaction(p: {
  e: GraphEdge;
  graph: Graph;
  graphIndex: Map<string, GraphNode>;
  tree: Tree;
  open: boolean;
  mark: boolean;
  markUnproven: boolean;
  activity?: ActivityState | null;
  onSelect(id: string): void;
}) {
  const { e, graph, graphIndex, tree, open, onSelect } = p;
  const [shown, setShown] = useState(open);
  const [line, setLine] = useState<number | null>(null);
  const guess = p.mark && e.basis === 'inferred';
  const proven = hasEvidence(e);
  const why = proven || !!e.reason;

  return (
    <div className="interaction-wrap">
      <div className="interaction" title={`${e.from} → ${e.to}`}>
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
        {guess && <span className="guess">inferred</span>}
        {!proven && p.markUnproven && (
          <span className="guess" title="The indexer recorded this interaction without the code behind it">
            no evidence
          </span>
        )}
        {why && (
          <button className="link why" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
            {shown ? 'hide' : 'why'}
          </button>
        )}
      </div>
      {shown && why && (
        <div className="evidence">
          {e.reason && (
            <div className="muted small">
              {e.reason}
              {e.confidence != null && <span className="num"> · {e.confidence.toFixed(2)}</span>}
            </div>
          )}
          {(e.evidence ?? []).map((ev, i) => (
            <div key={i}>
              <button className="ev" onClick={() => setLine((cur) => (cur === i ? null : i))} aria-expanded={line === i} title={`${ev.file}:${ev.line}`}>
                <span className="ev-src">{EVIDENCE_LABEL[ev.source] ?? ev.source}</span>
                <span className="ev-body">
                  <span className="ev-at">
                    {short(ev.file)}:{ev.line}
                    {ev.note && <span className="muted"> · {ev.note}</span>}
                  </span>
                  {ev.code && <span className="ev-code">{ev.code}</span>}
                </span>
              </button>
              {line === i && <Snippet ev={ev} graph={graph} graphIndex={graphIndex} tree={tree} rev={p.activity?.nodes[ev.file]?.at ?? 0} onSelect={onSelect} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CONTEXT = 4;

/** A few lines either side of one piece of evidence, read through the indexer's source route. */
function Snippet(p: { ev: EdgeEvidence; graph: Graph; graphIndex: Map<string, GraphNode>; tree: Tree; rev: number; onSelect(id: string): void }) {
  const { ev, graph, graphIndex, tree, onSelect } = p;
  const file = graphIndex.get(ev.file);
  const repo = graph.repos.find((r) => r.id === file?.repo);
  const { lines, error } = useSource(file?.repo ?? '', file?.path ?? '', repo?.commit, p.rev);

  // Go to the innermost symbol around the line, which both views have; the file itself only
  // exists in the code view, so fall back to it only when it's on this map.
  const target = useMemo(() => {
    let best: GraphNode | null = null;

    for (const n of graph.nodes) {
      if (n.kind !== 'symbol' || !n.lines || !n.id.startsWith(ev.file + '#') || n.lines[0] > ev.line || n.lines[1] < ev.line) continue;

      if (!best || n.lines[1] - n.lines[0] < best.lines![1] - best.lines![0]) best = n;
    }

    const id = best?.id ?? ev.file;
    const at = locate(tree, graphIndex, id);

    return at && at !== 'root' ? id : null;
  }, [graph, graphIndex, tree, ev]);

  if (!file?.path) return <div className="muted small snippet">That file isn't in the map.</div>;
  const a = Math.max(1, ev.line - CONTEXT);
  const b = lines ? Math.min(lines.length, ev.line + CONTEXT) : a;
  const web = repo && webUrl(repo, file.path, [ev.line, ev.line]);

  return (
    <div className="snippet">
      {error && (
        <div className="small muted">
          <span className="err-lead">Couldn't load the source.</span> {error}
        </div>
      )}
      {!lines && !error && <div className="muted small busy">loading…</div>}
      {lines && (
        <pre className="code">
          {lines.slice(a - 1, b).map((text, i) => (
            <div key={i} className={a + i === ev.line ? 'hl' : ''}>
              <span className="ln">{a + i}</span>
              {text || ' '}
            </div>
          ))}
        </pre>
      )}
      <div className="row gap">
        {target && (
          <button className="link" onClick={() => onSelect(target)}>
            show {short(target)} on the map
          </button>
        )}
        <span className="grow" />
        {web && (
          <a className="link" href={web} target="_blank" rel="noreferrer">
            open on GitHub ↗
          </a>
        )}
      </div>
    </div>
  );
}
