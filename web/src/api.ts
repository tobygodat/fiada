import type { Graph, Workspace } from '@strata/shared';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  workspace: () => call<Workspace>('/api/workspace'),
  graph: () => call<Graph>('/api/graph'),
  addRepo: (source: string) => call<Workspace>('/api/repos', { method: 'POST', body: JSON.stringify({ source }) }),
  removeRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refreshRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
};
