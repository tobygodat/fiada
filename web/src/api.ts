import type { ActivityState, ChangeKind, Graph, Grouping, LayerPreset, Workspace } from '@strata/shared';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

/** One indexed file's text, from the indexer's checkout. */
export interface SourceText {
  path: string;
  commit?: string;
  text: string;
}

/** An agent's diff for one file, against HEAD. */
export interface AgentDiff {
  agent: string;
  name: string;
  kind: ChangeKind;
  additions?: number;
  deletions?: number;
  diff?: string;
  at: string;
}

export const api = {
  workspace: () => call<Workspace>('/api/workspace'),
  graph: () => call<Graph>('/api/graph'),
  addRepo: (source: string) => call<Workspace>('/api/repos', { method: 'POST', body: JSON.stringify({ source }) }),
  removeRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refreshRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  source: (repo: string, path: string) => call<SourceText>(`/api/source?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`),
  applyPreset: (preset: LayerPreset) => call<{ grouping: Grouping }>('/api/grouping/preset', { method: 'POST', body: JSON.stringify({ preset }) }),
  agentDiffs: (node: string) => call<{ diffs: AgentDiff[] }>(`/api/agent/diff?node=${encodeURIComponent(node)}`),
  clearAgent: (id?: string) => call<ActivityState>(id ? `/api/agent/${encodeURIComponent(id)}` : '/api/agent', { method: 'DELETE' }),
};
