import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HAND_CLIENT, type ActivityState } from '@strata/shared';
import { AgentHub } from './agents.ts';
import type { ProjectStore } from './store.ts';
import { LocalWatcher } from './watch.ts';
import { Workspace } from './workspace.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const API = `export function listItems() {
  return fetch('/api/items');
}

export function getItem(id: string) {
  return fetch('/api/items/' + id);
}
`;

/** A committed local repo, indexed, with a watcher on it that settles quickly. */
async function watched() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'strata-watch-')));
  for (const [p, text] of Object.entries({ 'src/api.ts': API, '.gitignore': 'build/\n' })) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => [{ id: 'web', name: 'web', source: dir, kind: 'local' }],
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
  };
  const ws = new Workspace(store, 'default');
  await ws.init();
  for (let i = 0; i < 200 && ws.state().busy; i++) await sleep(20);
  const hub = new AgentHub(ws);
  const watcher = new LocalWatcher(ws, hub, 100);
  // Started once the repo was indexed; chokidar needs a moment to be ready.
  for (let i = 0; i < 100 && !watcher.isWatching('web'); i++) await sleep(20);
  return { dir, ws, hub, watcher };
}

/** The first state, now or pushed later, that passes `until`. */
function until(hub: AgentHub, ok: (s: ActivityState) => boolean, ms = 5000): Promise<ActivityState> {
  return new Promise((resolve, reject) => {
    if (ok(hub.state())) return resolve(hub.state());
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out; last state: ${JSON.stringify(hub.state().agents)}`));
    }, ms);
    const off = hub.subscribe((s) => {
      if (!ok(s)) return;
      clearTimeout(timer);
      off();
      resolve(s);
    });
  });
}

const hands = (s: ActivityState) => s.agents.find((a) => a.client === HAND_CLIENT);

test('a file saved by hand shows as yours, re-indexed, and comes off once it matches HEAD again', async () => {
  const { dir, ws, hub, watcher } = await watched();
  try {
    await fs.writeFile(path.join(dir, 'src/api.ts'), API.replace("fetch('/api/items')", "fetch('/api/items?all=1')"));
    const s = await until(hub, (s) => !!hands(s)?.files[0]?.symbols.length);
    const you = hands(s)!;
    assert.equal(you.name, 'You');
    assert.equal(you.state, 'waiting');
    assert.deepEqual(
      you.files.map((f) => [f.path, f.kind, f.additions, f.deletions]),
      [['src/api.ts', 'modified', 1, 1]],
    );
    assert.deepEqual(you.files[0].symbols.map((x) => [x.name, x.kind]), [['listItems', 'modified']]);
    assert.ok(hub.diffs('web/src/api.ts')[0].diff?.includes("+  return fetch('/api/items?all=1');"));

    // A new file is parsed and put on the map.
    await fs.writeFile(path.join(dir, 'src/tags.ts'), 'export function listTags() {\n  return [];\n}\n');
    const has = (id: string) => ws.getGraph().nodes.some((n) => n.id === id);
    await until(hub, (s) => !!hands(s)?.files.some((f) => f.path === 'src/tags.ts' && f.kind === 'added') && has('web/src/tags.ts#listTags'));

    // Both back to HEAD: nothing left, so the record goes.
    await fs.writeFile(path.join(dir, 'src/api.ts'), API);
    await fs.rm(path.join(dir, 'src/tags.ts'));
    await until(hub, (s) => !hands(s) && !has('web/src/tags.ts'));
  } finally {
    await watcher.close();
  }
});

test("an agent's own edit stays the agent's, and files git ignores stay out", async () => {
  const { dir, hub, watcher } = await watched();
  try {
    const agent = { client: 'claude-code', session: 's1', cwd: dir, root: dir };
    await hub.ingest([{ type: 'prompt', agent, text: 'Add paging' }]);
    await fs.writeFile(path.join(dir, 'src/api.ts'), `${API}\nexport const PAGE = 20;\n`);
    // The hook reports it right after the tool writes.
    await hub.ingest([{ type: 'changes', agent, files: [{ path: 'src/api.ts', kind: 'modified', lines: [[9, 9]], oldLines: [[9, 8]] }] }]);
    await fs.mkdir(path.join(dir, 'build'), { recursive: true });
    await fs.writeFile(path.join(dir, 'build/out.js'), 'export const x = 1;\n');
    await sleep(600);
    const s = hub.state();
    assert.equal(hands(s), undefined);
    assert.deepEqual(s.agents.map((a) => [a.client, a.files.map((f) => f.path)]), [['claude-code', ['src/api.ts']]]);
  } finally {
    await watcher.close();
  }
});

test('a hand edit the watcher saw first goes to the working agent that then reports it', async () => {
  const { dir, hub, watcher } = await watched();
  try {
    const agent = { client: 'claude-code', session: 's2', cwd: dir, root: dir };
    await hub.ingest([{ type: 'prompt', agent, text: 'Regenerate the client' }]);
    // A long shell command writes the file; its hook only sweeps once the command is done.
    await fs.writeFile(path.join(dir, 'src/api.ts'), `${API}\nexport const GENERATED = true;\n`);
    await until(hub, (s) => !!hands(s)?.files.length);
    await hub.ingest([{ type: 'changes', agent, files: [{ path: 'src/api.ts', kind: 'modified', swept: true }] }]);
    const s = hub.state();
    assert.equal(hands(s), undefined);
    assert.deepEqual(s.agents.map((a) => a.client), ['claude-code']);
  } finally {
    await watcher.close();
  }
});
