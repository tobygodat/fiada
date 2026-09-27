import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectStore, SavedRepo } from './store.ts';
import { Workspace } from './workspace.ts';

// A store whose saves can be made to fail, as MongoDB does when another
// indexer changed the project first.
function flakyStore(saved: SavedRepo[]) {
  let failSaves = false;
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => saved,
    saveRepos: async (_id, repos) => {
      if (failSaves) throw new Error('saved by another indexer');
      saved = repos;
    },
    loadGrouping: async () => null,
    saveGrouping: async () => {},
  };
  return { store, failNextSaves: () => (failSaves = true), saved: () => saved };
}

async function settled(ws: Workspace) {
  for (let i = 0; i < 100 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));
}

test('a rejected save leaves added and removed repos as they were', async () => {
  const missing = '/nonexistent/fiada-test-repo';
  const flaky = flakyStore([{ id: 'kept', name: 'kept', source: missing, kind: 'local' }]);
  const ws = new Workspace(flaky.store, 'default');
  await ws.init();
  await settled(ws);

  flaky.failNextSaves();
  await assert.rejects(ws.remove('kept'), /another indexer/);
  assert.deepEqual(ws.state().repos.map((r) => r.id), ['kept']);

  await assert.rejects(ws.add(process.cwd()), /another indexer/);
  assert.deepEqual(ws.state().repos.map((r) => r.id), ['kept']);
  assert.deepEqual(flaky.saved().map((r) => r.id), ['kept']);
});

test('a hosted indexer neither imports nor reads local folders', async () => {
  const flaky = flakyStore([{ id: 'laptop', name: 'laptop', source: process.cwd(), kind: 'local' }]);
  const ws = new Workspace(flaky.store, 'default', { localPaths: false, keyRequired: true });
  await ws.init();
  await settled(ws);

  // Saved by an indexer on someone's machine: kept in the project, but not read here.
  const [saved] = ws.state().repos;
  assert.equal(saved.status, 'error');
  assert.match(saved.error ?? '', /git repositories only/);
  assert.equal(await ws.readSource('laptop', 'package.json'), null);

  await assert.rejects(ws.add('/etc'), /git repositories only/);
  await assert.rejects(ws.add('~/secrets'), /git repositories only/);
  assert.deepEqual(flaky.saved().map((r) => r.id), ['laptop']);
  assert.ok(!ws.state().suggestions.some((s) => s.startsWith('/')), 'no local suggestion');
  assert.deepEqual(ws.state().access, { localPaths: false, keyRequired: true });
});
