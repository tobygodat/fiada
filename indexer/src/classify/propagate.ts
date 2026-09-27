// Domain strategy "seed-and-propagate", from the classification design
// (/mnt/project-files/design/classification/DESIGN.md):
//
//   1. Seeds. A few kinds of code name their feature outright: the routes a
//      handler serves (/items/{id}), ORM entities (class Item), framework page
//      routes, and files inside a structural folder (routes/items.py,
//      components/Items/AddItem.tsx). A seed name only becomes a domain if
//      seeds for it turn up in at least two files.
//   2. Propagation. Seeds hold still while everything else takes a decaying
//      share of its neighbours' domains along calls, HTTP requests, renders,
//      type uses and imports. Only neighbours that have made up their mind
//      pass anything on, so a UI kit used by every feature doesn't leak one
//      feature into the next. A clear winner (1.5× the runner-up) takes the
//      symbol; a close split goes to Shared, and so does code that three or
//      more features use directly.
//   3. File cohesion. Code with no path to any seed joins the majority of
//      its file. Whatever is left is Unsorted.
//
// The user's domain pins act as seeds too, so moving one symbol pulls its
// unclaimed neighbours along on the next run.

import { SHARED_DOMAIN, UNSORTED_DOMAIN, type EdgeKind, type GraphNode, type Placement } from '@fiada/shared';
import { GENERIC, words } from './domains.ts';
import type { Assignments, DomainStrategy } from './types.ts';

export interface PropagateOptions {
  maxDomains?: number;
  iterations?: number;
  decay?: number;
  /** A winner needs this multiple of the runner-up's score, or the node goes to Shared. */
  margin?: number;
  /** Code used directly by this many different domains is Shared. */
  sharedBreadth?: number;
  /** Each node passes on its score divided by degree^hubPenalty, so heavily used code doesn't flood its neighbours. */
  hubPenalty?: number;
  weights?: Partial<Record<EdgeKind, number>>;
}

const WEIGHTS: Record<EdgeKind, number> = { calls: 1, http: 1, renders: 0.9, imports: 0.8, references: 0.7, type: 0.6 };

/** Folders whose children are named after what they do, not how they're built. */
const STRUCTURAL = /^(routes?|routers?|controllers?|handlers?|endpoints?|api|apis|pages|views|screens|features?|modules?|domains?|components?|services?|types|schemas?|models?|entities|stores?|hooks|queries|jobs|workers|tasks)$/i;
const TECH = new Set('fastapi flask django express next react vue svelte angular prisma sqlalchemy sqlmodel celery graphql rest http json yaml auth0 v1 v2 v3 openapi swagger'.split(' '));

interface Seed {
  id: string;
  surface: string;
  why: string;
  /** Seeds from routes and entities are specific to one symbol; folder seeds cover a whole file. */
  file: string;
}

const humanize = (s: string) => {
  const t = s
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function seedAndPropagate(opts: PropagateOptions = {}): DomainStrategy {
  const maxDomains = opts.maxDomains ?? 12;
  const iterations = opts.iterations ?? 4;
  const decay = opts.decay ?? 0.5;
  const margin = opts.margin ?? 1.5;
  const sharedBreadth = opts.sharedBreadth ?? 3;
  const hubPenalty = opts.hubPenalty ?? 1;
  const weights = { ...WEIGHTS, ...opts.weights };

  return {
    name: 'seed-and-propagate',
    assign({ nodes, edges, grouping }) {
      const repoWords = new Map<string, Set<string>>();
      for (const n of nodes) if (n.kind === 'repo') repoWords.set(n.id, new Set([...words(n.name), ...words(n.id)]));
      const files = nodes.filter((n) => n.kind === 'file');
      const symbols = nodes.filter((n) => n.kind === 'symbol');
      const symbolsOf = new Map<string, GraphNode[]>();
      for (const s of symbols) (symbolsOf.get(s.parent) ?? symbolsOf.set(s.parent, []).get(s.parent)!).push(s);

      /** A seed id from free text: its feature words, or null when it only names structure. */
      const seedId = (text: string, repo: string) => {
        const skip = repoWords.get(repo);
        const ws = words(text).filter((w) => !GENERIC.has(w) && !TECH.has(w) && !skip?.has(w));
        return ws.length ? ws.join('-') : null;
      };
      /** First path segment that names something: "/api/v1/items/{id}" → "items". */
      const routeSeg = (route: string, repo: string) => {
        const p = route.includes(' ') ? route.slice(route.indexOf(' ') + 1) : route;
        for (const seg of p.split('/')) {
          if (!seg || /^[{[:<*]/.test(seg)) continue;
          const id = seedId(seg, repo);
          if (id) return { id, surface: seg };
        }
        return null;
      };

      // ── 1. seeds ───────────────────────────────────────────────────────
      const seeds = new Map<string, Seed>();
      for (const f of files) {
        const facts = f.facts ?? [];
        const path = f.path ?? '';
        let fileSeed: Omit<Seed, 'file'> | null = null;

        const page = facts.find((x) => x.type === 'pageRoute');
        const pageSeg = page && routeSeg(page.value, f.repo);
        if (pageSeg) fileSeed = { ...pageSeg, why: `page route ${page!.value}` };

        // Deepest structural folder, then the first part below it that names a feature.
        if (!fileSeed) {
          const parts = path.split('/');
          let s = -1;
          for (let i = parts.length - 2; i >= 0; i--) {
            if (STRUCTURAL.test(parts[i])) {
              s = i;
              break;
            }
          }
          if (s >= 0) {
            for (const part of parts.slice(s + 1)) {
              const id = seedId(part, f.repo);
              if (id) {
                fileSeed = { id, surface: part.replace(/\.[^.]+$/, ''), why: `${parts.slice(0, s + 1).join('/')}/ module ${part.replace(/\.[^.]+$/, '')}` };
                break;
              }
            }
          }
        }
        if (fileSeed) seeds.set(f.id, { ...fileSeed, file: f.id });

        for (const sym of symbolsOf.get(f.id) ?? []) {
          const sf = sym.facts ?? [];
          const route = sf.find((x) => x.type === 'route');
          const seg = route && routeSeg(route.value, f.repo);
          const table = sf.find((x) => x.type === 'table');
          const entity = table && seedId(table.value, f.repo);
          if (seg) seeds.set(sym.id, { ...seg, why: `serves ${route!.value}`, file: f.id });
          else if (entity) seeds.set(sym.id, { id: entity, surface: table!.value, why: `ORM entity ${table!.value}`, file: f.id });
          else if (fileSeed) seeds.set(sym.id, { ...fileSeed, file: f.id });
        }
      }

      // A domain needs seeds in two or more files: one file naming itself isn't a feature yet.
      const filesPer = new Map<string, Set<string>>();
      const surfaces = new Map<string, Map<string, number>>();
      for (const s of seeds.values()) {
        (filesPer.get(s.id) ?? filesPer.set(s.id, new Set()).get(s.id)!).add(s.file);
        const m = surfaces.get(s.id) ?? surfaces.set(s.id, new Map()).get(s.id)!;
        m.set(s.surface, (m.get(s.surface) ?? 0) + 1);
      }
      const size = (id: string) => [...seeds.values()].filter((s) => s.id === id).length;
      const kept = [...filesPer]
        .filter(([, fs]) => fs.size >= 2)
        .map(([id]) => [id, size(id)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxDomains)
        .map(([id]) => id);
      const keep = new Set(kept);

      // Pins are clamped seeds; a file pin covers its symbols.
      const fixed = new Map<string, { id: string; why: string }>();
      for (const [id, s] of seeds) if (keep.has(s.id)) fixed.set(id, { id: s.id, why: s.why });
      for (const n of [...files, ...symbols]) {
        const pin = grouping.pins[n.id]?.domain ?? (n.kind === 'symbol' ? grouping.pins[n.parent]?.domain : undefined);
        if (pin) fixed.set(n.id, { id: pin, why: 'you placed it here' });
      }

      // ── 2. propagation ─────────────────────────────────────────────────
      const known = new Set([...files, ...symbols].map((n) => n.id));
      const adj = new Map<string, [string, number][]>();
      const usedBy = new Map<string, Set<string>>();
      const link = (a: string, b: string, w: number) => (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]);
      for (const e of edges) {
        if (!known.has(e.from) || !known.has(e.to)) continue;
        const w = weights[e.kind] ?? 0.5;
        link(e.from, e.to, w);
        link(e.to, e.from, w);
        (usedBy.get(e.to) ?? usedBy.set(e.to, new Set()).get(e.to)!).add(e.from);
      }
      const ranked = (m: Map<string, number> | undefined) => [...(m ?? [])].sort((a, b) => b[1] - a[1]);
      const decided = (m: Map<string, number> | undefined) => {
        const r = ranked(m);
        return r.length > 0 && (r.length === 1 || r[0][1] >= margin * r[1][1]);
      };
      let score = new Map<string, Map<string, number>>();
      for (const [id, s] of fixed) score.set(id, new Map([[s.id, 1]]));
      for (let it = 0; it < iterations; it++) {
        const next = new Map<string, Map<string, number>>();
        for (const id of known) {
          if (fixed.has(id)) {
            next.set(id, score.get(id)!);
            continue;
          }
          const acc = new Map<string, number>();
          for (const [nb, w] of adj.get(id) ?? []) {
            const m = score.get(nb);
            if (!decided(m)) continue;
            const k = (decay * w) / Math.pow(adj.get(nb)!.length, hubPenalty);
            for (const [d, v] of m!) acc.set(d, (acc.get(d) ?? 0) + k * v);
          }
          if (acc.size) next.set(id, acc);
        }
        score = next;
      }

      // Named after the seed words, plural when the code says so ("Users" from routes/users.py and class User).
      const names = new Map<string, string>();
      for (const id of kept) {
        const last = id.split('-').pop()!;
        const plural = [...(surfaces.get(id)?.keys() ?? [])].some((s) => new RegExp(`${last.replace(/y$/, '(y|ie)')}s\\b`, 'i').test(s.replace(/([a-z])([A-Z])/g, '$1 $2')));
        const name = humanize(id);
        names.set(id, plural ? name.replace(/y$/, 'ie') + 's' : name);
      }
      const nameOf = (id: string) => names.get(id) ?? humanize(id);

      const out: Assignments = new Map();
      for (const id of known) {
        const f = fixed.get(id);
        if (f) {
          out.set(id, { id: f.id, confidence: 0.8, source: f.why === 'you placed it here' ? 'user-pin' : 'seed', evidence: [{ source: 'seed', detail: f.why, weight: 1 }] });
          continue;
        }
        const r = ranked(score.get(id));
        if (!r.length) continue;
        const [[d1, v1], second] = [r[0], r[1]];
        const v2 = second?.[1] ?? 0;
        // Used directly by several features: shared infrastructure, not any one of them.
        const users = new Set<string>();
        for (const u of usedBy.get(id) ?? []) {
          const m = score.get(u);
          if (decided(m)) users.add(ranked(m)[0][0]);
        }
        if (users.size >= sharedBreadth) {
          const list = [...users].map(nameOf);
          out.set(id, {
            id: SHARED_DOMAIN,
            confidence: 0.6,
            source: 'propagated',
            evidence: [{ source: 'propagated', detail: `used directly by ${list.slice(0, -1).join(', ')} and ${list.at(-1)}`, weight: users.size }],
          });
        } else if (v2 && v1 / v2 < margin) {
          out.set(id, {
            id: SHARED_DOMAIN,
            confidence: 0.5,
            source: 'propagated',
            evidence: [{ source: 'propagated', detail: `used by ${nameOf(d1)} (${v1.toFixed(2)}) and ${nameOf(second[0])} (${v2.toFixed(2)}) about equally`, weight: v1 }],
          });
        } else {
          out.set(id, {
            id: d1,
            confidence: Math.min(0.75, 0.4 + v1 / 4),
            source: 'propagated',
            evidence: [{ source: 'propagated', detail: `connected to ${nameOf(d1)} code (${v1.toFixed(2)}${v2 ? ` vs ${nameOf(second[0])} ${v2.toFixed(2)}` : ''})`, weight: v1 }],
          });
        }
      }

      // ── 3. file cohesion, then Unsorted ────────────────────────────────
      const majority = (ids: string[]) => {
        const tally = new Map<string, number>();
        for (const id of ids) {
          const d = out.get(id)?.id;
          if (d && d !== SHARED_DOMAIN) tally.set(d, (tally.get(d) ?? 0) + 1);
        }
        return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
      };
      const cohesion = (id: string, d: string, what: string): Placement => ({
        id: d,
        confidence: 0.4,
        source: 'cohesion',
        evidence: [{ source: 'cohesion', detail: `most of ${what} is ${nameOf(d)}`, weight: 1 }],
      });
      for (const f of files) {
        if (out.has(f.id)) continue;
        const d = majority((symbolsOf.get(f.id) ?? []).map((s) => s.id));
        if (d) out.set(f.id, cohesion(f.id, d, 'the code in it'));
      }
      for (const s of symbols) {
        if (out.has(s.id)) continue;
        const d = majority([s.parent, ...(symbolsOf.get(s.parent) ?? []).map((x) => x.id)]);
        if (d) out.set(s.id, cohesion(s.id, d, 'its file'));
      }
      const unsorted: Placement = {
        id: UNSORTED_DOMAIN,
        confidence: 0,
        source: 'fallback',
        evidence: [{ source: 'fallback', detail: 'no path to any seeded feature', weight: 0 }],
      };
      for (const id of known) if (!out.has(id)) out.set(id, unsorted);

      return { domains: kept.map((id) => ({ id, name: names.get(id)! })), assignments: out };
    },
  };
}
