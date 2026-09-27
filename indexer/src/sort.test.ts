import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNLAYERED, UNSORTED_DOMAIN, type Fact, type Graph, type GraphEdge, type GraphNode, type Grouping, type SortedGrouping } from '@strata/shared';
import { classifyGraph, type BaseGraph } from './build.ts';
import { sortProject, type Ask } from './classify/model-sort.ts';
import type { JsonRequest, LLM } from './llm.ts';
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
  assert.equal(settings.domain?.inferredBy, 'claude-test');
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
  assert.equal(stats.sortedByClaude, 3);
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
  assert.deepEqual(off.state(defaultGrouping(), 0), { available: false, status: 'off' });
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
  assert.deepEqual(ws.state().sorting, { available: false, status: 'off' });
});
