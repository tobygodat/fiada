// Default domain classifier: "feature tokens".
//
// Feature names tend to repeat across layers and repositories:
// web/components/Items/AddItem.tsx, api/routes/items.py and api/crud.py's
// create_item all mention "item". We split every path and symbol name into
// words, drop words that describe structure rather than features (src, lib,
// routes, utils, get, create…), and treat a word that recurs in several files,
// but not in most of them, as a domain.

import type { DomainClassifier, FileContext, Vote } from './types.ts';

const GENERIC = new Set(
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

export function featureTokens(): DomainClassifier {
  let features = new Set<string>();

  const pathTokens = (ctx: FileContext) => {
    const segs = ctx.file.path.split('/');
    const stem = segs.pop()!;
    // Most specific first: the file name, then directories from deepest up.
    const out = [...words(stem).reverse()];
    for (let i = segs.length - 1; i >= 0; i--) out.push(...words(segs[i]).reverse());
    return out.filter((w) => !GENERIC.has(w) && !ctx.repo.info.name.toLowerCase().includes(w));
  };

  return {
    name: 'feature-tokens',
    prepare(all) {
      const df = new Map<string, number>();
      for (const ctx of all) {
        // Only paths vote: symbol names are full of UI-kit words (Trigger, Separator…) that aren't features.
        for (const w of new Set(pathTokens(ctx))) df.set(w, (df.get(w) ?? 0) + 1);
      }
      // Recurs in several files but isn't everywhere (then it's structure, not a feature).
      // Keep the most common few: a map with a hundred domains isn't a map.
      const max = Math.max(4, all.length * 0.3);
      features = new Set(
        [...df]
          .filter(([, n]) => n >= 2 && n <= max)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_DOMAINS)
          .map(([w]) => w),
      );
    },
    classifyFile(ctx): Vote | null {
      const hit = pathTokens(ctx).find((w) => features.has(w));
      return hit ? { value: title(hit), confidence: 0.6, reason: `"${hit}" recurs across files` } : null;
    },
    classifySymbol(sym, file): Vote | null {
      const hit = words(sym.name).reverse().find((w) => features.has(w) && !GENERIC.has(w));
      if (!hit || title(hit) === file.value) return null;
      return { value: title(hit), confidence: 0.55, reason: `name mentions "${hit}"` };
    },
  };
}
