// Fences: circles a person marks on the map as "ask first" or "off limits".
// A fence covers everything inside its circle: a repository, a folder and the
// files under it, a file, or one symbol's lines. Before an agent's edit lands,
// its PreToolUse hook asks the indexer (POST /api/agent/check) and gets back
// a verdict: allow, ask the person, or deny. Off limits beats ask first; on a
// tie the nearest fence names the reason.
//
// Fences are kept per project through the ProjectStore, beside the grouping.
// A store without fences (one for tests) keeps them in memory.

import type { Fence, FenceRule, FenceVerdict, Graph, GraphNode, LineRange } from '@fiada/shared';
import { touches } from './agents.ts';
import type { ProjectStore } from './store.ts';

/** A file an agent is about to change, placed in an imported repository. */
export interface FencedFile {
  repo: string;
  /** Repo-relative, with forward slashes. */
  rel: string;
  /** The lines the edit replaces, when the hook could tell; absent means the whole file. */
  lines?: LineRange[];
}

const RULES: FenceRule[] = ['ask', 'off'];
/** More than anyone would mark by hand; keeps one project from growing without end. */
export const MAX_FENCES = 500;

export class FenceError extends Error {}

/** Only well-formed fences, one per node, from whatever the store held. */
export function cleanFences(raw: unknown): Fence[] {
  if (!Array.isArray(raw)) return [];
  const byNode = new Map<string, Fence>();
  for (const f of raw) {
    if (!f || typeof f.node !== 'string' || !f.node || !RULES.includes(f.rule)) continue;
    byNode.set(f.node, { node: f.node, rule: f.rule, at: typeof f.at === 'string' ? f.at : new Date(0).toISOString() });
  }
  return [...byNode.values()].slice(0, MAX_FENCES);
}

/** Whether `fence` covers this file (and, for a symbol fence, these lines), given the graph's nodes by id. */
export function covers(fence: Fence, file: FencedFile, nodes: Map<string, GraphNode>): boolean {
  const key = `${file.repo}/${file.rel}`;
  if (fence.node === file.repo || fence.node === key || key.startsWith(`${fence.node}/`)) return true;
  if (!fence.node.startsWith(`${key}#`)) return false;
  // A symbol: only an edit that reaches its lines. Without lines the edit may rewrite any of the file.
  const sym = nodes.get(fence.node);
  if (!sym?.lines) return false;
  return !file.lines || touches(sym.lines, file.lines);
}

/** Off limits first, then the nearest (longest id) fence. */
const stricter = (a: Fence, b: Fence) => (a.rule !== b.rule ? (a.rule === 'off' ? a : b) : a.node.length >= b.node.length ? a : b);

/** What the fences say about changing these files: the strictest fence round any of them decides. */
export function verdict(fences: Fence[], files: FencedFile[], graph: Graph): FenceVerdict {
  if (!fences.length || !files.length) return { decision: 'allow' };
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  let hit: { fence: Fence; file: string } | undefined;
  for (const file of files) {
    for (const fence of fences) {
      if (covers(fence, file, nodes) && (!hit || stricter(hit.fence, fence) !== hit.fence)) hit = { fence, file: `${file.repo}/${file.rel}` };
    }
  }
  if (!hit) return { decision: 'allow' };
  const { fence, file } = hit;
  // "api/app/core/config.py is inside api/app/core, which is …"; "api/app/main.py is …" for a fence on the file itself.
  const sym = fence.node.startsWith(`${file}#`) ? (nodes.get(fence.node)?.name ?? fence.node.slice(file.length + 1)) : null;
  const where = fence.node === file ? `${file} is` : sym ? `This edit reaches ${sym} in ${file}, which is` : `${file} is inside ${fence.node}, which is`;
  if (fence.rule === 'off') {
    return { decision: 'deny', fence, file, reason: `${where} off limits on the Fiada map. Leave it as it is: work around it, or ask the person to take the fence down.` };
  }
  return { decision: 'ask', fence, file, reason: `${where} marked "ask first" on the Fiada map.` };
}

/** One project's fences, loaded once and saved on every change. */
export class Fences {
  private list: Fence[] = [];
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private store: ProjectStore,
    private projectId: string,
    private now: () => Date = () => new Date(),
  ) {}

  async init() {
    this.list = cleanFences(await this.store.loadFences?.(this.projectId));
  }

  all(): Fence[] {
    return this.list;
  }

  /** Puts up, changes or (rule null) takes down the fence round one node of the graph. Returns them all. */
  async set(node: unknown, rule: unknown, graph: Graph): Promise<Fence[]> {
    if (typeof node !== 'string' || !node) throw new FenceError('Body must be { "node": "<graph node id>", "rule": "ask" | "off" | null }');
    if (rule !== null && !RULES.includes(rule as FenceRule)) throw new FenceError('rule must be "ask", "off" or null');
    const rest = this.list.filter((f) => f.node !== node);
    if (rule === null) {
      if (rest.length === this.list.length) return this.list;
    } else {
      // Taking one down always works, even for a node that has since left the graph.
      if (!graph.nodes.some((n) => n.id === node)) throw new FenceError(`${node} is not on the map`);
      if (rest.length >= MAX_FENCES) throw new FenceError(`A project can have at most ${MAX_FENCES} fences.`);
      rest.push({ node, rule: rule as FenceRule, at: this.now().toISOString() });
    }
    const before = this.list;
    this.list = rest;
    // One save at a time, each with the list as it stands when it runs.
    const run = this.saving.then(() => this.store.saveFences?.(this.projectId, this.list));
    this.saving = run.catch(() => {});
    try {
      await run;
    } catch (err) {
      if (this.list === rest) this.list = before;
      throw err;
    }
    return this.list;
  }

  verdict(files: FencedFile[], graph: Graph): FenceVerdict {
    return verdict(this.list, files, graph);
  }
}
