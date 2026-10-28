import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileProjectStore } from './store.ts';
import { clonesOf, openTenant, Tenants, type Tenant } from './tenants.ts';

/** Waits for the graph to hold the repository: a repo reads ready a moment before the graph is rebuilt. */
const settle = async (t: Tenant) => {
  for (let i = 0; i < 200 && (t.ws.state().busy || !t.ws.getGraph().nodes.length); i++) await new Promise((r) => setTimeout(r, 25));
};

async function project(store: FileProjectStore, home: string, projectId: string) {
  return openTenant({
    store,
    projectId,
    // Local folders stand in for clones here; a hosted indexer turns them off.
    access: { localPaths: true, keyRequired: false },
    sortLlm: null,
    summaryLlm: null,
    clones: clonesOf(home, projectId),
    githubToken: () => null,
    suggestions: () => [`${projectId}/own-repo`],
    account: () => ({ login: projectId, privateRepos: true }),
  });
}

test("one person's project never shows another's repositories, files or agents", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-tenants-'));
  const code = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-code-'));
  await fs.writeFile(path.join(code, 'secret.ts'), 'export const plan = 1;\n');
  const store = new FileProjectStore(home);
  const ada = await project(store, home, 'gh-1');
  const bob = await project(store, home, 'gh-2');

  try {
    const repo = await ada.ws.add(code);
    await settle(ada);
    assert.equal(repo.status, 'ready', repo.error);
    assert.equal(ada.ws.repos.length, 1);
    assert.equal(bob.ws.repos.length, 0);
    assert.equal(bob.ws.getGraph().nodes.length, 0);
    assert.ok(ada.ws.getGraph().nodes.some((n) => n.path === 'secret.ts'));
    assert.equal(await bob.ws.readSource(repo.id, 'secret.ts'), null);
    assert.equal((await ada.ws.readSource(repo.id, 'secret.ts'))?.text, 'export const plan = 1;\n');

    await ada.agents.ingest([{ type: 'status', text: 'working on the plan', agent: { client: 'claude-code', cwd: code, session: 's1' } }]);
    assert.equal(ada.agents.state().agents.length, 1);
    assert.equal(bob.agents.state().agents.length, 0);

    // Each project is saved on its own, and says whose it is.
    assert.equal((await store.loadRepos('gh-1'))?.length, 1);
    assert.equal(await store.loadRepos('gh-2'), null);
    assert.equal(ada.ws.state().account?.login, 'gh-1');
    assert.deepEqual(bob.ws.state().suggestions, ['gh-2/own-repo']);
    assert.equal(bob.ws.state().ownSuggestions, true);
  } finally {
    await ada.close();
    await bob.close();
  }
});

test('projects open once however many requests arrive, and close when idle', async () => {
  let t = 0;
  let opened = 0;
  const closed: string[] = [];

  const tenants = new Tenants(
    async (projectId) => {
      opened++;
      const idle = { state: () => ({ busy: false }) };

      return { projectId, ws: idle, agents: { watched: false }, close: async () => void closed.push(projectId) } as unknown as Tenant;
    },
    1000,
    () => t,
  );

  const who = { login: 'ada', privateRepos: false };
  const [a, b] = await Promise.all([tenants.get('gh-1', who), tenants.get('gh-1', who)]);
  assert.equal(a, b);
  assert.equal(opened, 1);
  await tenants.get('gh-2', who);
  t = 600;
  await tenants.get('gh-2', who);
  t = 1200;
  await tenants.sweep();
  assert.deepEqual(closed, ['gh-1']);
  assert.equal(tenants.size, 1);
  await tenants.get('gh-1', who);
  assert.equal(opened, 3, 'a closed project opens again when asked for');
  await tenants.closeAll();
});
