// Summaries for every node the map can select. The line (describe.ts) is
// computed on request. Generated summaries are written in batches: eagerly for
// files, then folders and function-view groups, then repositories, after each
// graph change and off the request path; for symbols, a file's worth at a time
// when one of them is first selected. Each is cached by a hash of what the
// model read (items.ts) and persisted through the ProjectStore, so a restart
// or re-index only rewrites what changed.

import { UNLAYERED, UNSORTED_DOMAIN, type Graph, type GraphNode, type NodeSummary } from '@fiada/shared';
import type { ProjectStore, StoredSummary } from '../store.ts';
import { describe, indexGraph, parseGroupId, type GraphIndex } from './describe.ts';
import { fileDoc, symbolDoc } from './docs.ts';
import { fileHeader, fileItem, folderItem, groupItem, matchReply, prompt, replySchema, repoItem, symbolItem, SYSTEM, takeBatch, type Batch, type Item } from './items.ts';
import { describeLLMError, KEY_HINT, type LLM } from '../llm.ts';

export interface SummariesOptions {
  store: ProjectStore;
  projectId: string;
  /** Null when no model key is set: lines only. */
  llm: LLM | null;
  /** An indexed file's text, or null. */
  read(repo: string, path: string): Promise<string | null>;
  /** True while repositories are still cloning or indexing; the eager pass waits for them. */
  busy?(): boolean;
  /** Requests in flight at once. */
  concurrency?: number;
  /** Quiet time after a graph change before the eager pass starts. */
  debounceMs?: number;
  log?(message: string): void;
}

interface Failure {
  message: string;
  at: number;
}

/** A failed item is retried when asked for again after this long. */
const RETRY_MS = 60_000;

export class Summaries {
  private cache = new Map<string, StoredSummary>();
  private unsaved: Record<string, StoredSummary> = {};
  private saveTimer?: NodeJS.Timeout;
  private gi: GraphIndex | null = null;
  private texts = new Map<string, Promise<string | null>>();
  private timer?: NodeJS.Timeout;
  private eagerRun: Promise<void> | null = null;
  /** The graph changed while the eager pass ran: run it again after. */
  private rerun = false;
  /** Hashes being written right now, so the eager pass and a selection never write the same item twice. */
  private claimed = new Set<string>();
  private failed = new Map<string, Failure>();
  private jobs = new Map<string, Promise<void>>();
  private active = 0;
  private waiting: { high: (() => void)[]; low: (() => void)[] } = { high: [], low: [] };
  /** Requests made and items written, for the log and the bench. */
  readonly stats = { calls: 0, items: 0, promptChars: 0, failures: 0 };

  constructor(private o: SummariesOptions) {}

  get enabled(): boolean {
    return !!this.o.llm;
  }

  async init() {
    try {
      const saved = (await this.o.store.loadSummaries?.(this.o.projectId)) ?? {};
      for (const [hash, s] of Object.entries(saved)) this.cache.set(hash, s);
      if (this.cache.size) this.log(`loaded ${this.cache.size} saved summaries`);
    } catch (err) {
      this.log(`couldn't load saved summaries: ${(err as Error).message}`);
    }
  }

  /** Call after every rebuild or reclassification. Starts the eager pass once things settle. */
  setGraph(graph: Graph) {
    this.gi = indexGraph(graph);
    this.texts.clear();
    if (!this.o.llm) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.startEager(), this.o.debounceMs ?? 1500);
  }

  /** The summary of one node, starting its generation if it has none yet. Null for an id the graph doesn't have. */
  async get(id: string): Promise<NodeSummary | null> {
    const gi = this.gi;
    if (!gi) return null;
    const derived = describe(gi, id);
    if (derived == null) return null;
    const n = gi.byId.get(id);
    const doc = n ? await this.doc(n) : '';
    const base: NodeSummary = { node: id, line: derived, ...(doc ? { doc } : {}), status: 'off' };
    if (!this.o.llm) return { ...base, off: `set ${KEY_HINT} on the indexer for generated summaries` };

    const it = await this.itemFor(gi, id);
    if (!it) return { ...base, status: 'error', error: "Couldn't read this code from the indexer's checkout." };
    const hit = this.cache.get(it.hash);
    if (hit) return { ...base, generated: hit, status: 'ready' };
    const failure = this.failed.get(it.hash);
    if (failure && Date.now() - failure.at < RETRY_MS) return { ...base, status: 'error', error: failure.message };

    if (it.kind === 'symbol') this.job(`file:${it.group}`, () => this.writeSymbols(gi, it.group!, it.node));
    // Containers above files wait for the eager pass while it's due or running, since they're written from their children's summaries.
    else if (it.kind === 'file' || (!this.eagerRun && !this.timer)) this.job(`item:${it.hash}`, () => this.write([it], 'high'));
    return { ...base, status: 'pending' };
  }

  /** Resolves when nothing is being written (tests and the bench). */
  async idle() {
    for (;;) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.startEager();
      }
      const pending = [this.eagerRun, ...this.jobs.values()].filter(Boolean);
      if (!pending.length) break;
      await Promise.all(pending);
    }
    await this.flush();
  }

  // ── items ──

  private text(n: GraphNode): Promise<string | null> {
    const key = `${n.repo}\0${n.path}`;
    let p = this.texts.get(key);
    if (!p) {
      p = this.o.read(n.repo, n.path!).catch(() => null);
      this.texts.set(key, p);
    }
    return p;
  }

  private async doc(n: GraphNode): Promise<string> {
    if ((n.kind !== 'file' && n.kind !== 'symbol') || !n.path) return '';
    const text = await this.text(n);
    if (!text) return '';
    return n.kind === 'file' ? fileDoc(text, n.lang) : symbolDoc(text, n);
  }

  /** What a container's item says about each child: its generated summary when there is one. */
  private summaryOf = (gi: GraphIndex) => (id: string) => {
    const kid = gi.byId.get(id);
    const known = this.known.get(id);
    if (known && this.cache.has(known)) return this.cache.get(known)!.text;
    return (kid && describe(gi, id)) ?? '';
  };

  /** Node id → hash of its latest item, so parents can find their children's summaries. */
  private known = new Map<string, string>();

  private remember(it: Item): Item {
    this.known.set(it.node, it.hash);
    return it;
  }

  private async itemFor(gi: GraphIndex, id: string): Promise<Item | null> {
    const g = parseGroupId(gi, id);
    if (g) return this.remember(groupItem(gi, id, g, this.summaryOf(gi)));
    const n = gi.byId.get(id);
    if (!n) return null;
    if (n.kind === 'file') return this.remember(fileItem(gi, n, await this.text(n)));
    if (n.kind === 'symbol') {
      const text = await this.text(n);
      return text == null ? null : this.remember(symbolItem(gi, n, text.split('\n')));
    }
    if (n.kind === 'folder') return this.remember(folderItem(gi, n, this.summaryOf(gi)));
    return this.remember(repoItem(gi, n, this.summaryOf(gi)));
  }

  // ── writing ──

  private job(key: string, run: () => Promise<void>) {
    if (this.jobs.has(key)) return;
    const p = run()
      .catch((err) => this.log(`summaries: ${(err as Error).message}`))
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, p);
  }

  private startEager() {
    this.timer = undefined;
    if (!this.o.llm || !this.gi) return;
    if (this.o.busy?.()) {
      this.timer = setTimeout(() => this.startEager(), 1000);
      return;
    }
    if (this.eagerRun) {
      // Running against an older graph: it stops between phases; go again after.
      this.rerun = true;
      return;
    }
    const gi = this.gi;
    const started = Date.now();
    const before = { ...this.stats };
    this.eagerRun = this.eager(gi)
      .then(() => {
        const calls = this.stats.calls - before.calls;
        if (calls) this.log(`summaries: wrote ${this.stats.items - before.items} in ${calls} request${calls === 1 ? '' : 's'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      })
      .catch((err) => this.log(`summaries: ${(err as Error).message}`))
      .finally(() => {
        this.eagerRun = null;
        if (this.rerun) {
          this.rerun = false;
          this.startEager();
        }
      });
  }

  /** Files, then folders and groups (from the files' summaries), then repositories. Stops early if the graph changes. */
  private async eager(gi: GraphIndex) {
    const nodes = gi.graph.nodes;
    const files = await Promise.all(nodes.filter((n) => n.kind === 'file').map((n) => this.itemFor(gi, n.id)));
    await this.write(files.filter((x): x is Item => !!x), 'low');
    if (this.gi !== gi) return;

    // Deepest folders first, so a folder can read its subfolders' summaries within the same phase's later batches.
    const depth = (n: GraphNode) => (n.path ?? '').split('/').length;
    const folders = nodes.filter((n) => n.kind === 'folder').sort((a, b) => depth(b) - depth(a));
    // The function view's groups: domains, and each layer within one, over symbols and symbol-less files.
    const leaves = nodes.filter((n) => n.kind === 'symbol' || (n.kind === 'file' && !gi.children.get(n.id)?.some((c) => c.kind === 'symbol')));
    const groups = new Set<string>();
    for (const n of leaves) {
      const d = `domain:${n.domain?.id ?? UNSORTED_DOMAIN}`;
      groups.add(d).add(`${d}/${n.layer?.id ?? UNLAYERED}`);
    }
    const second = await Promise.all([...groups].map((id) => this.itemFor(gi, id)));
    await this.write(second.filter((x): x is Item => !!x), 'low');
    for (const level of levels(folders, depth)) {
      if (this.gi !== gi) return;
      await this.write(await Promise.all(level.map((f) => this.itemFor(gi, f.id))).then((xs) => xs.filter((x): x is Item => !!x)), 'low');
    }
    if (this.gi !== gi) return;
    const repos = await Promise.all(nodes.filter((n) => n.kind === 'repo').map((n) => this.itemFor(gi, n.id)));
    await this.write(repos.filter((x): x is Item => !!x), 'low');
  }

  /** A file's symbols that have no summary yet, the selected one first, in as few requests as fit. */
  private async writeSymbols(gi: GraphIndex, fileId: string, first: string) {
    const file = gi.byId.get(fileId);
    if (!file) return;
    const text = await this.text(file);
    if (text == null) return;
    const lines = text.split('\n');
    const symbols = (gi.children.get(fileId) ?? []).filter((c) => c.kind === 'symbol');
    symbols.sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
    const items = symbols.map((s) => this.remember(symbolItem(gi, s, lines)));
    await this.write(items, 'high', fileHeader(gi, file, lines) ? `${file.path}\n${fileHeader(gi, file, lines)}` : file.path);
  }

  /** Writes whatever of `items` isn't cached or being written, `concurrency` requests at a time. */
  private async write(items: Item[], priority: 'high' | 'low', context?: string) {
    const queue = items.filter((it) => !this.cache.has(it.hash) && !this.claimed.has(it.hash) && !this.recentlyFailed(it.hash));
    const unique = new Map(queue.map((it) => [it.hash, it]));
    const todo = [...unique.values()];
    const workers: Promise<void>[] = [];
    const next = async (): Promise<void> => {
      while (todo.length) {
        await this.slot(priority);
        try {
          const batch = takeBatch(todo).filter((it) => !this.cache.has(it.hash) && !this.claimed.has(it.hash));
          if (batch.length) await this.run({ items: batch, context });
        } finally {
          this.release();
        }
      }
    };
    for (let i = 0; i < (this.o.concurrency ?? 3); i++) workers.push(next());
    await Promise.all(workers);
  }

  private recentlyFailed(hash: string) {
    const f = this.failed.get(hash);
    return !!f && Date.now() - f.at < RETRY_MS;
  }

  /** One request. A reply that was cut off or unreadable is retried as two halves; one that failed outright marks its items. */
  private async run(batch: Batch): Promise<void> {
    const llm = this.o.llm!;
    for (const it of batch.items) this.claimed.add(it.hash);
    try {
      const text = prompt(batch);
      this.stats.calls++;
      this.stats.promptChars += text.length + SYSTEM.length;
      const reply = (await llm.json({
        label: `summaries of ${batch.items.length} ${batch.items[0].kind === 'symbol' ? 'symbols' : 'nodes'}`,
        system: [SYSTEM],
        prompt: text,
        schema: replySchema(batch.items.length),
      })) as { summaries?: { id?: unknown; summary?: unknown }[] };
      const at = new Date().toISOString();
      const missing: Item[] = [];
      const texts = matchReply(batch.items, Array.isArray(reply?.summaries) ? reply.summaries : []);
      batch.items.forEach((it, i) => {
        const s = texts[i];
        if (!s) return void missing.push(it);
        const stored = { text: s, model: llm.model, at };
        this.cache.set(it.hash, stored);
        this.unsaved[it.hash] = stored;
        this.stats.items++;
      });
      this.scheduleSave();
      for (const it of batch.items) this.claimed.delete(it.hash);
      if (missing.length && missing.length < batch.items.length) await this.run({ ...batch, items: missing });
      else if (missing.length) this.fail(missing, 'The model left these out of its reply.');
    } catch (err) {
      for (const it of batch.items) this.claimed.delete(it.hash);
      // A reply that was cut off, declined or unreadable may be one item's fault: try the halves.
      if (batch.items.length > 1 && (err instanceof SyntaxError || /cut off|declined/.test((err as Error).message))) {
        const half = Math.ceil(batch.items.length / 2);
        await this.run({ ...batch, items: batch.items.slice(0, half) });
        await this.run({ ...batch, items: batch.items.slice(half) });
        return;
      }
      this.fail(batch.items, describeLLMError(err));
    }
  }

  private fail(items: Item[], message: string) {
    this.stats.failures += items.length;
    for (const it of items) this.failed.set(it.hash, { message, at: Date.now() });
    this.log(`summaries: ${items.length} not written: ${message}`);
  }

  private async slot(priority: 'high' | 'low') {
    if (this.active < (this.o.concurrency ?? 3)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting[priority].push(resolve));
  }

  private release() {
    const next = this.waiting.high.shift() ?? this.waiting.low.shift();
    if (next) next();
    else this.active--;
  }

  // ── saving ──

  private scheduleSave() {
    if (!this.o.store.saveSummaries || this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), 1000);
  }

  private async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const entries = this.unsaved;
    if (!Object.keys(entries).length || !this.o.store.saveSummaries) return;
    this.unsaved = {};
    try {
      await this.o.store.saveSummaries(this.o.projectId, entries);
    } catch (err) {
      // Kept in memory either way; the next save tries these again.
      this.unsaved = { ...entries, ...this.unsaved };
      this.log(`couldn't save summaries: ${(err as Error).message}`);
    }
  }

  private log(message: string) {
    (this.o.log ?? ((m) => console.log(`[fiada] ${m}`)))(message);
  }
}

/** Folders grouped by depth, deepest first. */
function levels(folders: GraphNode[], depth: (n: GraphNode) => number): GraphNode[][] {
  const by = new Map<number, GraphNode[]>();
  for (const f of folders) by.set(depth(f), [...(by.get(depth(f)) ?? []), f]);
  return [...by].sort((a, b) => b[0] - a[0]).map(([, fs]) => fs);
}
