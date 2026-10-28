// Who may use the API when the indexer runs somewhere other than your own
// machine: which browser origins may call it (the map hosted apart from the
// indexer, e.g. on Cloudflare), whether local folders can be imported, and the
// access key that changes need.

import { timingSafeEqual } from 'node:crypto';

/**
 * Origins allowed to call the API from a browser, from a comma-separated
 * list. `*` inside an entry stands for one run of letters, digits and
 * hyphens, which covers the Worker's preview URLs
 * (`https://*-fiada-web.<account>.workers.dev`); `*` alone allows
 * any origin. An empty list allows none, which is right when the map and
 * the API share an origin (the dev server's proxy).
 */
export function originMatcher(list: string | undefined): (origin: string | undefined) => boolean {
  const entries = (list ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

  if (entries.includes('*')) return (origin) => !!origin;
  const patterns = entries.map((e) => new RegExp(`^${e.split('*').map(escape).join('[a-z0-9-]*')}$`, 'i'));

  return (origin) => !!origin && patterns.some((re) => re.test(origin));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True for addresses only this machine can reach. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** Variables that hosting platforms set in every container they run. */
const PLATFORMS = ['RAILWAY_PROJECT_ID', 'RENDER', 'FLY_APP_NAME'];

/**
 * Where to listen when HOST isn't set: loopback on your own machine, every
 * interface on a hosting platform, whose proxy can't reach loopback. The
 * Dockerfile sets HOST itself; this covers a platform that builds the
 * indexer some other way.
 */
export function defaultHost(env: NodeJS.ProcessEnv = process.env): string {
  return PLATFORMS.some((name) => env[name]) ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Whether local folders can be imported. Importing a path reads that
 * directory, which only makes sense for an indexer on your own machine, so
 * it's off once the indexer listens beyond loopback unless
 * FIADA_ALLOW_LOCAL=1 says otherwise.
 */
export function allowLocalPaths(host: string, flag = process.env.FIADA_ALLOW_LOCAL): boolean {
  return flag ? flag === '1' : isLoopback(host);
}

/** Methods that only read; everything else changes the project and needs the key when there is one. */
export const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a coding agent may ask the map with its agent token: the read routes in ask.ts. */
export const AGENT_READS = new Set(['/api/agent/find', '/api/agent/dependents', '/api/agent/impact']);

/**
 * Who a request to an indexer people sign in to must be: an agent token only
 * reports (POST /api/agent/events) and asks about fences before an edit
 * (POST /api/agent/check); the read routes take an agent token or a
 * signed-in browser; everything else takes a signed-in browser.
 */
export function whoMayCall(method: string, route: string): 'agent' | 'agent-or-person' | 'person' {
  if (method === 'POST' && (route === '/api/agent/events' || route === '/api/agent/check')) return 'agent';

  if (READS.has(method) && AGENT_READS.has(route)) return 'agent-or-person';

  return 'person';
}

/** Whether a request's Authorization header carries the access key. */
export function hasKey(authorization: string | undefined, key: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(key);

  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * How many requests each caller (an account, or an address) may make per
 * window. Counts reset at the end of each caller's window; callers that have
 * gone quiet are forgotten.
 */
export class RateLimit {
  private hits = new Map<string, { n: number; until: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Counts a request from `key`: 0 when it is within the limit, else the seconds until the key may go again. */
  take(key: string): number {
    const t = this.now();
    let h = this.hits.get(key);

    if (!h || h.until <= t) {
      if (this.hits.size >= 10_000) for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k);
      h = { n: 0, until: t + this.windowMs };
      this.hits.set(key, h);
    }

    return ++h.n > this.limit ? Math.max(1, Math.ceil((h.until - t) / 1000)) : 0;
  }
}
