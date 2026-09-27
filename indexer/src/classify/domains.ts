// Default domain strategy: "feature tokens". (The design's seed-and-propagate
// strategy is the planned replacement; it plugs in here the same way.)
//
// Feature names tend to repeat across layers and repositories:
// web/components/Items/AddItem.tsx, api/routes/items.py and api/crud.py's
// create_item all mention "item". We split every path and symbol name into
// words, drop words that describe structure rather than features (src, lib,
// routes, utils, get, create…), and treat a word that recurs in several files,
// but not in most of them, as a domain.

import { UNSORTED_DOMAIN, type GraphNode, type Placement } from '@strata/shared';
import type { Assignments, DomainStrategy } from './types.ts';

export const GENERIC = new Set(
  (
    'src app apps lib libs pkg packages internal cmd component components page pages route routes router routers api apis ' +
    'service services util utils helper helpers common shared core model models db database type types index main mod ' +
    'client clients server backend frontend web ui view views controller controllers handler handlers config configs setting ' +
    'constant constants hook hooks store stores context contexts provider providers layout layouts style styles asset assets ' +
    'public static test tests spec mock mocks fixture fixtures schema schemas crud dto dtos entity entities repository ' +
    'repositories migration migrations alembic version versions script scripts job jobs task tasks worker workers ' +
    'module modules base default init setup env dev prod local global generated gen sdk core ' +
    'get set add create update delete remove list read write fetch load save show edit new use make build handle ' +
    'form modal dialog button table card item_list data info detail details input output request response result error ' +
    'root node tree link links nav navbar sidebar header footer menu icon icons logo theme toast loading pending ' +
    'action column row cell serializer param option prop value ' +
    'the and for with from into all one'
  ).split(' '),
);

/** "AddItem" / "add_item" / "add-item" → ["add", "item"] */
export function words(s: string): string[] {
  return s
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => singular(w.toLowerCase()))
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
}

function singular(w: string): string {
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is|ics)$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

const MAX_DOMAINS = 16;

const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const UNSORTED: Placement = {
  id: UNSORTED_DOMAIN,
  confidence: 0,
  source: 'fallback',
  evidence: [{ source: 'fallback', detail: 'no recurring feature name in its path', weight: 0 }],
};

export function featureTokens(): DomainStrategy {
  return {
    name: 'feature-tokens',
    assign({ nodes }) {
      const repoNames = new Map<string, string>();
      for (const n of nodes) if (n.kind === 'repo') repoNames.set(n.id, n.name.toLowerCase());
      const files = nodes.filter((n) => n.kind === 'file');

      const pathTokens = (f: GraphNode) => {
        const segs = (f.path ?? '').split('/');
        const stem = segs.pop()!;
        // Most specific first: the file name, then directories from deepest up.
        const out = [...words(stem).reverse()];
        for (let i = segs.length - 1; i >= 0; i--) out.push(...words(segs[i]).reverse());
        const repo = repoNames.get(f.repo) ?? f.repo.toLowerCase();
        return out.filter((w) => !GENERIC.has(w) && !repo.includes(w));
      };

      // Only paths vote: symbol names are full of UI-kit words (Trigger, Separator…) that aren't features.
      const df = new Map<string, number>();
      const tokens = new Map<string, string[]>();
      for (const f of files) {
        const t = pathTokens(f);
        tokens.set(f.id, t);
        for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
      }
      // Recurs in several files but isn't everywhere (then it's structure, not a feature).
      // Keep the most common few: a map with a hundred domains isn't a map.
      const max = Math.max(4, files.length * 0.3);
      const ranked = [...df]
        .filter(([, n]) => n >= 2 && n <= max)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_DOMAINS)
        .map(([w]) => w);
      const features = new Set(ranked);

      const out: Assignments = new Map();
      for (const f of files) {
        const hit = tokens.get(f.id)!.find((w) => features.has(w));
        out.set(f.id, hit ? { id: hit, confidence: 0.6, source: 'seed', evidence: [{ source: 'seed', detail: `"${hit}" recurs across file paths`, weight: df.get(hit)! }] } : UNSORTED);
      }
      for (const s of nodes) {
        if (s.kind !== 'symbol') continue;
        const file = out.get(s.parent) ?? UNSORTED;
        const hit = words(s.name).reverse().find((w) => features.has(w) && !GENERIC.has(w));
        out.set(
          s.id,
          hit && hit !== file.id ? { id: hit, confidence: 0.55, source: 'seed', evidence: [{ source: 'seed', detail: `name mentions "${hit}"`, weight: df.get(hit)! }] } : file,
        );
      }
      return { domains: ranked.map((w) => ({ id: w, name: title(w) })), assignments: out };
    },
  };
}
