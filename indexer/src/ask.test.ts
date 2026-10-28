import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DependentsAnswer, FindAnswer, ImpactAnswer } from '@fiada/shared';
import { answer, clampInt, dependents, find, impact, resolveTarget } from './ask.ts';
import type { ProjectStore, SavedRepo } from './store.ts';
import { indexGraph } from './summaries/describe.ts';
import { Workspace } from './workspace.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function memoryStore(saved: SavedRepo[]): ProjectStore {
  return { describe: () => 'memory', loadRepos: async () => saved, saveRepos: async () => {}, loadGrouping: async () => null, saveGrouping: async () => {} };
}

async function folder(files: Record<string, string>) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-ask-')));

  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }

  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');

  return dir;
}

// Two repositories: a FastAPI server, and a web client that requests its routes.
const API = {
  'app/main.py': `from fastapi import FastAPI\nfrom app.items import router\n\napp = FastAPI()\napp.include_router(router, prefix="/api")\n`,
  'app/items.py': [
    'from fastapi import APIRouter',
    'from app.store import save_item',
    '',
    'router = APIRouter()',
    '',
    '@router.post("/items")',
    'def create_item(name: str):',
    '    return save_item(name)',
    '',
    '@router.get("/items")',
    'def list_items():',
    '    return []',
    '',
  ].join('\n'),
  'app/store.py': 'def save_item(name):\n    return {"name": name}\n',
};

const WEB = {
  'src/client.ts': [
    'export function createItem(name: string) {',
    "  return fetch('/api/items', { method: 'POST', body: JSON.stringify({ name }) });",
    '}',
    '',
  ].join('\n'),
  'src/AddItem.tsx': [
    "import { createItem } from './client';",
    '',
    'export function AddItem() {',
    "  return <button onClick={() => createItem('x')}>add</button>;",
    '}',
    '',
  ].join('\n'),
  'src/App.tsx': ["import { AddItem } from './AddItem';", '', 'export function App() {', '  return <AddItem />;', '}', ''].join('\n'),
};

let shared: Promise<ReturnType<typeof indexGraph>> | null = null;

/** Both repositories, indexed once for every test here. */
function graph() {
  return (shared ??= (async () => {
    const [api, web] = await Promise.all([folder(API), folder(WEB)]);

    const ws = new Workspace(
      memoryStore([
        { id: 'api', name: 'api', source: api, kind: 'local' },
        { id: 'web', name: 'web', source: web, kind: 'local' },
      ]),
      'default',
    );

    await ws.init();

    for (let i = 0; i < 300 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));

    return indexGraph(ws.getGraph());
  })());
}

test('where something lives: by name, by words in any spelling, and by route', async () => {
  const gi = await graph();
  const hit = find(gi, 'create_item').hits[0];
  assert.equal(hit.id, 'api/app/items.py#create_item');
  assert.equal(hit.kind, 'symbol');
  assert.equal(hit.path, 'app/items.py');
  assert.deepEqual(hit.lines, [6, 8]);
  assert.ok(hit.layer && hit.domain, 'files and symbols say their layer and domain');
  // "create item" finds both spellings of it; the exact name is no better than camelCase.
  const ids = find(gi, 'create item').hits.map((h) => h.id);
  assert.ok(ids.includes('api/app/items.py#create_item') && ids.includes('web/src/client.ts#createItem'), ids.join(', '));
  assert.equal(find(gi, 'POST /api/items').hits[0].id, 'api/app/items.py#create_item');
  // Summaries come from whoever has one.
  assert.equal(find(gi, 'save_item', 1, (id) => `about ${id}`).hits[0].summary, 'about api/app/store.py#save_item');
  // A limit, and how many more there were.
  const few = find(gi, 'item', 2);
  assert.equal(few.hits.length, 2);
  assert.ok(few.more > 0);
  assert.deepEqual(find(gi, 'zzz nothing').hits, []);
});

test('a target is an id, a path, the end of a path, path#symbol or a name; several matches come back to choose from', async () => {
  const gi = await graph();

  const id = (t: string) => {
    const r = resolveTarget(gi, t);

    return 'node' in r ? r.node.id : r.candidates.map((c) => c.id);
  };

  assert.equal(id('api/app/store.py#save_item'), 'api/app/store.py#save_item');
  assert.equal(id('app/store.py'), 'api/app/store.py');
  assert.equal(id('./store.py'), 'api/app/store.py');
  assert.equal(id('src/client.ts#createItem'), 'web/src/client.ts#createItem');
  assert.equal(id('client.ts#createItem'), 'web/src/client.ts#createItem');
  assert.equal(id('AddItem'), 'web/src/AddItem.tsx#AddItem');
  assert.equal(id('web'), 'web');
  assert.equal(id('app'), 'api/app');
  // A name in another case, when only one has it; create_item and createItem are the same words, so say which.
  assert.equal(id('createitem'), 'web/src/client.ts#createItem');
  assert.deepEqual(id('create item'), ['api/app/items.py#create_item', 'web/src/client.ts#createItem']);
  assert.deepEqual(id('nothing at all'), []);
  // A path#symbol whose path doesn't hold it offers the symbol elsewhere rather than answering for it.
  assert.deepEqual(id('missing/file.py#save_item'), ['api/app/store.py#save_item']);
  assert.deepEqual(id('api/app/items.py#save_item'), ['api/app/store.py#save_item']);
});

test('who uses something: callers, importers and HTTP clients, with the code that proves each link', async () => {
  const gi = await graph();
  const save = dependents(gi, gi.byId.get('api/app/store.py#save_item')!);
  assert.deepEqual(save.dependents.map((d) => d.id), ['api/app/items.py#create_item']);
  const call = save.dependents[0].links.find((l) => l.kind === 'calls')!;
  assert.equal(call.basis, 'evidenced');
  assert.ok(call.evidence.some((e) => e.file === 'api/app/items.py' && e.line === 8 && e.code === 'return save_item(name)'), JSON.stringify(call.evidence));
  assert.equal(save.dependents[0].crossRepo, false);

  // The route is requested from the other repository.
  const route = dependents(gi, gi.byId.get('api/app/items.py#create_item')!);
  const client = route.dependents.find((d) => d.id === 'web/src/client.ts#createItem');
  assert.ok(client, route.dependents.map((d) => d.id).join(', '));
  assert.equal(client.crossRepo, true);
  assert.equal(client.links[0].kind, 'http');
  assert.ok(client.links[0].evidence.some((e) => e.file === 'web/src/client.ts' && e.line === 2));

  // A file's users include the users of the code in it, but not the file's own code.
  const store = dependents(gi, gi.byId.get('api/app/store.py')!);
  assert.ok(store.dependents.some((d) => d.id === 'api/app/items.py#create_item' || d.id === 'api/app/items.py'));
  assert.ok(!store.dependents.some((d) => d.id.startsWith('api/app/store.py')));
  assert.equal(dependents(gi, gi.byId.get('web/src/App.tsx#App')!).dependents.length, 0);
});

test('what an edit reaches: dependents of dependents, nearest first, across repositories, with counts', async () => {
  const gi = await graph();
  const a = impact(gi, gi.byId.get('api/app/store.py#save_item')!, 4);
  const at = (id: string) => a.reached.find((r) => r.id === id);
  assert.equal(at('api/app/items.py#create_item')?.depth, 1);
  assert.equal(at('web/src/client.ts#createItem')?.depth, 2);
  assert.equal(at('web/src/client.ts#createItem')?.crossRepo, true);
  assert.equal(at('web/src/client.ts#createItem')?.link, 'http');
  assert.equal(at('web/src/AddItem.tsx#AddItem')?.depth, 3);
  assert.equal(at('web/src/App.tsx#App')?.depth, 4);
  // Each node once, at its nearest distance; never the target or what's inside it.
  assert.equal(new Set(a.reached.map((r) => r.id)).size, a.reached.length);
  assert.ok(!a.reached.some((r) => r.id.startsWith('api/app/store.py')));
  assert.ok(a.reached.every((r, i) => i === 0 || a.reached[i - 1].depth <= r.depth));
  assert.equal(a.byRepo.api + a.byRepo.web, a.reached.length);
  // Depth stops it.
  const near = impact(gi, gi.byId.get('api/app/store.py#save_item')!, 1);
  assert.ok(near.reached.every((r) => r.depth === 1));
  assert.ok(!near.reached.some((r) => r.repo === 'web'));
  // A limit lists the nearest and counts the rest.
  const one = impact(gi, gi.byId.get('api/app/store.py#save_item')!, 4, 1);
  assert.equal(one.reached.length, 1);
  assert.equal(one.more, a.reached.length - 1);
  assert.equal(Object.values(one.byRepo).reduce((x, y) => x + y, 0), a.reached.length);
});

test('the routes answer with a status: 400 without a question, 404 for nothing, candidates for several', async () => {
  const gi = await graph();
  assert.equal(answer(gi, 'find', {}).status, 400);
  assert.equal(answer(gi, 'dependents', { node: ' ' }).status, 400);
  assert.equal(answer(gi, 'impact', {}).status, 400);
  const found = answer(gi, 'find', { q: 'save item', limit: '1' });
  assert.equal(found.status, 200);
  assert.equal((found.body as FindAnswer).hits.length, 1);
  assert.equal(answer(gi, 'dependents', { node: 'nothing at all' }).status, 404);
  const several = answer(gi, 'dependents', { node: 'create item' });
  assert.equal(several.status, 200);
  assert.equal((several.body as { target: null }).target, null);
  const deps = answer(gi, 'dependents', { node: 'app/store.py#save_item' }).body as DependentsAnswer;
  assert.equal(deps.target.id, 'api/app/store.py#save_item');
  const reach = answer(gi, 'impact', { node: 'api/app/store.py#save_item', depth: '99', limit: '0' }).body as ImpactAnswer;
  assert.equal(reach.depth, 6);
  assert.equal(reach.reached.length, 1);
  assert.equal(clampInt('abc', 3, 1, 6), 3);
  assert.equal(clampInt('2.6', 3, 1, 6), 3);
  assert.equal(clampInt(-4, 3, 1, 6), 1);
});
