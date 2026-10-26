// The site's Content-Security-Policy (web/public/_headers) allows index.html's
// one inline script by its hash, so an edit to that script must come with a new
// hash, or the theme stops being restored before first paint. vercel.json
// serves the same headers until the domain leaves Vercel.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Each header under `/*` in Cloudflare's `_headers` format. */
const siteHeaders = (): Map<string, string> => {
  const headers = new Map<string, string>();
  let all = false;
  for (const line of read('../public/_headers').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { all = line.trim() === '/*'; continue; }
    if (!all) continue;
    const at = line.indexOf(':');
    headers.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return headers;
};

test("the CSP allows index.html's inline scripts and nothing else inline", () => {
  const html = read('../index.html');
  const csp = siteHeaders().get('Content-Security-Policy');
  assert.ok(csp, '_headers sets a Content-Security-Policy on /*');
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '))!;
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  assert.ok(inline.length, 'index.html has its theme script');
  for (const hash of inline) assert.ok(scriptSrc.includes(hash), `script-src lacks ${hash}: update the CSP in web/public/_headers`);
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
});

test('vercel.json sends the same headers as _headers', () => {
  const vercel = JSON.parse(read('../../vercel.json'));
  const sent = new Map<string, string>(vercel.headers.flatMap((h: { headers: { key: string; value: string }[] }) => h.headers).map((h: { key: string; value: string }) => [h.key, h.value]));
  assert.deepEqual(sent, siteHeaders());
});
