// The HTTP server as an agent meets it: started for real, with a repository
// imported, asked the read routes the MCP server's tools use.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActivityState, DependentsAnswer, FindAnswer, ImpactAnswer } from '@fiada/shared';

const KEY = 'test-key';
let base = '';
let server: ChildProcess | null = null;
let log = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const get = async <T>(route: string, key?: string) => {
  const res = await fetch(`${base}${route}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: res.status, body: (await res.json()) as T };
};

before(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-server-'));
  const repo = path.join(home, 'shop');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src/cart.ts'), "export function addToCart(id: string) {\n  return id;\n}\n");
  await fs.writeFile(path.join(repo, 'src/page.ts'), "import { addToCart } from './cart';\n\nexport function buy() {\n  return addToCart('a');\n}\n");
  for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-qm', 'init']]) execFileSync('git', ['-C', repo, ...args]);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', FIADA_HOME: home, FIADA_API_KEY: KEY, FIADA_PROJECT: 'test' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FIADA_GITHUB_CLIENT_ID', 'FIADA_GITHUB_CLIENT_SECRET', 'STRATA_GITHUB_CLIENT_ID', 'STRATA_GITHUB_CLIENT_SECRET', 'MONGODB_URI']) delete env[k];
  const entry = fileURLToPath(new URL('./server.ts', import.meta.url));
  server = spawn(process.execPath, ['--import', 'tsx', entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (c) => (log += c));
  server.stderr!.on('data', (c) => (log += c));
  for (let i = 0; i < 150 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('listening'), log);

  const add = await fetch(`${base}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ source: repo }) });
  assert.equal(add.status, 202);
  for (let i = 0; i < 150; i++) {
    const ws = (await get<{ busy: boolean; repos: { status: string }[] }>('/api/workspace')).body;
    if (!ws.busy && ws.repos[0]?.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  server?.kill();
});

test('the read routes answer without the access key, as every read does', async () => {
  const found = await get<FindAnswer>('/api/agent/find?q=add%20to%20cart');
  assert.equal(found.status, 200);
  assert.equal(found.body.hits[0].id, 'shop/src/cart.ts#addToCart');

  const users = await get<DependentsAnswer>('/api/agent/dependents?node=cart.ts%23addToCart');
  assert.equal(users.status, 200);
  assert.deepEqual(users.body.dependents.map((d) => d.id), ['shop/src/page.ts#buy']);
  assert.ok(users.body.dependents[0].links[0].evidence.some((e) => e.file === 'shop/src/page.ts' && e.line === 4));

  const reach = await get<ImpactAnswer>('/api/agent/impact?node=shop/src/cart.ts&depth=2');
  assert.equal(reach.status, 200);
  assert.ok(reach.body.reached.some((r) => r.id === 'shop/src/page.ts#buy' && r.depth === 1));
  assert.equal(reach.body.depth, 2);

  assert.equal((await get('/api/agent/find')).status, 400);
  assert.equal((await get('/api/agent/impact?node=nowhere')).status, 404);
});

test('what the agent looked at goes through the events route, which still needs the key', async () => {
  const agent = { client: 'claude-code', session: 'x', cwd: '/elsewhere' };
  const events = [{ agent, type: 'looked', nodes: ['shop/src/cart.ts#addToCart'] }];
  const post = (key?: string) =>
    fetch(`${base}/api/agent/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(events) });
  assert.equal((await post()).status, 401);
  assert.equal((await post(KEY)).status, 200);
  const state = await get<ActivityState>('/api/agent/state');
  assert.deepEqual(Object.keys(state.body.looked ?? {}), ['shop/src/cart.ts#addToCart']);
  assert.equal(state.body.agents[0].looked?.count, 1);
});
