// Runs the model sort for a project, off the request path: after a rebuild
// finds repositories it hasn't sorted (a fresh import, a new commit), or when
// someone asks for it. One sort at a time; a request that arrives during one
// runs after it. Without a model (no API key) it does nothing, and the map
// keeps the classifier's result.

import type { Graph, Grouping, SortedGrouping, SortingState } from '@fiada/shared';
import { sortProject } from './classify/model-sort.ts';
import { describeLLMError, KEY_HINT, llmFromEnv, type LLM } from './llm.ts';

export interface SortHost {
  /** True while repositories are still cloning or indexing: sort once they're all in. */
  busy(): boolean;
  /** The graph as the classifier and the user's rules and pins place it, without Claude's sort. */
  graph(): Graph;
  grouping(): Grouping;
  /** Stores the sort in the project's grouping and redraws the map. */
  save(sorted: SortedGrouping): Promise<void>;
}

/** Repository id → commit, for the repositories in a graph. */
const basisOf = (g: Graph) => Object.fromEntries(g.repos.map((r) => [r.id, r.commit ?? '']));
const keyOf = (b: Record<string, string>) =>
  Object.entries(b)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, c]) => `${id}@${c}`)
    .join(' ');

export class Sorter {
  private status: SortingState['status'];
  private error?: string;
  private running: Promise<void> | null = null;
  private pending: { host: SortHost; force: boolean } | null = null;
  /** The repositories a sort failed for: not retried on its own until they change. */
  private failed?: string;

  constructor(private llm: LLM | null = null) {
    this.status = llm ? 'idle' : 'off';
  }

  /** Sorts with the model the environment gives (see llm.ts); without a key, sorting is off. */
  static fromEnv(): Sorter {
    return new Sorter(llmFromEnv());
  }

  get available(): boolean {
    return !!this.llm;
  }

  /** "OpenAI (gpt-5.5)" or "Claude (claude-opus-5)", for logs. */
  get describe(): string {
    return this.llm ? `${this.llm.label} (${this.llm.model})` : 'nothing';
  }

  state(grouping: Grouping, placed: number): SortingState {
    const sorted = grouping.sorted;
    // A stored sort still shows as done on an indexer without a key (say, one sorted elsewhere).
    const status = this.status === 'running' || this.status === 'error' ? this.status : sorted ? 'done' : this.status === 'off' ? 'off' : 'idle';
    const ds = sorted?.domains ?? [];
    const by = this.llm?.label ?? sorted?.by;
    return {
      available: this.available,
      status,
      ...(status === 'off' ? { keyHint: KEY_HINT } : {}),
      ...(by ? { by } : {}),
      ...(sorted ? { model: sorted.model, at: sorted.at, placed, merged: ds.filter((d) => d.mergeInto).length, renamed: ds.filter((d) => d.from && !d.mergeInto).length, added: ds.filter((d) => d.added).length } : {}),
      ...(status === 'error' && this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Sorts when the host's repositories aren't the ones the stored sort was
   * made for, or always with `force`. Returns at once; the sort lands through
   * `host.save`.
   */
  request(host: SortHost, force = false): void {
    if (!this.llm) return;
    if (this.running) {
      this.pending = { host, force: force || !!this.pending?.force };
      return;
    }
    if (host.busy()) return;
    const graph = host.graph();
    if (!graph.repos.length) return;
    const basis = basisOf(graph);
    const key = keyOf(basis);
    // Sorted already when every repository is in the last sort at the same commit (removing one needs no new sort).
    const sorted = host.grouping().sorted;
    if (!force && sorted && Object.entries(basis).every(([id, c]) => sorted.repos[id] === c)) return;
    if (!force && this.failed === key) return;
    this.running = this.run(host, graph, key).finally(() => {
      this.running = null;
      const next = this.pending;
      this.pending = null;
      if (next) this.request(next.host, next.force);
    });
  }

  /** Resolves when the current sort (if any) has landed. */
  settled(): Promise<void> {
    return (this.running ?? Promise.resolve()).then(() => (this.running ? this.settled() : undefined));
  }

  private async run(host: SortHost, graph: Graph, key: string) {
    this.status = 'running';
    this.error = undefined;
    const started = Date.now();
    const llm = this.llm!;
    console.log(`[fiada] sorting ${graph.repos.map((r) => r.id).join(', ')} with ${this.describe}`);
    try {
      const sorted = await sortProject(graph, host.grouping(), (req) => llm.json(req), { get model() { return llm.model; }, by: llm.label, log: (l) => console.log(l) });
      await host.save(sorted);
      this.failed = undefined;
      this.status = 'done';
      console.log(`[fiada] sorted in ${((Date.now() - started) / 1000).toFixed(0)}s: ${Object.keys(sorted.placements).length} placements, ${sorted.domains.length} domain decisions`);
    } catch (err) {
      this.failed = key;
      this.status = 'error';
      this.error = describeLLMError(err);
      console.error(`[fiada] sorting failed: ${this.error}`);
    }
  }
}
