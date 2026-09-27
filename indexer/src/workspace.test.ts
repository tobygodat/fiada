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
  const missing = '/nonexistent/strata-test-repo';
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
