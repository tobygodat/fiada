// The user's side of classification: checking a grouping that came from disk
// or the API, and applying its rules and pins on top of whatever the
// strategies decided. User placements always win.

import {
  SHARED_DOMAIN,
  UNLAYERED,
  UNSORTED_DOMAIN,
  type FactType,
  type GraphNode,
  type Grouping,
  type GroupingRule,
  type LayerDef,
  type LayerMatcher,
  type Placement,
} from '@strata/shared';
import { PRESETS } from './presets.ts';
import { normalizeSorted } from './sorted.ts';
import { globMatch } from './glob.ts';
import type { Assignments } from './types.ts';

const FACT_TYPES: FactType[] = ['import', 'frontend', 'route', 'pageRoute', 'returnsJSX', 'request', 'extends', 'table', 'typeOnly', 'decorator', 'entrypoint', 'test'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export class GroupingError extends Error {}

function matcher(raw: unknown, where: string): LayerMatcher {
  if (!isObj(raw)) throw new GroupingError(`${where}: expected an object`);
  const m: LayerMatcher = { priority: typeof raw.priority === 'number' ? raw.priority : 100 };
  if (raw.fact !== undefined) {
    if (!isObj(raw.fact) || !FACT_TYPES.includes(raw.fact.type as FactType)) {
      throw new GroupingError(`${where}.fact: type must be one of ${FACT_TYPES.join(', ')}`);
    }
    m.fact = { type: raw.fact.type as FactType };
    if (str(raw.fact.value)) m.fact.value = raw.fact.value as string;
  }
  for (const k of ['import', 'path', 'repo'] as const) if (str(raw[k])) m[k] = raw[k] as string;
  return m;
}

/** Validates a grouping (from disk, the API or a store) and fills in defaults. Throws GroupingError with a readable message. */
export function normalizeGrouping(raw: unknown): Grouping {
  if (!isObj(raw)) throw new GroupingError('grouping must be a JSON object');
  if (!Array.isArray(raw.layers)) throw new GroupingError('grouping.layers must be an array');
  const ids = new Set<string>();
  const layers: LayerDef[] = raw.layers.map((l, i) => {
    const where = `layers[${i}]`;
    if (!isObj(l) || !str(l.id)) throw new GroupingError(`${where}: needs an id`);
    const id = l.id as string;
    if (id === UNLAYERED) throw new GroupingError(`${where}: "${UNLAYERED}" is reserved`);
    if (ids.has(id)) throw new GroupingError(`${where}: duplicate id "${id}"`);
    ids.add(id);
    const match = Array.isArray(l.match) ? l.match.map((m, j) => matcher(m, `${where}.match[${j}]`)) : [];
    const def: LayerDef = { id, name: str(l.name) ?? id, match };
    if (typeof l.rank === 'number') def.rank = l.rank;
    return def;
  });
  const domains = (Array.isArray(raw.domains) ? raw.domains : []).filter(isObj).flatMap((d) => {
    if (!str(d.id)) return [];
    return [{ id: d.id as string, name: str(d.name), order: typeof d.order === 'number' ? d.order : undefined, hidden: d.hidden === true || undefined }];
  });
  const rules: GroupingRule[] = (Array.isArray(raw.rules) ? raw.rules : []).filter(isObj).flatMap((r) => {
    if (!isObj(r.match) || (!str(r.layer) && !str(r.domain))) return [];
    const match: GroupingRule['match'] = {};
    for (const k of ['repo', 'path', 'name', 'layer'] as const) if (str(r.match[k])) match[k] = r.match[k] as string;
    return [{ match, layer: str(r.layer), domain: str(r.domain) }];
  });
  const pins: Grouping['pins'] = {};
  if (isObj(raw.pins)) {
    for (const [id, p] of Object.entries(raw.pins)) {
      if (isObj(p) && (str(p.layer) || str(p.domain))) pins[id] = { layer: str(p.layer), domain: str(p.domain) };
    }
  }
  const preset = PRESETS.find((p) => p === raw.preset);
  const sorted = normalizeSorted(raw.sorted);
  return { schema: 1, ...(preset ? { preset } : {}), layers, domains, rules, pins, ...(sorted ? { sorted } : {}) };
}

const user = (source: 'user-rule' | 'user-pin', id: string, detail: string): Placement => ({
  id,
  confidence: 1,
  source,
  evidence: [{ source, detail, weight: 1 }],
});

function describeRule(r: GroupingRule): string {
  const m = r.match;
  const parts = [m.repo && `repo ${m.repo}`, m.path && `path ${m.path}`, m.name && `name /${m.name}/`, m.layer && `in ${m.layer}`].filter(Boolean);
  return `your rule: ${parts.join(', ') || 'everything'}`;
}

/** Applies rules (in order, later wins) and then pins. A pin on a file also covers its symbols that have no pin of their own. */
export function applyUserPlacements(nodes: GraphNode[], grouping: Grouping, layers: Assignments, domains: Assignments) {
  const layerIds = new Set([...grouping.layers.map((l) => l.id), UNLAYERED]);
  const nameRes = new Map<string, RegExp | null>();
  const nameRe = (src: string) => {
    if (!nameRes.has(src)) {
      try {
        nameRes.set(src, new RegExp(src));
      } catch {
        nameRes.set(src, null);
      }
    }
    return nameRes.get(src);
  };

  if (grouping.rules.length) {
    for (const n of nodes) {
      if (n.kind !== 'file' && n.kind !== 'symbol') continue;
      for (const r of grouping.rules) {
        const m = r.match;
        if (m.repo && n.repo !== m.repo) continue;
        if (m.path && !globMatch(m.path, n.id.split('#')[0])) continue;
        if (m.name && (n.kind !== 'symbol' || !nameRe(m.name)?.test(n.name))) continue;
        if (m.layer && layers.get(n.id)?.id !== m.layer) continue;
        if (r.layer && layerIds.has(r.layer)) layers.set(n.id, user('user-rule', r.layer, describeRule(r)));
        if (r.domain) domains.set(n.id, user('user-rule', r.domain, describeRule(r)));
      }
    }
  }

  const pinned = Object.keys(grouping.pins);
  if (!pinned.length) return;
  for (const n of nodes) {
    if (n.kind !== 'file' && n.kind !== 'symbol') continue;
    const own = grouping.pins[n.id];
    const pin = own ?? (n.kind === 'symbol' ? grouping.pins[n.parent] : undefined);
    if (!pin) continue;
    const detail = own ? 'you placed it here' : 'you placed its file here';
    if (pin.layer && layerIds.has(pin.layer)) layers.set(n.id, user('user-pin', pin.layer, detail));
    if (pin.domain) domains.set(n.id, user('user-pin', pin.domain, detail));
  }
}

/** Display names and order for every domain in use: the user's names and order first, then the strategy's. */
export function domainList(grouping: Grouping, proposed: { id: string; name: string }[], used: Set<string>) {
  const names = new Map(proposed.map((d) => [d.id, d.name]));
  names.set(SHARED_DOMAIN, 'Shared');
  names.set(UNSORTED_DOMAIN, 'Unsorted');
  const user = new Map(grouping.domains.map((d) => [d.id, d]));
  const rank = new Map(proposed.map((d, i) => [d.id, i]));
  const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]+/g, ' ');
  const order = (id: string) =>
    user.get(id)?.order ?? (id === UNSORTED_DOMAIN ? 1e9 : id === SHARED_DOMAIN ? 1e9 - 1 : 1e6 + (rank.get(id) ?? 1e5));
  return [...used]
    .map((id) => ({ id, name: user.get(id)?.name ?? names.get(id) ?? title(id), o: order(id) }))
    .sort((a, b) => a.o - b.o || a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }));
}
