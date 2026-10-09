import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ActivityState, AgentRef } from '@fiada/shared';
import { AgentHub, remoteKey, sameProcess, statusLine, touches } from './agents.ts';
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

async function localRepo(extra: Record<string, string> = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-agents-')));
  const files = { 'src/api.ts': API, 'src/old.ts': 'export function legacy() {\n  return 1;\n}\n', ...extra };
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
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

test('a reporter without a session joins the one sharing its nearest parent process', () => {
  const peer = (session: string, procs: number[]) => ({ ref: { client: 'claude-code', session, cwd: '/r', procs } });
  const a = peer('a', [101, 50, 1]);
  const b = peer('b', [202, 50, 1]);
  assert.equal(sameProcess([202, 50], [a, b]), b);
  // Both run under process 50: that says nothing about which one.
  assert.equal(sameProcess([303, 50], [a, b]), null);
  assert.equal(sameProcess(undefined, [a, b]), null);
});

test('the status line is the newest of the agent\'s words, its active step and the prompt', () => {
  const steps = [
    { text: 'Read the routes', status: 'done' as const },
    { text: 'Add the field', activeText: 'Adding the field', status: 'active' as const },
  ];
  const said = { text: 'Adding created_at to Item.\nThen the migration.', at: 2000 };
  const prompt = { text: 'Add created_at', at: 500 };
  assert.deepEqual(statusLine(said, steps, 1000, prompt), { text: said.text, from: 'agent', at: new Date(2000).toISOString() });
  // Said with the step it started: its words win the tie.
  assert.equal(statusLine(said, steps, 2000, prompt)?.from, 'agent');
  // The plan moved to another step after the agent last said anything.
  assert.deepEqual(statusLine(said, steps, 3000, prompt), { text: 'Adding the field', from: 'plan', at: new Date(3000).toISOString() });
  // No active step: the agent's words stand however old.
  assert.equal(statusLine(said, [{ text: 'x', status: 'done' }], 3000, prompt)?.from, 'agent');
  // A step left active from an earlier turn is older than the new prompt.
  assert.deepEqual(statusLine(undefined, steps, 100, prompt), { text: 'Add created_at', from: 'prompt', at: new Date(500).toISOString() });
  assert.equal(statusLine(undefined, [], 0, undefined), undefined);
});

test('an agent\'s status line follows what it says, its plan and each new prompt', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 12, 0, s)).toISOString();
  const now = () => hub.state().agents[0].now;

  await hub.ingest([{ agent, type: 'prompt', text: 'Add item search', at: at(0) }]);
  assert.deepEqual(now(), { text: 'Add item search', from: 'prompt', at: at(0) });
  // A plan from the todo list: its active step, until the agent says something itself.
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', activeText: 'Adding searchItems', status: 'active' }, { text: 'Test it', status: 'pending' }], at: at(1) }]);
  assert.deepEqual(now(), { text: 'Adding searchItems', from: 'plan', at: at(1) });
  await hub.ingest([{ agent, type: 'status', text: 'Reading src/api.ts to see how listItems builds its URL.', at: at(2) }]);
  assert.deepEqual(now(), { text: 'Reading src/api.ts to see how listItems builds its URL.', from: 'agent', at: at(2) });
  // Ticking the same step again leaves the agent's line; moving to the next step replaces it.
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', activeText: 'Adding searchItems', status: 'active' }, { text: 'Test it', status: 'pending' }], at: at(3) }]);
  assert.equal(now()?.from, 'agent');
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add searchItems', status: 'done' }, { text: 'Test it', status: 'active' }], at: at(4) }]);
  assert.deepEqual(now(), { text: 'Test it', from: 'plan', at: at(4) });
  await hub.ingest([{ agent, type: 'status', text: 'Running the tests.', at: at(5) }, { agent, type: 'state', state: 'waiting', at: at(6) }]);
  assert.equal(now()?.text, 'Running the tests.');
  // A new prompt: last turn's line is dropped.
  await hub.ingest([{ agent, type: 'prompt', text: 'Now add paging', at: at(7) }]);
  assert.deepEqual(now(), { text: 'Now add paging', from: 'prompt', at: at(7) });
  await hub.ingest([{ agent, type: 'task', steps: [{ text: 'Add a page parameter', status: 'active' }], at: at(8) }]);
  assert.deepEqual(now(), { text: 'Add a page parameter', from: 'plan', at: at(8) });
});

test("an agent's files revision stays through its status lines and moves with its changes", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const change = async (text: string, lines: [number, number][]) => {
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const rev = () => hub.state().agents[0].filesRev;
  await change(API.replace("'/api/items')", "'/api/items?all=1')"), [[2, 2]]);
  const r1 = rev();
  assert.ok(r1);
  await hub.ingest([{ agent, type: 'prompt', text: 'and the tests' }, { agent, type: 'status', text: 'Running the tests.' }]);
  assert.equal(rev(), r1);
  await change(API.replace("'/api/items/' + id", '`/api/items/${id}`'), [[6, 6]]);
  assert.notEqual(rev(), r1);
});

test("a file's changes that are another agent's are named with it, so its diff can leave them out", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const ref = (session: string): AgentRef => ({ client: 'claude-code', session, cwd: dir, root: dir });
  const [a, b] = [ref('a'), ref('b')];
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const of = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
  const get = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  const list = (text: string) => text.replace("'/api/items')", "'/api/items?all=1')");
  const all = (text: string) => text.replace("'/api/items?all=1')", "'/api/items?all=2')");
  // A changes listItems; B then changes getItem and adds an import; A changes listItems again, and
  // its diff, git's of the whole file, has B's changes too (as do the lines the hook reports).
  await report(a, list(API), [[2, 2]]);
  await report(b, `import { z } from './z';\n${get(list(API))}`, [[1, 1], [3, 3], [7, 7]]);
  await report(a, `import { z } from './z';\n${all(get(list(API)))}`, [[1, 1], [3, 3], [7, 7]]);
  assert.deepEqual(of('a').symbols.map((s) => s.name), ['listItems']);
  assert.deepEqual(of('a').others?.map((s) => s.id), ['web/src/api.ts#getItem']);
  assert.equal(of('a').topTheirs, true);
  assert.equal(of('b').topTheirs, undefined, "the import is B's own");
});

test('a change that sends no diff leaves the last diff with the time it came', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  await fs.writeFile(file, API.replace("'/api/items')", "'/api/items?all=1')"));
  await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts') }] }]);
  const [first] = hub.diffs('web/src/api.ts');
  assert.equal(first.diffAt, first.at);
  await new Promise((r) => setTimeout(r, 5));
  // Flagged again with no diff (before the edit landed, or git couldn't diff it).
  await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified' }] }]);
  const [again] = hub.diffs('web/src/api.ts');
  assert.equal(again.diff, first.diff);
  assert.equal(again.diffAt, first.diffAt);
  assert.ok(Date.parse(again.at) > Date.parse(again.diffAt!));
});

test('line ranges touch a symbol; pure removals only inside it', () => {
  assert.ok(touches([5, 10], [[10, 12]]));
  assert.ok(!touches([5, 10], [[11, 12]]));
  assert.ok(touches([5, 10], [[8, 7]]));
  assert.ok(!touches([5, 10], [[5, 4]]));
});

test('each function keeps its own change time: editing another one in its file does not move it', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const SEARCH = `\nexport function searchItems(q: string) {\n  return fetch('/api/items?q=' + q);\n}\n`;
  // The changed lines on each side, as the hook reports them.
  const edit = async (text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const diff = git(dir, 'diff', '--', 'src/api.ts');
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff, lines, oldLines }] }]);
    // Looked at before the file is re-indexed, as the map does while it waits.
    hub.state();
    await pushed;
    const f = hub.state().agents[0].files[0];
    return { file: f.at, ...Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) } as Record<string, string>;
  };

  const one = await edit(API + SEARCH, [[8, 11]], [[8, 7]]);
  assert.equal(one.searchItems, one.file);
  assert.equal(one.getItem, undefined);
  // getItem changes next: searchItems, added before, keeps its time.
  const getItem = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  const two = await edit(getItem + SEARCH, [[6, 6], [8, 11]], [[6, 6], [8, 7]]);
  assert.equal(two.getItem, two.file);
  assert.equal(two.searchItems, one.searchItems, 'searchItems keeps the time it was added');
  assert.notEqual(two.file, one.file);
  // listItems changes: one hunk now covers it and getItem, but getItem's own text is as it was.
  const three = await edit(getItem.replace("'/api/items')", "'/api/items?all=1')") + SEARCH, [[2, 2], [6, 6], [8, 11]], [[2, 2], [6, 6], [8, 7]]);
  assert.equal(three.listItems, three.file);
  assert.equal(three.getItem, two.getItem, 'getItem keeps the time it was changed');
  assert.equal(three.searchItems, one.searchItems);
  assert.equal(hub.state().nodes['web/src/api.ts#getItem'].at, Date.parse(two.getItem));
});

test("an added file's other code is a change only while there is some", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/extra.ts');
  const FN = 'export function extra() {\n  return 1;\n}\n';
  const report = async (text: string) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'added' }] }]);
    await pushed;
    return hub.state().agents[0].files[0];
  };
  // A new file with only a function: nothing outside it to read.
  assert.equal((await report(FN)).topAt, undefined);
  // An import on top is.
  const withImport = await report(`import { x } from './api.ts';\n\n${FN}`);
  assert.equal(withImport.topAt, withImport.at);
  // Taken out again, with the function still there: nothing outside it again.
  assert.equal((await report(FN)).topAt, undefined, 'no file-level change left to read');
});

test("a new file this agent took its function out of, with another agent's function left in it, is no longer this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/extra.ts');
  const fa = 'export function fa() {\n  return 1;\n}\n';
  const fb = 'export function fb() {\n  return 2;\n}\n';
  const report = async (agent: AgentRef, text: string) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'added' }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const filesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files;
  await report(a, fa);
  await report(b, `${fa}\n${fb}`);
  // A takes fa out: what's left of the new file is B's.
  await report(a, fb);
  assert.deepEqual(filesOf('a'), [], 'nothing in the file is A’s now');
  assert.deepEqual(filesOf('b')[0].symbols.map((s) => s.name), ['fb']);
});

test("the file's code outside its functions has its own change time, and a re-index overtaken by a newer change settles nothing", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  // Holds a re-index after the graph is rebuilt and before the text is read back, when set.
  let hold: Promise<void> | null = null;
  const update = ws.updateFiles.bind(ws);
  ws.updateFiles = async (...a: Parameters<Workspace['updateFiles']>) => {
    const h = hold;
    await update(...a);
    if (h) await h;
  };
  const times = () => {
    const f = hub.state().agents[0].files[0];
    return { file: f.at, top: f.topAt, ...Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) } as Record<string, string>;
  };
  const report = async (text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
  };
  const settle = async (report: () => Promise<void>) => {
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await report();
    await pushed;
    return times();
  };

  const getItem = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  const a = await settle(() => report(getItem, [[6, 6]], [[6, 6]]));
  assert.equal(a.getItem, a.file);
  assert.equal(a.top, undefined, 'nothing outside the functions changed yet');

  // listItems changes, and its re-index is held until a newer change (an import on top, which moves every line) is in.
  const both = getItem.replace("'/api/items')", "'/api/items?all=1')");
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  await report(both, [[2, 2], [6, 6]], [[2, 2], [6, 6]]);
  await new Promise((r) => setTimeout(r, 600));
  hold = null;
  const c = await settle(async () => {
    await report(`import { z } from './z';\n${both}`, [[1, 1], [3, 3], [7, 7]], [[1, 0], [2, 2], [6, 6]]);
    release();
  });
  await new Promise((r) => setTimeout(r, 600));
  const after = times();
  assert.equal(after.getItem, a.getItem, 'getItem’s own text never changed after the first edit');
  assert.equal(after.listItems, c.file, 'listItems was first seen while held, so the import that came before its first re-index counts for it too');
  assert.equal(after.top, after.file, 'the import moved the file’s other code on');

  // The import taken back: nothing outside the functions left to read, so no time for it.
  const back = await settle(() => report(both, [[2, 2], [6, 6]], [[2, 2], [6, 6]]));
  assert.equal(back.top, undefined, 'an import back as HEAD has it is no change');
  assert.equal(back.getItem, a.getItem);
  // Added again: a new change.
  const again = await settle(() => report(`import { z } from './z';\n${both}`, [[1, 1], [3, 3], [7, 7]], [[1, 0], [2, 2], [6, 6]]));
  assert.equal(again.top, again.file);
  assert.notEqual(again.top, after.top);
});

test('a function changed twice before its file is first re-indexed takes the later change', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  let hold: Promise<void> | null = null;
  const update = ws.updateFiles.bind(ws);
  ws.updateFiles = async (...a: Parameters<Workspace['updateFiles']>) => {
    const h = hold;
    await update(...a);
    if (h) await h;
  };
  const report = async (text: string) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines: [[6, 6]], oldLines: [[6, 6]] }] }]);
    hub.state();
  };
  // The first edit's re-index is held; a second edit to the same function comes in meanwhile.
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  await report(API.replace("'/api/items/' + id", '`/api/items/${id}`'));
  await new Promise((r) => setTimeout(r, 600));
  hold = null;
  const v = hub.state().graphVersion;
  const pushed = nextPush(hub, (s) => s.graphVersion > v);
  await report(API.replace("'/api/items/' + id", "'/api/items/' + encodeURIComponent(id)"));
  release();
  await pushed;
  const f = hub.state().agents[0].files[0];
  assert.equal(f.symbols.find((s) => s.name === 'getItem')?.at, f.at, 'the second edit is new to read too');
});

test("another agent's edit to a function never counts as this agent's next change", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  // Re-indexed with nobody watching, so nothing reads the state in between.
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const timesOf = (session: string) => {
    const f = hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
    return Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) as Record<string, string>;
  };
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]]);
  const before = timesOf('a');
  // B changes the same function, then A changes another one.
  const two = one.replace('`/api/items/${id}`', "'/api/items/' + encodeURIComponent(id)");
  await report(b, two, [[6, 6]]);
  await report(a, two.replace("'/api/items')", "'/api/items?all=1')"), [[2, 2], [6, 6]]);
  const after = timesOf('a');
  assert.equal(after.getItem, before.getItem, 'B’s edit to getItem is not A’s');
  assert.ok(after.listItems > before.getItem);
  // B adds an import, then A changes getItem again: the import is B's, not A's to read.
  const three = `import { z } from './z';\n${two.replace("'/api/items')", "'/api/items?all=1')")}`;
  await report(b, three, [[1, 1]]);
  await report(a, three.replace('encodeURIComponent(id)', 'encodeURIComponent(String(id))'), [[1, 1], [3, 3], [7, 7]]);
  const fileOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
  assert.equal(fileOf('a').topAt, undefined, 'A never changed the file’s other code');
  assert.ok(fileOf('b').topAt, 'B did');
});

test("a function only another agent changed stays that agent's when this one changes the file again", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  // Each report's lines are every change since HEAD, as the hook sends them.
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const of = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
  const timesOf = (session: string) => Object.fromEntries(of(session).symbols.map((s) => [s.name, s.at])) as Record<string, string>;
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]]);
  // B changes listItems, which A never touched; then A changes getItem again.
  const two = one.replace("'/api/items')", "'/api/items?all=1')");
  await report(b, two, [[2, 2], [6, 6]]);
  await report(a, two.replace('`/api/items/${id}`', '`/api/items/${encodeURIComponent(id)}`'), [[2, 2], [6, 6]]);
  assert.deepEqual(Object.keys(timesOf('a')), ['getItem'], 'listItems is B’s change, not A’s');
  assert.ok(timesOf('b').listItems);
  // A changes listItems too: now it is A's, at A's latest change.
  const three = two.replace('`/api/items/${id}`', '`/api/items/${encodeURIComponent(id)}`').replace('?all=1', '?all=2');
  await report(a, three, [[2, 2], [6, 6]]);
  assert.equal(timesOf('a').listItems, of('a').at);
});

test("another agent's deletion of a function this agent changed, and its added function taken away again, are not this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const timesOf = (session: string) =>
    Object.fromEntries(hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0].symbols.map((s) => [s.name, s])) as Record<string, { kind: string; at?: string }>;
  const getItem = 'export function getItem(id: string) {\n  return fetch(`/api/items/${id}`);\n}\n';
  const listItems = (q: string) => `export function listItems() {\n  return fetch('/api/items${q}');\n}\n`;
  const extra = 'export function countItems() {\n  return 0;\n}\n';
  // A changes getItem, with nobody watching the map.
  await report(a, `${listItems('')}\n${getItem}`, [[6, 6]]);
  const first = timesOf('a').getItem.at;
  // B deletes getItem, adds countItems, then takes countItems away again.
  await report(b, `${listItems('')}\n${extra}`, [[4, 7]]);
  await report(b, listItems(''), [[4, 7]]);
  // A changes listItems, then adds countItems just as B had it.
  await report(a, listItems('?all=1'), [[2, 2], [4, 7]]);
  const one = timesOf('a');
  assert.equal(one.getItem.kind, 'deleted');
  assert.equal(one.getItem.at, first, 'B’s deletion of getItem keeps the time A changed it');
  await report(a, `${listItems('?all=1')}\n${extra}`, [[2, 2], [4, 7]]);
  const two = timesOf('a');
  assert.ok(two.countItems, 'A’s own countItems is A’s change, though B once added the same');
  assert.equal(two.countItems.kind, 'added');
});

test("a function this agent took back and another agent then changed is the other agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const names = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0].symbols.map((s) => s.name);
  const list = (q: string) => (text: string) => text.replace("'/api/items')", `'/api/items${q}')`);
  const get = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  // A changes both functions, then takes getItem back.
  await report(a, get(list('?all=1')(API)), [[2, 2], [6, 6]]);
  await report(a, list('?all=1')(API), [[2, 2]]);
  assert.deepEqual(names('a'), ['listItems']);
  // B changes getItem; then A changes listItems again.
  const two = list('?all=1')(API).replace("'/api/items/' + id", "'/api/items/' + encodeURIComponent(id)");
  await report(b, two, [[2, 2], [6, 6]]);
  await report(a, list('?all=2')(two), [[2, 2], [6, 6]]);
  assert.deepEqual(names('a'), ['listItems'], 'getItem is B’s change now, not A’s');
});

test("a function another agent changed that this one restored, then changed the same way, is this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const names = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0].symbols.map((s) => s.name);
  const list = (q: string) => (text: string) => text.replace("'/api/items')", `'/api/items${q}')`);
  const get = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, list('?all=1')(API), [[2, 2]]);
  // B changes getItem; A puts it back as HEAD has it, then makes B's very change itself.
  await report(b, get(list('?all=1')(API)), [[2, 2], [6, 6]]);
  await report(a, list('?all=2')(API), [[2, 2]]);
  assert.deepEqual(names('a'), ['listItems']);
  await report(a, get(list('?all=2')(API)), [[2, 2], [6, 6]]);
  assert.deepEqual(names('a'), ['listItems', 'getItem'], 'getItem is A’s own change now');
});

test("an import another agent added and this one took away again is no change of this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const of = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]]);
  // B adds an import; A takes it away again and keeps its own change to getItem.
  await report(b, `import { z } from './z';\n${one}`, [[1, 1], [7, 7]]);
  assert.equal(of('a').topAt, undefined, 'B’s import is not A’s to read');
  await report(a, one.replace('${id}', '${encodeURIComponent(id)}'), [[6, 6]]);
  assert.equal(of('a').topAt, undefined, 'the file’s other code is as HEAD has it');
  // A adds B's import itself: A's change now.
  await report(a, `import { z } from './z';\n${one}`, [[1, 1], [7, 7]]);
  assert.equal(of('a').topAt, of('a').at);
});

test("a function another agent put back as HEAD has it is no longer this agent's change", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const symbolsOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files.flatMap((f) => f.symbols);
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]]);
  const first = symbolsOf('a').find((s) => s.name === 'getItem')!.at!;
  // B puts getItem back as HEAD has it: A's change to it is gone from the working tree.
  await report(b, API, [[6, 6]]);
  assert.deepEqual(symbolsOf('a'), [], 'nothing of A’s is left to read');
  // A makes the change again: a new one.
  await report(a, one, [[6, 6]]);
  const again = symbolsOf('a').find((s) => s.name === 'getItem')!.at!;
  assert.ok(again > first);
});

test("a function this agent added and another agent took away is new again when this agent adds it back", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const timeOf = (session: string, name: string) =>
    hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files.flatMap((f) => f.symbols).find((s) => s.name === name)?.at;
  const added = `${API}\nexport function extra() {\n  return 3;\n}\n`;
  await report(a, added, [[9, 12]]);
  const first = timeOf('a', 'extra')!;
  assert.ok(first);
  // B takes it away; A adds the same function again.
  await report(b, API, [[8, 8]]);
  await report(a, added, [[9, 12]]);
  assert.ok(timeOf('a', 'extra')! > first, 'added again: a new change to read');
});

test('on a checkout with CRLF line endings, an import taken back is no change', async () => {
  // A file with code outside its functions in HEAD already, which the line endings would set apart.
  const SVC = `import { y } from './y';\n\n${API}`;
  const { dir, ws } = await localRepo({ 'src/svc.ts': SVC });
  // HEAD's blob has LF; the working tree has CRLF, as git leaves it on Windows.
  git(dir, 'config', 'core.autocrlf', 'true');
  const crlf = (t: string) => t.replace(/\n/g, '\r\n');
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const file = path.join(dir, 'src/svc.ts');
  const report = async (text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, crlf(text));
    const v = ws.version;
    await hub.ingest([{ agent: a, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/svc.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const of = () => hub.state().agents[0].files[0];
  const one = SVC.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(one, [[8, 8]]);
  assert.equal(of().topAt, undefined, 'only getItem changed');
  await report(`import { z } from './z';\n${one}`, [[1, 1], [9, 9]]);
  assert.ok(of().topAt);
  await report(one, [[8, 8]]);
  assert.equal(of().topAt, undefined, 'the import is gone again');
  assert.equal(of().symbols.length, 1);
});

test("a file this agent took its change back from, still changed by another agent, is no longer this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const filesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files;
  const get = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  const list = (text: string) => text.replace("'/api/items')", "'/api/items?all=1')");
  await report(a, get(API), [[6, 6]]);
  await report(b, list(get(API)), [[2, 2], [6, 6]]);
  // A puts getItem back: what's left changed in the file is B's.
  await report(a, list(API), [[2, 2]]);
  assert.deepEqual(filesOf('a'), [], 'nothing in the file is A’s now');
  assert.equal(filesOf('b').length, 1);
  assert.deepEqual(hub.state().nodes['web/src/api.ts'].agents.map((x) => x.split('#').pop()), ['b'], 'the file’s mark is B’s alone');
  assert.deepEqual(hub.diffs('web/src/api.ts').map((d) => d.agent.split('#').pop()), ['b'], 'the file’s diffs are B’s alone');
  assert.deepEqual(hub.diffs('web/src/api.ts#listItems').map((d) => d.agent.split('#').pop()), ['b']);
  // A changes it again: A's once more.
  await report(a, get(list(API)), [[2, 2], [6, 6]]);
  assert.deepEqual(filesOf('a')[0].symbols.map((s) => s.name), ['getItem']);
  assert.deepEqual(hub.diffs('web/src/api.ts').map((d) => d.agent.split('#').pop()).sort(), ['a', 'b']);
});

test("an ended session whose changes are all now another agent's goes, before or after they became so", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const ref = (session: string): AgentRef => ({ client: 'claude-code', session, cwd: dir, root: dir });
  const [a, b, c] = [ref('a'), ref('b'), ref('c')];
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const end = (agent: AgentRef) => hub.ingest([{ agent, type: 'session', phase: 'end' }]);
  const ids = () => hub.state().agents.map((x) => x.id.split('#').pop()).sort();
  const get = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  const list = (text: string) => text.replace("'/api/items')", "'/api/items?all=1')");
  // A puts its change back while B's stays, then ends: A goes.
  await report(a, get(API), [[6, 6]]);
  await report(b, list(get(API)), [[2, 2], [6, 6]]);
  await report(a, list(API), [[2, 2]]);
  assert.deepEqual(ids(), ['a', 'b'], 'A is still in the queue while its session runs');
  await end(a);
  assert.deepEqual(ids(), ['b']);
  assert.deepEqual(hub.diffs('web/src/api.ts').map((d) => d.agent.split('#').pop()), ['b']);
  // C changes getItem and ends; B then puts getItem back, so all C changed is gone and what's left is B's: C goes.
  await report(c, get(list(API)), [[6, 6]]);
  await end(c);
  assert.deepEqual(ids(), ['b', 'c'], 'C ended with a change to review');
  await report(b, list(API), [[2, 2]]);
  assert.deepEqual(ids(), ['b']);
  assert.deepEqual(hub.diffs('web/src/api.ts').map((d) => d.agent.split('#').pop()), ['b']);
});

test("a function this agent deleted and another agent put back changed keeps this agent's time", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][], oldLines = lines) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const symsOf = (session: string) => Object.fromEntries(hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0].symbols.map((s) => [s.name, s]));
  // A deletes getItem.
  const without = API.slice(0, API.indexOf('\nexport function getItem')) + '\n';
  await report(a, without, [[3, 3]], [[4, 7]]);
  const deletedAt = symsOf('a').getItem.at;
  assert.equal(symsOf('a').getItem.kind, 'deleted');
  // B puts it back, changed.
  const back = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(b, back, [[6, 6]]);
  // A changes listItems: getItem, back as B left it, keeps the time A deleted it.
  await report(a, back.replace("'/api/items')", "'/api/items?all=1')"), [[2, 2], [6, 6]]);
  assert.equal(symsOf('a').getItem.at, deletedAt, 'B’s putting it back is not A’s new change');
  assert.equal(symsOf('a').listItems.at, hub.state().agents.find((x) => x.id.endsWith('#a'))!.files[0].at);
});

test("another agent deleting the whole file makes none of its untouched functions this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const settle = async (go: () => Promise<void>) => {
    const v = ws.version;
    await go();
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  await settle(async () => {
    await fs.writeFile(file, API.replace("'/api/items/' + id", '`/api/items/${id}`'));
    await hub.ingest([{ agent: a, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines: [[6, 6]], oldLines: [[6, 6]] }] }]);
  });
  const changed = hub.state().agents.find((x) => x.id.endsWith('#a'))!.files[0].symbols.find((s) => s.name === 'getItem')!.at;
  // B deletes the file.
  await settle(async () => {
    await fs.rm(file);
    await hub.ingest([{ agent: b, type: 'changes', files: [{ path: file, kind: 'deleted' }] }]);
  });
  const f = hub.state().agents.find((x) => x.id.endsWith('#a'))!.files[0];
  assert.deepEqual(
    f.symbols.map((s) => [s.name, s.kind, s.at]),
    [['getItem', 'deleted', changed]],
    'only the function A changed, at the time A changed it; listItems is B’s deletion',
  );
  assert.equal(f.topAt, undefined);
});

test("a file this agent deleted and another agent put back as HEAD has it is no longer this agent's", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const settle = async (go: () => Promise<void>) => {
    const v = ws.version;
    await go();
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const filesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files;
  await settle(async () => {
    await fs.rm(file);
    await hub.ingest([{ agent: a, type: 'changes', files: [{ path: file, kind: 'deleted' }] }]);
  });
  assert.deepEqual(filesOf('a').map((f) => [f.path, f.kind]), [['src/api.ts', 'deleted']]);
  // B puts the file back as HEAD has it.
  await settle(async () => {
    await fs.writeFile(file, API);
    await hub.ingest([{ agent: b, type: 'changes', files: [{ path: file, kind: 'modified', diff: '', lines: [[1, 7]], oldLines: [[1, 7]] }] }]);
  });
  assert.deepEqual(filesOf('a'), [], 'A’s deletion is gone from the working tree');
  // A changes it again: that change is A's.
  await settle(async () => {
    await fs.writeFile(file, API.replace("'/api/items/' + id", '`/api/items/${id}`'));
    await hub.ingest([{ agent: a, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines: [[6, 6]], oldLines: [[6, 6]] }] }]);
  });
  assert.deepEqual(filesOf('a').map((f) => [f.kind, f.symbols.map((s) => [s.name, s.kind]), f.topAt]), [['modified', [['getItem', 'modified']], undefined]]);
});

test("a file this agent added and another agent deleted is no longer this agent's, and new when added again", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/fresh.ts');
  const settle = async (go: () => Promise<void>) => {
    const v = ws.version;
    await go();
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const filesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files;
  const add = () =>
    settle(async () => {
      await fs.writeFile(file, "import { z } from './z';\n\nexport function fresh() {\n  return z;\n}\n");
      await hub.ingest([{ agent: a, type: 'changes', files: [{ path: file, kind: 'added', lines: [[1, 5]] }] }]);
    });
  await add();
  const first = filesOf('a')[0];
  assert.deepEqual([first.path, first.kind, first.symbols.map((s) => s.name)], ['src/fresh.ts', 'added', ['fresh']]);
  // B deletes it.
  await settle(async () => {
    await fs.rm(file);
    await hub.ingest([{ agent: b, type: 'changes', files: [{ path: file, kind: 'deleted' }] }]);
  });
  assert.deepEqual(filesOf('a'), [], 'nothing of A’s is left');
  // A adds it again: new to read.
  await new Promise((r) => setTimeout(r, 5));
  await add();
  const again = filesOf('a')[0];
  assert.ok(again.symbols[0].at! > first.symbols[0].at!);
  assert.ok(again.topAt! > first.topAt!);
});

test('each re-index stamps its functions, with nobody watching the map in between', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (text: string, lines: [number, number][]) => {
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(one, [[6, 6]]);
  const between = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  await report(one.replace("'/api/items')", "'/api/items?all=1')"), [[2, 2], [6, 6]]);
  // The first look at the state, after both.
  const f = hub.state().agents[0].files[0];
  const at = Object.fromEntries(f.symbols.map((s) => [s.name, Date.parse(s.at!)]));
  assert.ok(at.getItem < between, 'getItem keeps the time of the change that made it');
  assert.equal(at.listItems, Date.parse(f.at));
});

test("a class's own time moves with its own lines, not with each method in it", async () => {
  const STORE = 'class Store {\n  int size = 1;\n\n  int get() {\n    return 1;\n  }\n\n  int put() {\n    return 2;\n  }\n}\n';
  const { dir, ws } = await localRepo({ 'src/Store.java': STORE });
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/Store.java');
  const report = async (text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/Store.java'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const at = () => Object.fromEntries(hub.state().agents[0].files[0].symbols.map((s) => [s.id.slice(s.id.indexOf('#') + 1), s.at])) as Record<string, string>;
  const one = STORE.replace('return 1;', 'return 10;');
  await report(one, [[5, 5]]);
  const first = at();
  assert.equal(first.Store, undefined, 'a method’s change is not the class’s own: nothing of the class to read');
  // Another method changes: the class's own lines still didn't.
  const two = one.replace('return 2;', 'return 20;');
  await report(two, [[5, 5], [9, 9]]);
  assert.equal(at().Store, undefined);
  assert.equal(at()['Store.get'], first['Store.get']);
  // A field changes: the class's own change, at its own time.
  await report(two.replace('size = 1', 'size = 2'), [[2, 2], [5, 5], [9, 9]]);
  assert.ok(at().Store > first['Store.get'], 'its own field is');
  // The field put back, the methods still changed: nothing of the class's own is left to read, so
  // a stop that was read before the field changed isn't unread by a change that's gone.
  await report(two, [[5, 5], [9, 9]]);
  assert.equal(at().Store, undefined);
  assert.equal(at()['Store.get'], first['Store.get']);
});

test('a class whose own lines are back as HEAD has them, around a method still changed, is nothing new to read', async () => {
  const STORE = 'class Store {\n  int size = 1;\n\n  int get() {\n    return 1;\n  }\n}\n';
  const { dir, ws } = await localRepo({ 'src/Store.java': STORE });
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/Store.java');
  const report = async (text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/Store.java'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const at = () => Object.fromEntries(hub.state().agents[0].files[0].symbols.map((s) => [s.id.slice(s.id.indexOf('#') + 1), s.at])) as Record<string, string>;
  const both = STORE.replace('size = 1', 'size = 2').replace('return 1;', 'return 10;');
  await report(both, [[2, 2], [5, 5]]);
  const first = at();
  // The field is put back; the method stays changed, so its lines still reach into the class.
  await report(STORE.replace('return 1;', 'return 10;'), [[5, 5]]);
  assert.equal(at().Store, undefined, 'the class’s own lines are as HEAD has them: nothing of it to read, so no stop carries it');
  assert.equal(at()['Store.get'], first['Store.get']);
  // Changed again: a new change.
  await report(both, [[2, 2], [5, 5]]);
  assert.ok(at().Store > first.Store);
});

test("a class only round this agent's method change is no one's: another agent's change to its field isn't this agent's", async () => {
  const STORE = 'class Store {\n  int size = 1;\n\n  int get() {\n    return 1;\n  }\n}\n';
  const { dir, ws } = await localRepo({ 'src/Store.java': STORE });
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/Store.java');
  const report = async (agent: AgentRef, text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/Store.java'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const namesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files.flatMap((f) => f.symbols.map((s) => s.id.slice(s.id.indexOf('#') + 1)));
  // A changes the method only.
  const one = STORE.replace('return 1;', 'return 10;');
  await report(a, one, [[5, 5]]);
  // B changes the class's field; then A changes its method again, its report taking in B's field.
  const two = one.replace('size = 1', 'size = 2');
  await report(b, two, [[2, 2]]);
  await report(a, two.replace('return 10;', 'return 11;'), [[2, 2], [5, 5]]);
  assert.ok(namesOf('b').includes('Store'), 'the field is B’s');
  assert.ok(!namesOf('a').includes('Store'), 'not A’s');
  assert.ok(namesOf('a').includes('Store.get'));
});

test('a function the agent takes back and then changes again is new to read', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: lines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const f = hub.state().agents[0].files[0];
    return { file: f.at, ...Object.fromEntries(f.symbols.map((x) => [x.name, x.at])) } as Record<string, string>;
  };
  const getItem = (text: string) => text.replace("'/api/items/' + id", '`/api/items/${id}`');
  const listItems = (text: string) => text.replace("'/api/items')", "'/api/items?all=1')");
  const one = await report(getItem(API), [[6, 6]]);
  // listItems changes and getItem goes back to HEAD: it's no longer one of the changes.
  const two = await report(listItems(API), [[2, 2]]);
  assert.equal(two.getItem, undefined);
  // The same edit to getItem again: a change after the first, so new to read.
  const three = await report(getItem(listItems(API)), [[2, 2], [6, 6]]);
  assert.equal(three.getItem, three.file);
  assert.notEqual(three.getItem, one.getItem);
  assert.equal(three.listItems, two.listItems, 'listItems keeps its time');
});

test("another agent moving a function's lines doesn't make this agent's change to it new again", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    // A map is watching: the state is read after every change.
    hub.state();
  };
  const timesOf = (session: string) => {
    const f = hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files[0];
    return Object.fromEntries(f.symbols.map((s) => [s.name, s.at])) as Record<string, string>;
  };
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]], [[6, 6]]);
  const first = timesOf('a').getItem;
  // B puts ten lines on top: A's own ranges now point above both functions.
  const pad = '// note\n'.repeat(10);
  await report(b, pad + one, [[1, 10], [16, 16]], [[1, 0], [6, 6]]);
  // A changes listItems, its ranges now counted from B's text.
  await report(a, pad + one.replace("'/api/items')", "'/api/items?all=1')"), [[1, 10], [12, 12], [16, 16]], [[1, 0], [2, 2], [6, 6]]);
  assert.equal(timesOf('a').getItem, first, 'getItem keeps the time A changed it');
});

test("another agent's lines above this agent's changed function leave it this agent's, and the file in view", async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const a: AgentRef = { client: 'claude-code', session: 'a', cwd: dir, root: dir };
  const b: AgentRef = { client: 'claude-code', session: 'b', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const report = async (agent: AgentRef, text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = ws.version;
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  const filesOf = (session: string) => hub.state().agents.find((x) => x.id.endsWith(`#${session}`))!.files;
  const one = API.replace("'/api/items/' + id", '`/api/items/${id}`');
  await report(a, one, [[6, 6]], [[6, 6]]);
  const at = filesOf('a')[0].symbols[0].at;
  // B puts an import and nine lines of notes on top: A's line 6 is one of B's notes now.
  const top = `import { z } from './z';\n${'// note\n'.repeat(9)}`;
  await report(b, top + one, [[1, 10], [16, 16]], [[1, 0], [6, 6]]);
  const mine = filesOf('a');
  assert.equal(mine.length, 1, 'A’s file is still in view');
  assert.deepEqual(mine[0].symbols.map((s) => [s.name, s.at]), [['getItem', at]], 'with getItem, at the time A changed it');
  assert.equal(mine[0].topAt, undefined, 'the import and notes are B’s');
  assert.deepEqual(hub.diffs('web/src/api.ts#getItem').map((d) => d.agent.split('#').pop()).sort(), ['a', 'b']);
});

test('a file that drops out of the map, grown too large to read, is a new change for every stop it had', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const edit = async (text: string, lines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines: [[6, 6]] }] }]);
    await pushed;
    return hub.state().agents[0].files[0];
  };
  const one = await edit(API.replace("'/api/items/' + id", '`/api/items/${id}`'), [[6, 6]]);
  assert.ok(one.symbols.some((s) => s.name === 'getItem' && s.at === one.at));
  // Past the size the indexer reads: the graph drops the file, and with it every function.
  const two = await edit(API.replace("'/api/items/' + id", '`/api/items/${id}`') + '// generated\n'.repeat(40_000), [[6, 6], [9, 40_008]]);
  assert.equal(hub.state().nodes['web/src/api.ts#getItem']?.kind ?? 'deleted', 'deleted');
  assert.ok(two.symbols.length > 0 && two.symbols.every((s) => s.kind === 'deleted'), 'its functions are gone from the map');
  for (const s of two.symbols) assert.equal(s.at, two.at, `${s.name} takes the change that dropped it`);
  assert.equal(two.topAt, two.at, 'and so does the file\'s other code');
});

test('a file emptied out settles, and every function it had takes that change', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const edit = async (text: string, lines: [number, number][], oldLines: [number, number][]) => {
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(file, text);
    const v = hub.state().graphVersion;
    const pushed = nextPush(hub, (s) => s.graphVersion > v);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', diff: git(dir, 'diff', '--', 'src/api.ts'), lines, oldLines }] }]);
    await pushed;
    return hub.state().agents[0].files[0];
  };
  const one = await edit(API.replace("'/api/items/' + id", '`/api/items/${id}`'), [[6, 6]], [[6, 6]]);
  assert.ok(one.symbols.some((s) => s.name === 'getItem' && s.at === one.at));
  // Nothing left in it, not even a newline: the graph still has the file, with no functions.
  const two = await edit('', [], [[1, API.split('\n').length - 1]]);
  assert.ok(two.symbols.length > 0 && two.symbols.every((s) => s.kind === 'deleted'), 'its functions are gone');
  for (const s of two.symbols) assert.equal(s.at, two.at, `${s.name} takes the change that emptied the file`);
});

test('only source files the indexer reads are kept as text, never a large artifact', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  await fs.writeFile(path.join(dir, 'src/api.ts'), API.replace("'/api/items')", "'/api/items?all=1')"));
  await fs.writeFile(path.join(dir, 'src/big.ts'), '// generated\n'.repeat(40_000));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'todo\n');
  // Source by its extension, but not what the indexer reads: a build output and a test.
  await fs.mkdir(path.join(dir, 'dist'));
  await fs.writeFile(path.join(dir, 'dist/api.js'), 'export function listItems() {}\n');
  await fs.writeFile(path.join(dir, 'src/api.test.ts'), 'export function testItems() {}\n');
  const files = ['src/api.ts', 'src/big.ts', 'notes.txt', 'dist/api.js', 'src/api.test.ts'];
  // Every file AgentHub reads to compare, before the re-index and after.
  const reads: string[] = [];
  const readFile = fs.readFile;
  fs.readFile = ((p: string, ...rest: unknown[]) => (reads.push(path.relative(dir, String(p))), (readFile as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fs.readFile;
  const pushed = nextPush(hub, (s) => s.graphVersion > 1);
  await hub.ingest([{ agent, type: 'changes', files: files.map((p) => ({ path: path.join(dir, p), kind: 'modified' as const })) }]);
  await pushed;
  fs.readFile = readFile;
  assert.deepEqual([...new Set(reads.filter((r) => files.includes(r)))], ['src/api.ts'], 'only the source the indexer takes in is read at all');
  const recs = (hub as unknown as { agents: Map<string, { files: Map<string, { rel?: string; sigs: unknown }> }> }).agents;
  const text = Object.fromEntries([...[...recs.values()][0].files.values()].map((f) => [f.rel, f.sigs != null]));
  assert.deepEqual(text, { 'src/api.ts': true, 'src/big.ts': false, 'notes.txt': false, 'dist/api.js': false, 'src/api.test.ts': false });
});

test('a re-index keeps a digest of each function, not its text', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  // A function of some 300 KB: one changes event can name thousands of files like it.
  const body = '  const x = 1; // padding the function out\n'.repeat(7_000);
  await fs.writeFile(path.join(dir, 'src/api.ts'), API.replace('export function getItem', `export function huge() {\n${body}}\n\nexport function getItem`));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1);
  await hub.ingest([{ agent, type: 'changes', files: [{ path: path.join(dir, 'src/api.ts'), kind: 'modified' }] }]);
  await pushed;
  const huge = hub.state().agents[0].files[0].symbols.find((x) => x.name === 'huge');
  assert.equal(huge?.kind, 'added', 'the new function is on the map');
  // Everything the hub keeps of the file, as one string: digests and times, with nothing of the text.
  const recs = (hub as unknown as { agents: Map<string, { files: Map<string, Record<string, unknown>> }> }).agents;
  const kept = JSON.stringify([...[...recs.values()][0].files.values()], (_, v) => (v instanceof Map ? [...v] : v));
  assert.ok(kept.length < 4_000, `a few hundred bytes, not the file (${kept.length})`);
  assert.doesNotMatch(kept, /padding the function out/);
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

test("an edit in another checkout of the repository carries each changed function's lines in HEAD, which the map still has", async () => {
  const { ws } = await localRepo();
  const hub = new AgentHub(ws);
  // A second checkout, named like the imported one: the map isn't re-indexed for it.
  const other = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-other-'))), 'web');
  await fs.mkdir(path.join(other, 'src'), { recursive: true });
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: other, root: other };
  await hub.ingest([{ agent, type: 'changes', files: [{ path: path.join(other, 'src/api.ts'), kind: 'modified', lines: [[36, 36]], oldLines: [[6, 6]] }] }]);
  const f = hub.state().agents[0].files[0];
  assert.equal(f.node, 'web/src/api.ts');
  assert.deepEqual(
    f.symbols.map((s) => [s.name, s.kind, s.oldLines]),
    [['getItem', 'modified', [5, 7]]],
  );
});

test('a function deleted from a file it stays in carries its lines from HEAD', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  // The layer the map has for getItem before it goes, which its stop keeps.
  const layer = ws.getGraph().nodes.find((n) => n.id === 'web/src/api.ts#getItem')?.layer?.id;
  assert.ok(layer);
  // getItem (lines 5-7 in HEAD) goes, with the blank line before it.
  await fs.writeFile(path.join(dir, 'src/api.ts'), API.slice(0, API.indexOf('\nexport function getItem')));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1);
  await hub.ingest([{ agent, type: 'changes', files: [{ path: path.join(dir, 'src/api.ts'), kind: 'modified', lines: [[3, 3]], oldLines: [[4, 7]], deletions: 4 }] }]);
  await pushed;
  await new Promise((r) => setTimeout(r, 400));
  const f = hub.state().agents[0].files[0];
  const { at: _, ...gone } = f.symbols.find((x) => x.name === 'getItem')!;
  assert.deepEqual(gone, { id: 'web/src/api.ts#getItem', name: 'getItem', kind: 'deleted', oldLines: [5, 7], layer });
});

test('a function deleted after the map moved it to another layer keeps the layer the map had for it last', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const file = path.join(dir, 'src/api.ts');
  const settle = async (go: () => Promise<void>) => {
    const v = ws.version;
    await go();
    for (let i = 0; i < 100 && ws.version === v; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  };
  // listItems changes first, so the file's symbols in HEAD are read with the layers they had then.
  const one = API.replace("'/api/items')", "'/api/items?all=1')");
  await settle(async () => {
    await fs.writeFile(file, one);
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', lines: [[2, 2]], oldLines: [[2, 2]] }] }]);
  });
  // The project's grouping then puts getItem in another layer.
  const node = ws.getGraph().nodes.find((n) => n.id === 'web/src/api.ts#getItem')!;
  node.layer = { ...node.layer!, id: 'moved' };
  // getItem goes.
  await settle(async () => {
    await fs.writeFile(file, one.slice(0, one.indexOf('\nexport function getItem')));
    await hub.ingest([{ agent, type: 'changes', files: [{ path: file, kind: 'modified', lines: [[2, 3]], oldLines: [[2, 7]] }] }]);
  });
  assert.equal(hub.state().agents[0].files[0].symbols.find((x) => x.name === 'getItem')?.layer, 'moved');
});

test('a class that lost a method carries its lines from HEAD, with the method', async () => {
  // Java lists a class and each method in it.
  const STORE = 'class Store {\n  int get() {\n    return 1;\n  }\n\n  int put() {\n    return 2;\n  }\n}\n';
  const { dir, ws } = await localRepo({ 'src/Store.java': STORE });
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  const ids = ws.getGraph().nodes.filter((n) => n.id.startsWith('web/src/Store.java#')).map((n) => [n.id, n.lines]);
  assert.deepEqual(ids, [['web/src/Store.java#Store', [1, 9]], ['web/src/Store.java#Store.get', [2, 4]], ['web/src/Store.java#Store.put', [6, 8]]]);
  // put (lines 6-8 in HEAD) goes, with the blank line before it.
  await fs.writeFile(path.join(dir, 'src/Store.java'), STORE.replace('\n  int put() {\n    return 2;\n  }\n', ''));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1);
  await hub.ingest([{ agent, type: 'changes', files: [{ path: path.join(dir, 'src/Store.java'), kind: 'modified', lines: [[4, 4]], oldLines: [[5, 8]], deletions: 4 }] }]);
  await pushed;
  await new Promise((r) => setTimeout(r, 400));
  const f = hub.state().agents[0].files[0];
  const of = (name: string) => f.symbols.find((x) => x.id === `web/src/Store.java#${name}`);
  assert.deepEqual([of('Store')?.kind, of('Store')?.oldLines], ['modified', [1, 9]]);
  assert.deepEqual([of('Store.put')?.kind, of('Store.put')?.oldLines], ['deleted', [6, 8]]);
});

test('two sessions in one checkout are two agents, and a sweep does not claim the other one\'s edit', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const base = { client: 'claude-code', cwd: dir, root: dir };
  const s1: AgentRef = { ...base, session: 'aaaa1111', procs: [101, 50, 1] };
  const s2: AgentRef = { ...base, session: 'bbbb2222', procs: [202, 50, 1] };
  const mcp2: AgentRef = { ...base, procs: [202, 50] };
  const byId = () => Object.fromEntries(hub.state().agents.map((a) => [a.name, a]));

  await hub.ingest([
    { agent: s1, type: 'session', phase: 'start' },
    { agent: s2, type: 'session', phase: 'start' },
    { agent: s1, type: 'prompt', text: 'Add search' },
    { agent: s2, type: 'prompt', text: 'Fix login' },
    // Session 2's MCP server, told apart by the process it shares with session 2's hooks.
    { agent: mcp2, type: 'task', task: 'Fixing the login redirect' },
  ]);
  let a = byId();
  assert.deepEqual(Object.keys(a).sort(), ['Claude Code · aaaa', 'Claude Code · bbbb']);
  assert.equal(a['Claude Code · aaaa'].task, undefined);
  assert.equal(a['Claude Code · bbbb'].task, 'Fixing the login redirect');

  // Session 1 edits api.ts; session 2's next sweep sees it in the tree but it isn't session 2's.
  await fs.appendFile(path.join(dir, 'src/api.ts'), '// more\n');
  await fs.writeFile(path.join(dir, 'src/gen.ts'), 'export const g = 1;\n');
  await hub.ingest([{ agent: s1, type: 'changes', files: [{ path: 'src/api.ts', kind: 'modified' }] }]);
  const reply = await hub.ingest([
    {
      agent: s2,
      type: 'changes',
      files: [
        { path: 'src/api.ts', kind: 'modified', swept: true },
        { path: 'src/gen.ts', kind: 'added', swept: true },
      ],
    },
  ]);
  assert.deepEqual(reply.files.map((f) => f.kind), ['elsewhere', 'added']);
  a = byId();
  assert.deepEqual(a['Claude Code · aaaa'].files.map((f) => f.path), ['src/api.ts']);
  assert.deepEqual(a['Claude Code · bbbb'].files.map((f) => f.path), ['src/gen.ts']);

  // Session 1 then names gen.ts itself (it made it with a shell command): the sweep's claim gives way.
  await hub.ingest([{ agent: s1, type: 'changes', files: [{ path: 'src/gen.ts', kind: 'added' }] }]);
  a = byId();
  assert.deepEqual(a['Claude Code · aaaa'].files.map((f) => f.path).sort(), ['src/api.ts', 'src/gen.ts']);
  assert.deepEqual(a['Claude Code · bbbb'].files, []);

  // One session ending leaves the other working.
  await hub.ingest([{ agent: s1, type: 'session', phase: 'end' }, { agent: s2, type: 'state', state: 'working' }]);
  a = byId();
  assert.equal(a['Claude Code · aaaa'].state, 'ended');
  assert.equal(a['Claude Code · bbbb'].state, 'working');
  // With session 1 gone, an MCP server nobody can place joins the session still working.
  await hub.ingest([{ agent: { ...base, procs: [999] }, type: 'task', note: 'almost there' }]);
  assert.equal(byId()['Claude Code · bbbb'].note, 'almost there');
});

test('an MCP server that reports before its session\'s hooks is taken over by that session', async () => {
  const { dir, ws } = await localRepo();
  const hub = new AgentHub(ws);
  const base = { client: 'claude-code', cwd: dir, root: dir };
  await hub.ingest([{ agent: { ...base, procs: [303, 60] }, type: 'task', task: 'Early' }]);
  // A session under another parent doesn't take it; the one under 303 does.
  await hub.ingest([{ agent: { ...base, session: 'dddd', procs: [404, 60, 1] }, type: 'session', phase: 'start' }]);
  await hub.ingest([{ agent: { ...base, session: 'cccc', procs: [303, 60, 1] }, type: 'session', phase: 'start' }]);
  const agents = hub.state().agents;
  assert.equal(agents.length, 2);
  assert.equal(agents.find((x) => x.id.endsWith('#cccc'))?.task, 'Early');
  assert.equal(agents.find((x) => x.id.endsWith('#dddd'))?.task, undefined);
});

test('a deleted file stands on the collapsed folder that now covers its directory', async () => {
  // lib holds only lib/deep, so they are one node; once one.ts goes, lib/deep holds only lib/deep/x too.
  const { dir, ws } = await localRepo({ 'lib/deep/one.ts': 'export const one = 1;\n', 'lib/deep/x/two.ts': 'export const two = 2;\n' });
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/lib/deep'));
  const hub = new AgentHub(ws);
  const agent: AgentRef = { client: 'claude-code', session: 's', cwd: dir, root: dir };
  await fs.rm(path.join(dir, 'lib/deep/one.ts'));
  const pushed = nextPush(hub, (s) => s.graphVersion > 1 && !!s.nodes['web/lib/deep/one.ts']);
  await hub.ingest([{ agent, type: 'changes', files: [{ path: 'lib/deep/one.ts', kind: 'deleted', oldLines: [[1, 1]], deletions: 1 }] }]);
  const s = await pushed;
  assert.ok(ws.getGraph().nodes.some((n) => n.id === 'web/lib/deep/x'));
  assert.equal(s.nodes['web/lib/deep/one.ts'].anchor, 'web/lib/deep/x');
  assert.equal(s.nodes['web/lib/deep/one.ts#one'].kind, 'deleted');
});
