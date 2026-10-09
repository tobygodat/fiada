// What coding agents are doing, as the map sees it. Events arrive from the
// agent package (its MCP server and tool hooks); this keeps one record per
// agent (a client's session in a working tree), maps the files it changed onto graph
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
  AgentNow,
  AgentRef,
  AgentState,
  AgentStep,
  ChangeKind,
  FileChange,
  Graph,
  GraphNode,
  LineRange,
  NodeChange,
} from '@fiada/shared';
import { fileId, symbolIds } from './link.ts';
import { parseFile } from './parse/index.ts';
import { DEFAULT_LOAD, fileWithin, sourcePaths } from './sources.ts';
import type { Workspace } from './workspace.ts';

const exec = promisify(execFile);

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', cli: 'Script', mcp: 'Agent' };
/** Symbol names/lines in HEAD's version of a file, keyed by symbol id, with the layer the map gave each. */
type SymbolLines = Map<string, { name: string; lines: [number, number]; layer?: string }>;

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
  /** Only ever seen in a working-tree sweep, never named by a tool: another agent may have made it. */
  swept: boolean;
  /** The file's lines as last re-indexed, to tell which symbols' own text changed. */
  text: string[] | null;
  /**
   * The re-index for the latest change is in and can be read: with its text, or with the file
   * gone from the graph (deleted, or no longer something the indexer reads), so nothing is left to compare.
   */
  settled: boolean;
  /**
   * Each touched symbol's own change time: moved on only when the symbol's text changes, so
   * editing one function doesn't make the others in the file new again. `sig` is null until the
   * re-indexed text is in.
   */
  symAt: Map<string, Stamp>;
  /** The same for the file's code outside every symbol (imports, constants), or null before the first look. */
  topAt: Stamp | null;
  /** That code as HEAD has it, so a file whose imports are back as they were has no change there; null when unknown. */
  baseTop: string | null;
  /** Counts the changes reported, so a re-index that began before the latest one doesn't settle it. */
  gen: number;
  /** `gen` when a re-index last settled the file for this agent: equal while it has changed nothing since. */
  settledGen: number;
}

/** A file's code outside every symbol, blank lines aside: its imports and constants. */
function outside(text: string[], spans: ([number, number] | undefined)[]): string {
  // How many symbols cover each line, from one pass over the spans: a big generated file has
  // thousands of both, and a scan per line would be their product.
  const depth = new Int32Array(text.length + 2);
  for (const l of spans) {
    if (!l) continue;
    depth[Math.max(1, l[0])]++;
    depth[Math.min(text.length + 1, l[1] + 1)]--;
  }
  const out: string[] = [];
  for (let i = 0, d = 0; i < text.length; i++) {
    d += depth[i + 1];
    if (d <= 0 && text[i].trim()) out.push(text[i]);
  }
  return out.join('\n');
}

/** A change time and the text it was taken for (null until the re-indexed text is in). */
type Stamp = { sig: string | null; at: number };

/**
 * Moves a change time on only when the text it was taken for changes. Before its first text is
 * in, every change counts: there is nothing yet to tell which of them touched it.
 */
const advance = (prev: Stamp | null | undefined, sig: string | null, at: number): Stamp =>
  !prev || prev.sig === null ? { sig, at } : sig === null || sig === prev.sig ? prev : { sig, at };

interface AgentRec {
  id: string;
  ref: AgentRef;
  state: AgentState;
  task?: string;
  prompt?: string;
  /** When the prompt came. */
  promptAt: number;
  note?: string;
  /** The agent's own status line this turn, from its `status` tool. */
  said?: Said;
  steps: AgentStep[];
  /** When the plan's active step last changed, so the newer of it and `said` heads the entry. */
  stepAt: number;
  files: Map<string, FileRec>;
  startedAt: number;
  updatedAt: number;
}

export interface IngestReply {
  files: { path: string; repo?: string; node?: string; kind: string; symbols?: number }[];
}

/** A client in a working tree; the sessions of it are told apart by `agentId`. */
export const agentKey = (ref: AgentRef) => `${ref.client}@${ref.root ?? ref.cwd}`;
export const agentId = (ref: AgentRef) => (ref.session ? `${agentKey(ref)}#${ref.session}` : agentKey(ref));

/**
 * Which of `peers` (sessions of one client in one checkout) a reporter with
 * no session of its own belongs to: the one whose hooks share its nearest
 * parent process. Null when that doesn't single one out.
 */
export function sameProcess<T extends { ref: AgentRef }>(procs: number[] | undefined, peers: T[]): T | null {
  for (const pid of procs ?? []) {
    const hits = peers.filter((p) => p.ref.procs?.includes(pid));
    if (hits.length === 1) return hits[0];
    if (hits.length) return null;
  }
  return null;
}

/** A line and when it was said. */
type Said = { text: string; at: number };

/** The active step, as the key that tells when the agent moved to another one. */
const activeKey = (steps: AgentStep[]) => {
  const s = steps.find((x) => x.status === 'active');
  return s ? `${s.id ?? ''}|${s.text}` : '';
};

/**
 * The agent's status line: the newest of its own words, its plan's active
 * step and the user's prompt; on a tie its own words, then the step. A new
 * prompt drops what it said last turn, so until it speaks or its plan moves,
 * the prompt heads the entry.
 */
export function statusLine(said: Said | undefined, steps: AgentStep[], stepAt: number, prompt: Said | undefined): AgentNow | undefined {
  const active = steps.find((s) => s.status === 'active');
  const lines: (Said & { from: AgentNow['from'] })[] = [];
  if (said) lines.push({ ...said, from: 'agent' });
  if (active) lines.push({ text: active.activeText ?? active.text, at: stepAt, from: 'plan' });
  if (prompt) lines.push({ ...prompt, from: 'prompt' });
  const best = lines.reduce<(typeof lines)[number] | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
  return best && { text: best.text, from: best.from, at: new Date(best.at).toISOString() };
}

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
  private offGraph: () => void;

  constructor(private ws: Workspace) {
    this.offGraph = ws.onGraph(() => this.push());
  }

  /** Whether any map is listening. */
  get watched(): boolean {
    return this.listeners.size > 0;
  }

  /** Stops following the workspace and drops pending work; the activity goes with it. */
  close() {
    this.offGraph();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.pushTimer = this.indexTimer = null;
    this.listeners.clear();
  }

  // ── events ──

  async ingest(events: AgentEvent[]): Promise<IngestReply> {
    const reply: IngestReply = { files: [] };
    for (const ev of events) {
      if (!ev?.agent || typeof ev.agent.cwd !== 'string' || typeof ev.agent.client !== 'string') continue;
      const rec = this.agentFor(ev.agent);
      const now = ev.at ? Date.parse(ev.at) || Date.now() : Date.now();
      rec.updatedAt = now;
      const wasActive = activeKey(rec.steps);
      switch (ev.type) {
        case 'session':
          if (ev.phase === 'start') rec.state = 'waiting';
          else {
            rec.state = 'ended';
            // Nothing left to review: the agent goes from the queue.
            if (!rec.files.size) this.agents.delete(rec.id);
          }
          break;
        case 'prompt':
          rec.prompt = ev.text || rec.prompt;
          rec.promptAt = now;
          rec.task = undefined;
          rec.note = undefined;
          // A new turn: last turn's line no longer says what it's doing.
          rec.said = undefined;
          if (rec.steps.every((s) => s.status === 'done')) rec.steps = [];
          rec.state = 'working';
          break;
        case 'task':
          this.applyTask(rec, ev);
          break;
        case 'status':
          if (typeof ev.text === 'string' && ev.text.trim()) rec.said = { text: ev.text.trim(), at: now };
          rec.state = 'working';
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
      if (activeKey(rec.steps) !== wasActive) rec.stepAt = now;
      // A session's processes are its hooks'; an MCP server matched to it keeps them.
      const procs = ev.agent.session || !rec.ref.session ? (ev.agent.procs ?? rec.ref.procs) : rec.ref.procs;
      rec.ref = { ...rec.ref, ...ev.agent, session: ev.agent.session ?? rec.ref.session, procs };
    }
    this.version++;
    this.push();
    return reply;
  }

  /**
   * The record for an event's agent. Each session of a client is its own
   * agent, even in the same checkout. A reporter without a session (an MCP
   * server) joins the session it runs beside: the one sharing its parent
   * process, else the latest active one; failing both it gets a record of
   * its own, which the session's hooks take over when they first report.
   */
  private agentFor(ref: AgentRef): AgentRec {
    const key = agentKey(ref);
    const fresh = (id: string): AgentRec => ({ id, ref, state: 'working', steps: [], stepAt: 0, promptAt: 0, files: new Map(), startedAt: Date.now(), updatedAt: Date.now() });
    if (ref.session) {
      const id = agentId(ref);
      let rec = this.agents.get(id);
      if (!rec) {
        const early = this.agents.get(key);
        // Unless the early reporter's parent process is plainly not this session's.
        const theirs = early && (!early.ref.procs?.length || !ref.procs || ref.procs.includes(early.ref.procs[0]));
        if (early && theirs) {
          this.agents.delete(key);
          rec = Object.assign(early, { id });
        } else rec = fresh(id);
        this.agents.set(id, rec);
      }
      return rec;
    }
    const peers = [...this.agents.values()].filter((r) => r.ref.session && r.state !== 'ended' && agentKey(r.ref) === key);
    const joined = sameProcess(ref.procs, peers) ?? (peers.length ? peers.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)) : null);
    if (joined) return joined;
    let rec = this.agents.get(key);
    if (!rec) this.agents.set(key, (rec = fresh(key)));
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
    const swept = f.swept === true;
    let file = rec.files.get(key);
    const others = [...this.agents.values()].filter((r) => r !== rec && r.files.has(key));
    if (!file && swept && others.some((r) => r.state !== 'ended' && !r.files.get(key)!.swept)) {
      // Seen in the working tree, but another live agent in it named this file itself: that agent's change.
      return { path: shown, repo: where.repo, kind: 'elsewhere' };
    }
    if (!swept) {
      // Named by this agent's own tool: an agent that only swept it up was wrong to claim it.
      for (const r of others) if (r.files.get(key)!.swept) r.files.delete(key);
    }
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
        ...(where.repo ? await this.baseSymbols(where.repo, where.rel!, where.live, kind) : { base: null, baseTop: null }),
        swept,
        text: null,
        settled: false,
        symAt: new Map(),
        topAt: null,
        gen: 0,
        settledGen: -1,
      };
      rec.files.set(key, file);
    }
    if (!swept) file.swept = false;
    Object.assign(file, {
      kind,
      lines: f.lines,
      oldLines: f.oldLines,
      additions: f.additions,
      deletions: f.deletions,
      diff: typeof f.diff === 'string' ? f.diff : file.diff,
      at: now,
      fresh: false,
      settled: false,
      gen: file.gen + 1,
    });
    if (Array.isArray(f.symbols)) file.named = [...new Set([...file.named, ...f.symbols.filter((s) => typeof s === 'string')])];
    if (where.live) this.reindex(where.repo!, where.rel!);
    const ix = this.index(this.ws.getGraph());
    const node = where.repo && ix.nodes.has(key) ? key : undefined;
    return { path: shown, repo: where.repo, node, kind, symbols: node ? this.symbolsOf(file, ix).length : undefined };
  }

  /** Which imported repository a changed file belongs to, and whether Fiada reads that very directory. */
  private async resolve(ref: AgentRef, f: FileChange): Promise<{ abs: string; repo?: string; rel?: string; live: boolean }> {
    const abs = path.resolve(ref.root ?? ref.cwd, f.path);
    for (const r of this.ws.repos) {
      if (r.kind !== 'local' || !this.ws.allowLocal) continue;
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
          const theirs = r.kind === 'git' ? r.source : r.kind === 'upload' ? (r.remote ?? null) : this.ws.allowLocal ? await this.localRemote(r.source) : null;
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
   * An added file had none. Each keeps the layer the map has for it now, while
   * the graph still holds the file as it was, so a deleted symbol is read with it.
   */
  private async baseSymbols(repo: string, rel: string, live: boolean, kind: ChangeKind): Promise<{ base: SymbolLines | null; baseTop: string | null }> {
    if (kind === 'added') return { base: new Map(), baseTop: '' };
    const fid = fileId(repo, rel);
    const syms = this.index(this.ws.getGraph()).symbols.get(fid);
    const layer = new Map(syms?.map((s) => [s.id, s.layer?.id]));
    if (live) {
      const root = this.ws.rootOf(repo);
      const text = root
        ? await exec('git', ['-C', root, 'show', `HEAD:${rel}`], { maxBuffer: 16 << 20, timeout: 5000 }).then((r) => r.stdout, () => null)
        : null;
      if (text != null) {
        const parsed = await parseFile(rel, text).catch(() => null);
        if (!parsed) return { base: new Map(), baseTop: null };
        const ids = symbolIds(fid, parsed);
        return {
          base: new Map(parsed.symbols.map((s, i) => [ids[i], { name: s.name, lines: s.lines, layer: layer.get(ids[i]) }])),
          baseTop: outside(text.split('\n'), parsed.symbols.map((s) => s.lines)),
        };
      }
    }
    return { base: syms ? new Map(syms.map((s) => [s.id, { name: s.name, lines: s.lines ?? [0, 0], layer: s.layer?.id }])) : null, baseTop: null };
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
      const source = this.ws.repos.find((r) => r.id === repo)?.source;
      // Only source the indexer reads too (a symbol's text is all it's for), so neither a large
      // artifact nor generated code, a test or an ignored file is ever read here.
      const wanted = source ? await sourcePaths(this.realSource(source), [...rels]) : new Set<string>();
      const read = async () => {
        const text = new Map<string, string | null>();
        for (const rel of rels) {
          // Read as untrusted: only a regular file inside the repository.
          const at = source && wanted.has(rel) ? await fileWithin(this.realSource(source), rel) : null;
          text.set(rel, at && at.size <= DEFAULT_LOAD.maxFileBytes ? await fs.promises.readFile(at.abs, 'utf8').catch(() => null) : null);
        }
        return text;
      };
      const files = [...this.agents.values()].flatMap((rec) => [...rec.files.values()].filter((f) => f.repo === repo && rels.has(f.rel!)));
      const gens = new Map(files.map((f) => [f, f.gen]));
      const before = await read();
      await this.ws.updateFiles(repo, [...rels]);
      const after = await read();
      const ix = this.index(this.ws.getGraph());
      const own: FileRec[] = [];
      const others: FileRec[] = [];
      for (const f of files) {
        // A change reported meanwhile has its own re-index coming: this one is already behind it.
        if (gens.get(f) !== f.gen) continue;
        f.fresh = true;
        // The text the graph was built from, only when it held still the whole time (else it may
        // not match), and only for a file the indexer took in (else no symbol needs it).
        const text = after.get(f.rel!);
        const indexed = ix.nodes.has(fileId(repo, f.rel!));
        f.text = text != null && text === before.get(f.rel!) && indexed ? text.split('\n') : null;
        f.settled = !!f.text || !indexed;
        (f.settledGen === f.gen ? others : own).push(f);
        f.settledGen = f.gen;
      }
      // This agent's own change: stamped now, while the graph and text are this change's, so a
      // later change before anyone looks at the map doesn't take its time.
      for (const f of own) this.stamp(f, this.symbolsOf(f, ix), ix, true);
      // Another agent's change to a file this agent changed too: its text is this agent's new
      // baseline, so the other agent's edit never counts as this one's next change.
      for (const f of others) this.rebase(f, ix);
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
    const names = this.names();
    const out = [];
    for (const rec of this.agents.values()) {
      const f = rec.files.get(key);
      if (f) out.push({ agent: rec.id, name: names.get(rec.id)!, kind: f.kind, additions: f.additions, deletions: f.deletions, diff: f.diff, at: new Date(f.at).toISOString() });
    }
    return out;
  }

  /** "Claude Code", with the start of the session id when two sessions of it share a checkout. */
  private names(): Map<string, string> {
    const count = new Map<string, number>();
    for (const rec of this.agents.values()) count.set(agentKey(rec.ref), (count.get(agentKey(rec.ref)) ?? 0) + 1);
    const out = new Map<string, string>();
    for (const rec of this.agents.values()) {
      const name = NAMES[rec.ref.client] ?? rec.ref.client;
      out.set(rec.id, count.get(agentKey(rec.ref))! > 1 && rec.ref.session ? `${name} · ${rec.ref.session.slice(0, 4)}` : name);
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
    const folderPath = new Map<string, string>();
    for (const n of graph.nodes) {
      nodes.add(n.id);
      if (n.kind === 'symbol') {
        const list = symbols.get(n.parent) ?? [];
        list.push(n);
        symbols.set(n.parent, list);
      } else if (n.kind === 'folder' && n.path) folderPath.set(n.id, n.path);
    }
    // One node stands for a chain of single-child folders ("src/main/java"): each dir in it, up to the parent's, maps to it.
    for (const n of graph.nodes) {
      if (n.kind !== 'folder' || !n.path) continue;
      const stop = folderPath.get(n.parent) ?? '';
      for (let d = n.path; d && d !== '.' && d !== stop; d = path.posix.dirname(d)) folders.set(`${n.repo}/${d}`, n.id);
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

  /**
   * Each symbol's own change time: the file's latest change when the symbol's text is new, else
   * the time it last changed. A file Fiada doesn't re-index (a clone), or one the graph dropped,
   * has no text to compare, so every change to it counts for each of its symbols. A symbol's time is never
   * forgotten: which symbols a change touches can read wrong for a while (until the graph catches
   * up, or after another agent moved the lines), and forgetting one would make it new again.
   */
  private stamp(f: FileRec, symbols: AgentFile['symbols'], ix: ReturnType<AgentHub['index']>, own = false): { symbols: AgentFile['symbols']; top: number | null } {
    const settled = !f.live || f.settled;
    const sig = this.signer(f, ix);
    const out = symbols.map((s) => {
      const cur = advance(f.symAt.get(s.id), settled ? sig(s.id, s.kind) : null, f.at);
      f.symAt.set(s.id, cur);
      return { ...s, at: new Date(cur.at).toISOString() };
    });
    // Right after this agent's own change is re-indexed its lines are current, so a symbol gone
    // from its changes was taken back: its text is forgotten (its time kept), and the same edit
    // made again later is a new change. (Not otherwise: another agent may have moved the lines.)
    if (own && settled) {
      const now = new Set(symbols.map((s) => s.id));
      for (const [id, prev] of f.symAt) if (!now.has(id) && prev.sig !== null) f.symAt.set(id, { sig: null, at: prev.at });
    }
    f.topAt = advance(f.topAt, settled ? sig.top() : null, f.at);
    // Back as HEAD has it: nothing outside the symbols to read, so no time for it.
    return { symbols: out, top: f.baseTop != null && f.topAt.sig === f.baseTop ? null : f.topAt.at };
  }

  /**
   * Another agent changed the file: every time this agent has for it stays, and each takes the
   * text as it is now (found by symbol id, whatever this agent's own line ranges say).
   */
  private rebase(f: FileRec, ix: ReturnType<AgentHub['index']>) {
    if (!f.text) return;
    const sig = this.signer(f, ix);
    for (const [id, prev] of f.symAt) {
      const kind = prev.sig?.split(/[\n@]/)[0] as ChangeKind | undefined;
      const now = kind ? sig(id, kind) : null;
      if (now !== null) f.symAt.set(id, { sig: now, at: prev.at });
    }
    if (!f.topAt) return;
    const top = sig.top();
    // This agent hadn't changed the file's other code: the other agent's version is its baseline
    // now, so it isn't this agent's change to read.
    if (f.baseTop != null && f.topAt.sig === f.baseTop) f.baseTop = top;
    f.topAt = { sig: top, at: f.topAt.at };
  }

  /** What a symbol's change time is taken for: its kind and its own text; and the same for the file's other code. */
  private signer(f: FileRec, ix: ReturnType<AgentHub['index']>) {
    const all = f.repo ? (ix.symbols.get(fileId(f.repo, f.rel!)) ?? []) : [];
    const lines = new Map(all.map((n) => [n.id, n.lines]));
    const text = f.live ? f.text : null;
    const sig = (id: string, kind: ChangeKind): string | null => {
      if (kind === 'deleted') return 'deleted';
      if (!text) return `${kind}@${f.at}`;
      const at = lines.get(id);
      return at ? `${kind}\n${text.slice(at[0] - 1, at[1]).join('\n')}` : null;
    };
    sig.top = () => (text ? outside(text, all.map((n) => n.lines)) : `@${f.at}`);
    return sig;
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
    // lines apply; until then, and for clones Fiada doesn't re-index, it has HEAD's.
    const newSide = f.live && f.fresh ? f.lines : f.oldLines;
    for (const s of now) {
      const rawName = s.id.slice(s.id.indexOf('#') + 1).replace(/~\d+$/, '');
      if (f.kind === 'added' || (f.fresh && base && !base.has(s.id))) out.push({ id: s.id, name: s.name, kind: 'added' });
      else if ((s.lines && newSide && touches(s.lines, newSide)) || named.has(rawName) || named.has(s.name)) out.push({ id: s.id, name: s.name, kind: 'modified' });
    }
    if (f.fresh && base) {
      const nowIds = new Set(now.map((s) => s.id));
      for (const [id, s] of base) if (!nowIds.has(id)) out.push({ id, name: s.name, kind: 'deleted', ...(s.lines[0] > 0 && { oldLines: s.lines }), ...(s.layer && { layer: s.layer }) });
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
    const names = this.names();
    for (const rec of this.agents.values()) {
      const files: AgentFile[] = [];
      for (const f of [...rec.files.values()].sort((a, b) => b.at - a.at)) {
        const { symbols, top } = this.stamp(f, this.symbolsOf(f, ix), ix);
        let node: string | undefined;
        if (f.repo) {
          const fid = fileId(f.repo, f.rel!);
          const folder = ix.folders.get(fid);
          node = ix.nodes.has(fid) ? fid : folder;
          mark(node ?? fid, { kind: f.kind, at: f.at, unit: 'file', anchor: node ? undefined : this.anchor(ix, f.repo, f.rel!) }, rec.id);
          for (const s of symbols) mark(s.id, { kind: s.kind, at: Date.parse(s.at!), unit: 'symbol', anchor: ix.nodes.has(s.id) ? undefined : (node ?? this.anchor(ix, f.repo, f.rel!)) }, rec.id);
        }
        files.push({
          repo: f.repo,
          path: f.rel ?? f.abs,
          node,
          kind: f.kind,
          additions: f.additions,
          deletions: f.deletions,
          symbols,
          topAt: top == null ? undefined : new Date(top).toISOString(),
          at: new Date(f.at).toISOString(),
          diff: !!f.diff,
        });
      }
      const root = rec.ref.root ?? rec.ref.cwd;
      const repo = this.ws.repos.find((r) => r.kind === 'local' && this.realSource(r.source) === root);
      agents.push({
        id: rec.id,
        client: rec.ref.client,
        name: names.get(rec.id)!,
        where: repo?.id ?? path.basename(root),
        cwd: rec.ref.cwd,
        state: rec.state,
        task: rec.task,
        prompt: rec.prompt,
        note: rec.note,
        now: statusLine(rec.said, rec.steps, rec.stepAt, rec.prompt ? { text: rec.prompt, at: rec.promptAt } : undefined),
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
