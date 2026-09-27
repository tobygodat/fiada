import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileProjectStore } from './store.ts';
import { Workspace } from './workspace.ts';

test('the code view reads indexed files and nothing else', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-src-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/items.ts'), 'export function listItems() {\n  return [];\n}\n');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-home-'));
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
