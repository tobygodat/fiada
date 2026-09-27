// Sorting a project with a language model (Claude), after the deterministic classifier:
//
//   1. Domains. Claude sees each domain the classifier found (its files, what
//      seeded it, its biggest symbols) and an outline of the leftovers. It
//      names each domain for the feature it is, merges domains that are one
//      feature ("Shares" and "Sharing"), and adds the few domains the
//      leftovers need ("Platform", "Search").
//   2. Leftovers. Every file with code in Unlayered or Unsorted goes to Claude
//      in batches, with its imports, detected facts, symbols and which
//      domains and layers its neighbours are in. Claude picks a layer from the
//      project's own list and a domain from step 1, with a one-line reason.
//
// The result is a SortedGrouping, stored in the project's grouping. It only
// fills gaps: code the classifier placed keeps its place, and the user's
// rules, pins and names win over it (see ./sorted.ts).

import {
  describeFact,
  SHARED_DOMAIN,
  UNLAYERED,
  UNSORTED_DOMAIN,
  type Graph,
  type GraphNode,
  type Grouping,
  type SortedDomain,
  type SortedGrouping,
  type SortedPlacement,
} from '@strata/shared';
import type { JsonRequest } from '../llm.ts';
import { leftoverFiles, type LeftoverFile } from './leftovers.ts';

/** Asks the model one structured question (LLM.json). */
export type Ask = (req: JsonRequest) => Promise<unknown>;

export interface SortOptions {
  model: string;
  /** Leftover files per request. */
  batchSize?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  log?: (line: string) => void;
}

const INSTRUCTIONS = `You sort code for Strata, a map of software repositories. The map groups every function, class and component two ways: by layer, its role in the request flow, from the project's own list of layers; and by domain, the product feature it serves ("Documents", "Billing", "Sign-in").

A deterministic classifier has already placed most of the code, from routes, ORM entities, folder names and the call graph. You finish what it couldn't, so the person opening the map starts from a sorted project and adjusts it from there. They will read your reasons next to the code, so each reason is one plain line a developer can check against the code: cite the path, an import, what calls it or what it does. Don't restate the name of the layer or domain you chose.`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const oneOf = (values: string[]) => (values.length ? { type: 'string', enum: values } : { type: 'string' });

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const listTally = (xs: string[], max = 4) =>
  tally(xs)
    .slice(0, max)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');

/**
 * Sorts a classified graph's leftovers. `graph` must be classified without a
 * previous sort (so its leftovers are the classifier's own) but with the
 * user's rules and pins, which Claude then works around.
 */
export async function sortProject(graph: Graph, grouping: Grouping, ask: Ask, opts: SortOptions): Promise<SortedGrouping> {
  const log = opts.log ?? (() => {});
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileOf = (id: string) => {
    const n = byId.get(id);
    return n?.kind === 'symbol' ? n.parent : id;
  };
  const layerName = new Map([...graph.layers.map((l) => [l.id, l.name] as const), [UNLAYERED, 'Unlayered']]);
  const domainName = new Map(graph.domains.map((d) => [d.id, d.name]));
  const repos = Object.fromEntries(graph.repos.map((r) => [r.id, r.commit ?? '']));
  const leftovers = leftoverFiles(graph).sort((a, b) => a.file.id.localeCompare(b.file.id));

  // ── context ──────────────────────────────────────────────────────────
  const project = graph.repos
    .map((r) => `- ${r.name}: ${r.fileCount ?? 0} files, ${r.symbolCount ?? 0} symbols${r.frameworks?.length ? `, ${r.frameworks.join(', ')}` : ''}${r.languages ? ` (${Object.keys(r.languages).join(', ')})` : ''}`)
    .join('\n');
  const layersText = graph.layers.length
    ? graph.layers.map((l) => `- ${l.id}: ${l.name}${l.rank != null ? ` (rank ${l.rank} in the request flow)` : ''}`).join('\n')
    : '(this project has no layers; leave layer empty)';

  // Domains the classifier found, with what's in them.
  const userOwned = new Set(grouping.domains.map((d) => d.id));
  const members = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if ((n.kind !== 'symbol' && n.kind !== 'file') || !n.domain) continue;
    const d = n.domain.id;
    if (d === UNSORTED_DOMAIN || d === SHARED_DOMAIN) continue;
    (members.get(d) ?? members.set(d, []).get(d)!).push(n);
  }
  const found = graph.domains.filter((d) => members.has(d.id));
  const symbolsIn = tally(graph.nodes.filter((n) => n.kind === 'symbol').map((n) => n.parent));
  const perFile = new Map(symbolsIn);
  /** A domain's files, most telling first: files that seeded it, then files most of whose code is in it (not a big shared file that lends it a few symbols). */
  const filesOf = (id: string) => {
    const ms = members.get(id) ?? [];
    const seeded = new Set(ms.filter((n) => n.domain!.source === 'seed').map((n) => fileOf(n.id)));
    return tally(ms.map((n) => fileOf(n.id)))
      .map(([f, n]) => [f, (seeded.has(f) ? 10 : 0) + n / Math.max(perFile.get(f) ?? 1, n)] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
  };
  const describeDomain = (d: { id: string; name: string }) => {
    const ms = members.get(d.id) ?? [];
    const files = filesOf(d.id);
    const seeds = tally(ms.filter((n) => n.domain!.source === 'seed').map((n) => n.domain!.evidence[0]?.detail ?? '')).filter(([s]) => s);
    const syms = ms
      .filter((n) => n.kind === 'symbol')
      .sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0))
      .slice(0, 8)
      .map((n) => n.name);
    return [
      `- ${d.id} ("${d.name}")${userOwned.has(d.id) ? ' [named by the user: keep it, no rename or merge]' : ''}: ${ms.filter((n) => n.kind === 'symbol').length} symbols in ${files.length} files`,
      `  files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}`,
      seeds.length ? `  seeded by: ${seeds.slice(0, 4).map(([s]) => s).join('; ')}` : '',
      syms.length ? `  biggest symbols: ${syms.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  // ── 1. domains: names, merges, additions ───────────────────────────
  const renameable = found.filter((d) => !userOwned.has(d.id));
  const leftoverOutline = outline(leftovers);
  const domainsPrompt = `Project:
${project}

Layers:
${layersText}

Domains the classifier found:
${found.map(describeDomain).join('\n') || '(none)'}

Code the classifier couldn't place (${leftovers.length} files):
${leftoverOutline}

For each domain the classifier found that the user hasn't named:
- name: a short, plain name for the product feature (one to three words, e.g. "Documents", "Sign-in", "Webhooks"). Keep the current name when it's already good.
- merge_into: the id of another domain when both are the same feature (for example "share" and "sharing"). Leave it empty for distinct features, even related ones.
- reason: one line on the name or the merge.

Then new_domains: the few domains the leftover code needs that none of the above covers (for example "Platform" for configuration, logging and startup, or "Search"). Prefer the existing domains; add a new one only when several leftover files belong together in it, and no more than eight. Give each an id (lowercase, hyphenated), a name and a one-line description of what belongs in it.`;

  let domainAnswer: { domains: { id: string; name: string; merge_into: string; reason: string }[]; new_domains: { id: string; name: string; reason: string }[] } = {
    domains: [],
    new_domains: [],
  };
  if (renameable.length || leftovers.length) {
    log(`[strata] sort: naming ${renameable.length} domains with ${opts.model}`);
    domainAnswer = (await ask({
      label: 'domains',
      system: [INSTRUCTIONS],
      prompt: domainsPrompt,
      schema: obj({
        domains: { type: 'array', items: obj({ id: oneOf(renameable.map((d) => d.id)), name: { type: 'string' }, merge_into: oneOf(['', ...found.map((d) => d.id)]), reason: { type: 'string' } }) },
        new_domains: { type: 'array', items: obj({ id: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' } }) },
      }),
    })) as typeof domainAnswer;
  }

  const sortedDomains: SortedDomain[] = [];
  const renameableIds = new Set(renameable.map((d) => d.id));
  const foundIds = new Set(found.map((d) => d.id));
  const seen = new Set<string>();
  for (const d of domainAnswer.domains ?? []) {
    if (!renameableIds.has(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    const was = domainName.get(d.id) ?? d.id;
    const name = d.name?.trim() || was;
    const mergeInto = d.merge_into && d.merge_into !== d.id && foundIds.has(d.merge_into) ? d.merge_into : undefined;
    sortedDomains.push({
      id: d.id,
      name,
      ...(name !== was ? { from: was } : {}),
      ...(mergeInto ? { mergeInto } : {}),
      ...(d.reason?.trim() ? { reason: d.reason.trim() } : {}),
    });
  }
  // A domain merged into one that is itself merged away follows it; a pair merged into each other keeps the first.
  const mergedAway = new Set<string>();
  for (const d of sortedDomains) {
    if (!d.mergeInto) continue;
    if (mergedAway.has(d.mergeInto) && sortedDomains.find((x) => x.id === d.mergeInto)?.mergeInto === d.id) delete d.mergeInto;
    else mergedAway.add(d.id);
  }
  const taken = new Set([...foundIds, SHARED_DOMAIN, UNSORTED_DOMAIN, ...grouping.domains.map((d) => d.id)]);
  for (const d of (domainAnswer.new_domains ?? []).slice(0, 8)) {
    const id = slug(d.id || d.name);
    if (!id || taken.has(id) || !d.name?.trim()) continue;
    taken.add(id);
    sortedDomains.push({ id, name: d.name.trim(), added: true, ...(d.reason?.trim() ? { reason: d.reason.trim() } : {}) });
  }

  // ── 2. leftovers ───────────────────────────────────────────────────
  const finalName = new Map<string, string>();
  for (const d of found) if (!mergedAway.has(d.id)) finalName.set(d.id, sortedDomains.find((x) => x.id === d.id)?.name ?? d.name);
  for (const d of sortedDomains) if (d.added) finalName.set(d.id, d.name);
  const about = new Map(sortedDomains.map((d) => [d.id, d.reason]));
  const domainIds = [...finalName.keys()];
  const domainsText = domainIds
    .map((id) => {
      const d = found.find((x) => x.id === id);
      const files = d ? filesOf(id).slice(0, 4) : [];
      return `- ${id}: ${finalName.get(id)}${sortedDomains.find((x) => x.id === id)?.added ? ` (new: ${about.get(id) ?? ''})` : files.length ? ` (e.g. ${files.join(', ')})` : ''}`;
    })
    .join('\n');
  const context = `Project:
${project}

Layers (pick by id):
${layersText}

Domains (pick by id):
${domainsText}`;

  // Neighbours: which domains and layers the code a file uses, and the code using it, is in.
  const out = new Map<string, { domains: string[]; layers: string[] }>();
  const inc = new Map<string, { domains: string[]; layers: string[] }>();
  const nameFor = (n: GraphNode | undefined, merged: (id: string) => string) => {
    const d = n?.domain?.id;
    return {
      domain: d && d !== UNSORTED_DOMAIN ? (d === SHARED_DOMAIN ? 'Shared' : (finalName.get(merged(d)) ?? domainName.get(d) ?? d)) : null,
      layer: n?.layer && n.layer.id !== UNLAYERED ? (layerName.get(n.layer.id) ?? n.layer.id) : null,
    };
  };
  const into = new Map(sortedDomains.filter((d) => d.mergeInto).map((d) => [d.id, d.mergeInto!]));
  const merged = (id: string) => into.get(id) ?? id;
  const push = (m: typeof out, file: string, other: GraphNode | undefined) => {
    const e = m.get(file) ?? m.set(file, { domains: [], layers: [] }).get(file)!;
    const { domain, layer } = nameFor(other, merged);
    if (domain) e.domains.push(domain);
    if (layer) e.layers.push(layer);
  };
  for (const e of graph.edges) {
    const a = fileOf(e.from);
    const b = fileOf(e.to);
    if (a === b) continue;
    push(out, a, byId.get(e.to));
    push(inc, b, byId.get(e.from));
  }

  const describeFile = (lf: LeftoverFile, ref: string) => {
    const f = lf.file;
    const facts = f.facts ?? [];
    const imports = facts.filter((x) => x.type === 'import').map((x) => x.value);
    const seenFacts = facts.filter((x) => x.type !== 'import').map(describeFact);
    const sym = (s: GraphNode) => (s.kind === 'file' ? 'the file itself' : `${s.name} (${s.symbolKind ?? 'symbol'}${s.loc ? `, ${s.loc} lines` : ''}${s.facts?.length ? `; ${s.facts.map(describeFact).join(', ')}` : ''})`);
    const o = out.get(f.id);
    const i = inc.get(f.id);
    const current = f.layer && f.layer.id !== UNLAYERED ? layerName.get(f.layer.id) : null;
    return [
      `${ref} ${f.id} (${f.lang ?? 'unknown'}, ${f.loc ?? 0} lines)`,
      `  layer: ${lf.needsLayer ? 'needs one' : `${current} (decided; leave layer empty)`}`,
      lf.needsDomain.length ? `  needs a domain: ${lf.needsDomain.slice(0, 25).map(sym).join('; ')}${lf.needsDomain.length > 25 ? `; and ${lf.needsDomain.length - 25} more` : ''}` : '  domain: decided (leave domain empty)',
      lf.placed.length ? `  already placed in this file: ${listTally(lf.placed.map((s) => nameFor(s, merged).domain ?? '?'))}` : '',
      seenFacts.length ? `  detected: ${seenFacts.slice(0, 6).join('; ')}` : '',
      imports.length ? `  imports: ${imports.slice(0, 10).join(', ')}${imports.length > 10 ? ` +${imports.length - 10}` : ''}` : '',
      o?.domains.length || o?.layers.length ? `  uses code in: ${[listTally(o.domains), listTally(o.layers)].filter(Boolean).join(' · ')}` : '',
      i?.domains.length || i?.layers.length ? `  used by code in: ${[listTally(i.domains), listTally(i.layers)].filter(Boolean).join(' · ')}` : '',
      !o && !i ? '  no links to other files' : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const layerIds = graph.layers.map((l) => l.id);
  const schema = obj({
    files: {
      type: 'array',
      items: obj({
        ref: { type: 'string' },
        layer: oneOf(['', ...layerIds]),
        layer_reason: { type: 'string' },
        domain: oneOf(['', ...domainIds]),
        reason: { type: 'string' },
        symbols: { type: 'array', items: obj({ name: { type: 'string' }, domain: oneOf(domainIds), reason: { type: 'string' } }) },
      }),
    },
  });
  const ask2 = `For every file below:
- layer: when it needs one, the layer it belongs in, with layer_reason. Otherwise leave both empty.
- domain: when something in it needs a domain, the domain that code serves, with reason. It applies to everything in the file that needs a domain.
- symbols: only for a symbol that clearly serves a different domain than the rest of its file: its name, its domain and why.
Answer every file, by its ref.`;

  const placements: Record<string, SortedPlacement> = {};
  const refs = new Map<string, LeftoverFile>();
  const batchSize = opts.batchSize ?? 60;
  const run = async (batch: LeftoverFile[], n: number, of: number) => {
    const first = refs.size + 1;
    const lines = batch.map((lf, i) => {
      refs.set(`F${first + i}`, lf);
      return describeFile(lf, `F${first + i}`);
    });
    log(`[strata] sort: placing ${batch.length} files (${n} of ${of})`);
    const answer = (await ask({ label: `leftovers ${n}/${of}`, system: [INSTRUCTIONS, context], prompt: `${ask2}\n\n${lines.join('\n\n')}`, schema })) as {
      files?: { ref: string; layer: string; layer_reason: string; domain: string; reason: string; symbols?: { name: string; domain: string; reason: string }[] }[];
    };
    const valid = new Set(batch.map((_, i) => `F${first + i}`));
    const done = new Set<string>();
    for (const a of answer.files ?? []) {
      const lf = valid.has(a.ref) ? refs.get(a.ref) : undefined;
      if (!lf || done.has(a.ref)) continue;
      done.add(a.ref);
      const p: Partial<SortedPlacement> = {};
      if (lf.needsLayer && layerIds.includes(a.layer)) {
        p.layer = a.layer;
        if (a.layer_reason?.trim()) p.layerReason = a.layer_reason.trim();
      }
      if (lf.needsDomain.length && finalName.has(a.domain)) p.domain = a.domain;
      const reason = a.reason?.trim() || p.layerReason;
      if ((p.layer || p.domain) && reason) {
        if (p.layerReason === reason) delete p.layerReason;
        placements[lf.file.id] = { ...p, reason };
      }
      for (const s of a.symbols ?? []) {
        const target = lf.needsDomain.find((x) => x.name === s.name && !placements[x.id]);
        if (target && target.kind === 'symbol' && finalName.has(s.domain) && s.domain !== p.domain && s.reason?.trim()) placements[target.id] = { domain: s.domain, reason: s.reason.trim() };
      }
    }
    return [...valid].filter((r) => !done.has(r)).map((r) => refs.get(r)!);
  };

  const batches: LeftoverFile[][] = [];
  for (let i = 0; i < leftovers.length; i += batchSize) batches.push(leftovers.slice(i, i + batchSize));
  const missed = (await pool(batches.map((b, i) => [b, i + 1] as const), opts.concurrency ?? 4, ([b, n]) => run(b, n, batches.length))).flat();
  // Files an answer skipped get one more try on their own.
  if (missed.length) {
    log(`[strata] sort: asking again about ${missed.length} files the answers skipped`);
    for (let i = 0; i < missed.length; i += batchSize) await run(missed.slice(i, i + batchSize), 1, 1);
  }

  return { model: opts.model, at: new Date().toISOString(), repos, domains: sortedDomains, placements };
}

/** The leftovers as folders with file counts, so step 1 sees their shape without every file. */
function outline(leftovers: LeftoverFile[]): string {
  if (leftovers.length <= 400) return leftovers.map((lf) => `- ${lf.file.id}${lf.needsLayer ? ' (no layer)' : ''}`).join('\n') || '(none)';
  const dirs = tally(leftovers.map((lf) => lf.file.id.split('/').slice(0, -1).join('/')));
  return dirs.map(([d, n]) => `- ${d}/ (${n} files)`).join('\n');
}
