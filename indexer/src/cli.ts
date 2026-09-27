// Index repositories without the UI. Handy for tuning layer matchers:
//
//   npm run index -- ../some-repo org/other-repo --layers
//   npm run index -- ../some-repo --grouping my.grouping.json --layers
//   npm run index -- ../some-repo --preset by-repo --out graph.json
//   npm run index -- org/repo --sort --save-grouping sorted.grouping.json   (needs OPENAI_API_KEY or ANTHROPIC_API_KEY)

import './env.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GraphNode, LayerPreset, RepoInfo } from '@strata/shared';
import { buildBase, classifyGraph } from './build.ts';
import { defaultGrouping, describeStats, normalizeGrouping, PRESETS, sortStats } from './classify/index.ts';
import { sortProject } from './classify/model-sort.ts';
import { KEY_HINT, llmFromEnv } from './llm.ts';
import type { ParsedRepo } from './model.ts';
import { loadRepo } from './sources.ts';
import { parseSource, STRATA_HOME } from './workspace.ts';

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
    'usage: npm run index -- <path | git url | org/repo>... [--preset roles|by-repo|empty] [--grouping file.json] [--sort] [--save-grouping file.json] [--layers] [--domains] [--out graph.json]',
  );
  process.exit(1);
}

const repos: ParsedRepo[] = [];
for (const input of sources) {
  const src = await parseSource(input);
  let dir = src.location;
  if (src.kind === 'git') {
    dir = path.join(STRATA_HOME, 'cli', src.name);
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
if (out) {
  await fs.writeFile(out, JSON.stringify(graph));
  console.error(`\nwrote ${out}`);
}
