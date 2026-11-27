import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProjectStore, SavedRepo } from './store.ts';
import { UploadError } from './upload.ts';
import { Workspace } from './workspace.ts';

// A store whose saves can be made to fail, as Postgres does when another
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

/** A git repository with one committed file, to clone from. */
async function commitOne() {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-src-'));
  await fs.writeFile(path.join(src, 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q', src]);
  execFileSync('git', ['-C', src, 'add', '.']);
  execFileSync('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a']);

  return src;
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

test('a project holds at most maxRepos repositories', async () => {
  const dirs = await Promise.all([1, 2, 3].map(() => fs.mkdtemp(path.join(os.tmpdir(), 'fiada-cap-'))));
  const flaky = flakyStore([]);
  const ws = new Workspace(flaky.store, 'default', undefined, undefined, { clones: await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-')), maxRepos: 2 });
  await ws.init();
  await ws.add(dirs[0]);
  await ws.add(dirs[1]);
  // The same one again refreshes it rather than counting twice.
  await ws.add(dirs[1]);
  await assert.rejects(ws.add(dirs[2]), /2 repositories at most/);
  assert.equal(ws.repos.length, 2);
  await settled(ws);
});

test('a clone larger than maxCloneBytes is removed and reported', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-big-'));
  await fs.writeFile(path.join(src, 'big.ts'), `export const big = "${'x'.repeat(4096)}";\n`);
  execFileSync('git', ['init', '-q', src]);
  execFileSync('git', ['-C', src, 'add', '.']);
  execFileSync('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'big']);
  const clones = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-'));
  const flaky = flakyStore([{ id: 'big', name: 'big', source: `file://${src}`, kind: 'git' }]);
  const ws = new Workspace(flaky.store, 'default', undefined, undefined, { clones, maxCloneBytes: 1024 });
  await ws.init();
  await settled(ws);
  assert.equal(ws.repos[0].status, 'error');
  assert.match(ws.repos[0].error ?? '', /over this indexer's limit/);
  assert.match(ws.repos[0].error ?? '', /more than 0 MB/);
  assert.deepEqual(await fs.readdir(clones), []);
});

test('a clone that fails leaves nothing on disk', async () => {
  const clones = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-'));
  const flaky = flakyStore([{ id: 'gone', name: 'gone', source: `file://${path.join(clones, 'no-such-repo')}`, kind: 'git' }]);
  const ws = new Workspace(flaky.store, 'default', undefined, undefined, { clones, maxCloneBytes: 1 << 20 });
  await ws.init();
  await settled(ws);
  assert.equal(ws.repos[0].status, 'error');
  assert.deepEqual(await fs.readdir(clones), []);
});

test('below minFreeBytes, a project takes no imports, clones or uploads', async () => {
  const src = await commitOne();
  const clones = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-'));
  const flaky = flakyStore([{ id: 'saved', name: 'saved', source: `file://${src}`, kind: 'git' }]);
  const ws = new Workspace(flaky.store, 'default', undefined, undefined, { clones, minFreeBytes: Number.MAX_SAFE_INTEGER });
  await ws.init();
  await settled(ws);

  // Saved before the disk filled: not cloned again.
  assert.equal(ws.repos[0].status, 'error');
  assert.match(ws.repos[0].error ?? '', /disk is nearly full \(\d+ MB free\)/);
  assert.deepEqual(await fs.readdir(clones), []);

  await assert.rejects(ws.add(await commitOne()), /disk is nearly full/);
  assert.deepEqual(flaky.saved().map((r) => r.id), ['saved']);

  await assert.rejects(ws.upload('folder', Buffer.from('not unpacked')), (err) => err instanceof UploadError && err.status === 507);
  assert.deepEqual(await fs.readdir(clones), []);
  assert.equal(ws.repos.length, 1);
});

test('two adds of one repository at once count it once, disk check and all', async () => {
  const src = await commitOne();
  const ws = new Workspace(flakyStore([]).store, 'default', undefined, undefined, { clones: await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-')), maxRepos: 1, minFreeBytes: 1 });
  await ws.init();
  await Promise.all([ws.add(src), ws.add(src)]);
  assert.equal(ws.repos.length, 1);
  await settled(ws);
});

test('with room above minFreeBytes, a clone goes ahead', async () => {
  const src = await commitOne();
  const clones = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-clones-'));
  const flaky = flakyStore([{ id: 'saved', name: 'saved', source: `file://${src}`, kind: 'git' }]);
  const ws = new Workspace(flaky.store, 'default', undefined, undefined, { clones, minFreeBytes: 1 });
  await ws.init();
  await settled(ws);
  assert.equal(ws.repos[0].status, 'ready');
  assert.deepEqual(await fs.readdir(clones), ['saved']);
});
