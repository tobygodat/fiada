// The project's fences: circles marked "ask first" or "off limits", which an
// agent's hook checks before an edit lands. Loaded with the graph and changed
// one circle at a time from the detail panel.

import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Every load and change takes a number; an answer counts only if nothing started after it,
  // so a load still on its way can't put back the fences a change just replaced.
  const turn = useRef(0);
  useEffect(() => {
    const mine = ++turn.current;
    api.fences().then(
      (r) => mine === turn.current && setFences(r.fences),
      () => undefined,
    );
    return () => {
      if (mine === turn.current) turn.current++;
    };
  }, [rev]);
  const set = useCallback(async (node: string, rule: FenceRule | null) => {
    const mine = ++turn.current;
    const r = await api.setFence(node, rule);
    if (mine === turn.current) setFences(r.fences);
  }, []);
  return { fences, set };
}
