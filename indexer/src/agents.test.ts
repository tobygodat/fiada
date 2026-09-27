import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ActivityState, AgentRef } from '@strata/shared';
import { AgentHub, remoteKey, touches } from './agents.ts';
import type { ProjectStore, SavedRepo } from './store.ts';
import { Workspace } from './workspace.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function memoryStore(saved: SavedRepo[]): ProjectStore {
  return {
    describe: () => 'memory',
    loadRepos: async () => saved,
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
  };
}

const API = `export function listItems() {
  return fetch('/api/items');
}

export function getItem(id: string) {
  return fetch('/api/items/' + id);
}
`;

async function localRepo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'strata-agents-')));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/api.ts'), API);
  await fs.writeFile(path.join(dir, 'src/old.ts'), 'export function legacy() {\n  return 1;\n}\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  const ws = new Workspace(memoryStore([{ id: 'web', name: 'web', source: dir, kind: 'local' }]), 'default');
  await ws.init();
  for (let i = 0; i < 200 && ws.state().busy; i++) await new Promise((r) => setTimeout(r, 20));
  return { dir, ws };
}

/** The next state pushed after something changed the graph. */
const nextPush = (hub: AgentHub, until: (s: ActivityState) => boolean) =>
  new Promise<ActivityState>((resolve) => {
    const off = hub.subscribe((s) => {
      if (until(s)) {
        off();
        resolve(s);
      }
    });
  });

test('remote URLs compare however they are spelled', () => {
  assert.equal(remoteKey('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(remoteKey('https://github.com/org/repo'), 'github.com/org/repo');
  assert.equal(remoteKey('https://x-access-token:abc@github.com/org/repo.git/'), 'github.com/org/repo');
});

test('line ranges touch a symbol; pure removals only inside it', () => {
  assert.ok(touches([5, 10], [[10, 12]]));
  assert.ok(!touches([5, 10], [[11, 12]]));
  assert.ok(touches([5, 10], [[8, 7]]));
  assert.ok(!touches([5, 10], [[5, 4]]));
});

test('an agent edit is mapped to its file and symbols, and the file re-indexed', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };

  await hub.ingest([
    { agent, type: 'prompt', text: 'Add item search' },
    { agent, type: 'task', steps: [{ text: 'Add searchItems', status: 'active' }, { text: 'Use it on the page', status: 'pending' }] },
  ]);

  // getItem changes and searchItems is added after it; old.ts is deleted.
  await fs.writeFile(
    path.join(dir, 'src/api.ts'),
    API.replace("'/api/items/' + id", '`/api/items/${id}`') + `\nexport function searchItems(q: string) {\n  return fetch('/api/items?q=' + q);\n}\n`,
  );
  await fs.rm(path.join(dir, 'src/old.ts'));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1 && !!s.nodes['web/src/api.ts#searchItems']);
  const reply = await hub.ingest([
    {
      agent,
      type: 'changes',
      files: [
        { path: path.join(dir, 'src/api.ts'), kind: 'modified', lines: [[6, 6], [9, 12]], oldLines: [[6, 6], [9, 8]], additions: 5, deletions: 1, diff: '@@ -6 +6 @@\n-x\n+y\n' },
        { path: 'src/old.ts', kind: 'deleted', oldLines: [[1, 3]], deletions: 3 },
        { path: '/somewhere/else.ts', kind: 'added' },
      ],
    },
  ]);
  assert.deepEqual(
    reply.files.map((f) => [f.path, f.repo, f.node]),
    [
      ['src/api.ts', 'web', 'web/src/api.ts'],
      ['src/old.ts', 'web', 'web/src/old.ts'],
      ['/somewhere/else.ts', undefined, undefined],
    ],
  );

  const s = await pushed;
  assert.equal(s.nodes['web/src/api.ts'].kind, 'modified');
  assert.equal(s.nodes['web/src/api.ts#getItem'].kind, 'modified');
  assert.equal(s.nodes['web/src/api.ts#searchItems'].kind, 'added');
  assert.equal(s.nodes['web/src/api.ts#listItems'], undefined);
  // The deleted file left the graph; its folder stands in for it on the map.
  assert.equal(s.nodes['web/src/old.ts'].kind, 'deleted');
  assert.equal(s.nodes['web/src/old.ts'].anchor, 'web/src');
  assert.equal(s.nodes['web/src/old.ts#legacy'].kind, 'deleted');
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/src/api.ts#searchItems'));
  assert.ok(!ws.getGraph().nodes.some((n) => n.id === 'web/src/old.ts'));

  const [a] = s.agents;
  assert.equal(a.name, 'Claude Code');
  assert.equal(a.where, 'web');
  assert.equal(a.prompt, 'Add item search');
  assert.deepEqual(a.steps.map((x) => x.status), ['active', 'pending']);
  assert.deepEqual(a.files.map((f) => f.path).sort(), ['/somewhere/else.ts', 'src/api.ts', 'src/old.ts']);
  assert.equal(hub.diffs('web/src/api.ts#getItem')[0].diff, '@@ -6 +6 @@\n-x\n+y\n');

  // Moving on to the next step finishes the one before; done finishes the plan.
  await hub.ingest([{ agent, type: 'task', step: 'Use it on the page' }]);
  assert.deepEqual(hub.state().agents[0].steps.map((x) => x.status), ['done', 'active']);
  await hub.ingest([{ agent, type: 'state', state: 'waiting' }, { agent, type: 'changes', files: [{ path: 'src/api.ts', kind: 'reverted' }] }]);
  assert.equal(hub.state().agents[0].state, 'waiting');
  assert.equal(hub.state().nodes['web/src/api.ts'], undefined);

  hub.clear();
  assert.deepEqual(hub.state().agents, []);
});
