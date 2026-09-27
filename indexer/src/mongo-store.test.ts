import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Grouping } from '@strata/shared';
import { decodeKeys, encodeKeys, MongoProjectStore, ProjectConflictError, redact } from './mongo-store.ts';
import { createStore, FileProjectStore, type SavedRepo } from './store.ts';

const repos: SavedRepo[] = [{ id: 'web', name: 'web', source: 'https://github.com/org/web', kind: 'git' }];
// Only the shape matters to the store; the workspace validates groupings.
const grouping = {
  rules: [{ match: { path: 'web/src/**' }, domain: 'items' }],
  pins: { 'web/src/api.ts#Items.fetch': { domain: 'items' }, $odd: { layer: 'ui' } },
} as unknown as Grouping;

test('field names with dots and dollars survive a round trip', () => {
  const encoded = encodeKeys(grouping) as { pins: Record<string, unknown> };
  assert.ok(Object.keys(encoded.pins).every((k) => !k.includes('.') && !k.includes('$')));
  assert.deepEqual(decodeKeys(encoded), grouping);

  // Distinct keys stay distinct, including ones that look like escapes.
  const tricky = { 'api.ts': 1, 'api．ts': 2, 'api%2Ets': 3, 'a%b': 4, $x: 5, 'x$y': 6, '%24x': 7 };
  const out = encodeKeys(tricky) as Record<string, number>;
  assert.equal(Object.keys(out).length, Object.keys(tricky).length);
  assert.deepEqual(decodeKeys(out), tricky);
});

test('connection strings are logged without credentials', () => {
  assert.equal(redact('mongodb+srv://toby:s3cret@cluster0.ab12c.mongodb.net/?retryWrites=true&w=majority'), 'mongodb+srv://cluster0.ab12c.mongodb.net');
  assert.equal(redact('mongodb://127.0.0.1:27017/strata'), 'mongodb://127.0.0.1:27017');
});

test('createStore uses files when MONGODB_URI is unset or MongoDB is unusable', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-store-'));
  const previous = process.env.MONGODB_URI;
  try {
    delete process.env.MONGODB_URI;
    assert.ok((await createStore(home)) instanceof FileProjectStore);

    process.env.MONGODB_URI = 'mongodb+srv://toby:s3cret@cluster0.example.mongodb.net/';
    t.mock.method(MongoProjectStore, 'connect', async () => {
      throw new Error('bad auth : authentication failed');
    });
    assert.ok((await createStore(home)) instanceof FileProjectStore);
  } finally {
    if (previous === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previous;
  }
});

// These need a MongoDB to talk to, e.g. STRATA_TEST_MONGODB_URI=mongodb://127.0.0.1:27017
const mongoUri = process.env.STRATA_TEST_MONGODB_URI;
const needsMongo = { skip: !mongoUri && 'set STRATA_TEST_MONGODB_URI to run' };

async function withDb(name: string, run: (open: () => Promise<MongoProjectStore>, raw: MongoClient) => Promise<void>) {
  const dbName = `strata_test_${name}_${process.pid}`;
  const raw = new MongoClient(mongoUri!);
  const opened: MongoProjectStore[] = [];
  try {
    await run(async () => {
      const store = await MongoProjectStore.connect(mongoUri!, dbName);
      opened.push(store);
      return store;
    }, raw);
  } finally {
    await raw.db(dbName).dropDatabase().catch(() => {});
    await raw.close();
    for (const s of opened) await s.close();
  }
}

test('mongo store keeps repos and grouping in one document per project', needsMongo, () =>
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

    const docs = await raw.db(`strata_test_roundtrip_${process.pid}`).collection('projects').find().sort({ _id: 1 }).toArray();
    assert.deepEqual(docs.map((d) => d._id), ['default', 'demo']);
    assert.equal(docs[0].reposRev, 2);
    assert.equal(docs[0].groupingRev, 1);
  }),
);

test('mongo store refuses to overwrite a save from another indexer', needsMongo, () =>
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

    // Revisions are per field: a stale repo list doesn't block a grouping save.
    assert.equal(await a.loadGrouping('p'), null);
    await a.saveGrouping('p', grouping);
    assert.deepEqual(await b.loadGrouping('p'), grouping);
    assert.deepEqual(await b.loadRepos('p'), repos);
  }),
);
