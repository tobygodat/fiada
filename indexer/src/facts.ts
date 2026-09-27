// Detectors: turn what the parser saw into language-neutral facts that a
// project's layer matchers are written against. This is the one place that
// knows about frameworks (which base classes are ORM tables, what a Next.js
// page is); classification only ever reads the facts.

import type { Fact } from '@strata/shared';
import { nextPath } from './link.ts';
import type { ParsedFile, ParsedRepo, ParsedSymbol } from './model.ts';
import { isTable } from './orm.ts';

export const UI_FRAMEWORKS = /^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|react-native|solid-js|preact)$/;
/** Data-shape base classes: request/response schemas, typed dicts, enums. */
const SCHEMA_BASES = /(^|\.)(BaseModel|SQLModel|TypedDict|Schema|Enum|IntEnum|StrEnum|Protocol|NamedTuple)$/;
const APP_PAGE = /(?:^|\/)app\/(?:(.*)\/)?(page|layout|template|loading|error|not-found|default)\.[cm]?[jt]sx?$/;
const PAGES_PAGE = /(?:^|\/)pages\/(?!api\/)(.+?)\.[cm]?[jt]sx?$/;

export interface FileFacts {
  file: Fact[];
  /** Aligned with file.symbols. */
  symbols: Fact[][];
}

export interface FactContext {
  repo: ParsedRepo;
  file: ParsedFile;
  /** Packages imported from outside the indexed repos. */
  externalImports: string[];
  /** Routes served by the file (index 0) and each symbol (index i + 1). */
  routes: (string[] | undefined)[];
  /** Client-side page routes rendered by the file (index 0) and each symbol (index i + 1). */
  pages?: (string[] | undefined)[];
  test: boolean;
}

/** UI framework the file's nearest package depends on, if any. */
function frontendOf(repo: ParsedRepo, file: ParsedFile): string | undefined {
  if (file.lang === 'python' || file.lang === 'go') return undefined;
  let best: { dir: string; fw: string } | undefined;
  for (const p of repo.packages) {
    if (p.dir !== '' && !file.path.startsWith(p.dir + '/')) continue;
    if (best && best.dir.length > p.dir.length) continue;
    const fw = p.deps.find((d) => d === 'next') ?? p.deps.find((d) => UI_FRAMEWORKS.test(d));
    best = { dir: p.dir, fw: fw ?? '' };
  }
  return best?.fw || undefined;
}

const isSchema = (s: ParsedSymbol) => (s.kind === 'class' || s.kind === 'enum') && !!s.bases?.some((b) => SCHEMA_BASES.test(b));

function symbolFacts(s: ParsedSymbol, routes: string[] | undefined, pages: string[] | undefined): Fact[] {
  const out: Fact[] = [];
  for (const r of routes ?? []) out.push({ type: 'route', value: r });
  for (const p of pages ?? []) out.push({ type: 'pageRoute', value: p });
  if (s.kind === 'component') out.push({ type: 'returnsJSX', value: 'true' });
  if (isTable(s)) out.push({ type: 'table', value: s.name });
  for (const b of s.bases ?? []) if (/^[\w.]+$/.test(b)) out.push({ type: 'extends', value: b });
  for (const d of s.decorators ?? []) out.push({ type: 'decorator', value: d });
  for (const r of s.requests ?? []) out.push({ type: 'request', value: `${r.method} ${r.path}` });
  return out;
}

export function detectFacts({ repo, file, externalImports, routes, pages = [], test }: FactContext): FileFacts {
  const symbols = file.symbols.map((s, i) => symbolFacts(s, routes[i + 1], pages[i + 1]));
  const out: Fact[] = [];
  const add = (type: Fact['type'], value: string) => {
    if (!out.some((f) => f.type === type && f.value === value)) out.push({ type, value });
  };

  for (const m of externalImports) add('import', m);
  const fw = frontendOf(repo, file);
  if (fw) add('frontend', fw);
  if (test) add('test', 'true');

  // Everything a symbol serves, renders, maps or requests, the file does too.
  for (const r of routes[0] ?? []) add('route', r);
  for (const p of pages[0] ?? []) add('pageRoute', p);
  for (const f of symbols.flat()) if (f.type === 'route' || f.type === 'table' || f.type === 'request' || f.type === 'pageRoute') add(f.type, f.value);
  for (const r of file.requests) add('request', `${r.method} ${r.path}`);
  if (file.jsx || file.symbols.some((s) => s.kind === 'component')) add('returnsJSX', 'true');

  if (fw === 'next') {
    const app = file.path.match(APP_PAGE);
    const pages = !app && /(^|\/)pages\//.test(file.path) ? file.path.match(PAGES_PAGE) : null;
    if (app) add('pageRoute', nextPath(app[1] ?? ''));
    else if (pages && !/(^|\/)_(app|document|error)$/.test(pages[1])) add('pageRoute', nextPath(pages[1].replace(/(^|\/)index$/, '')));
  }

  // A file of nothing but types, interfaces, enums or schema classes is a contract.
  const syms = file.symbols;
  if (syms.length && syms.every((s) => s.kind === 'interface' || s.kind === 'type' || s.kind === 'enum' || (isSchema(s) && !isTable(s)))) {
    add('typeOnly', 'true');
  }
  return { file: out, symbols };
}
