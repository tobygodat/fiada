import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Graph, RepoInfo } from '@fiada/shared';
import { buildGraph } from '../build.ts';
import { defaultGrouping } from '../classify/index.ts';
import { loadRepo } from '../sources.ts';
import { FileProjectStore, type ProjectStore, type StoredSummary } from '../store.ts';
import { describe as line, indexGraph } from './describe.ts';
import { fileDoc, firstSentence, symbolDoc } from './docs.ts';
import { Summaries } from './index.ts';
import { hashOf, takeBatch, type Item } from './items.ts';
import type { JsonRequest, LLM } from '../llm.ts';

const FILES: Record<string, string> = {
  'backend/app/api/items.py': [
    'from fastapi import APIRouter',
    'from app import crud',
    '',
    'router = APIRouter(prefix="/items")',
    '',
    '@router.get("/")',
    'def read_items():',
    '    """Retrieve items.',
    '',
    '    Revision ID: not part of the summary',
    '    """',
    '    return crud.list_items()',
    '',
    '@router.post("/")',
    'def create_item(item):',
    '    return crud.create_item(item)',
    '',
  ].join('\n'),
  'backend/app/crud.py': ['def list_items():', '    return []', '', 'def create_item(item):', '    return item', '', 'def unused():', '    pass', ''].join('\n'),
  'backend/app/main.py': ['from fastapi import FastAPI', 'from app.api import items', '', 'app = FastAPI()', 'app.include_router(items.router)', ''].join('\n'),
  'backend/app/__init__.py': '',
  'backend/app/api/__init__.py': '',
  'backend/pyproject.toml': '[project]\nname = "app"\ndependencies = ["fastapi"]\n',
};

async function fixtureGraph(files = FILES): Promise<{ graph: Graph; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-summaries-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  const info: RepoInfo = { id: 'shop', name: 'shop', source: dir, kind: 'local', status: 'indexing' };
  const repo = await loadRepo(info, dir);
  return { graph: buildGraph([repo], defaultGrouping()), dir };
}

/** A model stand-in: answers every item, records each request, and can be told to fail. */
function fakeLlm(opts: { fail?: (req: JsonRequest) => Error | null } = {}) {
  const requests: JsonRequest[] = [];
  const llm: LLM = {
    label: 'Fake',
    model: 'fake-model',
    async json(req: JsonRequest) {
      requests.push(req);
      const err = opts.fail?.(req);
      if (err) throw err;
      // "about <first word of the item> (<hash of the item>)", so a changed item gets a changed summary.
      const items = req.prompt.split(/^### item /m).slice(1);
      return { summaries: items.map((it) => ({ id: it.split(' ')[0], summary: `about ${it.split('\n')[1].split(' ')[0]} (${hashOf(it).slice(0, 6)})` })) };
    },
  };
  return { llm, requests };
}

function memoryStore(): ProjectStore & { saved: Record<string, StoredSummary> } {
  const saved: Record<string, StoredSummary> = {};
  return {
    saved,
    describe: () => 'memory',
    loadRepos: async () => null,
    saveRepos: async () => {},
    loadGrouping: async () => null,
    saveGrouping: async () => {},
    loadSummaries: async () => ({ ...saved }),
    saveSummaries: async (_id, entries) => void Object.assign(saved, entries),
  };
}

function summaries(graph: Graph, dir: string, llm: LLM | null, store: ProjectStore = memoryStore()) {
  const s = new Summaries({
    store,
    projectId: 'test',
    llm,
    read: (_repo, p) => fs.readFile(path.join(dir, p), 'utf8').catch(() => null),
    debounceMs: 0,
    log: () => {},
  });
  s.setGraph(graph);
  return s;
}

test('doc comments: the first sentence of the first paragraph, and no licence headers', () => {
  assert.equal(firstSentence('Retrieve items.\n\nRevision ID: 123'), 'Retrieve items.');
  assert.equal(firstSentence('Loads the user. Then caches it.'), 'Loads the user.');
  assert.equal(firstSentence('@deprecated use x'), '');
  const ts = ['/**', ' * Fetches one page of documents.', ' * @param id the collection', ' */', '@Injectable()', 'export function list(id) {', '}'].join('\n');
  assert.equal(symbolDoc(ts, { lang: 'typescript', lines: [6, 7] }), 'Fetches one page of documents.');
  assert.equal(symbolDoc('// Copyright 2024 Someone\nexport const x = 1', { lang: 'typescript', lines: [2, 2] }), '');
  const go = ['// Package store keeps articles in Postgres.', 'package store', '', '// Save writes an article', 'func Save() {}'].join('\n');
  assert.equal(fileDoc(go, 'go'), 'Package store keeps articles in Postgres.');
  assert.equal(symbolDoc(go, { lang: 'go', lines: [5, 5] }), 'Save writes an article.');
  assert.equal(fileDoc('#!/usr/bin/env python\n"""Seeds the database with a first superuser."""\nimport x', 'python'), 'Seeds the database with a first superuser.');
  assert.equal(fileDoc('/* eslint-disable */\nimport x from "y"', 'typescript'), '');
});

test('every node gets a line that reads as a sentence', async () => {
  const { graph } = await fixtureGraph();
  const gi = indexGraph(graph);
  const at = (id: string) => line(gi, id);
  assert.match(at('shop/backend/app/api/items.py#read_items')!, /^Handles GET \/items\/\./);
  assert.equal(at('shop/backend/app/crud.py#unused'), 'Function that nothing in the map calls.');
  assert.equal(at('shop/backend/app/crud.py#list_items'), 'Function used by read_items.');
  assert.match(at('shop/backend/app/api/items.py')!, /^Serves GET \/items\/ and POST \/items\/\. Used by main\.py\.$/);
  assert.match(at('shop/backend/app/crud.py')!, /^Defines list_items, create_item and unused\. Used by items\.py\.$/);
  assert.match(at('shop')!, /^A Python codebase using FastAPI: 5 files and 5 symbols\. Serves 2 HTTP routes\.$/);
  assert.match(at('shop/backend/app')!, /^5 files/);
  const domain = graph.domains[0];
  assert.match(at(`domain:${domain.id}`)!, /symbols? (in|across) the/);
  assert.equal(at('shop/nope.py'), null);
});

test('batches fill to their budget and keep grouped items together', () => {
  const it = (n: number, group?: string, size = 10): Item => ({ node: `n${n}`, kind: 'file', text: 'x'.repeat(size), hash: `h${n}`, group });
  const queue = [it(1), it(2, 'a'), it(3), it(4, 'a'), it(5)];
  assert.deepEqual(takeBatch(queue, { chars: 1000, items: 40 }).map((x) => x.node), ['n1', 'n3', 'n5']);
  assert.deepEqual(takeBatch(queue, { chars: 1000, items: 40 }).map((x) => x.node), ['n2', 'n4']);
  const big = [it(1, undefined, 600), it(2, undefined, 600), it(3, undefined, 600)];
  assert.equal(takeBatch(big, { chars: 1000, items: 40 }).length, 1, 'one item even over budget, then stops');
  assert.equal(takeBatch([it(1), it(2), it(3)], { chars: 1000, items: 2 }).length, 2);
});

test('without a model key, summaries are the line and say they are off', async () => {
  const { graph, dir } = await fixtureGraph();
  const s = summaries(graph, dir, null);
  const got = await s.get('shop/backend/app/api/items.py#read_items');
  assert.equal(got?.status, 'off');
  assert.match(got!.off!, /ANTHROPIC_API_KEY/);
  assert.equal(got?.doc, 'Retrieve items.');
  assert.match(got!.line, /^Handles GET/);
  assert.equal(await s.get('shop/missing'), null);
});

test('the eager pass writes containers in few requests, children before parents, and only once', async () => {
  const { graph, dir } = await fixtureGraph();
  const { llm, requests } = fakeLlm();
  const store = memoryStore();
  const s = summaries(graph, dir, llm, store);
  await s.idle();
  const kinds = requests.map((r) => [...r.prompt.matchAll(/^### item \d+ \((\w+)\)/gm)].map((m) => m[1]));
  assert.deepEqual(kinds[0], ['file', 'file', 'file', 'file', 'file'], 'all files in one request, first');
  assert.equal(kinds.at(-1)?.join(), 'repo', 'the repository last');
  assert.ok(!kinds.flat().includes('symbol'), 'symbols wait until they are selected');
  // A folder reads its files' generated summaries, and its subfolders' (written in an earlier request).
  const app = requests.find((r) => r.prompt.includes('shop/backend/app (folder'))!;
  assert.match(app.prompt, /crud\.py: about shop\/backend\/app\/crud\.py/);
  assert.match(app.prompt, /api\/: about shop\/backend\/app\/api \(\S+\)/);
  const calls = requests.length;

  const file = await s.get('shop/backend/app/crud.py');
  assert.equal(file?.status, 'ready');
  assert.equal(file?.generated?.model, 'fake-model');
  assert.ok(Object.keys(store.saved).length >= 5, 'saved through the store');

  // The same graph again (a reclassify, a restart): nothing new to write.
  s.setGraph(structuredClone(graph));
  await s.idle();
  assert.equal(requests.length, calls);

  // A new instance on the same store starts with them.
  const again = fakeLlm();
  const fresh = new Summaries({ store, projectId: 'test', llm: again.llm, read: (_r, p) => fs.readFile(path.join(dir, p), 'utf8'), debounceMs: 0, log: () => {} });
  await fresh.init();
  fresh.setGraph(graph);
  await fresh.idle();
  assert.equal(again.requests.length, 0);
  assert.equal((await fresh.get('shop/backend/app/crud.py'))?.status, 'ready');
});

test('changing one file rewrites it and what contains it, nothing else', async () => {
  const { graph, dir } = await fixtureGraph();
  const { llm, requests } = fakeLlm();
  const s = summaries(graph, dir, llm);
  await s.idle();
  const before = requests.length;

  await fs.appendFile(path.join(dir, 'backend/app/crud.py'), '\ndef delete_item(item):\n    pass\n');
  const repo = await loadRepo({ id: 'shop', name: 'shop', source: dir, kind: 'local', status: 'indexing' }, dir);
  s.setGraph(buildGraph([repo], defaultGrouping()));
  await s.idle();
  const written = requests.slice(before).flatMap((r) => [...r.prompt.matchAll(/^### item \d+ \((\w+)\)\n(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`));
  assert.ok(written.includes('file shop/backend/app/crud.py'));
  assert.ok(!written.some((w) => w.startsWith('file ') && !w.endsWith('crud.py')), `only crud.py among files: ${written}`);
  assert.ok(written.some((w) => w.startsWith('repo ')), `the repository summary follows its contents: ${written}`);
});

test('a selected symbol has its whole file written in one request, the selected one first', async () => {
  const { graph, dir } = await fixtureGraph();
  const { llm, requests } = fakeLlm();
  const s = summaries(graph, dir, llm);
  await s.idle();
  const before = requests.length;

  const first = await s.get('shop/backend/app/crud.py#unused');
  assert.equal(first?.status, 'pending');
  await s.idle();
  assert.equal(requests.length, before + 1);
  const req = requests.at(-1)!;
  assert.match(req.prompt, /^Context shared by the items below:\nbackend\/app\/crud\.py/);
  assert.match(req.prompt, /### item 1 \(symbol\)\nunused /);
  assert.equal((req.prompt.match(/\(symbol\)/g) ?? []).length, 3);
  for (const id of ['unused', 'list_items', 'create_item']) assert.equal((await s.get(`shop/backend/app/crud.py#${id}`))?.status, 'ready', id);
  await s.idle();
  assert.equal(requests.length, before + 1, 'selecting the others costs nothing');
});

test('a cut-off reply is retried in halves; a failed request marks its items with the reason', async () => {
  const { graph, dir } = await fixtureGraph();
  let cut = true;
  const { llm, requests } = fakeLlm({
    fail: (req) => {
      const n = (req.prompt.match(/^### item/gm) ?? []).length;
      if (cut && n > 1) return new Error("Claude's answer to the summaries request was cut off.");
      if (req.prompt.includes('(repo)')) return new Error('OpenAI answered 429: slow down');
      return null;
    },
  });
  const s = summaries(graph, dir, llm);
  await s.idle();
  assert.ok(requests.every((r) => (r.prompt.match(/^### item/gm) ?? []).length >= 1));
  assert.equal((await s.get('shop/backend/app/crud.py'))?.status, 'ready', 'written after splitting');
  const repo = await s.get('shop');
  assert.equal(repo?.status, 'error');
  assert.match(repo!.error!, /429/);
  cut = false;
});

test('summaries persist in the file store and merge across saves', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-store-'));
  const store = new FileProjectStore(home);
  assert.equal(await store.loadSummaries('p'), null);
  const a = { text: 'a', model: 'm', at: '2026-09-27T00:00:00Z' };
  const b = { text: 'b', model: 'm', at: '2026-09-27T00:00:01Z' };
  await Promise.all([store.saveSummaries('p', { [hashOf('a')]: a }), store.saveSummaries('p', { [hashOf('b')]: b })]);
  assert.deepEqual(await store.loadSummaries('p'), { [hashOf('a')]: a, [hashOf('b')]: b });
});
