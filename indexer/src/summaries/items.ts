// What the model reads for each node, and how nodes share a request. An
// item's text is also its cache key: a node is rewritten only when what the
// model would read about it changes.

import { createHash } from 'node:crypto';
import type { GraphNode } from '@strata/shared';
import { declaration, fileDoc } from './docs.ts';
import { descendants, fileNeighbours, groupMembers, list, symbolNeighbours, type GraphIndex } from './describe.ts';

/** Bump when the prompt or item format changes enough that old summaries should be rewritten. */
export const PROMPT_VERSION = 1;

export type ItemKind = 'repo' | 'folder' | 'file' | 'symbol' | 'domain' | 'layer';

export interface Item {
  /** The node id the map selects. */
  node: string;
  kind: ItemKind;
  text: string;
  hash: string;
  /** Items that must share a request (a file's symbols share its header). */
  group?: string;
}

export const hashOf = (text: string) => createHash('sha256').update(`v${PROMPT_VERSION}\n${text}`).digest('base64url').slice(0, 22);

const item = (node: string, kind: ItemKind, text: string, group?: string): Item => ({ node, kind, text, hash: hashOf(text), ...(group ? { group } : {}) });

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Repo-relative, as people say it: "backend/app/crud.py". */
const where = (gi: GraphIndex, id: string) => {
  const n = gi.byId.get(id);
  return n?.path ?? id.slice(id.indexOf('/') + 1);
};

export const FILE_LINES = 40;
export const SYMBOL_LINES = 120;

export function fileItem(gi: GraphIndex, n: GraphNode, text: string | null): Item {
  const symbols = (gi.children.get(n.id) ?? []).filter((c) => c.kind === 'symbol');
  const lines = text?.split('\n') ?? [];
  const out = [`${n.repo}/${n.path} (${n.lang ?? 'file'}, ${n.loc ?? lines.length} lines, ${gi.layerName(n.layer?.id)} layer)`];
  const doc = text ? fileDoc(text, n.lang) : '';
  if (doc) out.push(`doc: ${doc}`);
  if (n.routes?.length) out.push(`serves: ${list(n.routes, 8)}`);
  const pages = (n.facts ?? []).filter((f) => f.type === 'pageRoute').map((f) => f.value);
  if (pages.length) out.push(`page: ${list(pages, 3)}`);
  if (symbols.length) {
    out.push('declares:');
    for (const s of symbols.slice(0, 30)) out.push(`  ${declaration(lines, s) || `${s.symbolKind ?? 'symbol'} ${s.name}`}`);
    if (symbols.length > 30) out.push(`  … and ${symbols.length - 30} more`);
  } else if (lines.length) {
    out.push('code:');
    for (const l of lines.slice(0, FILE_LINES)) out.push(`  ${cap(l, 160)}`);
    if (lines.length > FILE_LINES) out.push(`  … ${lines.length - FILE_LINES} more lines`);
  }
  const inside = (id: string) => id === n.id || id.startsWith(`${n.id}#`);
  const { uses, usedBy } = fileNeighbours(gi, [n, ...symbols], inside);
  if (uses.length) out.push(`uses: ${list(uses.map((u) => where(gi, u)), 6)}`);
  if (usedBy.length) out.push(`used by: ${list(usedBy.map((u) => where(gi, u)), 6)}`);
  return item(n.id, 'file', out.join('\n'));
}

/** A symbol with its own code; the file's header goes in the request once for all of them. */
export function symbolItem(gi: GraphIndex, n: GraphNode, lines: string[]): Item {
  const [a, b] = n.lines ?? [1, 1];
  const body = lines.slice(a - 1, Math.min(b, a - 1 + SYMBOL_LINES)).map((l) => cap(l, 200));
  const nb = symbolNeighbours(gi, n.id);
  const out = [`${n.name} (${n.symbolKind ?? 'symbol'}, ${n.path}:${a}-${b})`];
  if (n.routes?.length) out.push(`serves: ${list(n.routes, 6)}`);
  if (nb.calls.length) out.push(`calls: ${list(nb.calls, 8)}`);
  if (nb.httpCallers.length) out.push(`called over HTTP by: ${list(nb.httpCallers, 6)}`);
  if (nb.users.length) out.push(`used by: ${list(nb.users, 8)}`);
  out.push('```', ...body, ...(b - a + 1 > SYMBOL_LINES ? [`… ${b - a + 1 - SYMBOL_LINES} more lines`] : []), '```');
  return item(n.id, 'symbol', out.join('\n'), n.parent);
}

/** The lines above a file's first symbol (imports, constants), for context. */
export function fileHeader(gi: GraphIndex, file: GraphNode, lines: string[], max = 30): string {
  const first = Math.min(...(gi.children.get(file.id) ?? []).filter((c) => c.lines).map((c) => c.lines![0]), lines.length + 1);
  const head = lines.slice(0, Math.min(first - 1, max)).map((l) => cap(l, 200));
  return head.join('\n').trim();
}

/** What a container is made of: each child with its summary (generated if there is one, else its line). */
type SummaryOf = (id: string) => string;

export function folderItem(gi: GraphIndex, n: GraphNode, summaryOf: SummaryOf): Item {
  const kids = gi.children.get(n.id) ?? [];
  const weight = (c: GraphNode) => (c.kind === 'file' ? (c.loc ?? 0) : descendants(gi, c.id).reduce((k, d) => k + (d.kind === 'file' ? (d.loc ?? 0) : 0), 0));
  const ranked = [...kids].sort((x, y) => weight(y) - weight(x));
  const out = [`${n.repo}/${n.path} (folder, ${descendants(gi, n.id).filter((d) => d.kind === 'file').length} files)`, 'contains:'];
  for (const c of ranked.slice(0, 40)) out.push(`  ${c.name}${c.kind === 'folder' ? '/' : ''}: ${summaryOf(c.id)}`);
  if (ranked.length > 40) out.push(`  … and ${ranked.length - 40} more`);
  return item(n.id, 'folder', out.join('\n'));
}

export function repoItem(gi: GraphIndex, n: GraphNode, summaryOf: SummaryOf): Item {
  const info = gi.graph.repos.find((r) => r.id === n.id);
  const kids = gi.children.get(n.id) ?? [];
  const out = [
    `${n.name} (repository${info?.frameworks?.length ? `; frameworks: ${info.frameworks.join(', ')}` : ''}${info?.languages ? `; languages: ${Object.keys(info.languages).join(', ')}` : ''})`,
    'top level:',
  ];
  for (const c of kids.slice(0, 40)) out.push(`  ${c.name}${c.kind === 'folder' ? '/' : ''}: ${summaryOf(c.id)}`);
  return item(n.id, 'repo', out.join('\n'));
}

/** A function-view group: a domain, or one layer of it. */
export function groupItem(gi: GraphIndex, id: string, g: { domain: string; layer?: string }, summaryOf: SummaryOf): Item {
  const members = groupMembers(gi, g);
  const byFile = new Map<string, string[]>();
  for (const m of members) {
    const f = m.kind === 'symbol' ? m.parent : m.id;
    const names = byFile.get(f) ?? [];
    if (m.kind === 'symbol') names.push(m.name);
    byFile.set(f, names);
  }
  const files = [...byFile].sort((a, b) => b[1].length - a[1].length);
  const domain = gi.domainName(g.domain);
  const out = [
    g.layer == null
      ? `${domain} (a domain: the code that serves one purpose, across layers and repositories)`
      : `${gi.layerName(g.layer)} code in the ${domain} domain`,
    'members, by file:',
  ];
  for (const [f, names] of files.slice(0, 25)) out.push(`  ${where(gi, f)}${names.length ? ` (${list(names, 8)})` : ''}: ${summaryOf(f)}`);
  if (files.length > 25) out.push(`  … and ${files.length - 25} more files`);
  return item(id, g.layer == null ? 'domain' : 'layer', out.join('\n'));
}

// ── requests ──

export const SYSTEM = [
  'You write the short summaries at the top of a codebase map. A developer new to the code selects a node (a repository, folder, file, function, class, or a group of code by purpose) and reads your summary to decide whether to open it.',
  'For every item, write one or two plain sentences, at most 40 words, saying what it does and why it exists in this codebase. Lead with the behaviour ("Creates an item owned by the signed-in user and…"), not the name, the path or "This file". Name a collaborator only when it explains the role.',
  'Say only what the code shown supports; if something is trivial, say so briefly. Plain prose: no markdown, no backticks, no lists.',
  'Reply with one entry per item, using the item ids exactly as given.',
].join('\n\n');

export const SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, summary: { type: 'string' } },
        required: ['id', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['summaries'],
  additionalProperties: false,
} as const;

export interface Batch {
  items: Item[];
  /** Shared context above the items, e.g. a file's imports. */
  context?: string;
}

/** The request text for a batch; items are numbered so ids stay short and exact. */
export function prompt(batch: Batch): string {
  const head = batch.context ? `Context shared by the items below:\n${batch.context}\n\n` : '';
  return `${head}${batch.items.map((it, i) => `### item ${i + 1} (${it.kind})\n${it.text}`).join('\n\n')}`;
}

export const BUDGET = { chars: 48_000, items: 40 };

/**
 * Takes the next batch off the front of `queue`: items in order until the
 * character or item budget is full. Items with a `group` only share a batch
 * with their own group. Always takes at least one item.
 */
export function takeBatch(queue: Item[], budget = BUDGET): Item[] {
  const out: Item[] = [];
  let chars = 0;
  const group = queue[0]?.group;
  for (let i = 0; i < queue.length && out.length < budget.items; ) {
    const it = queue[i];
    if (it.group !== group) {
      i++;
      continue;
    }
    if (out.length && chars + it.text.length > budget.chars) break;
    out.push(it);
    chars += it.text.length;
    queue.splice(i, 1);
  }
  return out;
}

