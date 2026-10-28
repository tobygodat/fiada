// Default layer strategy: the project's own matchers, then graph position.
//
//   1. Every matcher of every layer in the project's grouping is tried against
//      the file (its path, its repo, its facts); the highest priority wins.
//   2. Files nothing matched take the layer most of their callers (or, failing
//      that, their callees) have.
//   3. Anything still unplaced is Unlayered, so it shows up as needing a rule.
//
// Symbols inherit their file's layer unless one of their own facts matches a
// fact matcher: a schema class in a routes file, a fetch helper in a component file.

import { describeFact, UNLAYERED, type Fact, type LayerDef, type LayerMatcher, type Placement, type PlacementSource } from '@fiada/shared';
import { globMatch } from './glob.ts';
import type { Assignments, LayerStrategy } from './types.ts';

const regexes = new Map<string, RegExp | null>();
function regex(src: string): RegExp | null {
  if (!regexes.has(src)) {
    try {
      regexes.set(src, new RegExp(src));
    } catch {
      console.warn(`[fiada] ignoring invalid regex in a layer matcher: ${src}`);
      regexes.set(src, null);
    }
  }
  return regexes.get(src)!;
}

/** "sqlalchemy" matches "sqlalchemy" and "sqlalchemy.orm"; "next" matches "next/server". */
export const importMatches = (spec: string, prefix: string) =>
  spec === prefix || (spec.startsWith(prefix) && (spec[prefix.length] === '/' || spec[prefix.length] === '.'));


export interface Hit {
  layer: LayerDef;
  matcher: LayerMatcher;
  source: PlacementSource;
  detail: string;
}

/**
 * Tests one matcher; returns what it matched on, or null. Every field that is
 * set must match. A matcher's source is its most specific condition: a path
 * qualified by a fact ("api/ in a react package") is still a path convention.
 */
export function matchOne(m: LayerMatcher, node: { repo: string; id: string }, facts: Fact[]): { source: PlacementSource; detail: string } | null {
  const parts: string[] = [];
  const kinds: PlacementSource[] = [];
  if (m.path !== undefined) {
    if (!globMatch(m.path, node.id.split('#')[0])) return null;
    parts.push(`path matches ${m.path}`);
    kinds.push('path');
  }
  if (m.import !== undefined) {
    const f = facts.find((f) => f.type === 'import' && importMatches(f.value, m.import!));
    if (!f) return null;
    parts.push(`imports ${f.value}`);
    kinds.push('import');
  }
  if (m.fact) {
    const re = m.fact.value ? regex(m.fact.value) : null;
    if (m.fact.value && !re) return null;
    const f = facts.find((f) => f.type === m.fact!.type && (!re || re.test(f.value)));
    if (!f) return null;
    parts.push(describeFact(f));
    kinds.push('fact');
  }
  if (m.repo !== undefined) {
    if (node.repo !== m.repo) return null;
    parts.push(`in repo ${m.repo}`);
    kinds.push('repo');
  }
  return { source: kinds[0] ?? 'fallback', detail: parts.join(', ') || 'matches everything' };
}

/** Confidence follows the priority bands the presets use, so a user's high-priority path rule reads as confident. */
const confidence = (priority: number) => (priority >= 300 ? 0.9 : priority >= 200 ? 0.7 : priority >= 100 ? 0.6 : 0.5);

/** All matches for a node, best first. Ties go to the layer listed first, then the matcher listed first. */
export function matchLayers(layers: LayerDef[], node: { repo: string; id: string }, facts: Fact[], factMatchersOnly = false): Hit[] {
  const hits: Hit[] = [];
  for (const layer of layers) {
    for (const m of layer.match) {
      if (factMatchersOnly && !m.fact) continue;
      const r = matchOne(m, node, facts);
      if (r) hits.push({ layer, matcher: m, ...r });
    }
  }
  return hits.sort((a, b) => b.matcher.priority - a.matcher.priority);
}

function placement(hits: Hit[]): Placement {
  const win = hits[0];
  // Runners-up from other layers explain close calls ("also imports sqlmodel").
  const seen = new Set([win.layer.id]);
  const evidence = [{ source: win.source, detail: win.detail, weight: win.matcher.priority }];
  for (const h of hits.slice(1)) {
    if (seen.has(h.layer.id) || evidence.length >= 2) continue;
    seen.add(h.layer.id);
    evidence.push({ source: h.source, detail: `${h.detail} (would be ${h.layer.name})`, weight: h.matcher.priority });
  }
  return { id: win.layer.id, confidence: confidence(win.matcher.priority), source: win.source, evidence };
}

export const UNPLACED: Placement = {
  id: UNLAYERED,
  confidence: 0,
  source: 'fallback',
  evidence: [{ source: 'fallback', detail: 'no layer matcher applies and no neighbours to go by', weight: 0 }],
};

export const projectMatchers: LayerStrategy = {
  name: 'project-matchers',
  assign({ nodes, edges, grouping }): Assignments {
    const layers = grouping.layers;
    const names = new Map(layers.map((l) => [l.id, l.name]));
    const out: Assignments = new Map();
    const files = nodes.filter((n) => n.kind === 'file');

    // 1. Matchers.
    for (const f of files) {
      const hits = matchLayers(layers, f, f.facts ?? []);
      if (hits.length) out.set(f.id, placement(hits));
    }

    // 2. Neighbours, a few rounds so placements can travel along call chains.
    const fileOf = (id: string) => id.split('#')[0];
    const callers = new Map<string, Set<string>>();
    const callees = new Map<string, Set<string>>();
    for (const e of edges) {
      const a = fileOf(e.from);
      const b = fileOf(e.to);
      if (a === b) continue;
      (callers.get(b) ?? callers.set(b, new Set()).get(b)!).add(a);
      (callees.get(a) ?? callees.set(a, new Set()).get(a)!).add(b);
    }
    const majority = (ids: Set<string> | undefined): [string, number, number] | null => {
      if (!ids?.size) return null;
      const tally = new Map<string, number>();
      let placed = 0;
      for (const id of ids) {
        const l = out.get(id)?.id;
        if (!l || l === UNLAYERED) continue;
        placed++;
        tally.set(l, (tally.get(l) ?? 0) + 1);
      }
      const [top, n] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [];
      return top && n / placed > 0.5 ? [top, n, placed] : null;
    };
    for (let round = 0; round < 3; round++) {
      const next: [string, Placement][] = [];
      for (const f of files) {
        if (out.has(f.id)) continue;
        const up = majority(callers.get(f.id));
        const down = up ? null : majority(callees.get(f.id));
        const m = up ?? down;
        if (!m) continue;
        const [layer, n, of] = m;
        const detail = `${n} of ${of} ${up ? 'callers' : 'files it uses'} ${n === 1 ? 'is' : 'are'} ${names.get(layer) ?? layer}`;
        next.push([f.id, { id: layer, confidence: 0.4, source: 'graph', evidence: [{ source: 'graph', detail, weight: n / of }] }]);
      }
      if (!next.length) break;
      for (const [id, p] of next) out.set(id, p);
    }
    for (const f of files) if (!out.has(f.id)) out.set(f.id, UNPLACED);

    // 3. Symbols: their own facts, or their file's layer.
    const inheritedCache = new Map<Placement, Placement>();
    for (const s of nodes) {
      if (s.kind !== 'symbol') continue;
      const hits = s.facts?.length ? matchLayers(layers, s, s.facts, true) : [];
      if (hits.length) {
        out.set(s.id, placement(hits));
        continue;
      }
      const file = out.get(s.parent) ?? UNPLACED;
      const inherited = inheritedCache.get(file) ?? { ...file, evidence: file.evidence.map((e, i) => (i ? e : { ...e, detail: `its file: ${e.detail}` })) };
      inheritedCache.set(file, inherited);
      out.set(s.id, inherited);
    }
    return out;
  },
};

