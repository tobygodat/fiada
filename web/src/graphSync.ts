// Which graph the map draws: fetched when the workspace says it moved on, and kept with the
// version it was fetched for, so "the map has the newer graph" means the one it draws, not the
// workspace's word that one exists.

import type { Graph } from '@fiada/shared';

export interface LoadedGraph {
  graph: Graph;
  version: number;
}

export class GraphSync {
  /** The version last asked for, so a poll while it loads doesn't fetch it again. */
  private asked = -1;
  /** The version the map has. */
  private have = -1;
  /** Counts fetches, so only the latest one asked for lands (a slow older one doesn't replace it). */
  private seq = 0;

  /**
   * The graph for `version` when it differs from the one the map has (a restarted indexer counts
   * from 0 again); null when there's nothing new, or a later fetch has overtaken this one.
   */
  async sync(version: number, fetch: () => Promise<Graph>): Promise<LoadedGraph | null> {
    if (version === this.asked || version === this.have) return null;
    this.asked = version;
    const mine = ++this.seq;
    let graph: Graph;
    try {
      graph = await fetch();
    } catch (err) {
      // Failed: the next poll asks again.
      if (this.seq === mine) this.asked = -1;
      throw err;
    }
    if (this.seq !== mine) return null;
    this.have = version;
    return { graph, version };
  }
}
