// A person's own model key on a running indexer people sign in to: the map's
// header sets it for the person asking and nobody else, and a request
// without it takes it away. Sessions are minted with the indexer's secret,
// so no GitHub is involved.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODEL_KEY_HEADER, type SortingState } from '@fiada/shared';
import { Auth } from './auth.ts';
import { FileProjectStore } from './store.ts';

const SECRET = 'model-key-test-secret';
const KEY_A = `sk-ant-api03-${'a'.repeat(48)}`;
const KEY_B = `sk-proj-${'b'.repeat(48)}`;
let base = '';
let home = '';
let server: ChildProcess | null = null;
let log = '';
const sessions: Record<'ada' | 'bob', string> = { ada: '', bob: '' };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const at = s.address();
      assert.ok(at instanceof Object);
      s.close(() => resolve(at.port));
    });
  });

/** What the person's map says about sorting, asked with their model key or without one. */
async function sorting(who: 'ada' | 'bob', key?: string): Promise<SortingState> {
  const authorization = `Bearer ${sessions[who]}`;
  const res = await fetch(`${base}/api/workspace`, { headers: key ? { authorization, [MODEL_KEY_HEADER]: key } : { authorization } });
  assert.equal(res.status, 200);

  return ((await res.json()) as { sorting: SortingState }).sorting;
}

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-model-key-'));
  const store = new FileProjectStore(home);
  const auth = new Auth(store, { clientId: 'id', clientSecret: 'shh', secret: SECRET, scope: 'read:user repo' });

  for (const [who, githubId] of [['ada', 1], ['bob', 2]] as const) {
    const account = await store.saveSignIn({ id: `gh-${githubId}`, githubId, login: who, sealedToken: 'not-sealed', scopes: 'read:user', updatedAt: new Date().toISOString() });
    sessions[who] = auth.sessionToken(account);
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', FIADA_HOME: home, FIADA_GITHUB_CLIENT_ID: 'id', FIADA_GITHUB_CLIENT_SECRET: 'shh', FIADA_SESSION_SECRET: SECRET };

  for (const k of ['OPENAI_API_KEY', 'FIADA_API_KEY', 'STRATA_GITHUB_CLIENT_ID', 'STRATA_GITHUB_CLIENT_SECRET', 'STRATA_SESSION_SECRET']) delete env[k];
  // The indexer's own key, which a signed-in person's map never uses.
  env.ANTHROPIC_API_KEY = `sk-ant-api03-${'h'.repeat(48)}`;
  // Empty rather than deleted, so the indexer can't load one from the repo's .env.
  env.DATABASE_URL = '';
  const entry = fileURLToPath(new URL('./server.ts', import.meta.url));
  server = spawn(process.execPath, ['--import', 'tsx', entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (c) => (log += c));
  server.stderr!.on('data', (c) => (log += c));

  for (let i = 0; i < 150 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('listening'), log);
});

after(() => {
  server?.kill();
});

test("without their own key a signed-in person's map sorts by rules, whatever key the indexer has", async () => {
  const s = await sorting('ada');
  assert.equal(s.available, false);
  assert.equal(s.status, 'off');
  assert.match(s.keyHint ?? '', /under model key in the sidebar/);
  assert.match(log, /each person's own model key; the indexer's ANTHROPIC_API_KEY or OPENAI_API_KEY is unused/);
});

test("one person's key sorts their map alone, and a request without it takes it away", async () => {
  assert.equal((await sorting('ada', KEY_A)).available, true);
  assert.equal((await sorting('bob')).available, false, "bob's map doesn't get ada's key");
  assert.equal((await sorting('ada', KEY_A)).by, 'Claude');
  assert.equal((await sorting('bob', KEY_B)).by, 'OpenAI');
  assert.equal((await sorting('ada', KEY_A)).by, 'Claude', "ada's map keeps her key");
  assert.equal((await sorting('ada')).available, false);
  assert.equal((await sorting('bob', KEY_B)).available, true);

  const removed = await fetch(`${base}/api/model-key`, { method: 'DELETE', headers: { authorization: `Bearer ${sessions.bob}` } });
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { sorting: SortingState }).sorting.available, false);
  // Something that isn't a key is ignored, as no key.
  assert.equal((await sorting('bob', 'not a key')).available, false);
});

test("saving a key says what's wrong with one that can't be a key, without asking a provider", async () => {
  const res = await fetch(`${base}/api/model-key`, { method: 'PUT', headers: { authorization: `Bearer ${sessions.ada}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sk-oops' }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /isn't an Anthropic key \(sk-ant-…\) or an OpenAI key/);

  const signedOut = await fetch(`${base}/api/model-key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY_A }) });
  assert.equal(signedOut.status, 401);
});

test('no key reaches the log or the disk', async () => {
  const keys = [KEY_A, KEY_B].map((k) => k.slice(8));

  for (const k of keys) assert.ok(!log.includes(k), 'the log holds a key');

  for (const name of await fs.readdir(home, { recursive: true })) {
    const file = path.join(home, name);

    if (!(await fs.stat(file)).isFile()) continue;
    const text = await fs.readFile(file, 'utf8');

    for (const k of keys) assert.ok(!text.includes(k), `${name} holds a key`);
  }
});
