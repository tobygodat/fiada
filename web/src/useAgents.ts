// Follows what coding agents are doing: the indexer pushes the whole activity
// state over server-sent events whenever an agent reports something.
// EventSource reconnects by itself when the indexer restarts.

import { useCallback, useEffect, useState } from 'react';
import type { ActivityState } from '@strata/shared';
import { api } from './api.ts';

export interface AgentsHandle {
  state: ActivityState | null;
  /** Dismiss an agent and its changes (all agents without an id). */
  clear(id?: string): Promise<void>;
}

export function useAgents(): AgentsHandle {
  const [state, setState] = useState<ActivityState | null>(null);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/agent/stream');
    es.onmessage = (e) => {
      try {
        setState(JSON.parse(e.data) as ActivityState);
      } catch {
        // a partial message: the next one replaces it
      }
    };
    return () => es.close();
  }, []);

  const clear = useCallback(async (id?: string) => {
    setState(await api.clearAgent(id));
  }, []);

  return { state, clear };
}
