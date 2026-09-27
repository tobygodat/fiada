// Keeps the workspace and graph in sync with the indexer: polls quickly while
// anything is cloning or indexing, and refetches the graph when it changes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Graph, LayerPreset, Workspace } from '@fiada/shared';
import { api } from './api.ts';

export interface WorkspaceHandle {
  workspace: Workspace | null;
  graph: Graph | null;
  /** Why the indexer can't be reached; null while it answers. */
  offline: string | null;
  add(source: string): Promise<void>;
  /** Sends a packed folder; `replace` names the upload it updates. */
  upload(name: string, archive: Blob, replace?: string): Promise<void>;
  remove(id: string): Promise<void>;
  refresh(id: string): Promise<void>;
  /** Starts the project's layers over from a preset. */
  applyPreset(preset: LayerPreset): Promise<void>;
  /** Asks the model to sort the project's leftovers again. */
  sortAgain(): Promise<void>;
  /** Checks with the indexer now instead of at the next poll (it said the graph changed). */
  reload(): Promise<void>;
}

export function useWorkspace(): WorkspaceHandle {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const version = useRef(-1);
  const timer = useRef<number | undefined>(undefined);

  const sync = useCallback(async (ws?: Workspace) => {
    window.clearTimeout(timer.current);
    try {
      const next = ws ?? (await api.workspace());
      setOffline(null);
      setWorkspace(next);
      if (next.graphVersion !== version.current) {
        version.current = next.graphVersion;
        setGraph(await api.graph());
      }
      // Quick while repositories index or Claude sorts, so the result shows as soon as it lands.
      timer.current = window.setTimeout(() => sync(), next.busy || next.sorting?.status === 'running' ? 800 : 5000);
    } catch (err) {
      setOffline((err as Error).message);
      timer.current = window.setTimeout(() => sync(), 2000);
    }
  }, []);

  useEffect(() => {
    sync();
    return () => window.clearTimeout(timer.current);
  }, [sync]);

  return {
    workspace,
    graph,
    offline,
    add: async (source) => sync(await api.addRepo(source)),
    upload: async (name, archive, replace) => sync(await api.uploadRepo(name, archive, replace)),
    remove: async (id) => sync(await api.removeRepo(id)),
    refresh: async (id) => sync(await api.refreshRepo(id)),
    applyPreset: async (preset) => {
      await api.applyPreset(preset);
      await sync();
    },
    sortAgain: async () => sync(await api.sortAgain()),
    reload: () => sync(),
  };
}
