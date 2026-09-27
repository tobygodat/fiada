import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import type { UploadPolicy } from '@fiada/shared';
import type { ProjectStore, SavedRepo } from './store.ts';
import { gitMeta, readTar, safePath, unpackUpload, UPLOAD, UploadError, withoutCredentials } from './upload.ts';

// Uploads unpack under FIADA_HOME; keep this file's out of the checkout.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-upload-'));
process.env.FIADA_HOME = home;
const { Workspace } = await import('./workspace.ts');
const { AgentHub } = await import('./agents.ts');

/** A tar entry by hand, so a test can say exactly what an archive holds. */
function entry(name: string, body: string | Buffer, type = '0'): Buffer {
  const data = Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const archive = (...entries: Buffer[]) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

async function scratch() {
  return fs.mkdtemp(path.join(home, 'case-'));
}

test('reads what GNU tar writes, long names included', async () => {
  const dir = await scratch();
  const deep = `src/${'nested-folder/'.repeat(9)}really-long-module-name.ts`;
  await fs.mkdir(path.join(dir, 'app', path.dirname(deep)), { recursive: true });
  await fs.writeFile(path.join(dir, 'app', deep), 'export const x = 1;\n');
  await fs.writeFile(path.join(dir, 'app', 'main.py'), 'print("hi")\n');
  const tgz = path.join(dir, 'app.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', path.join(dir, 'app'), '.']);
  const files = [...readTar(zlib.gunzipSync(await fs.readFile(tgz)))].map((e) => [e.path.replace(/^\.\//, ''), e.data.toString()]);
  assert.deepEqual(files.sort(), [
    ['main.py', 'print("hi")\n'],
    [deep, 'export const x = 1;\n'],
  ]);
  assert.ok(deep.length > 100, 'the name needed a long-name header');
});

test('keeps only the source the indexer reads, and never writes outside the folder', async () => {
  const dest = path.join(await scratch(), 'out');
  const got = await unpackUpload(
    archive(
      entry('src/app.ts', 'export function app() {}\n'),
      entry('src/types.d.ts', 'declare const x: number;\n'),
      entry('package.json', '{"name":"app"}'),
      entry('tsconfig.base.json', '{}'),
      entry('.gitignore', 'dist\n'),
      entry('logo.png', Buffer.alloc(64, 1)),
      entry('node_modules/left-pad/index.js', 'module.exports = 1;\n'),
      entry('lib', '', '5'),
      entry('.git/HEAD', 'ref: refs/heads/main\n'),
      entry('.git/refs/heads/main', `${SHA}\n`),
      entry('.git/config', '[remote "origin"]\n\turl = https://x-access-token:secret@github.com/org/private-app.git\n'),
    ),
    dest,
  );
  const listed = execFileSync('find', ['.', '-type', 'f'], { cwd: dest, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, ['./.gitignore', './package.json', './src/app.ts', './tsconfig.base.json']);
  assert.equal(got.files, 4);
  assert.deepEqual(got.git, { remote: 'https://github.com/org/private-app.git', branch: 'main', head: SHA });

  for (const bad of ['../escape.ts', '/etc/cron.ts', 'src/../../x.ts']) {
    const to = path.join(await scratch(), 'out');
    await assert.rejects(unpackUpload(archive(entry(bad, 'x')), to), (err) => err instanceof UploadError && /outside its folder/.test(err.message));
    assert.equal(await fs.stat(to).catch(() => null), null, `${bad}: nothing unpacked`);
  }
  await assert.rejects(unpackUpload(Buffer.from('not gzip'), path.join(await scratch(), 'out')), /not a gzipped tar/);
  await assert.rejects(unpackUpload(zlib.gzipSync(Buffer.alloc(4096)), path.join(await scratch(), 'out')), /no source files/);
  await assert.rejects(unpackUpload(archive(entry('notes.md', '# hi'), entry('.gitignore', 'x')), path.join(await scratch(), 'out')), /no source files/);
});

test('an upload over the limit says so', async () => {
  const small: UploadPolicy = { ...UPLOAD, maxBytes: 1000, maxFiles: 3 };
  await assert.rejects(unpackUpload(archive(entry('a.ts', 'x'.repeat(1001))), path.join(await scratch(), 'o'), small), (err) => {
    assert.ok(err instanceof UploadError);
    assert.equal(err.status, 413);
    assert.match(err.message, /more than 0 MB of source files, the upload limit/);
    return true;
  });
  const four = ['a', 'b', 'c', 'd'].map((n) => entry(`${n}.ts`, 'x'));
  await assert.rejects(unpackUpload(archive(...four), path.join(await scratch(), 'o'), small), /more than 3 source files/);
  // A bomb stops at the archive limit instead of filling memory.
  const bomb = zlib.gzipSync(Buffer.alloc(20 << 20));
  await assert.rejects(unpackUpload(bomb, path.join(await scratch(), 'o'), small), (err) => err instanceof UploadError && err.status === 413);
});

test('git metadata: remote without credentials, packed refs, a detached HEAD', () => {
  assert.equal(withoutCredentials('https://user:pa55@gitlab.com/org/app.git'), 'https://gitlab.com/org/app.git');
  assert.equal(withoutCredentials('git@github.com:org/app.git'), 'git@github.com:org/app.git');
  assert.equal(withoutCredentials('ssh://git@github.com/org/app'), 'ssh://github.com/org/app');
  const packed = new Map([
    ['.git/HEAD', 'ref: refs/heads/feature/x\n'],
    ['.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/feature/x\n`],
    ['.git/config', '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:else/where.git\n[remote "origin"]\n\turl = git@github.com:org/app.git\n'],
  ]);
  assert.deepEqual(gitMeta(packed), { remote: 'git@github.com:org/app.git', branch: 'feature/x', head: SHA });
  assert.deepEqual(gitMeta(new Map([['.git/HEAD', `${SHA}\n`]])), { head: SHA });
  assert.deepEqual(gitMeta(new Map()), {});
  assert.equal(safePath('./src/a.ts'), 'src/a.ts');
  assert.equal(safePath('src//a.ts'), null);
});

function memoryStore(saved: SavedRepo[] = []) {
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => saved,
    saveRepos: async (_id, repos) => {
      saved = repos;
    },
    loadGrouping: async () => null,
    saveGrouping: async () => {},
  };
  return { store, saved: () => saved };
}

async function settled(ws: InstanceType<typeof Workspace>) {
  for (let i = 0; i < 250 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));
}

const project = (extra: Buffer[] = [], body = 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n') =>
  archive(
    entry('src/greet.ts', body),
    entry('src/main.ts', "import { greet } from './greet';\nexport const main = () => greet('you');\n"),
    entry('.git/HEAD', 'ref: refs/heads/main\n'),
    entry('.git/refs/heads/main', `${SHA}\n`),
    ...extra,
  );

test('an uploaded folder is indexed like a clone, replaced by the next upload, and remembered', async () => {
  const mem = memoryStore();
  const ws = new Workspace(mem.store, 'default', { localPaths: false, keyRequired: true });
  await ws.init();

  const config = entry('.git/config', '[remote "origin"]\n\turl = https://github.com/org/private-app.git\n');
  const first = await ws.upload('private-app', project([config]));
  await settled(ws);
  const [repo] = ws.state().repos;
  assert.equal(repo.id, first.id);
  assert.equal(repo.status, 'ready', repo.error);
  assert.equal(repo.kind, 'upload');
  assert.equal(repo.fileCount, 2);
  assert.equal(repo.commit, SHA.slice(0, 7));
  assert.equal(repo.branch, 'main');
  assert.equal(repo.remote, 'https://github.com/org/private-app.git');
  assert.ok(ws.getGraph().nodes.some((n) => n.kind === 'symbol' && n.name === 'greet'));
  assert.equal((await ws.readSource(repo.id, 'src/greet.ts'))?.text.includes('greet'), true);
  assert.deepEqual(
    mem.saved().map(({ id, kind, remote, branch, commit }) => ({ id, kind, remote, branch, commit })),
    [{ id: 'private-app', kind: 'upload', remote: 'https://github.com/org/private-app.git', branch: 'main', commit: SHA.slice(0, 7) }],
  );

  // An agent in the real checkout, wherever it is, finds the upload by its remote.
  const hub = new AgentHub(ws);
  const checkout = '/home/someone/code/private-app';
  const reply = await hub.ingest([
    { agent: { client: 'claude-code', session: 's', cwd: checkout, root: checkout, remote: 'git@github.com:org/private-app.git' }, type: 'changes', files: [{ path: `${checkout}/src/greet.ts`, kind: 'modified' }] },
  ]);
  assert.deepEqual(reply.files.map((f) => [f.repo, f.node]), [['private-app', 'private-app/src/greet.ts']]);

  // The same remote under another folder name replaces it rather than adding a second copy.
  await ws.upload('private-app-copy', project([config], 'export function greet() {}\nexport function wave() {}\n'));
  await settled(ws);
  assert.deepEqual(ws.state().repos.map((r) => [r.id, r.name, r.status]), [['private-app', 'private-app-copy', 'ready']]);
  assert.ok(ws.getGraph().nodes.some((n) => n.kind === 'symbol' && n.name === 'wave'));

  // A bad upload changes nothing.
  await assert.rejects(ws.upload('private-app', archive(entry('../x.ts', 'x'))), UploadError);
  assert.equal(ws.state().repos.length, 1);
  assert.deepEqual((await fs.readdir(path.join(home, 'repos'))).filter((n) => n.startsWith('.upload-')), []);

  // A fresh indexer with the same store and disk picks it up again.
  const again = new Workspace(mem.store, 'default', { localPaths: false, keyRequired: true });
  await again.init();
  await settled(again);
  assert.equal(again.state().repos[0].status, 'ready');
  assert.equal(again.state().repos[0].commit, SHA.slice(0, 7));

  await ws.remove('private-app');
  assert.equal(await fs.stat(path.join(home, 'repos', 'private-app')).catch(() => null), null);
});

test('an upload whose files were lost asks to be uploaded again', async () => {
  const mem = memoryStore([{ id: 'gone', name: 'gone', source: 'gone', kind: 'upload', commit: 'abc1234' }]);
  const ws = new Workspace(mem.store, 'default');
  await ws.init();
  await settled(ws);
  const [repo] = ws.state().repos;
  assert.equal(repo.status, 'error');
  assert.match(repo.error ?? '', /Upload the folder again/);
  assert.equal(repo.commit, 'abc1234');
});
