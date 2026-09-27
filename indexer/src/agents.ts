// What coding agents are doing, as the map sees it. Events arrive from the
// agent package (its MCP server and tool hooks); this keeps one record per
// agent (a client in a working tree), maps the files it changed onto graph
// nodes, works out which symbols each change touched, re-indexes changed
// files of local repositories, and pushes the result to the map.
//
// Nothing here is persisted: activity is live state, and a restarted indexer
// starts with an empty queue.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ActivityState,
  AgentActivity,
  AgentEvent,
  AgentFile,
  AgentRef,
  AgentState,
  AgentStep,
  ChangeKind,
  FileChange,
  Graph,
  GraphNode,
  LineRange,
  NodeChange,
} from '@strata/shared';
import { fileId, symbolIds } from './link.ts';
import { parseFile } from './parse/index.ts';
import type { Workspace } from './workspace.ts';

const exec = promisify(execFile);

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', cli: 'Script', mcp: 'Agent' };
/** Symbol names/lines in HEAD's version of a file, keyed by symbol id. */
type SymbolLines = Map<string, { name: string; lines: [number, number] }>;

interface FileRec {
  /** `${repo}/${rel}` for files in an imported repository, else the absolute path. */
  key: string;
  abs: string;
  repo?: string;
  rel?: string;
  kind: ChangeKind;
  lines?: LineRange[];
  oldLines?: LineRange[];
  additions?: number;
  deletions?: number;
  diff?: string;
  /** Symbol names the agent named itself. */
  named: string[];
  at: number;
  /** The graph holds this version of the file (it was re-indexed after the change), so `lines` apply. */
  fresh: boolean;
  /** Can be re-indexed: a local repo the agent edits in place. */
  live: boolean;
  /** Symbols before the agent's changes, from HEAD; null when there's no HEAD version to read. */
  base: SymbolLines | null;
}

interface AgentRec {
  id: string;
  ref: AgentRef;
  state: AgentState;
  task?: string;
  prompt?: string;
  note?: string;
  steps: AgentStep[];
  files: Map<string, FileRec>;
  startedAt: number;
  updatedAt: number;
}

export interface IngestReply {
  files: { path: string; repo?: string; node?: string; kind: string; symbols?: number }[];
}

export const agentKey = (ref: AgentRef) => `${ref.client}@${ref.root ?? ref.cwd}`;

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const posix = (p: string) => p.split(path.sep).join('/');

/** "github.com/org/repo" from any spelling of a remote URL. */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

/** Whether a changed-line range touches a symbol's lines. Pure removals only count strictly inside it. */
export function touches(sym: [number, number], ranges: LineRange[]): boolean {
  const [s, e] = sym;
  return ranges.some(([a, b]) => (b >= a ? a <= e && b >= s : s < a && a <= e));
}

export class AgentHub {
  private agents = new Map<string, AgentRec>();
  private version = 0;
  private listeners = new Set<(s: ActivityState) => void>();
  private cached: { version: number; graph: number; state: ActivityState } | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private pendingIndex = new Map<string, Set<string>>();
  private indexTimer: NodeJS.Timeout | null = null;
  private realSources = new Map<string, string>();
  private remotes = new Map<string, Promise<string | null>>();

  constructor(private ws: Workspace) {
    ws.onGraph(() => this.push());
  }

  // ── events ──

  async ingest(events: AgentEvent[]): Promise<IngestReply> {
    const reply: IngestReply = { files: [] };
    for (const ev of events) {
      if (!ev?.agent || typeof ev.agent.cwd !== 'string' || typeof ev.agent.client !== 'string') continue;
      const rec = this.agentFor(ev.agent);
      const now = ev.at ? Date.parse(ev.at) || Date.now() : Date.now();
      rec.updatedAt = now;
      switch (ev.type) {
        case 'session':
          if (ev.phase === 'start') {
            if (ev.agent.session && ev.agent.session !== rec.ref.session) Object.assign(rec, { task: undefined, prompt: undefined, note: undefined, steps: [] });
            rec.state = 'waiting';
          } else {
            rec.state = 'ended';
            // Nothing left to review: the agent goes from the queue.
            if (!rec.files.size) this.agents.delete(rec.id);
          }
          break;
        case 'prompt':
          rec.prompt = ev.text || rec.prompt;
          rec.task = undefined;
          rec.note = undefined;
          if (rec.steps.every((s) => s.status === 'done')) rec.steps = [];
          rec.state = 'working';
          break;
        case 'task':
          this.applyTask(rec, ev);
          break;
        case 'step': {
          const i = rec.steps.findIndex((s) => s.id === ev.id);
          if (ev.status === 'removed') {
            if (i >= 0) rec.steps.splice(i, 1);
          } else if (i >= 0) {
            const s = rec.steps[i];
            rec.steps[i] = { ...s, text: ev.text ?? s.text, activeText: ev.activeText ?? s.activeText, status: ev.status ?? s.status };
          } else if (ev.text) rec.steps.push({ id: ev.id, text: ev.text, activeText: ev.activeText, status: ev.status ?? 'pending' });
          rec.state = 'working';
          break;
        }
        case 'changes':
          for (const f of ev.files ?? []) {
            const out = await this.applyChange(rec, f, now);
            if (out) reply.files.push(out);
          }
          break;
        case 'state':
          rec.state = ev.state;
          break;
      }
      rec.ref = { ...rec.ref, ...ev.agent, session: ev.agent.session ?? rec.ref.session };
    }
    this.version++;
    this.push();
    return reply;
  }

  private agentFor(ref: AgentRef): AgentRec {
    const id = agentKey(ref);
    let rec = this.agents.get(id);
    if (!rec) {
      rec = { id, ref, state: 'working', steps: [], files: new Map(), startedAt: Date.now(), updatedAt: Date.now() };
      this.agents.set(id, rec);
    }
    return rec;
  }

  private applyTask(rec: AgentRec, ev: Extract<AgentEvent, { type: 'task' }>) {
    if (ev.task !== undefined) rec.task = ev.task || undefined;
    if (ev.note !== undefined) rec.note = ev.note || undefined;
    if (ev.steps) {
      // Keep ids from an earlier plan when the text matches, so the list doesn't reshuffle.
      rec.steps = ev.steps.map((s) => ({ ...rec.steps.find((o) => o.text === s.text), ...s }));
    }
    if (ev.step) {
      const want = ev.step.trim().toLowerCase();
      let i = rec.steps.findIndex((s) => s.text.trim().toLowerCase() === want || s.activeText?.trim().toLowerCase() === want);
      if (i < 0) {
        rec.steps.push({ text: ev.step, status: 'active' });
        i = rec.steps.length - 1;
      }
      rec.steps.forEach((s, j) => {
        if (j === i) s.status = 'active';
        else if (s.status === 'active' || j < i) s.status = 'done';
      });
    }
    rec.state = ev.state ?? 'working';
    if (ev.state === 'waiting') for (const s of rec.steps) s.status = 'done';
  }

  private async applyChange(rec: AgentRec, f: FileChange, now: number): Promise<IngestReply['files'][number] | null> {
    if (!f || typeof f.path !== 'string') return null;
    const where = await this.resolve(rec.ref, f);
    const key = where.repo ? `${where.repo}/${where.rel}` : where.abs;
    const shown = where.rel ?? where.abs;
    if (f.kind === 'reverted') {
      rec.files.delete(key);
      if (where.live) this.reindex(where.repo!, where.rel!);
      return { path: shown, repo: where.repo, kind: 'reverted' };
    }
    const kind: ChangeKind = f.kind === 'added' || f.kind === 'deleted' ? f.kind : 'modified';
    let file = rec.files.get(key);
    if (!file) {
      file = {
        key,
        abs: where.abs,
        repo: where.repo,
        rel: where.rel,
        kind,
        named: [],
        at: now,
        fresh: false,
        live: where.live,
        base: where.repo ? await this.baseSymbols(where.repo, where.rel!, where.live, kind) : null,
      };
      rec.files.set(key, file);
    }
    Object.assign(file, {
      kind,
      lines: f.lines,
      oldLines: f.oldLines,
      additions: f.additions,
      deletions: f.deletions,
      diff: typeof f.diff === 'string' ? f.diff : file.diff,
      at: now,
      fresh: false,
    });
    if (Array.isArray(f.symbols)) file.named = [...new Set([...file.named, ...f.symbols.filter((s) => typeof s === 'string')])];
    if (where.live) this.reindex(where.repo!, where.rel!);
    const ix = this.index(this.ws.getGraph());
    const node = where.repo && ix.nodes.has(key) ? key : undefined;
    return { path: shown, repo: where.repo, node, kind, symbols: node ? this.symbolsOf(file, ix).length : undefined };
  }

  /** Which imported repository a changed file belongs to, and whether Strata reads that very directory. */
  private async resolve(ref: AgentRef, f: FileChange): Promise<{ abs: string; repo?: string; rel?: string; live: boolean }> {
    const abs = path.resolve(ref.root ?? ref.cwd, f.path);
    for (const r of this.ws.repos) {
      if (r.kind !== 'local') continue;
      const src = this.realSource(r.source);
      if (inside(abs, src) && abs !== src) return { abs, repo: r.id, rel: posix(path.relative(src, abs)), live: true };
    }
    // Another checkout of an imported repository: match it by remote, then by folder name.
    const co = f.checkout ?? (ref.root && inside(abs, ref.root) ? { root: ref.root, remote: ref.remote } : null);
    if (co && inside(abs, co.root)) {
      const rel = posix(path.relative(co.root, abs));
      if (co.remote) {
        const want = remoteKey(co.remote);
        for (const r of this.ws.repos) {
          const theirs = r.kind === 'git' ? r.source : await this.localRemote(r.source);
          if (theirs && remoteKey(theirs) === want) return { abs, repo: r.id, rel, live: false };
        }
      }
      const named = this.ws.repos.find((r) => r.name === path.basename(co.root));
      if (named) return { abs, repo: named.id, rel, live: false };
    }
    return { abs, live: false };
  }

  private realSource(src: string) {
    let real = this.realSources.get(src);
    if (!real) {
      try {
        real = fs.realpathSync(src);
      } catch {
        real = src;
      }
      this.realSources.set(src, real);
    }
    return real;
  }

  private localRemote(dir: string): Promise<string | null> {
    let p = this.remotes.get(dir);
    if (!p) {
      p = exec('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5000 }).then((r) => r.stdout.trim() || null, () => null);
      this.remotes.set(dir, p);
    }
    return p;
  }

  /**
   * The file's symbols before the agent touched it: parsed from HEAD for a
   * local repo, else what the graph has now (a clone is at HEAD already).
   * An added file had none.
   */
  private async baseSymbols(repo: string, rel: string, live: boolean, kind: ChangeKind): Promise<SymbolLines | null> {
    if (kind === 'added') return new Map();
    const fid = fileId(repo, rel);
    if (live) {
      const root = this.ws.rootOf(repo);
      const text = root
        ? await exec('git', ['-C', root, 'show', `HEAD:${rel}`], { maxBuffer: 16 << 20, timeout: 5000 }).then((r) => r.stdout, () => null)
        : null;
      if (text != null) {
        const parsed = await parseFile(rel, text).catch(() => null);
        if (!parsed) return new Map();
        const ids = symbolIds(fid, parsed);
        return new Map(parsed.symbols.map((s, i) => [ids[i], { name: s.name, lines: s.lines }]));
      }
    }
    const syms = this.index(this.ws.getGraph()).symbols.get(fid);
    return syms ? new Map(syms.map((s) => [s.id, { name: s.name, lines: s.lines ?? [0, 0] }])) : null;
  }

  /** Re-indexes changed files of local repos, a moment after the last change so a burst of edits is one rebuild. */
  private reindex(repo: string, rel: string) {
    let set = this.pendingIndex.get(repo);
    if (!set) this.pendingIndex.set(repo, (set = new Set()));
    set.add(rel);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => void this.flushIndex(), 250);
  }

  private async flushIndex() {
    this.indexTimer = null;
    const batches = [...this.pendingIndex];
    this.pendingIndex.clear();
    for (const [repo, rels] of batches) {
      await this.ws.updateFiles(repo, [...rels]);
      for (const rec of this.agents.values()) for (const f of rec.files.values()) if (f.repo === repo && rels.has(f.rel!)) f.fresh = true;
    }
    this.version++;
    this.push();
  }

  // ── reading ──

  clear(id?: string) {
    if (id) this.agents.delete(id);
    else this.agents.clear();
    this.version++;
    this.push();
  }

  /** Diffs agents hold for one file (or the file a symbol is in). */
  diffs(nodeId: string): { agent: string; name: string; kind: ChangeKind; additions?: number; deletions?: number; diff?: string; at: string }[] {
    const key = nodeId.includes('#') ? nodeId.slice(0, nodeId.indexOf('#')) : nodeId;
    const out = [];
    for (const rec of this.agents.values()) {
      const f = rec.files.get(key);
      if (f) out.push({ agent: rec.id, name: NAMES[rec.ref.client] ?? rec.ref.client, kind: f.kind, additions: f.additions, deletions: f.deletions, diff: f.diff, at: new Date(f.at).toISOString() });
    }
    return out;
  }

  subscribe(fn: (s: ActivityState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private push() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (!this.listeners.size) return;
      const s = this.state();
      for (const fn of this.listeners) fn(s);
    }, 60);
  }

  private indexCache: { graph: Graph; nodes: Set<string>; symbols: Map<string, GraphNode[]>; folders: Map<string, string> } | null = null;

  private index(graph: Graph) {
    if (this.indexCache?.graph === graph) return this.indexCache;
    const nodes = new Set<string>();
    const symbols = new Map<string, GraphNode[]>();
    const folders = new Map<string, string>(); // `${repo}/${dir}` → folder node id, for every dir a collapsed folder covers
    for (const n of graph.nodes) {
      nodes.add(n.id);
      if (n.kind === 'symbol') {
        const list = symbols.get(n.parent) ?? [];
        list.push(n);
        symbols.set(n.parent, list);
      } else if (n.kind === 'folder' && n.path) folders.set(`${n.repo}/${n.path}`, n.id);
    }
    return (this.indexCache = { graph, nodes, symbols, folders });
  }

  /** Nearest folder (or the repo) in the graph for a path that isn't there itself. */
  private anchor(ix: ReturnType<AgentHub['index']>, repo: string, rel: string): string {
    for (let d = path.posix.dirname(rel); d && d !== '.'; d = path.posix.dirname(d)) {
      const hit = ix.folders.get(`${repo}/${d}`) ?? (ix.nodes.has(`${repo}/${d}`) ? `${repo}/${d}` : undefined);
      if (hit) return hit;
    }
    return repo;
  }

  /** The symbols a file change touches, each with its own change kind. */
  private symbolsOf(f: FileRec, ix: ReturnType<AgentHub['index']>): AgentFile['symbols'] {
    if (!f.repo) return [];
    const fid = fileId(f.repo, f.rel!);
    const now = ix.symbols.get(fid) ?? [];
    const base = f.base;
    const out: AgentFile['symbols'] = [];
    const named = new Set(f.named);
    if (f.kind === 'deleted') {
      if (base) for (const [id, s] of base) out.push({ id, name: s.name, kind: 'deleted' });
      else for (const s of now) out.push({ id: s.id, name: s.name, kind: 'deleted' });
      return out;
    }
    // Once a local file is re-indexed the graph has the new version, so the new-side
    // lines apply; until then, and for clones Strata doesn't re-index, it has HEAD's.
    const newSide = f.live && f.fresh ? f.lines : f.oldLines;
    for (const s of now) {
      const rawName = s.id.slice(s.id.indexOf('#') + 1).replace(/~\d+$/, '');
      if (f.kind === 'added' || (f.fresh && base && !base.has(s.id))) out.push({ id: s.id, name: s.name, kind: 'added' });
      else if ((s.lines && newSide && touches(s.lines, newSide)) || named.has(rawName) || named.has(s.name)) out.push({ id: s.id, name: s.name, kind: 'modified' });
    }
    if (f.fresh && base) {
      const nowIds = new Set(now.map((s) => s.id));
      for (const [id, s] of base) if (!nowIds.has(id)) out.push({ id, name: s.name, kind: 'deleted' });
    }
    return out;
  }

  state(): ActivityState {
    const graph = this.ws.getGraph();
    if (this.cached && this.cached.version === this.version && this.cached.graph === this.ws.version) return this.cached.state;
    const ix = this.index(graph);
    const nodes: Record<string, NodeChange> = {};
    const mark = (id: string, c: Omit<NodeChange, 'agents'>, agent: string) => {
      const cur = nodes[id];
      if (!cur) nodes[id] = { ...c, agents: [agent] };
      else {
        if (!cur.agents.includes(agent)) cur.agents.push(agent);
        if (c.at >= cur.at) Object.assign(cur, { kind: c.kind, at: c.at });
      }
    };
    const agents: AgentActivity[] = [];
    for (const rec of this.agents.values()) {
      const files: AgentFile[] = [];
      for (const f of [...rec.files.values()].sort((a, b) => b.at - a.at)) {
        const symbols = this.symbolsOf(f, ix);
        let node: string | undefined;
        if (f.repo) {
          const fid = fileId(f.repo, f.rel!);
          const folder = ix.folders.get(fid);
          node = ix.nodes.has(fid) ? fid : folder;
          mark(node ?? fid, { kind: f.kind, at: f.at, unit: 'file', anchor: node ? undefined : this.anchor(ix, f.repo, f.rel!) }, rec.id);
          for (const s of symbols) mark(s.id, { kind: s.kind, at: f.at, unit: 'symbol', anchor: ix.nodes.has(s.id) ? undefined : (node ?? this.anchor(ix, f.repo, f.rel!)) }, rec.id);
        }
        files.push({
          repo: f.repo,
          path: f.rel ?? f.abs,
          node,
          kind: f.kind,
          additions: f.additions,
          deletions: f.deletions,
          symbols,
          at: new Date(f.at).toISOString(),
          diff: !!f.diff,
        });
      }
      const root = rec.ref.root ?? rec.ref.cwd;
      const repo = this.ws.repos.find((r) => r.kind === 'local' && this.realSource(r.source) === root);
      agents.push({
        id: rec.id,
        client: rec.ref.client,
        name: NAMES[rec.ref.client] ?? rec.ref.client,
        where: repo?.id ?? path.basename(root),
        cwd: rec.ref.cwd,
        state: rec.state,
        task: rec.task,
        prompt: rec.prompt,
        note: rec.note,
        steps: rec.steps,
        files,
        startedAt: new Date(rec.startedAt).toISOString(),
        updatedAt: new Date(rec.updatedAt).toISOString(),
      });
    }
    agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const state: ActivityState = { version: this.version, graphVersion: this.ws.version, agents, nodes };
    this.cached = { version: this.version, graph: this.ws.version, state };
    return state;
  }
}
