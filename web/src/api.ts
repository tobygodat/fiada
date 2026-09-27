import type { ActivityState, ChangeKind, Graph, Grouping, LayerPreset, Workspace } from '@strata/shared';

/**
 * Where the indexer is. Empty means this origin, which the dev server
 * proxies to the indexer; a build for a static host (Vercel) sets
 * VITE_API_URL to the hosted indexer.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');

export const apiUrl = (path: string) => `${API_BASE}${path}`;

const KEY_ITEM = 'strata.key';

/**
 * A hosted indexer's access key, which changes need: opened once as
 * ?key=<key> (taken out of the address bar), then remembered in this
 * browser. ?key= with nothing forgets it.
 */
const accessKey: string | null = (() => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const given = params.get('key');
  if (given === null) {
    try {
      return window.localStorage.getItem(KEY_ITEM);
    } catch {
      return null;
    }
  }
  params.delete('key');
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  try {
    if (given) window.localStorage.setItem(KEY_ITEM, given);
    else window.localStorage.removeItem(KEY_ITEM);
  } catch {
    // storage blocked: the key lasts until the page is reloaded
  }
  return given || null;
})();

/** Whether this browser can change the project: the indexer needs no key, or we have it. */
export const canEdit = (ws: Workspace | null) => !ws?.access?.keyRequired || !!accessKey;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  // Only changes need the key; leaving it off reads keeps them free of CORS preflights.
  if (accessKey && init?.method && init.method !== 'GET') headers.authorization = `Bearer ${accessKey}`;
  const res = await fetch(apiUrl(path), { ...init, headers });
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
  clearAgent: (id?: string) => call<ActivityState>(id ? `/api/agent?id=${encodeURIComponent(id)}` : '/api/agent', { method: 'DELETE' }),
};
