import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RepoInfo } from '@strata/shared';
import { buildGraph } from './build.ts';
import { globToRegExp } from './classify/config.ts';
import { matchRoute, segments } from './link.ts';
import { loadRepo } from './sources.ts';
import { parseSource } from './workspace.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const info = (id: string): RepoInfo => ({ id, name: id, source: id, kind: 'local', status: 'indexing' });

test('route matching tolerates mount prefixes and param styles', () => {
  const routes = [
    { method: 'GET', path: '/items/', node: 'list', segs: segments('/items/') },
    { method: 'GET', path: '/items/{id}', node: 'one', segs: segments('/items/{id}') },
    { method: 'POST', path: '/items/', node: 'create', segs: segments('/items/') },
  ];
  assert.equal(matchRoute(routes, 'GET', segments('/api/v1/items/'))?.node, 'list');
  assert.equal(matchRoute(routes, 'GET', segments('/api/v1/items/{}'))?.node, 'one');
  assert.equal(matchRoute(routes, 'POST', segments('/api/v1/items'))?.node, 'create');
  assert.equal(matchRoute(routes, 'DELETE', segments('/api/v1/items/1')), null);
  assert.deepEqual(segments('/users/:id/posts/[slug]'), ['users', '*', 'posts', '*']);
});

test('config globs', () => {
  assert.ok(globToRegExp('src/server/**').test('src/server/a/b.ts'));
  assert.ok(globToRegExp('**/models.py').test('backend/app/models.py'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
});

test('parseSource understands what people paste', async () => {
  assert.deepEqual(await parseSource('fastapi/full-stack-fastapi-template'), {
    kind: 'git',
    location: 'https://github.com/fastapi/full-stack-fastapi-template',
    name: 'full-stack-fastapi-template',
  });
  assert.equal((await parseSource('github.com/org/repo/')).location, 'https://github.com/org/repo');
  assert.equal((await parseSource('git@github.com:org/repo.git')).name, 'repo');
  assert.equal((await parseSource(os.tmpdir())).kind, 'local');
  await assert.rejects(parseSource('--upload-pack=evil'));
});

test('links a web client to an API in another repo, and classifies both', async () => {
  const web = await fixture({
    'package.json': JSON.stringify({ name: 'web', dependencies: { react: '19' } }),
    'tsconfig.json': '{ "compilerOptions": { /* alias */ "paths": { "@/*": ["./src/*"] } } }',
    'src/lib/api.ts': 'export async function getItem(id: string) { return fetch(`${BASE}/api/items/${id}`); }',
    'src/components/ItemCard.tsx': 'import { getItem } from "@/lib/api";\nexport function ItemCard() { getItem("1"); return <div/>; }',
    'src/types.ts': 'export interface Item { id: string }\nexport type ItemId = string;',
  });
  const api = await fixture({
    'app/__init__.py': '',
    'app/models.py': 'from sqlmodel import SQLModel\nclass Item(SQLModel, table=True):\n    id: str\nclass ItemPublic(SQLModel):\n    id: str\n',
    'app/routes/items.py':
      'from fastapi import APIRouter\nfrom app.models import Item, ItemPublic\nrouter = APIRouter(prefix="/items")\n' +
      '@router.get("/{id}")\ndef read_item(id: str) -> ItemPublic:\n    return Item(id=id)\n',
  });
  const graph = buildGraph([await loadRepo(info('web'), web), await loadRepo(info('api'), api)]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const has = (from: string, to: string, kind: string) => graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  assert.ok(has('web/src/lib/api.ts#getItem', 'api/app/routes/items.py#read_item', 'http'), 'fetch matched to the FastAPI route');
  assert.ok(has('web/src/components/ItemCard.tsx#ItemCard', 'web/src/lib/api.ts#getItem', 'calls'), 'tsconfig alias resolved');
  assert.ok(has('api/app/routes/items.py#read_item', 'api/app/models.py#Item', 'calls'));

  assert.equal(byId.get('api/app/routes/items.py')?.layer?.value, 'API');
  assert.equal(byId.get('web/src/components/ItemCard.tsx')?.layer?.value, 'UI');
  assert.equal(byId.get('web/src/lib/api.ts')?.layer?.value, 'Client');
  assert.equal(byId.get('web/src/types.ts')?.layer?.value, 'Contracts');
  assert.equal(byId.get('api/app/models.py#Item')?.layer?.value, 'Storage');
  assert.equal(byId.get('api/app/models.py#ItemPublic')?.layer?.value, 'Contracts');
  assert.deepEqual(byId.get('api/app/routes/items.py#read_item')?.routes, ['GET /items/{id}']);
});
