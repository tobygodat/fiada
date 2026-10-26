import type { ActivityState, AgentConnection, AuthState, ChangeKind, Fence, FenceRule, Graph, Grouping, LayerPreset, NodeSummary, Workspace } from '@fiada/shared';
import { apiBase } from './apiBase.ts';

/**
 * Where the indexer is. Empty means this origin, which the dev server
 * proxies to the indexer; a production build sets VITE_API_URL to the
 * hosted indexer (web/.env.production) for the static host, Cloudflare.
 */
export const API_BASE = apiBase(import.meta.env.VITE_API_URL);

export const apiUrl = (path: string) => `${API_BASE}${path}`;

/** Said when nothing answers at the indexer's address. */
const UNREACHABLE = API_BASE ? `Can't reach the indexer at ${API_BASE}.` : "Can't reach the indexer. Start it with bun run dev.";

/** Said when /api on the page's own host is a plain 404: a deployed build without VITE_API_URL. */
const NOT_SET_UP = 'No indexer is set up for this deployment. Set VITE_API_URL to the hosted indexer and redeploy (see Deploy in the README).';

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

const SESSION_ITEM = 'fiada.session';

/**
 * Where the indexer sent us back after signing in with GitHub: the session
 * (or why it failed) in the address's fragment, which never reaches a
 * server. Taken out of the address bar at once.
 */
const returned = ((): { session?: string; error?: string } => {
  if (typeof window === 'undefined') return {};
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const session = hash.get('fiada_session') ?? undefined;
  const error = hash.get('fiada_error') ?? undefined;
  if (!session && !error) return {};
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return { session, error };
})();

/** Why the last sign-in failed, to show on the sign-in screen. */
export const signInError = returned.error ?? null;

/** The signed-in session, on an indexer people sign in to; remembered in this browser. */
let session: string | null = (() => {
  if (typeof window === 'undefined') return null;
  try {
    if (returned.session) window.localStorage.setItem(SESSION_ITEM, returned.session);
    return returned.session ?? window.localStorage.getItem(SESSION_ITEM);
  } catch {
    // storage blocked: the session lasts until the page is reloaded
    return returned.session ?? null;
  }
})();

/** Told when the indexer says this browser has to sign in (again). */
const signedOutListeners = new Set<() => void>();
export const onSignedOut = (fn: () => void) => {
  signedOutListeners.add(fn);
  return () => void signedOutListeners.delete(fn);
};

/** Forgets the session in this browser, without saying so: an indexer without sign-in has no use for one. */
export function dropSession() {
  session = null;
  try {
    window.localStorage.removeItem(SESSION_ITEM);
  } catch {
    // nothing stored
  }
}

/** Forgets the session in this browser and brings back the sign-in. */
export function signOut() {
  dropSession();
  for (const fn of signedOutListeners) fn();
}

/** Where the browser goes to sign in with GitHub; the indexer brings it back to this page. */
export const signInUrl = () => apiUrl(`/api/auth/github/login?return=${encodeURIComponent(`${window.location.origin}${window.location.pathname}`)}`);

/** Headers that say who is asking: the session for everything, else the access key for changes. */
export function authHeaders(method = 'GET'): Record<string, string> {
  if (session) return { authorization: `Bearer ${session}` };
  // Only changes need the key; leaving it off reads keeps them free of CORS preflights.
  if (accessKey && method !== 'GET') return { authorization: `Bearer ${accessKey}` };
  return {};
}

/** The access key this browser has for a shared indexer, for the agent setup command. */
export const sharedKey = () => accessKey;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = authHeaders(init?.method);
  if (typeof init?.body === 'string') headers['content-type'] = 'application/json';
  else if (init?.body instanceof Blob) headers['content-type'] = init.body.type;
  const res = await fetch(apiUrl(path), { ...init, headers }).catch(() => {
    throw new Error(UNREACHABLE);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && body.signIn) {
      signOut();
      throw new Error(body.error);
    }
    // The indexer's own errors carry a message. A bare 404 is some other server answering for /api:
    // the static host itself when no VITE_API_URL was built in.
    if (body.error) throw new Error(body.error);
    if (res.status === 404) throw new Error(API_BASE ? UNREACHABLE : NOT_SET_UP);
    throw new Error(`The indexer answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
  }
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
  /** When the change that sent `diff` came, behind `at` when a later one sent none. */
  diffAt?: string;
  at: string;
}

export const api = {
  auth: () => call<AuthState>('/api/auth'),
  agentConnection: () => call<AgentConnection>('/api/auth/agent'),
  resetAgentToken: () => call<AgentConnection>('/api/auth/agent/reset', { method: 'POST' }),
  deleteAccount: () => call<{ deleted: boolean }>('/api/auth/account', { method: 'DELETE' }),
  workspace: () => call<Workspace>('/api/workspace'),
  graph: () => call<Graph>('/api/graph'),
  addRepo: (source: string) => call<Workspace>('/api/repos', { method: 'POST', body: JSON.stringify({ source }) }),
  removeRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** A folder packed by upload/folder.ts; `replace` names the upload it updates. */
  uploadRepo: (name: string, archive: Blob, replace?: string) =>
    call<Workspace>(`/api/repos/upload?name=${encodeURIComponent(name)}${replace ? `&replace=${encodeURIComponent(replace)}` : ''}`, { method: 'POST', body: archive }),
  refreshRepo: (id: string) => call<Workspace>(`/api/repos/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  source: (repo: string, path: string) => call<SourceText>(`/api/source?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`),
  summary: (node: string) => call<NodeSummary>(`/api/summary?node=${encodeURIComponent(node)}`),
  applyPreset: (preset: LayerPreset) => call<{ grouping: Grouping }>('/api/grouping/preset', { method: 'POST', body: JSON.stringify({ preset }) }),
  sortAgain: () => call<Workspace>('/api/grouping/sort', { method: 'POST' }),
  fences: () => call<{ fences: Fence[] }>('/api/fences'),
  /** Puts up or changes the fence round a node; null takes it down. */
  setFence: (node: string, rule: FenceRule | null) => call<{ fences: Fence[] }>('/api/fences', { method: 'PUT', body: JSON.stringify({ node, rule }) }),
  agentDiffs: (node: string) => call<{ diffs: AgentDiff[] }>(`/api/agent/diff?node=${encodeURIComponent(node)}`),
  clearAgent: (id?: string) => call<ActivityState>(id ? `/api/agent?id=${encodeURIComponent(id)}` : '/api/agent', { method: 'DELETE' }),
};
