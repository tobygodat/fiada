import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNLAYERED, UNSORTED_DOMAIN, type Fact, type Graph, type GraphEdge, type GraphNode, type Grouping, type SortedGrouping } from '@fiada/shared';
import { classifyGraph, type BaseGraph } from './build.ts';
import { matchRef, sortProject, type Ask } from './classify/model-sort.ts';
import { KEY_HINT, type JsonRequest, type LLM } from './llm.ts';
import { defaultGrouping, leftoverFiles, normalizeGrouping, sortStats } from './classify/index.ts';
import { Sorter, type SortHost } from './sorter.ts';
import type { ProjectStore } from './store.ts';
import { Workspace } from './workspace.ts';

const file = (id: string, facts?: Fact[]): GraphNode => ({ id, kind: 'file', name: id.split('/').pop()!, parent: 'app', repo: 'app', path: id.slice(4), facts });
const sym = (fileId: string, name: string, facts?: Fact[]): GraphNode => ({ id: `${fileId}#${name}`, kind: 'symbol', name, parent: fileId, repo: 'app', path: fileId.slice(4), facts, loc: 10 });
const route = (v: string): Fact[] => [{ type: 'route', value: v }];
const e = (from: string, to: string): GraphEdge => ({ from, to, kind: 'calls' });

// A small project with what the classifier can place (routes, feature
// folders) and what it can't (a settings module, a stray helper).
const base: BaseGraph = {
  repos: [{ id: 'app', name: 'app', source: 'app', kind: 'local', status: 'ready', commit: 'abc123' }],
  nodes: [
    { id: 'app', kind: 'repo', name: 'app', parent: 'root', repo: 'app' },
    file('app/api/routes/items.py', [{ type: 'import', value: 'fastapi' }]),
    sym('app/api/routes/items.py', 'read_item', route('GET /items/{id}')),
    file('app/api/routes/shares.py', [{ type: 'import', value: 'fastapi' }]),
    sym('app/api/routes/shares.py', 'create_share', route('POST /shares')),
    file('app/api/routes/sharing.py', [{ type: 'import', value: 'fastapi' }]),
    sym('app/api/routes/sharing.py', 'share_link', route('GET /sharing/{id}')),
    file('app/web/components/Items/ItemCard.tsx', [{ type: 'returnsJSX', value: '' }]),
    sym('app/web/components/Items/ItemCard.tsx', 'ItemCard'),
    file('app/web/components/Shares/ShareMenu.tsx', [{ type: 'returnsJSX', value: '' }]),
    sym('app/web/components/Shares/ShareMenu.tsx', 'ShareMenu'),
    file('app/web/components/Sharing/SharingPage.tsx', [{ type: 'returnsJSX', value: '' }]),
    sym('app/web/components/Sharing/SharingPage.tsx', 'SharingPage'),
    file('app/settings.py'),
    sym('app/settings.py', 'Settings'),
    sym('app/settings.py', 'load_env'),
    file('app/util/strings.py'),
    sym('app/util/strings.py', 'slugify'),
  ],
  edges: [e('app/web/components/Items/ItemCard.tsx#ItemCard', 'app/api/routes/items.py#read_item')],
};

const leftoversOf = (g: Graph) => g.nodes.filter((n) => (n.kind === 'symbol' || n.kind === 'file') && (n.domain?.id === UNSORTED_DOMAIN || n.layer?.id === UNLAYERED));

/** Answers like Claude would, and records what it was asked. */
function scripted(): { ask: Ask; asked: JsonRequest[] } {
  const asked: JsonRequest[] = [];
  const ask: Ask = async (req) => {
    asked.push(req);
    if (req.label === 'domains') {
      return {
        domains: [
          { id: 'item', name: 'Items', merge_into: '', reason: 'item routes and cards' },
          { id: 'share', name: 'Sharing', merge_into: '', reason: 'share links and the share menu' },
          { id: 'sharing', name: 'Sharing', merge_into: 'share', reason: 'the same share links as share' },
        ],
        new_domains: [{ id: 'Platform', name: 'Platform', reason: 'settings, environment and small helpers' }],
      };
    }
    const refs = [...req.prompt.matchAll(/^(F\d+) (\S+)/gm)].map((m) => ({ ref: m[1], id: m[2] }));
    return {
      files: refs.map(({ ref, id }) => ({
        ref,
        layer: 'service',
        layer_reason: id.includes('settings') ? 'reads the environment at startup' : 'plain helpers the services call',
        domain: 'platform',
        reason: id.includes('settings') ? 'app configuration loaded from the environment' : 'string helpers with no feature of their own',
        symbols: [],
      })),
    };
  };
  return { ask, asked };
}

test('Claude fills the classifier gaps, merges and names domains, and says why', async () => {
  const grouping = defaultGrouping();
  const before = classifyGraph(base, grouping);
  const gaps = leftoversOf(before).map((n) => n.id);
  assert.ok(gaps.includes('app/settings.py#Settings') && gaps.includes('app/util/strings.py#slugify'), 'the classifier leaves settings and helpers unplaced');
  assert.deepEqual(
    leftoverFiles(before).map((l) => l.file.id),
    ['app/settings.py', 'app/util/strings.py'],
  );

  const { ask, asked } = scripted();
  const sorted = await sortProject(before, grouping, ask, { model: 'claude-test' });
  assert.equal(asked.length, 2, 'one request for domains, one batch of files');
  assert.match(asked[0].prompt, /- share \("Shares"\)/, 'step 1 sees the classifier domains');
  assert.match(asked[0].prompt, /app\/settings\.py \(no layer\)/, 'and the outline of leftovers');
  assert.match(asked[1].system[1], /- platform: Platform \(new: settings, environment and small helpers\)/, 'step 2 picks from the new domain list');
  assert.ok(!/- sharing:/.test(asked[1].system[1]), 'merged domains are not offered');
  assert.deepEqual(sorted.repos, { app: 'abc123' });
  assert.deepEqual(sorted.domains.find((d) => d.id === 'share'), { id: 'share', name: 'Sharing', from: 'Shares', reason: 'share links and the share menu' });
  assert.equal(sorted.domains.find((d) => d.id === 'platform')?.added, true, 'new ids are slugged');

  const after = classifyGraph(base, { ...grouping, sorted });
  assert.deepEqual(leftoversOf(after), [], 'nothing left unsorted');
  const settings = after.nodes.find((n) => n.id === 'app/settings.py#Settings')!;
  assert.equal(settings.domain?.id, 'platform');
  assert.equal(settings.domain?.source, 'model');
  assert.equal(settings.domain?.inferredBy, 'Claude', 'credited by label');
  assert.equal(settings.domain?.evidence[0].detail, 'its file: app configuration loaded from the environment');
  assert.equal(settings.layer?.id, 'service');
  assert.equal(settings.layer?.evidence[0].detail, 'its file: reads the environment at startup');

  const sharing = after.nodes.find((n) => n.id === 'app/api/routes/sharing.py#share_link')!;
  assert.equal(sharing.domain?.id, 'share', 'merged into share');
  assert.equal(sharing.domain?.source, 'seed', 'still placed by its route');
  assert.equal(sharing.domain!.evidence.at(-1)!.detail, 'Claude folded a second Sharing domain into this one: the same share links as share');
  const item = after.nodes.find((n) => n.id === 'app/api/routes/items.py#read_item')!;
  assert.equal(item.domain?.source, 'seed', 'code the classifier placed keeps its place');
  assert.deepEqual(
    after.domains.map((d) => d.name),
    ['Items', 'Sharing', 'Platform'],
  );
  const stats = sortStats(after);
  assert.equal(stats.leftover, 0);
  assert.equal(stats.sortedByModel, 3);
});

test("the user's pins, rules and names win over Claude's sort", async () => {
  const { ask } = scripted();
  const sorted = await sortProject(classifyGraph(base, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test' });
  const grouping: Grouping = {
    ...defaultGrouping(),
    sorted,
    domains: [{ id: 'sharing', name: 'Public links' }],
    pins: { 'app/util/strings.py': { domain: 'item', layer: 'data' } },
  };
  const g = classifyGraph(base, grouping);
  const slugify = g.nodes.find((n) => n.id === 'app/util/strings.py#slugify')!;
  assert.equal(slugify.domain?.id, 'item');
  assert.equal(slugify.domain?.source, 'user-pin');
  assert.equal(slugify.layer?.id, 'data');
  const link = g.nodes.find((n) => n.id === 'app/api/routes/sharing.py#share_link')!;
  assert.equal(link.domain?.id, 'sharing', 'a domain the user named is not merged away');
  assert.equal(g.domains.find((d) => d.id === 'sharing')?.name, 'Public links');
  // A stale sort (a layer that no longer exists) is ignored rather than breaking the map.
  const stale = classifyGraph(base, { ...defaultGrouping('empty'), sorted });
  assert.ok(stale.nodes.every((n) => n.layer?.source !== 'model'));
});

test('a stored sort survives validation, and junk in it is dropped', () => {
  const sorted: SortedGrouping = {
    model: 'claude-test',
    at: '2026-09-27T00:00:00.000Z',
    repos: { app: 'abc' },
    domains: [{ id: 'a', name: 'A', mergeInto: 'b', reason: 'same' }],
    placements: { 'app/x.py': { domain: 'a', reason: 'why' } },
  };
  const g = normalizeGrouping({ ...defaultGrouping(), sorted: { ...sorted, placements: { ...sorted.placements, bad: { domain: 'a' }, worse: 3 } } });
  assert.deepEqual(g.sorted, sorted);
  assert.equal(normalizeGrouping({ ...defaultGrouping(), sorted: { at: 'x' } }).sorted, undefined);
});

test('the sorter runs once per set of repositories, off the request path', async () => {
  let calls = 0;
  let fail = false;
  const { ask } = scripted();
  const counting: Ask = async (req) => {
    calls++;
    if (fail) throw new Error('boom');
    return ask(req);
  };
  let grouping = defaultGrouping();
  const host: SortHost = {
    busy: () => false,
    graph: () => classifyGraph(base, { ...grouping, sorted: undefined }),
    grouping: () => grouping,
    save: async (s) => {
      grouping = { ...grouping, sorted: s };
    },
  };
  const llm: LLM = { label: 'Claude', model: 'claude-test', json: counting };
  const sorter = new Sorter(llm);
  assert.equal(sorter.state(grouping, 0).status, 'idle');
  sorter.request(host);
  assert.equal(sorter.state(grouping, 0).status, 'running');
  sorter.request(host); // lands after the first, and finds nothing new
  await sorter.settled();
  assert.equal(calls, 2);
  assert.equal(sorter.state(grouping, 3).status, 'done');
  assert.equal(sorter.state(grouping, 3).merged, 1);
  assert.equal(sorter.state(grouping, 3).by, 'Claude');

  sorter.request(host);
  await sorter.settled();
  assert.equal(calls, 2, 'same repositories, same commits: no new sort');

  fail = true;
  sorter.request(host, true);
  await sorter.settled();
  assert.equal(sorter.state(grouping, 3).status, 'error');
  assert.equal(sorter.state(grouping, 3).error, 'boom');

  const off = new Sorter();
  off.request(host, true);
  assert.deepEqual(off.state(defaultGrouping(), 0), { available: false, status: 'off', keyHint: KEY_HINT });
  const kept = off.state(grouping, 3);
  assert.equal(kept.status, 'done', 'a stored sort still shows without a key');
  assert.equal(kept.by, 'Claude', "credited to the client that sorted, from the stored sort");
});

test("a grouping sent without Claude's sort keeps it", async () => {
  let saved: unknown = null;
  const store: ProjectStore = {
    describe: () => 'memory',
    loadRepos: async () => [],
    saveRepos: async () => {},
    loadGrouping: async () => saved,
    saveGrouping: async (_id, g) => {
      saved = g;
    },
  };
  const sorted: SortedGrouping = { model: 'claude-test', at: '2026-09-27T00:00:00.000Z', repos: {}, domains: [], placements: { 'a/b.py': { domain: 'x', reason: 'y' } } };
  const ws = new Workspace(store, 'default');
  await ws.init();
  await ws.setGrouping({ ...defaultGrouping(), sorted });
  const { sorted: _dropped, ...withoutSort } = ws.getGrouping();
  await ws.setGrouping({ ...withoutSort, pins: { 'a/b.py': { domain: 'z' } } });
  assert.deepEqual(ws.getGrouping().sorted, sorted);
  await ws.setGrouping({ ...withoutSort, sorted: null });
  assert.equal(ws.getGrouping().sorted, undefined, 'null clears it');
  assert.deepEqual(ws.state().sorting, { available: false, status: 'off', keyHint: KEY_HINT });
});

// The hosted indexer on 2026-10-08: a repository the classifier found no
// features in (typingsite, 20 files), sorted with Claude Haiku. Its answers
// gave each file's path where the prompt's "F1" ref was asked for, every
// file was skipped twice, and the sort ended with "0 placements".
const plain: BaseGraph = {
  repos: [{ id: 'typing', name: 'typing', source: 'typing', kind: 'local', status: 'ready', commit: 'def456' }],
  nodes: [
    { id: 'typing', kind: 'repo', name: 'typing', parent: 'root', repo: 'typing' },
    { id: 'typing/src/game/words.ts', kind: 'file', name: 'words.ts', parent: 'typing', repo: 'typing', path: 'src/game/words.ts' },
    { id: 'typing/src/game/words.ts#pickWords', kind: 'symbol', name: 'pickWords', parent: 'typing/src/game/words.ts', repo: 'typing', path: 'src/game/words.ts', loc: 12 },
    { id: 'typing/src/game/score.ts', kind: 'file', name: 'score.ts', parent: 'typing', repo: 'typing', path: 'src/game/score.ts' },
    { id: 'typing/src/game/score.ts#wpm', kind: 'symbol', name: 'wpm', parent: 'typing/src/game/score.ts', repo: 'typing', path: 'src/game/score.ts', loc: 8 },
    { id: 'typing/src/game/score.ts#accuracy', kind: 'symbol', name: 'accuracy', parent: 'typing/src/game/score.ts', repo: 'typing', path: 'src/game/score.ts', loc: 6 },
    { id: 'typing/src/theme.ts', kind: 'file', name: 'theme.ts', parent: 'typing', repo: 'typing', path: 'src/theme.ts' },
    { id: 'typing/src/theme.ts#applyTheme', kind: 'symbol', name: 'applyTheme', parent: 'typing/src/theme.ts', repo: 'typing', path: 'src/theme.ts', loc: 9 },
  ],
  edges: [{ from: 'typing/src/game/score.ts#wpm', to: 'typing/src/game/words.ts#pickWords', kind: 'calls' }],
};

/** Answers the way Haiku did: step 1 adds domains, step 2 names each file by `refOf` its prompt line. */
function haikuLike(refOf: (ref: string, id: string) => unknown, extra: Record<string, unknown> = {}): { ask: Ask; asked: JsonRequest[] } {
  const asked: JsonRequest[] = [];
  const ask: Ask = async (req) => {
    asked.push(req);
    if (req.label === 'domains') {
      return {
        domains: [],
        new_domains: [
          { id: 'game', name: 'Typing game', reason: 'words to type and the score' },
          { id: 'appearance', name: 'Appearance', reason: 'themes' },
        ],
      };
    }
    const lines = [...req.prompt.matchAll(/^(F\d+) (\S+)/gm)].map((m) => ({ ref: m[1], id: m[2] }));
    return {
      files: lines.map(({ ref, id }) => ({
        ref: refOf(ref, id),
        layer: 'client',
        layer_reason: 'runs in the browser',
        domain: id.includes('theme') ? 'appearance' : 'game',
        reason: id.includes('theme') ? 'switches the colour theme' : 'part of the typing round',
        symbols: [],
        ...extra,
      })),
    };
  };
  return { ask, asked };
}

const placedIn = (sorted: SortedGrouping) => Object.keys(sorted.placements).sort();
const allFiles = ['typing/src/game/score.ts', 'typing/src/game/words.ts', 'typing/src/theme.ts'];

test("Claude answering with each file's path instead of its ref still places every file", async () => {
  const before = classifyGraph(plain, defaultGrouping());
  assert.equal(leftoverFiles(before).length, 3, 'the classifier places no feature here');
  const lines: string[] = [];
  const { ask, asked } = haikuLike((_ref, id) => id);
  const sorted = await sortProject(before, defaultGrouping(), ask, { model: 'claude-haiku-5-5', by: 'Claude', log: (l) => lines.push(l) });
  assert.deepEqual(placedIn(sorted), allFiles);
  assert.equal(asked.length, 2, 'no second try: nothing was skipped');
  assert.ok(!lines.some((l) => /asking again/.test(l)));
  assert.deepEqual(sorted.placements['typing/src/theme.ts'], { layer: 'client', layerReason: 'runs in the browser', domain: 'appearance', reason: 'switches the colour theme' });

  const after = classifyGraph(plain, { ...defaultGrouping(), sorted });
  assert.deepEqual(leftoversOf(after), [], 'nothing left unsorted on the map');
  assert.equal(after.nodes.find((n) => n.id === 'typing/src/game/score.ts#wpm')?.domain?.id, 'game');
});

test('every way a model writes a ref lands on its file', async () => {
  const forms: Record<string, (ref: string, id: string) => unknown> = {
    'the ref': (ref) => ref,
    'lower case': (ref) => ref.toLowerCase(),
    'in brackets': (ref) => `[${ref}]`,
    'with its path': (ref, id) => `${ref} ${id}`,
    'the whole prompt line': (_ref, id) => `${id} (unknown, 0 lines)`,
    'the path in the repository': (_ref, id) => id.replace(/^typing\//, ''),
    'with ./': (_ref, id) => `./${id.replace(/^typing\//, '')}`,
    'its file name': (_ref, id) => id.split('/').pop(),
  };
  for (const [form, refOf] of Object.entries(forms)) {
    const { ask } = haikuLike(refOf);
    const sorted = await sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test' });
    assert.deepEqual(placedIn(sorted), allFiles, form);
  }
});

test('the request lists its refs in the schema and says to answer with them', async () => {
  const { ask, asked } = haikuLike((ref) => ref);
  await sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test', batchSize: 2 });
  const batches = asked.filter((r) => r.label.startsWith('leftovers'));
  assert.equal(batches.length, 2);
  const refsOf = (r: JsonRequest) => (r.schema as any).properties.files.items.properties.ref.enum;
  assert.deepEqual(refsOf(batches[0]), ['F1', 'F2']);
  assert.deepEqual(refsOf(batches[1]), ['F1'], 'numbered within each request');
  assert.match(batches[1].prompt, /^F1 typing\/src\/theme\.ts /m);
  assert.match(batches[0].prompt, /ref: the file's ref exactly as written, e\.g\. "F1" \(not its path\)/);
});

test('a domain or layer given by name instead of id still counts', async () => {
  const { ask } = haikuLike((ref) => ref, { layer: 'Client', domain: 'Typing game' });
  const sorted = await sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test' });
  assert.deepEqual(placedIn(sorted), allFiles);
  assert.equal(sorted.placements['typing/src/theme.ts'].domain, 'game');
  assert.equal(sorted.placements['typing/src/theme.ts'].layer, 'client');
});

test('a name two domains share, in any case, picks neither; the exact id still does', async () => {
  const run = async (domain: string) => {
    const { ask: answer } = haikuLike((ref) => ref, { domain });
    const ask: Ask = async (req) =>
      req.label === 'domains'
        ? {
            domains: [],
            new_domains: [
              { id: 'game', name: 'Typing', reason: 'the round' },
              { id: 'drills', name: 'typing', reason: 'practice lists' },
              { id: 'appearance', name: 'Game', reason: 'themes' },
            ],
          }
        : answer(req);
    return sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test' });
  };
  for (const name of ['Typing', 'TYPING', 'GAME']) {
    const sorted = await run(name);
    assert.deepEqual(Object.values(sorted.placements).map((p) => p.domain), [undefined, undefined, undefined], name);
  }
  assert.equal((await run('game')).placements['typing/src/theme.ts'].domain, 'game', 'the id as written');
  assert.equal((await run('Drills')).placements['typing/src/theme.ts'].domain, 'drills', 'an id in another case no name shares');
});

test('answers bare or keyed by ref are read too', async () => {
  const keyed: Ask = async (req) => {
    const a = (await haikuLike((ref) => ref).ask(req)) as { files?: { ref: string }[] };
    return a.files ? Object.fromEntries([['files', Object.fromEntries(a.files.map(({ ref, ...f }) => [ref, f]))]]) : a;
  };
  const bare: Ask = async (req) => {
    const a = (await haikuLike((ref) => ref).ask(req)) as { files?: unknown[] };
    return a.files ?? a;
  };
  for (const ask of [keyed, bare]) {
    const sorted = await sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test' });
    assert.deepEqual(placedIn(sorted), allFiles);
  }
});

test('when no ref matches, the log says what came back', async () => {
  const lines: string[] = [];
  const { ask, asked } = haikuLike(() => 'file-1');
  const sorted = await sortProject(classifyGraph(plain, defaultGrouping()), defaultGrouping(), ask, { model: 'claude-test', log: (l) => lines.push(l) });
  assert.deepEqual(sorted.placements, {});
  assert.equal(asked.length, 3, 'domains, the batch, and one more try');
  assert.ok(lines.includes('[fiada] sort: no file in the answer to leftovers 1/1 matched a ref: 3 files, refs "file-1", "file-1", "file-1"'), lines.join('\n'));
});

test('matchRef: a shared file name or a folder that starts like a ref picks nothing wrong', () => {
  const lf = (id: string) => ({ file: { id, kind: 'file', name: id.split('/').pop()!, parent: 'r', repo: 'r', path: id.slice(2) } as GraphNode, needsLayer: true, needsDomain: [], placed: [] });
  const a = lf('r/a/index.ts');
  const b = lf('r/b/index.ts');
  const c = lf('r/f2/util.ts');
  const match = matchRef(new Map([['F1', a], ['F2', b], ['F3', c]]));
  assert.equal(match('index.ts'), undefined, 'two files share the name');
  assert.equal(match('f2/util.ts'), c, 'a path, not ref F2');
  assert.equal(match('F2'), b);
  assert.equal(match('F9'), undefined);
  assert.equal(match(7), undefined);
  assert.equal(match(''), undefined);
});

test('matchRef: a path two repositories share, or two files differing only in case, picks neither', () => {
  const lf = (repo: string, path: string) => ({ file: { id: `${repo}/${path}`, kind: 'file', name: path.split('/').pop()!, parent: repo, repo, path } as GraphNode, needsLayer: true, needsDomain: [], placed: [] });
  const web = lf('web', 'src/index.ts');
  const api = lf('api', 'src/index.ts');
  const upper = lf('api', 'src/Foo.ts');
  const lower = lf('api', 'src/foo.ts');
  const match = matchRef(new Map([['F1', web], ['F2', api], ['F3', upper], ['F4', lower]]));
  assert.equal(match('src/index.ts'), undefined, 'in both repositories');
  assert.equal(match('./src/index.ts (typescript, 3 lines)'), undefined);
  assert.equal(match('web/src/index.ts'), web);
  assert.equal(match('api/src/index.ts'), api);
  assert.equal(match('api/src/Foo.ts'), upper, 'the exact id still picks its file');
  assert.equal(match('api/src/foo.ts'), lower);
  assert.equal(match('API/SRC/FOO.TS'), undefined, 'in any case it could be either');
  assert.equal(match('F2'), api);

  // Repository "src" has an index.ts at its root: its id is web's path.
  const root = lf('src', 'index.ts');
  const both = matchRef(new Map([['F1', root], ['F2', web]]));
  assert.equal(both('src/index.ts'), undefined, "src's id and web's path");
  assert.equal(both('web/src/index.ts'), web);

  // A file at a repository's root named F1, but labelled F2.
  const f1 = lf('tools', 'F1');
  const labels = matchRef(new Map([['F1', web], ['F2', f1]]));
  for (const ref of ['F1', 'f1', '[F1]', 'F01', 'F1 web/src/index.ts']) assert.equal(labels(ref), undefined, ref);
  assert.equal(labels('F2'), f1);

  // A file at a repository's root named index.ts, and src/index.ts, whose name is the same.
  const top = lf('web', 'index.ts');
  const names = matchRef(new Map([['F1', top], ['F2', web]]));
  for (const ref of ['index.ts', 'INDEX.TS', './index.ts', 'index.ts (typescript, 3 lines)']) assert.equal(names(ref), undefined, ref);
  assert.equal(names('web/index.ts'), top);
  assert.equal(names('web/src/index.ts'), web);
  assert.equal(names('src/index.ts'), web);
  assert.equal(labels('web/src/index.ts'), web);
  assert.equal(labels('tools/F1'), f1);
});
