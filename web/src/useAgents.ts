// Follows what coding agents are doing: the indexer pushes the whole activity
// state over server-sent events whenever an agent reports something. Read
// with fetch rather than EventSource, which can't send the session a
// signed-in indexer needs; it reconnects the same way when the indexer
// restarts.

import { useCallback, useEffect, useState } from 'react';
import type { ActivityState } from '@fiada/shared';
import { api, apiUrl, authHeaders } from './api.ts';
import { takeEvents } from './sse.ts';

export interface AgentsHandle {
  state: ActivityState | null;
  /** Dismiss an agent and its changes (all agents without an id). */
  clear(id?: string): Promise<void>;
}

/** How long to wait before connecting again after the stream ends or fails. */
const RETRY_MS = 2000;

export function useAgents(): AgentsHandle {
  const [state, setState] = useState<ActivityState | null>(null);

  useEffect(() => {
    let stopped = false;
    let ctl: AbortController | undefined;
    let timer: number | undefined;
    const connect = async () => {
      ctl = new AbortController();
      try {
        const res = await fetch(apiUrl('/api/agent/stream'), { headers: authHeaders(), signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { data, rest } = takeEvents(buf + value);
          buf = rest;
          for (const d of data) {
            try {
              setState(JSON.parse(d) as ActivityState);
            } catch {
              // a malformed message: the next one replaces it
            }
          }
        }
      } catch {
        // the indexer went away, or we stopped
      }
      if (!stopped) timer = window.setTimeout(connect, RETRY_MS);
    };
    connect();
    return () => {
      stopped = true;
      ctl?.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const clear = useCallback(async (id?: string) => {
    setState(await api.clearAgent(id));
  }, []);

  return { state, clear };
}
