import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileProjectStore } from './store.ts';
import { Workspace } from './workspace.ts';

test('the code view reads indexed files and nothing else', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-src-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/items.ts'), 'export function listItems() {\n  return [];\n}\n');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-home-'));
  const ws = new Workspace(new FileProjectStore(home), 'test');
  const repo = await ws.add(dir);
  for (let i = 0; i < 200 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(repo.status, 'ready', repo.error);

  const src = await ws.readSource(repo.id, 'src/items.ts');
  assert.match(src?.text ?? '', /listItems/);
  assert.equal(await ws.readSource(repo.id, '.env'), null);
  assert.equal(await ws.readSource(repo.id, '../../etc/passwd'), null);
  assert.equal(await ws.readSource('nope', 'src/items.ts'), null);
});

test('links out of a repository are never read, even when one appears after indexing', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-outside-'));
  await fs.writeFile(path.join(outside, 'secret.ts'), 'export const SECRET = "hunter2";\n');
  await fs.writeFile(path.join(outside, 'package.json'), '{ "name": "stolen", "dependencies": { "express": "1" } }\n');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-src-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/items.ts'), 'export function listItems() {\n  return [];\n}\n');
  await fs.writeFile(path.join(dir, 'src/also.ts'), 'export const also = 1;\n');
  // A link inside the repository is fine; ones leading out of it are skipped.
  await fs.symlink('items.ts', path.join(dir, 'src/alias.ts'));
  await fs.symlink(path.join(outside, 'secret.ts'), path.join(dir, 'src/leak.ts'));
  await fs.symlink(path.join(outside, 'package.json'), path.join(dir, 'package.json'));
  // As a clone would be: git lists links as files.
  execFileSync('git', ['init', '-q', dir]);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-home-'));
  const ws = new Workspace(new FileProjectStore(home), 'test');
  const repo = await ws.add(dir);
  for (let i = 0; i < 200 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(repo.status, 'ready', repo.error);

  assert.equal(await ws.readSource(repo.id, 'src/leak.ts'), null);
  assert.match((await ws.readSource(repo.id, 'src/alias.ts'))?.text ?? '', /listItems/);
  assert.ok(!repo.frameworks?.includes('express'), 'a linked manifest is not read');

  // A file parsed as a plain file, then swapped for a link (as a refresh could), isn't served.
  await fs.rm(path.join(dir, 'src/also.ts'));
  await fs.symlink(path.join(outside, 'secret.ts'), path.join(dir, 'src/also.ts'));
  assert.equal(await ws.readSource(repo.id, 'src/also.ts'), null);
});
