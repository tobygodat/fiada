import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import type { Grouping } from '@fiada/shared';
import { PostgresProjectStore, ProjectConflictError, redact, unquote } from './postgres-store.ts';
import { createStore, FileProjectStore, type SavedRepo } from './store.ts';

const repos: SavedRepo[] = [{ id: 'web', name: 'web', source: 'https://github.com/org/web', kind: 'git' }];

// Only the shape matters to the store; the workspace validates groupings.
const grouping = {
  schema: 1,
  layers: [],
  domains: [],
  rules: [{ match: { path: 'web/src/**' }, domain: 'items' }],
  pins: { 'web/src/api.ts#Items.fetch': { domain: 'items' }, $odd: { layer: 'ui' } },
} satisfies Grouping;

test('connection strings are logged without credentials', () => {
  assert.equal(redact('postgresql://postgres.abc:s3cret@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), 'postgresql://aws-0-us-west-1.pooler.supabase.com:5432');
  assert.equal(redact('postgres://127.0.0.1:5432/fiada'), 'postgres://127.0.0.1:5432');
  assert.equal(redact('postgresql://postgres:p@ss@db.example.supabase.co:5432/postgres'), 'postgresql://db.example.supabase.co:5432');
  assert.equal(redact('not a url'), 'the configured server');
});

test('connection strings pasted with their .env quotes still work', () => {
  const url = 'postgresql://postgres.abc:s3cret@aws-0-us-west-1.pooler.supabase.com:5432/postgres';
  assert.equal(unquote(` "${url}" `), url);
  assert.equal(unquote(`${url}"`), url);
  assert.equal(unquote(`'${url}'`), url);
  assert.equal(unquote(url), url);
  assert.equal(unquote(undefined), '');
});

test('createStore uses files when DATABASE_URL is unset, or on this machine when Postgres is unusable', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-store-'));
  const previous = process.env.DATABASE_URL;

  try {
    delete process.env.DATABASE_URL;
    assert.ok((await createStore(home)) instanceof FileProjectStore);

    process.env.DATABASE_URL = 'postgresql://postgres:s3cret@db.example.supabase.co:5432/postgres';
    t.mock.method(PostgresProjectStore, 'connect', async () => {
      throw new Error('password authentication failed for user "postgres"');
    });
    assert.ok((await createStore(home)) instanceof FileProjectStore);

    // An indexer others reach would lose those files on restart, so it doesn't start.
    await assert.rejects(createStore(home, false), /password authentication failed/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test('file store counts accounts and repositories for the usage numbers, missing folders and all', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-store-'));
  const store = new FileProjectStore(home);
  assert.deepEqual(await store.usage(), { accounts: [], reposPerProject: [] });

  await store.saveSignIn({ id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's', scopes: 'repo', updatedAt: 't1' });
  await store.saveSignIn({ id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's', scopes: 'repo', updatedAt: 't2' });
  await store.saveRepos('gh-1', repos);
  await store.saveRepos('gh-2', []);
  await store.saveGrouping('gh-3', grouping);
  assert.deepEqual(await store.usage(), { accounts: [{ createdAt: 't1', updatedAt: 't2' }], reposPerProject: [1, 0] });
});

// These need a Postgres to talk to, e.g. FIADA_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
const dbUrl = process.env.FIADA_TEST_DATABASE_URL;
const needsPostgres = { skip: !dbUrl && 'set FIADA_TEST_DATABASE_URL to run' };

async function withDb(name: string, run: (open: () => Promise<PostgresProjectStore>, raw: postgres.Sql) => Promise<void>) {
  const schema = `fiada_test_${name}_${process.pid}`;
  const raw = postgres(dbUrl!, { onnotice: () => {} });
  const opened: PostgresProjectStore[] = [];

  try {
    await run(async () => {
      const store = await PostgresProjectStore.connect(dbUrl!, schema);
      opened.push(store);

      return store;
    }, raw);
  } finally {
    for (const s of opened) await s.close();
    await raw.unsafe(`drop schema if exists ${schema} cascade`).catch(() => {});
    await raw.end();
  }
}

test('postgres store keeps repos and grouping in one row per project', needsPostgres, () =>
  withDb('roundtrip', async (open, raw) => {
    const store = await open();
    assert.equal(await store.loadRepos('default'), null);
    assert.equal(await store.loadGrouping('default'), null);

    await store.saveRepos('default', repos);
    await store.saveGrouping('default', grouping);
    await store.saveRepos('demo', []);
    assert.deepEqual(await store.loadRepos('default'), repos);
    assert.deepEqual(await store.loadGrouping('default'), grouping);
    assert.equal(await store.loadGrouping('demo'), null);

    // Saving one field leaves the other alone.
    await store.saveRepos('default', []);
    assert.deepEqual(await store.loadGrouping('default'), grouping);

    const rows = await raw.unsafe(`select id, repos_rev, grouping_rev from fiada_test_roundtrip_${process.pid}.projects order by id`);
    assert.deepEqual(rows.map((r) => [r.id, r.repos_rev, r.grouping_rev]), [['default', 2, 1], ['demo', 1, 0]]);
  }),
);

test('overlapping saves from one indexer apply in order instead of conflicting', needsPostgres, () =>
  withDb('overlap', async (open) => {
    const store = await open();
    assert.equal(await store.loadRepos('p'), null);
    const lists = [repos, [], [...repos, { id: 'api', name: 'api', source: '/src/api', kind: 'local' as const }]];
    await Promise.all(lists.map((list) => store.saveRepos('p', list)));
    assert.deepEqual(await store.loadRepos('p'), lists[2]);
  }),
);

test('postgres store refuses to overwrite a save from another indexer', needsPostgres, () =>
  withDb('conflict', async (open) => {
    const a = await open();
    const b = await open();

    // Both start from an empty project; only the first to save wins.
    assert.equal(await a.loadRepos('p'), null);
    assert.equal(await b.loadRepos('p'), null);
    await a.saveRepos('p', repos);
    await assert.rejects(b.saveRepos('p', []), ProjectConflictError);

    // Both load the same revision; again only the first save lands.
    assert.deepEqual(await b.loadRepos('p'), repos);
    await a.saveRepos('p', [...repos, { id: 'api', name: 'api', source: '/src/api', kind: 'local' }]);
    await assert.rejects(b.saveRepos('p', []), ProjectConflictError);

    // After reloading, b saves again, and now a is the stale one.
    assert.equal((await b.loadRepos('p'))?.length, 2);
    await b.saveRepos('p', repos);
    await assert.rejects(a.saveRepos('p', []), ProjectConflictError);

    // Re-saving an unchanged list (every indexer does after indexing) is a
    // no-op, so it doesn't make the other indexer stale, even though jsonb
    // hands the keys back in another order.
    assert.deepEqual(await a.loadRepos('p'), repos);
    await b.saveRepos('p', repos);
    await a.saveRepos('p', repos);
    await b.saveRepos('p', []);
    assert.deepEqual(await a.loadRepos('p'), []);

    // Revisions are per field: a stale repo list doesn't block a grouping save.
    assert.equal(await a.loadGrouping('p'), null);
    await a.saveGrouping('p', grouping);
    assert.deepEqual(await b.loadGrouping('p'), grouping);
    await b.saveGrouping('p', { ...grouping });
    await a.saveGrouping('p', grouping);
    assert.deepEqual(await b.loadRepos('p'), []);
  }),
);

test('postgres store changes accounts in one step each, so a sign-in never undoes a reset', needsPostgres, () =>
  withDb('accounts', async (open) => {
    const [one, two] = [await open(), await open()];
    const signIn = { id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's1', scopes: 'repo', updatedAt: 't1' };
    assert.equal(await one.loadAccount('gh-1'), null);
    assert.equal(await one.bumpAgentEpoch('gh-1', 't'), null);
    assert.deepEqual(await one.saveSignIn(signIn), { ...signIn, agentEpoch: 0, createdAt: 't1' });
    await Promise.all([one.bumpAgentEpoch('gh-1', 't2'), two.saveSignIn({ ...signIn, name: 'Ada', sealedToken: 's2', updatedAt: 't3' })]);
    const saved = await two.loadAccount('gh-1');
    assert.equal(saved?.agentEpoch, 1);
    assert.equal(saved?.sealedToken, 's2');
    assert.equal(saved?.name, 'Ada');
    assert.equal(saved?.createdAt, 't1');
  }),
);

test('postgres store deletes a project and an account, and a project made again starts afresh', needsPostgres, () =>
  withDb('delete', async (open) => {
    const store = await open();
    await store.saveRepos('gh-1', repos);
    await store.saveGrouping('gh-1', grouping);
    await store.saveFences('gh-1', [{ node: 'web/src', rule: 'off', at: 't' }]);
    await store.saveSummaries('gh-1', { h: { text: 't', model: 'm', at: 'a' } });
    await store.saveSummaries('gh-2', { h: { text: 'kept', model: 'm', at: 'a' } });
    await store.saveSignIn({ id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's', scopes: 'repo', updatedAt: 't' });
    await store.deleteProject('gh-1');
    await store.deleteAccount('gh-1');
    assert.equal(await store.loadRepos('gh-1'), null);
    assert.equal(await store.loadGrouping('gh-1'), null);
    assert.equal(await store.loadFences('gh-1'), null);
    assert.equal(await store.loadSummaries('gh-1'), null);
    assert.equal(await store.loadAccount('gh-1'), null);
    assert.deepEqual(await store.loadSummaries('gh-2'), { h: { text: 'kept', model: 'm', at: 'a' } });
    await store.saveRepos('gh-1', []);
    assert.deepEqual(await store.loadRepos('gh-1'), []);
  }),
);

test('postgres store adds summaries without dropping the ones saved before', needsPostgres, () =>
  withDb('summaries', async (open) => {
    const store = await open();
    await store.saveSummaries('p', { a: { text: 'one', model: 'm', at: '1' } });
    await store.saveSummaries('p', { a: { text: 'two', model: 'm', at: '2' }, b: { text: 'b', model: 'm', at: '2' } });
    assert.deepEqual(await store.loadSummaries('p'), { a: { text: 'two', model: 'm', at: '2' }, b: { text: 'b', model: 'm', at: '2' } });
  }),
);

test('postgres store counts accounts and repositories for the usage numbers', needsPostgres, () =>
  withDb('usage', async (open) => {
    const store = await open();
    assert.deepEqual(await store.usage(), { accounts: [], reposPerProject: [] });
    await store.saveSignIn({ id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's', scopes: 'repo', updatedAt: 't1' });
    await store.saveSignIn({ id: 'gh-1', githubId: 1, login: 'ada', sealedToken: 's', scopes: 'repo', updatedAt: 't2' });
    await store.saveRepos('gh-1', repos);
    await store.saveRepos('gh-2', []);
    await store.saveGrouping('gh-3', grouping);
    const usage = await store.usage();
    assert.deepEqual(usage.accounts, [{ createdAt: 't1', updatedAt: 't2' }]);
    assert.deepEqual(usage.reposPerProject.sort(), [0, 0, 1]);
  }),
);
