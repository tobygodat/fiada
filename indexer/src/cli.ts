// Index repositories without the UI. Handy for tuning layer matchers:
//
//   npm run index -- ../some-repo org/other-repo --layers
//   npm run index -- ../some-repo --grouping my.grouping.json --layers
//   npm run index -- ../some-repo --preset by-repo --out graph.json
//   npm run index -- org/repo --sort --save-grouping sorted.grouping.json   (needs OPENAI_API_KEY or ANTHROPIC_API_KEY)
//   npm run index -- org/repo --summaries    (lines, and what generating summaries would cost; calls no model)

import './env.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GraphNode, LayerPreset, RepoInfo } from '@fiada/shared';
import { buildBase, classifyGraph } from './build.ts';
import { defaultGrouping, describeStats, normalizeGrouping, PRESETS, sortStats } from './classify/index.ts';
import { sortProject } from './classify/model-sort.ts';
import { KEY_HINT, llmFromEnv, type LLM } from './llm.ts';
import type { ParsedRepo } from './model.ts';
import { loadRepo } from './sources.ts';
import type { ProjectStore } from './store.ts';
import { Summaries } from './summaries/index.ts';
import { SYSTEM } from './summaries/items.ts';
import { parseSource, FIADA_HOME } from './workspace.ts';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const VALUED = ['--out', '--grouping', '--preset', '--save-grouping'];
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const out = opt('--out');
const sources = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const preset = (opt('--preset') ?? 'roles') as LayerPreset;

if (!sources.length || !PRESETS.includes(preset)) {
  console.error(
    'usage: npm run index -- <path | git url | org/repo>... [--preset roles|by-repo|empty] [--grouping file.json] [--sort] [--save-grouping file.json] [--layers] [--domains] [--summaries] [--out graph.json]',
  );
  process.exit(1);
}

const repos: ParsedRepo[] = [];
for (const input of sources) {
  const src = await parseSource(input);
  let dir = src.location;
  if (src.kind === 'git') {
    dir = path.join(FIADA_HOME, 'cli', src.name);
    const cloned = await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
    if (!cloned) {
      console.error(`cloning ${src.location} …`);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await exec('git', ['clone', '--depth', '1', '--', src.location, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    }
  }
  const info: RepoInfo = { id: src.name.toLowerCase(), name: src.name, source: src.location, kind: src.kind, status: 'indexing' };
  const t = Date.now();
  repos.push(await loadRepo(info, dir));
  console.error(`parsed ${src.name} in ${Date.now() - t}ms`);
}

const groupingFile = opt('--grouping');
const grouping = groupingFile
  ? normalizeGrouping(JSON.parse(await fs.readFile(groupingFile, 'utf8')))
  : defaultGrouping(preset, repos.map((r) => r.info));

const t = Date.now();
const base = buildBase(repos);
let graph = classifyGraph(base, grouping);
console.error(`linked and classified in ${Date.now() - t}ms\n`);

// --sort: Claude places what the classifier left, as the server does after an import.
if (flag('--sort')) {
  const llm = llmFromEnv();
  if (!llm) {
    console.error(`--sort needs ${KEY_HINT} (in the environment or .env)`);
    process.exit(1);
  }
  const unsorted = classifyGraph(base, { ...grouping, sorted: undefined });
  console.log(`classifier alone: ${describeStats(sortStats(unsorted))}`);
  const st = Date.now();
  grouping.sorted = await sortProject(unsorted, grouping, (req) => llm.json(req), { get model() { return llm.model; }, by: llm.label, log: (l) => console.error(l) });
  graph = classifyGraph(base, grouping);
  console.log(`with ${llm.label} (${llm.model}, ${((Date.now() - st) / 1000).toFixed(0)}s): ${describeStats(sortStats(graph))}\n`);
  for (const d of grouping.sorted.domains) {
    const what = d.mergeInto ? `merged into ${d.mergeInto}` : d.added ? 'added' : d.from ? `renamed from "${d.from}"` : 'kept';
    console.log(`  domain ${d.id.padEnd(22)} "${d.name}" ${what}${d.reason ? ` · ${d.reason}` : ''}`);
  }
  console.log();
  const save = opt('--save-grouping');
  if (save) {
    await fs.writeFile(save, JSON.stringify(grouping, null, 2) + '\n');
    console.error(`wrote ${save}`);
  }
} else {
  console.log(`sorted: ${describeStats(sortStats(graph))}`);
}

const count = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
};
const files = graph.nodes.filter((n) => n.kind === 'file');
const symbols = graph.nodes.filter((n) => n.kind === 'symbol');
for (const r of graph.repos) console.log(`${r.name}: ${r.fileCount} files, ${r.symbolCount} symbols, ${r.frameworks?.join(', ') || 'no frameworks detected'}`);
console.log(`\nedges: ${graph.edges.length} (${count(graph.edges, (e) => e.kind)})`);
console.log(`file layers: ${count(files, (n) => n.layer!.id)}`);
console.log(`symbol layers: ${count(symbols, (n) => n.layer!.id)}`);
console.log(`layer decided by: ${count(files, (n) => n.layer!.source)}`);
console.log(`domains: ${count(symbols, (n) => n.domain!.id)}`);

const http = graph.edges.filter((e) => e.kind === 'http');
if (http.length) {
  console.log(`\nHTTP contracts matched (${http.length}):`);
  for (const e of http.slice(0, 30)) console.log(`  ${e.from.split('/').slice(1).join('/')}  →  ${e.detail}  →  ${e.to.split('/').slice(1).join('/')}`);
}

const row = (n: GraphNode) =>
  `  ${n.layer!.id.padEnd(10)} ${n.layer!.source.padEnd(8)} ${n.id.padEnd(60)} ${n.layer!.evidence.map((e) => e.detail).join('; ')}`;
if (flag('--layers')) {
  console.log('\nlayer      source   file                                                         evidence');
  for (const n of files) console.log(row(n));
}
if (flag('--domains')) {
  console.log('\ndomain assignments:');
  for (const n of files) console.log(`  ${n.domain!.id.padEnd(16)} ${n.id.padEnd(60)} ${n.domain!.evidence[0]?.detail ?? ''}`);
}
if (flag('--summaries')) await summaryPlan();

/**
 * The line for a sample of nodes, then a dry run of generated summaries: a
 * model stand-in answers every request, so the counts are exactly what a
 * fresh import would send, without spending anything.
 */
async function summaryPlan() {
  const byRepo = new Map(repos.map((r) => [r.info.id, r]));
  const read = async (repo: string, p: string) => {
    const r = byRepo.get(repo);
    return r && r.files.some((f) => f.path === p) ? fs.readFile(path.join(r.root, p), 'utf8') : null;
  };
  const replies = { input: 0, output: 0 };
  const dry: LLM = {
    label: 'a dry run',
    model: 'dry-run',
    async json(req) {
      const n = (req.prompt.match(/^### item \d+/gm) ?? []).length;
      replies.output += n * 45;
      return { summaries: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), summary: 'x' })) };
    },
  };
  const memory: ProjectStore = { describe: () => 'memory', loadRepos: async () => null, saveRepos: async () => {}, loadGrouping: async () => null, saveGrouping: async () => {} };
  const lines = new Summaries({ store: memory, projectId: 'cli', llm: null, read });
  lines.setGraph(graph);
  const sample = (kind: string, k: number) => graph.nodes.filter((n) => n.kind === kind).slice(0, k);
  console.log('\nsummary lines (no model):');
  for (const n of [...sample('repo', 2), ...sample('folder', 3), ...sample('file', 6), ...sample('symbol', 8)]) {
    const s = await lines.get(n.id);
    console.log(`  ${n.kind.padEnd(7)} ${n.id}\n          ${s?.doc ? `[doc] ${s.doc}\n          ` : ''}${s?.line}`);
  }
  for (const d of graph.domains.slice(0, 3)) console.log(`  domain  ${d.name}\n          ${(await lines.get(`domain:${d.id}`))?.line}`);

  const s = new Summaries({ store: memory, projectId: 'cli', llm: dry, read, log: () => {} });
  s.setGraph(graph);
  const started = Date.now();
  await s.idle();
  const eager = { ...s.stats };
  const tokens = (chars: number) => Math.round(chars / 3.6);
  console.log(`\neager pass (files, folders, domains and layers, repos): ${eager.calls} requests for ${eager.items} summaries, about ${tokens(eager.promptChars).toLocaleString()} input and ${replies.output.toLocaleString()} output tokens (${Date.now() - started}ms to plan)`);

  const withSymbols = graph.nodes.filter((n) => n.kind === 'file' && graph.nodes.some((c) => c.parent === n.id && c.kind === 'symbol'));
  for (const f of withSymbols) {
    const first = graph.nodes.find((c) => c.parent === f.id && c.kind === 'symbol')!;
    await s.get(first.id);
  }
  await s.idle();
  const all = s.stats;
  console.log(
    `symbols, when first selected: one request per file (${withSymbols.length} files, ${graph.nodes.filter((n) => n.kind === 'symbol').length} symbols); opening every one would take ${all.calls - eager.calls} requests, about ${tokens(all.promptChars - eager.promptChars).toLocaleString()} input tokens`,
  );
  console.log(`(system prompt ${tokens(SYSTEM.length)} tokens per request; tokens estimated at 3.6 characters each)`);
}

if (out) {
  await fs.writeFile(out, JSON.stringify(graph));
  console.error(`\nwrote ${out}`);
}
