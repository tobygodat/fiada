import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UNLAYERED, type GraphNode, type Grouping, type RepoInfo } from '@fiada/shared';
import { buildGraph } from './build.ts';
import { classify, defaultGrouping, GroupingError, normalizeGrouping, seedAndPropagate } from './classify/index.ts';
import { projectMatchers } from './classify/layers.ts';
import { globToRegExp } from './classify/glob.ts';
import { importMatches } from './classify/layers.ts';
import { matchRoute, segments } from './link.ts';
import { loadRepo } from './sources.ts';
import { FileProjectStore } from './store.ts';
import { parseSource } from './workspace.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-'));
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

test('globs and import prefixes', () => {
  assert.ok(globToRegExp('src/server/**').test('src/server/a/b.ts'));
  assert.ok(globToRegExp('**/models.py').test('backend/app/models.py'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/use[A-Z]*.ts').test('web/src/hooks/useItems.ts'));
  assert.ok(!globToRegExp('**/use[A-Z]*.ts').test('web/src/users.ts'));
  assert.ok(importMatches('sqlalchemy.orm', 'sqlalchemy'));
  assert.ok(importMatches('next/server', 'next'));
  assert.ok(!importMatches('react-dom', 'react'));
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
  const graph = buildGraph([await loadRepo(info('web'), web), await loadRepo(info('api'), api)], defaultGrouping());
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const has = (from: string, to: string, kind: string) => graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  assert.ok(has('web/src/lib/api.ts#getItem', 'api/app/routes/items.py#read_item', 'http'), 'fetch matched to the FastAPI route');
  assert.ok(has('web/src/components/ItemCard.tsx#ItemCard', 'web/src/lib/api.ts#getItem', 'calls'), 'tsconfig alias resolved');
  assert.ok(has('api/app/routes/items.py#read_item', 'api/app/models.py#Item', 'calls'));

  const layer = (id: string) => byId.get(id)?.layer?.id;
  assert.equal(layer('api/app/routes/items.py'), 'api');
  assert.equal(layer('web/src/components/ItemCard.tsx'), 'ui');
  assert.equal(layer('web/src/lib/api.ts'), 'client');
  assert.equal(layer('web/src/types.ts'), 'contract');
  assert.equal(layer('api/app/models.py'), 'data');
  assert.equal(layer('api/app/models.py#Item'), 'data', 'table=True makes an ORM table');
  assert.equal(layer('api/app/models.py#ItemPublic'), 'contract', 'a schema class splits off its models file');
  assert.equal(byId.get('api/app/routes/items.py#read_item')?.layer?.evidence[0].detail, 'serves GET /items/{id}');
  assert.deepEqual(byId.get('api/app/routes/items.py#read_item')?.routes, ['GET /items/{id}']);
  assert.ok(byId.get('api/app/models.py')?.facts?.some((f) => f.type === 'import' && f.value === 'sqlmodel'));
  assert.deepEqual(graph.layers.map((l) => l.id), ['ui', 'client', 'api', 'service', 'data', 'job', 'contract', 'test']);

  // The same code under the by-repo preset: one layer per repository.
  const byRepo = buildGraph([await loadRepo(info('web'), web), await loadRepo(info('api'), api)], defaultGrouping('by-repo', [info('web'), info('api')]));
  assert.equal(byRepo.nodes.find((n) => n.id === 'api/app/models.py#ItemPublic')?.layer?.id, 'api');
});

// A tiny hand-made graph for exercising the classifier directly.
const file = (id: string, facts: GraphNode['facts'] = []): GraphNode => ({ id, kind: 'file', name: id, parent: 'r', repo: id.split('/')[0], path: id.split('/').slice(1).join('/'), facts });
const sym = (fileId: string, name: string, facts: GraphNode['facts'] = []): GraphNode => ({ id: `${fileId}#${name}`, kind: 'symbol', name, parent: fileId, repo: fileId.split('/')[0], facts });

test('project layers: priorities, neighbours, Unlayered', () => {
  const grouping: Grouping = {
    schema: 1,
    layers: [
      { id: 'edge', name: 'Edge', match: [{ fact: { type: 'route' }, priority: 300 }, { path: '**/handlers/**', priority: 100 }] },
      { id: 'store', name: 'Store', match: [{ import: 'pg', priority: 200 }] },
    ],
    domains: [],
    rules: [],
    pins: {},
  };
  const nodes = [
    file('svc/handlers/a.ts', [{ type: 'import', value: 'pg' }]), // import (200) beats path (100)
    file('svc/handlers/b.ts'),
    file('svc/util/helper.ts'), // only called from handlers
    file('svc/misc/lonely.ts'), // no signal, no neighbours
    sym('svc/handlers/b.ts', 'getThing', [{ type: 'route', value: 'GET /thing' }]),
    sym('svc/handlers/b.ts', 'helper'),
  ];
  const edges = [
    { from: 'svc/handlers/b.ts#getThing', to: 'svc/util/helper.ts', kind: 'calls' as const },
    { from: 'svc/handlers/b.ts#helper', to: 'svc/handlers/a.ts', kind: 'calls' as const },
  ];
  const { layers } = classify(nodes, edges, grouping);
  assert.equal(layers.get('svc/handlers/a.ts')?.id, 'store');
  assert.match(layers.get('svc/handlers/a.ts')!.evidence[1].detail, /would be Edge/);
  assert.equal(layers.get('svc/handlers/b.ts')?.id, 'edge');
  assert.equal(layers.get('svc/util/helper.ts')?.source, 'graph');
  assert.equal(layers.get('svc/util/helper.ts')?.id, 'edge');
  assert.equal(layers.get('svc/misc/lonely.ts')?.id, UNLAYERED);
  assert.equal(layers.get('svc/handlers/b.ts#getThing')?.source, 'fact');
  assert.equal(layers.get('svc/handlers/b.ts#helper')?.source, 'path', 'inherits its file');
});

test('user rules and pins win, later rules over earlier ones', () => {
  const grouping = normalizeGrouping({
    schema: 1,
    layers: [{ id: 'a', name: 'A', match: [{ path: 'r/**', priority: 100 }] }, { id: 'b', name: 'B', match: [] }],
    rules: [
      { match: { path: 'r/legacy/**' }, layer: 'b', domain: 'old' },
      { match: { path: 'r/legacy/**', name: '^keep' }, layer: 'a' },
      { match: { path: 'r/**' }, layer: 'no-such-layer' },
    ],
    pins: { 'r/x.ts': { layer: 'b' } },
  });
  const nodes = [file('r/legacy/old.ts'), sym('r/legacy/old.ts', 'keepMe'), sym('r/legacy/old.ts', 'dropMe'), file('r/x.ts'), sym('r/x.ts', 'f')];
  const { layers, domains, domainList } = classify(nodes, [], grouping);
  assert.equal(layers.get('r/legacy/old.ts')?.id, 'b');
  assert.equal(layers.get('r/legacy/old.ts#keepMe')?.id, 'a');
  assert.equal(layers.get('r/legacy/old.ts#dropMe')?.source, 'user-rule');
  assert.equal(domains.get('r/legacy/old.ts#dropMe')?.id, 'old');
  assert.equal(layers.get('r/x.ts')?.source, 'user-pin');
  assert.equal(layers.get('r/x.ts#f')?.id, 'b', 'a file pin covers its symbols');
  assert.ok(domainList.some((d) => d.id === 'old' && d.name === 'Old'));
});

test('groupings are validated before use', () => {
  assert.throws(() => normalizeGrouping({ layers: [{ id: 'unlayered' }] }), GroupingError);
  assert.throws(() => normalizeGrouping({ layers: [{ id: 'a' }, { id: 'a' }] }), GroupingError);
  assert.throws(() => normalizeGrouping({ layers: [{ id: 'a', match: [{ fact: { type: 'nope' } }] }] }), /fact: type must be/);
  const g = normalizeGrouping({ layers: [{ id: 'a', match: [{ path: 'x/**' }] }], pins: { n: { layer: 'a' }, bad: 3 } });
  assert.equal(g.layers[0].name, 'a');
  assert.equal(g.layers[0].match[0].priority, 100);
  assert.deepEqual(Object.keys(g.pins), ['n']);
});

test('file store round-trips a project and ignores its own writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-store-'));
  const store = new FileProjectStore(dir);
  assert.equal(await store.loadGrouping('p1'), null);
  let changes = 0;
  const stop = store.watchGrouping('p1', () => changes++);
  await store.saveGrouping('p1', defaultGrouping());
  await store.saveRepos('p1', [{ id: 'a', name: 'a', source: '/tmp/a', kind: 'local' }]);
  assert.equal(normalizeGrouping(await store.loadGrouping('p1')).layers.length, 8);
  assert.equal((await store.loadRepos('p1'))?.[0].id, 'a');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(changes, 0);
  await fs.writeFile(store.describe('p1'), JSON.stringify({ schema: 1, layers: [] }));
  await new Promise((r) => setTimeout(r, 300));
  stop();
  assert.equal(changes, 1, 'a hand edit is noticed');
  assert.throws(() => store.describe('../escape'));
});

test('domains: seeds from routes, entities and feature folders spread along edges', () => {
  const route = (v: string) => [{ type: 'route' as const, value: v }];
  const nodes: GraphNode[] = [
    { id: 'app', kind: 'repo', name: 'app', parent: 'root', repo: 'app' },
    file('app/api/routes/items.py'),
    sym('app/api/routes/items.py', 'read_item', route('GET /items/{id}')),
    sym('app/api/routes/items.py', 'read_user_items', route('GET /users/{id}/items')),
    file('app/api/routes/users.py'),
    sym('app/api/routes/users.py', 'read_user', route('GET /users/{id}')),
    file('app/models.py'),
    sym('app/models.py', 'Item', [{ type: 'table', value: 'Item' }]),
    sym('app/models.py', 'User', [{ type: 'table', value: 'User' }]),
    file('app/crud.py'),
    sym('app/crud.py', 'get_item'), // only items code uses it
    sym('app/crud.py', 'get_session'), // everything uses it
    file('web/components/Items/ItemCard.tsx'),
    sym('web/components/Items/ItemCard.tsx', 'ItemCard'),
    file('web/components/ui/button.tsx'),
    sym('web/components/ui/button.tsx', 'Button'),
    file('web/components/Billing/Invoice.tsx'),
    sym('web/components/Billing/Invoice.tsx', 'Invoice'),
    file('app/api/routes/orders.py'),
    sym('app/api/routes/orders.py', 'list_orders', route('GET /orders')),
    file('web/components/Orders/OrderList.tsx'),
    sym('web/components/Orders/OrderList.tsx', 'OrderList'),
    file('web/lib/misc.ts'),
    sym('web/lib/misc.ts', 'noop'),
  ];
  const e = (from: string, to: string, kind: 'calls' | 'renders' = 'calls') => ({ from, to, kind });
  const edges = [
    e('app/api/routes/items.py#read_item', 'app/crud.py#get_item'),
    e('app/crud.py#get_item', 'app/models.py#Item'),
    e('app/api/routes/items.py#read_item', 'app/crud.py#get_session'),
    e('app/api/routes/users.py#read_user', 'app/crud.py#get_session'),
    e('web/components/Items/ItemCard.tsx#ItemCard', 'app/crud.py#get_session'),
    e('web/components/Orders/OrderList.tsx#OrderList', 'app/crud.py#get_session'),
    e('web/components/Items/ItemCard.tsx#ItemCard', 'web/components/ui/button.tsx#Button', 'renders'),
    e('web/components/Billing/Invoice.tsx#Invoice', 'web/components/ui/button.tsx#Button', 'renders'),
  ];
  const grouping = { ...defaultGrouping(), pins: { 'web/components/Billing/Invoice.tsx#Invoice': { domain: 'item' } } };
  const { domains, domainList } = classify(nodes, edges, grouping, { layers: projectMatchers, domains: seedAndPropagate() });
  const d = (id: string) => domains.get(id)?.id;
  assert.equal(d('app/api/routes/items.py#read_item'), 'item');
  assert.equal(d('app/api/routes/items.py#read_user_items'), 'user', 'its own route beats its module');
  assert.equal(d('app/models.py#User'), 'user');
  assert.equal(d('app/crud.py#get_item'), 'item');
  assert.equal(domains.get('app/crud.py#get_item')?.source, 'propagated');
  assert.equal(d('app/crud.py#get_session'), 'shared', 'used directly by Items, Users and Orders');
  assert.match(domains.get('app/crud.py#get_session')!.evidence[0].detail, /^used directly by /);
  assert.equal(d('web/components/Items/ItemCard.tsx#ItemCard'), 'item');
  assert.equal(d('web/components/ui/button.tsx#Button'), 'item', 'the pin pulled Invoice, and with it the button, into Items');
  assert.equal(d('web/components/Billing/Invoice.tsx#Invoice'), 'item');
  assert.equal(d('web/lib/misc.ts#noop'), 'unsorted');
  assert.ok(!domainList.some((x) => x.id === 'billing'), 'one file naming itself is not a domain');
  assert.deepEqual(
    domainList.filter((x) => x.id === 'item' || x.id === 'user').map((x) => x.name),
    ['Items', 'Users'],
  );
});
