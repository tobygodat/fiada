/**
 * The indexer's base URL from VITE_API_URL, as typed into the host's
 * settings: no quotes or trailing slash, and https:// in front of a bare
 * host, which fetch would otherwise read as a path on the map's own site.
 * Empty stays empty: the same origin, which the dev server proxies.
 */
export function apiBase(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/\/+$/, '');
  if (!value || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `${/^(localhost|127\.|\[::1\])/i.test(value) ? 'http' : 'https'}://${value}`;
}
