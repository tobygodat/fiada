// Sends events to the Strata indexer. An agent must never wait on Strata or
// fail because it's down, so every send is short and swallows errors.

import type { AgentEvent, AgentRef } from '@strata/shared';
import { checkout, real, type Checkout } from './git.ts';

export const STRATA_URL = (process.env.STRATA_URL ?? `http://127.0.0.1:${process.env.STRATA_INDEXER_PORT ?? 4178}`).replace(/\/+$/, '');

/** What the indexer made of the files in a batch. */
export interface IngestReply {
  files?: { path: string; repo?: string; node?: string; kind: string; symbols?: number }[];
}

export async function send(events: AgentEvent[], timeoutMs = 1500): Promise<IngestReply | null> {
  if (!events.length) return null;
  try {
    const res = await fetch(`${STRATA_URL}/api/agent/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as IngestReply) : null;
  } catch {
    return null;
  }
}

/** Who's working where: the agent's client name and the checkout its directory is in. */
export async function whoAndWhere(client: string, cwd: string, session?: string): Promise<{ agent: AgentRef; co: Checkout | null }> {
  const dir = await real(cwd);
  const co = await checkout(dir);
  return { agent: { client, session, cwd: dir, root: co?.root, remote: co?.remote }, co };
}
