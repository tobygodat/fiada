// The site's Content-Security-Policy (vercel.json) allows index.html's one
// inline script by its hash, so an edit to that script must come with a new
// hash, or the theme stops being restored before first paint.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test("the CSP allows index.html's inline scripts and nothing else inline", () => {
  const html = read('../index.html');
  const vercel = JSON.parse(read('../../vercel.json'));
  const csp: string = vercel.headers.flatMap((h: { headers: { key: string; value: string }[] }) => h.headers).find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '))!;
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  assert.ok(inline.length, 'index.html has its theme script');
  for (const hash of inline) assert.ok(scriptSrc.includes(hash), `script-src lacks ${hash}: update the CSP in vercel.json`);
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
});
