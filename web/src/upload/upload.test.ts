import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { UploadPolicy } from '@fiada/shared';
import { collect, fromFileList, pack, type Folder } from './folder.ts';
import { isIgnored, parseGitignore } from './gitignore.ts';

// What the indexer sends in /api/workspace (indexer/src/upload.ts), trimmed.
const POLICY: UploadPolicy = {
  maxBytes: 50 << 20,
  maxFiles: 20_000,
  files: String.raw`^(?!.*\.d\.ts$)(?!.*\.min\.js$).*(?:\.ts|\.tsx|\.js|\.py|\.go)$|(^|\/)(package\.json|[tj]sconfig(\..+)?\.json|go\.mod)$`,
  skipDirs: ['node_modules', '.git', 'dist', '__pycache__', '.venv'],
};

test('gitignore patterns', () => {
  const rules = [
    ...parseGitignore(['# comment', '*.log', '/build', 'out/', 'docs/**/*.gen.ts', '**/fixtures', 'secret?.ts', '!keep.log', '\\#hash', 'trailing   ', ''].join('\n')),
    ...parseGitignore('*.ts\n!index.ts\n/local-only\n', 'pkg'),
  ];

  const cases: [string, boolean, boolean][] = [
    ['app.log', false, true],
    ['src/deep/app.log', false, true],
    ['keep.log', false, false],
    ['build', true, true],
    ['src/build', true, false], // anchored to the top
    ['out', true, true],
    ['out', false, false], // "out/" only matches folders
    ['src/out', true, true],
    ['docs/a/b/x.gen.ts', false, true],
    ['docs/x.gen.ts', false, true],
    ['src/docs/x.gen.ts', false, false],
    ['a/b/fixtures', true, true],
    ['secret1.ts', false, true],
    ['secret12.ts', false, false],
    ['#hash', false, true],
    ['trailing', false, true],
    ['pkg/a.ts', false, true],
    ['pkg/index.ts', false, false],
    ['a.ts', false, false], // pkg's rules stay in pkg
    ['pkg/local-only', true, true],
    ['pkg/sub/local-only', true, false],
  ];

  for (const [p, dir, want] of cases) assert.equal(isIgnored(rules, p, dir), want, `${p}${dir ? '/' : ''}`);
});

/** A folder on disk, walked the way the browser's directory handle is. */
function fromDisk(dir: string): Folder {
  return {
    name: path.basename(dir),
    async entries() {
      return Promise.all(
        (await fs.readdir(dir, { withFileTypes: true })).map(async (e) => {
          const abs = path.join(dir, e.name);

          return e.isDirectory() ? { name: e.name, folder: fromDisk(abs) } : { name: e.name, file: async () => new File([await fs.readFile(abs)], e.name) };
        }),
      );
    },
  };
}

async function repo() {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-pick-')), 'private-app');

  const files = {
    '.gitignore': 'generated/\n*.local.ts\n',
    'package.json': '{"name":"private-app"}',
    'src/app.ts': 'export const app = 1;\n',
    'src/app.local.ts': 'export const secret = 1;\n',
    'src/types.d.ts': 'declare const x: 1;\n',
    'src/generated/api.ts': 'export {};\n',
    'src/ui/Button.tsx': 'export const Button = () => null;\n',
    'server/main.py': 'print(1)\n',
    'server/.gitignore': '!keep.local.ts\n',
    'server/keep.local.ts': 'export {};\n',
    'README.md': '# hi\n',
    'logo.png': 'png',
    [`src/${'very-long-folder-name/'.repeat(6)}deep.ts`]: 'export const deep = 1;\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'dist/app.js': 'x',
  } satisfies Record<string, string>;

  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.join(root, path.dirname(p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:org/private-app.git'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });

  return root;
}

test('a folder is walked for its source and packed into a tar the indexer can read', async () => {
  const root = await repo();
  const picked = await collect(fromDisk(root), POLICY);
  const paths = picked.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    '.git/HEAD',
    '.git/config',
    '.git/refs/heads/main',
    '.gitignore',
    'package.json',
    'server/.gitignore',
    'server/keep.local.ts',
    'server/main.py',
    'src/app.ts',
    'src/ui/Button.tsx',
    `src/${'very-long-folder-name/'.repeat(6)}deep.ts`,
  ]);
  assert.equal(picked.sources, 6);

  // GNU tar agrees on what's inside, long name included.
  const tgz = path.join(path.dirname(root), 'out.tgz');
  await fs.writeFile(tgz, Buffer.from(await (await pack(picked)).arrayBuffer()));
  const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, paths);
  const out = path.join(path.dirname(root), 'unpacked');
  await fs.mkdir(out);
  execFileSync('tar', ['-xzf', tgz, '-C', out]);
  assert.equal(await fs.readFile(path.join(out, `src/${'very-long-folder-name/'.repeat(6)}deep.ts`), 'utf8'), 'export const deep = 1;\n');
  assert.match(await fs.readFile(path.join(out, '.git/config'), 'utf8'), /git@github\.com:org\/private-app\.git/);
});

test('a folder over the limit stops with the reason', async () => {
  const root = await repo();
  await assert.rejects(collect(fromDisk(root), { ...POLICY, maxBytes: 40 }), /private-app has more than 0 MB of source files, the upload limit/);
  await assert.rejects(collect(fromDisk(root), { ...POLICY, maxFiles: 2 }), /more than 2 source files/);
  const empty = path.join(path.dirname(root), 'empty');
  await fs.mkdir(empty);
  await fs.writeFile(path.join(empty, 'notes.md'), '# notes');
  await assert.rejects(collect(fromDisk(empty), POLICY), /Nothing to map in empty/);
});

test('an <input webkitdirectory> file list becomes the same folder', async () => {
  const file = (rel: string, text: string) => Object.defineProperty(new File([text], rel.split('/').pop()!), 'webkitRelativePath', { value: rel });

  const folder = fromFileList([
    file('app/.gitignore', 'ignored.ts\n'),
    file('app/src/a.ts', 'export {};'),
    file('app/src/ignored.ts', 'export {};'),
    file('app/node_modules/x/index.js', ''),
    file('app/.git/HEAD', 'ref: refs/heads/main\n'),
    file('app/.git/objects/ab/cdef', 'blob'),
  ]);

  assert.equal(folder?.name, 'app');
  const picked = await collect(folder!, POLICY);
  assert.deepEqual(picked.files.map((f) => f.path).sort(), ['.git/HEAD', '.gitignore', 'src/a.ts']);
  assert.equal(fromFileList([]), null);
});
