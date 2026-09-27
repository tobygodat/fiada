// Who may use the API when the indexer runs somewhere other than your own
// machine: which browser origins may call it (the map hosted apart from the
// indexer, e.g. on Vercel), whether local folders can be imported, and the
// access key that changes need.

import { timingSafeEqual } from 'node:crypto';

/**
 * Origins allowed to call the API from a browser, from a comma-separated
 * list. `*` inside an entry stands for one run of letters, digits and
 * hyphens, which covers Vercel preview URLs
 * (`https://hackgt13-*-toby-godats-projects.vercel.app`); `*` alone allows
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
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Whether local folders can be imported. Importing a path reads that
 * directory, which only makes sense for an indexer on your own machine, so
 * it's off once the indexer listens beyond loopback unless
 * STRATA_ALLOW_LOCAL=1 says otherwise.
 */
export function allowLocalPaths(host: string, flag = process.env.STRATA_ALLOW_LOCAL): boolean {
  return flag ? flag === '1' : isLoopback(host);
}

/** Methods that only read; everything else changes the project and needs the key when there is one. */
export const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether a request's Authorization header carries the access key. */
export function hasKey(authorization: string | undefined, key: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(key);
  return given.length === want.length && timingSafeEqual(given, want);
}
