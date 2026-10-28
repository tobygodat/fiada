// The projects this indexer serves at once. Without sign-in there is one,
// shared by everyone who can reach the indexer. With GitHub sign-in (auth.ts)
// each person has their own: its repositories, clones, grouping, fences,
// summaries and agent activity are theirs alone, so what one person imports or runs is
// never on anyone else's map.
//
// A person's project opens on their first request and closes after it has
// sat idle a while (no requests, no map listening, nothing indexing), which
// frees its parsed repositories. Opening it again re-indexes from its clones.

import path from 'node:path';
import type { AccountInfo, Workspace as WorkspaceState } from '@fiada/shared';
import { AgentHub } from './agents.ts';
import { Fences } from './fences.ts';
import type { LLM } from './llm.ts';
import { Sorter } from './sorter.ts';
import type { ProjectStore } from './store.ts';
import { Summaries } from './summaries/index.ts';
import { Workspace, type WorkspaceOptions } from './workspace.ts';

export interface Tenant {
  projectId: string;
  ws: Workspace;
  summaries: Summaries;
  agents: AgentHub;
  /** Where agents must ask first or keep out. */
  fences: Fences;
  close(): Promise<void>;
}

export interface OpenOptions extends WorkspaceOptions {
  store: ProjectStore;
  projectId: string;
  access: WorkspaceState['access'];
  /** Sorts leftovers into layers and domains; null leaves the classifier's sort. */
  sortLlm: LLM | null;
  /** Writes node summaries; null gives the lines built from the graph. */
  summaryLlm: LLM | null;
}

/** Opens one project: its workspace, summaries, fences and agent hub, wired together as the server uses them. */
export async function openTenant(o: OpenOptions): Promise<Tenant> {
  const ws = new Workspace(o.store, o.projectId, o.access, new Sorter(o.sortLlm), o);

  const summaries = new Summaries({
    store: o.store,
    projectId: o.projectId,
    llm: o.summaryLlm,
    read: (repo, p) => ws.readSource(repo, p).then((s) => s?.text ?? null),
    busy: () => ws.state().busy,
  });

  await summaries.init();
  const off = ws.onGraph(() => summaries.setGraph(ws.getGraph()));
  await ws.init();
  summaries.setGraph(ws.getGraph());
  const fences = new Fences(o.store, o.projectId);
  await fences.init();
  const agents = new AgentHub(ws);

  return {
    projectId: o.projectId,
    ws,
    summaries,
    agents,
    fences,
    async close() {
      off();
      agents.close();
      ws.close();
      await Promise.all([summaries.close(), fences.close()]);
    },
  };
}

/** Where a signed-in person's project keeps its clones and uploads, apart from everyone else's. */
export const clonesOf = (home: string, projectId: string) => path.join(home, 'clones', projectId);

interface Entry {
  tenant: Promise<Tenant>;
  used: number;
}

/** Signed-in people's projects, open while they're in use. */
export class Tenants {
  private open = new Map<string, Entry>();
  private timer: NodeJS.Timeout;

  constructor(
    private make: (projectId: string, account: AccountInfo) => Promise<Tenant>,
    /** How long a project sits idle before it closes. */
    private idleMs = 30 * 60_000,
    private now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  /** The person's project, opening it if it isn't open. Concurrent calls share one opening. */
  get(projectId: string, account: AccountInfo): Promise<Tenant> {
    let e = this.open.get(projectId);

    if (!e) {
      e = { tenant: this.make(projectId, account), used: this.now() };
      this.open.set(projectId, e);
      // A project that failed to open is tried again on the next request.
      e.tenant.catch(() => this.open.get(projectId) === e && this.open.delete(projectId));
    }

    e.used = this.now();

    return e.tenant;
  }

  /** Closes the person's project if it is open, and forgets it, so their next request would open it afresh. */
  async drop(projectId: string) {
    const e = this.open.get(projectId);

    if (!e) return;
    this.open.delete(projectId);
    await (await e.tenant.catch(() => null))?.close();
  }

  get size(): number {
    return this.open.size;
  }

  /** Closes projects nobody has used for a while, that no map is listening to and that aren't indexing. */
  async sweep() {
    const cutoff = this.now() - this.idleMs;

    for (const [id, e] of this.open) {
      if (e.used > cutoff) continue;
      const t = await e.tenant.catch(() => null);

      if (!t || this.open.get(id) !== e || e.used > cutoff || t.agents.watched || t.ws.state().busy) continue;
      this.open.delete(id);
      await t.close().catch((err) => console.error(`[fiada] closing project ${id}: ${(err as Error).message}`));
    }
  }

  async closeAll() {
    clearInterval(this.timer);
    const all = [...this.open.values()];
    this.open.clear();

    for (const e of all) await (await e.tenant.catch(() => null))?.close();
  }
}
