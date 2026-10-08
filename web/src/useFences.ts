// The project's fences: circles marked "ask first" or "off limits", which an
// agent's hook checks before an edit lands. Loaded with the graph and changed
// one circle at a time from the detail panel.

import { useCallback, useEffect, useState } from 'react';
import type { Fence, FenceRule } from '@fiada/shared';
import { api } from './api.ts';

export interface FencesHandle {
  fences: Fence[];
  /** Puts up, changes or (null) takes down the fence round a node. Throws with the indexer's words. */
  set(node: string, rule: FenceRule | null): Promise<void>;
}

/** `rev` changes when the project might have: a new graph, a reconnect. */
export function useFences(rev: unknown): FencesHandle {
  const [fences, setFences] = useState<Fence[]>([]);
  useEffect(() => {
    let live = true;
    api.fences().then(
      (r) => live && setFences(r.fences),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rev]);
  const set = useCallback(async (node: string, rule: FenceRule | null) => {
    setFences((await api.setFence(node, rule)).fences);
  }, []);
  return { fences, set };
}
