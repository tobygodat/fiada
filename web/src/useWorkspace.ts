// Keeps the workspace and graph in sync with the indexer: polls quickly while
// anything is cloning or indexing, and refetches the graph when it changes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Graph, LayerPreset, Workspace } from '@strata/shared';
import { api } from './api.ts';

export interface WorkspaceHandle {
  workspace: Workspace | null;
  graph: Graph | null;
  /** Set when the indexer can't be reached. */
  offline: boolean;
  add(source: string): Promise<void>;
  remove(id: string): Promise<void>;
  refresh(id: string): Promise<void>;
  /** Starts the project's layers over from a preset. */
  applyPreset(preset: LayerPreset): Promise<void>;
}

export function useWorkspace(): WorkspaceHandle {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [offline, setOffline] = useState(false);
  const version = useRef(-1);
  const timer = useRef<number | undefined>(undefined);

  const sync = useCallback(async (ws?: Workspace) => {
    window.clearTimeout(timer.current);
    try {
      const next = ws ?? (await api.workspace());
      setOffline(false);
      setWorkspace(next);
      if (next.graphVersion !== version.current) {
        version.current = next.graphVersion;
        setGraph(await api.graph());
      }
      timer.current = window.setTimeout(() => sync(), next.busy ? 800 : 5000);
    } catch {
      setOffline(true);
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
    remove: async (id) => sync(await api.removeRepo(id)),
    refresh: async (id) => sync(await api.refreshRepo(id)),
    applyPreset: async (preset) => {
      await api.applyPreset(preset);
      await sync();
    },
  };
}
