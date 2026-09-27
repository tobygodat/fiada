// Turns per-file facts into edges: resolves imports (relative, tsconfig
// paths, workspace packages, Python packages, across every indexed repo),
// binds each identifier a symbol uses to the symbol it names, and matches
// client HTTP requests to the server routes that serve them.

import path from 'node:path';
import type { EdgeKind, GraphEdge } from '@strata/shared';
import type { ImportSpec, ParsedFile, ParsedRepo, Ref, RefKind } from './model.ts';

const posix = path.posix;

export const fileId = (repo: string, p: string) => `${repo}/${p}`;

/** Stable symbol ids for a file, aligned with file.symbols. Duplicate names get a ~n suffix. */
export function symbolIds(fid: string, file: ParsedFile): string[] {
  const seen = new Map<string, number>();
  return file.symbols.map((s) => {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return `${fid}#${s.name}${n > 1 ? `~${n}` : ''}`;
  });
}

interface FileEntry {
  id: string;
  repo: ParsedRepo;
  file: ParsedFile;
  symbols: Map<string, string>; // name → symbol id (first declaration wins)
  defaultSymbol?: string;
  bindings: Map<string, { spec: ImportSpec; imported: string }>;
}

export interface RouteEntry {
  method: string;
  path: string;
  node: string;
  segs: string[];
}

export interface LinkResult {
  edges: GraphEdge[];
  routes: RouteEntry[];
  /** Per file: top-level names of imported packages that aren't in any indexed repo. */
  externalImports: Map<string, string[]>;
}

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const KIND_OF: Record<RefKind, EdgeKind> = { call: 'calls', new: 'calls', jsx: 'renders', type: 'type', ref: 'references' };
const RANK: Record<EdgeKind, number> = { http: 6, calls: 5, renders: 4, type: 3, references: 2, imports: 1 };

export function link(repos: ParsedRepo[]): LinkResult {
  const files = new Map<string, FileEntry>();
  for (const repo of repos) {
    for (const file of repo.files) {
      const id = fileId(repo.info.id, file.path);
      const ids = symbolIds(id, file);
      const symbols = new Map<string, string>();
      let defaultSymbol: string | undefined;
      file.symbols.forEach((s, i) => {
        if (!symbols.has(s.name)) symbols.set(s.name, ids[i]);
        if (s.isDefault) defaultSymbol = ids[i];
      });
      if (!defaultSymbol && file.defaultExport) defaultSymbol = symbols.get(file.defaultExport);
      const bindings = new Map<string, { spec: ImportSpec; imported: string }>();
      for (const spec of file.imports) for (const b of spec.names) bindings.set(b.local, { spec, imported: b.imported });
      files.set(id, { id, repo, file, symbols, defaultSymbol, bindings });
    }
  }

  // ── module resolution ────────────────────────────────────────────────
  const exists = (repo: ParsedRepo, p: string) => {
    const id = fileId(repo.info.id, posix.normalize(p).replace(/^\.\//, ''));
    return files.has(id) ? id : null;
  };
  const tryTs = (repo: ParsedRepo, p: string): string | null => {
    const hit = exists(repo, p);
    if (hit) return hit;
    const stem = p.replace(/\.(m|c)?jsx?$/, '');
    for (const ext of TS_EXTS) {
      const f = exists(repo, stem + ext) ?? exists(repo, `${p}/index${ext}`);
      if (f) return f;
    }
    return null;
  };
  const tryPy = (repo: ParsedRepo, p: string) => exists(repo, `${p}.py`) ?? exists(repo, `${p}/__init__.py`);

  const packagesByName = new Map<string, { repo: ParsedRepo; dir: string; main?: string }>();
  for (const repo of repos) for (const p of repo.packages) if (p.name) packagesByName.set(p.name, { repo, dir: p.dir, main: p.main });

  const resolveTs = (e: FileEntry, spec: string): string | null => {
    const repo = e.repo;
    const dir = posix.dirname(e.file.path);
    if (spec.startsWith('.')) return tryTs(repo, posix.join(dir, spec));
    // tsconfig "paths" and "baseUrl", from the nearest config above this file.
    const cfgs = repo.tsconfigs
      .filter((c) => c.dir === '' || dir === c.dir || dir.startsWith(c.dir + '/'))
      .sort((a, b) => b.dir.length - a.dir.length);
    for (const cfg of cfgs) {
      const base = posix.join(cfg.dir, cfg.baseUrl ?? '.');
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.endsWith('*');
        const prefix = star ? pattern.slice(0, -1) : pattern;
        if (star ? !spec.startsWith(prefix) : spec !== pattern) continue;
        const rest = star ? spec.slice(prefix.length) : '';
        for (const t of targets) {
          const hit = tryTs(repo, posix.join(base, t.replace('*', rest)));
          if (hit) return hit;
        }
      }
      if (cfg.baseUrl) {
        const hit = tryTs(repo, posix.join(base, spec));
        if (hit) return hit;
      }
    }
    // Workspace packages, in this repo or any other indexed one.
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkg = packagesByName.get(name);
    if (pkg) {
      const sub = spec.slice(name.length + 1);
      if (sub) return tryTs(pkg.repo, posix.join(pkg.dir, sub)) ?? tryTs(pkg.repo, posix.join(pkg.dir, 'src', sub));
      return (
        (pkg.main ? tryTs(pkg.repo, posix.join(pkg.dir, pkg.main)) : null) ??
        tryTs(pkg.repo, posix.join(pkg.dir, 'src/index')) ??
        tryTs(pkg.repo, posix.join(pkg.dir, 'index'))
      );
    }
    return null;
  };

  const resolvePy = (e: FileEntry, source: string, level: number): string | null => {
    const parts = source ? source.split('.') : [];
    if (level > 0) {
      let base = posix.dirname(e.file.path);
      for (let i = 1; i < level; i++) base = posix.dirname(base);
      if (base === '.') base = '';
      return parts.length ? tryPy(e.repo, posix.join(base, ...parts)) : exists(e.repo, posix.join(base, '__init__.py'));
    }
    if (!parts.length) return null;
    const ordered = [e.repo, ...repos.filter((r) => r !== e.repo)];
    for (const repo of ordered) {
      for (const root of repo.pyRoots) {
        const hit = tryPy(repo, posix.join(root || '.', ...parts));
        if (hit) return hit;
      }
    }
    return null;
  };

  const moduleCache = new Map<string, string | null>();
  const resolveModule = (e: FileEntry, spec: ImportSpec): string | null => {
    const key = `${e.id}|${spec.level}|${spec.source}`;
    if (moduleCache.has(key)) return moduleCache.get(key)!;
    const hit = e.file.lang === 'python' ? resolvePy(e, spec.source, spec.level) : resolveTs(e, spec.source);
    moduleCache.set(key, hit);
    return hit;
  };

  /** Find what `name` means inside module `fid`, following re-exports and barrels. */
  const resolveName = (fid: string, name: string, depth = 0): string | null => {
    const e = files.get(fid);
    if (!e || depth > 6) return null;
    if (name === 'default') return e.defaultSymbol ?? null;
    const own = e.symbols.get(name);
    if (own) return own;
    const b = e.bindings.get(name);
    if (b) {
      const mod = resolveModule(e, b.spec);
      if (mod) {
        if (b.imported === '*') return mod;
        const hit = resolveName(mod, b.imported, depth + 1) ?? submodule(e, b.spec, b.imported);
        if (hit) return hit;
      }
    }
    for (const spec of e.file.imports) {
      if (!spec.reexportAll) continue;
      const mod = resolveModule(e, spec);
      const hit = mod && resolveName(mod, name, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  /** Python `from pkg import mod` where mod is a module, not a name. */
  const submodule = (e: FileEntry, spec: ImportSpec, name: string): string | null =>
    e.file.lang === 'python' ? resolvePy(e, spec.source ? `${spec.source}.${name}` : name, spec.level) : null;

  const fileOf = (id: string) => id.split('#')[0];

  // ── symbol edges ─────────────────────────────────────────────────────
  const externalImports = new Map<string, string[]>();
  const edgeMap = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, kind: EdgeKind, detail?: string) => {
    if (from === to || fileOf(from) === to) return;
    const key = `${from}|${to}`;
    const prev = edgeMap.get(key);
    if (!prev || RANK[kind] > RANK[prev.kind]) edgeMap.set(key, detail ? { from, to, kind, detail } : { from, to, kind });
  };

  const resolveRef = (e: FileEntry, r: Ref, usedModules: Set<string>): string | null => {
    if (!r.member) {
      const local = e.symbols.get(r.name);
      if (local) return local;
    }
    const b = e.bindings.get(r.name);
    if (!b) return r.member ? (e.symbols.get(r.name) ?? null) : null;
    const mod = resolveModule(e, b.spec);
    if (!mod) return null;
    usedModules.add(mod);
    let target: string | null = b.imported === '*' ? mod : (resolveName(mod, b.imported) ?? submodule(e, b.spec, b.imported));
    if (target && !target.includes('#') && target !== mod) usedModules.add(target);
    if (r.member && target && !target.includes('#')) target = resolveName(target, r.member) ?? target;
    return target ?? mod;
  };

  for (const e of files.values()) {
    const ids = symbolIds(e.id, e.file);
    const usedModules = new Set<string>();
    const sources: [string, Ref[]][] = [[e.id, e.file.fileRefs], ...e.file.symbols.map((s, i) => [ids[i], s.refs] as [string, Ref[]])];
    for (const [from, refs] of sources) {
      for (const r of refs) {
        const to = resolveRef(e, r, usedModules);
        if (to) {
          usedModules.add(fileOf(to));
          addEdge(from, to, KIND_OF[r.kind]);
        }
      }
    }
    // Imports nothing visibly uses (side effects, re-exports, barrels) still connect the files.
    const external = new Set<string>();
    for (const spec of e.file.imports) {
      const mod = resolveModule(e, spec);
      if (!mod && spec.level === 0 && !spec.source.startsWith('.')) external.add(packageName(spec.source, e.file.lang === 'python'));
      if (mod && !usedModules.has(mod)) {
        const names = spec.names.map((n) => n.imported).filter((n) => n !== '*');
        addEdge(e.id, mod, 'imports', names.length ? names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '') : undefined);
      }
    }
    externalImports.set(e.id, [...external]);
  }

  // ── HTTP: client requests → server routes ────────────────────────────
  const routes: RouteEntry[] = [];
  const addRoute = (method: string, p: string, node: string) => routes.push({ method, path: p, node, segs: segments(p) });
  for (const e of files.values()) {
    const ids = symbolIds(e.id, e.file);
    for (const r of e.file.routes) addRoute(r.method, r.path, e.id);
    e.file.symbols.forEach((s, i) => s.routes?.forEach((r) => addRoute(r.method, r.path, ids[i])));
    // Next.js route handlers: app/**/route.ts exporting GET/POST/…
    const appRoute = e.file.path.match(/(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/);
    if (appRoute && e.file.lang !== 'python') {
      e.file.symbols.forEach((s, i) => {
        if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name)) addRoute(s.name, nextPath(appRoute[1]), ids[i]);
      });
    }
    // Next.js pages/api/**.
    const pagesApi = e.file.path.match(/(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/);
    if (pagesApi && e.defaultSymbol) addRoute('*', nextPath(pagesApi[1].replace(/\/index$/, '')), e.defaultSymbol);
  }

  for (const e of files.values()) {
    const ids = symbolIds(e.id, e.file);
    const reqs: [string, { method: string; path: string }][] = [
      ...e.file.requests.map((r) => [e.id, r] as [string, typeof r]),
      ...e.file.symbols.flatMap((s, i) => (s.requests ?? []).map((r) => [ids[i], r] as [string, typeof r])),
    ];
    for (const [from, req] of reqs) {
      const route = matchRoute(routes, req.method, segments(req.path));
      if (route) addEdge(from, route.node, 'http', `${req.method} ${route.path}`);
    }
  }

  return { edges: [...edgeMap.values()], routes, externalImports };
}

/** "@scope/pkg/sub" → "@scope/pkg", "lodash/fp" → "lodash", "sqlalchemy.orm" → "sqlalchemy". */
function packageName(source: string, python: boolean): string {
  if (python) return source.split('.')[0];
  const parts = source.replace(/^node:/, '').split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** "/api/v1/items/{id}" → ["api","v1","items","*"]. Every param style collapses to "*". */
export function segments(p: string): string[] {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(\{.*\}|:.+|\[.*\]|<.*>|\*)$/.test(s) ? '*' : s.toLowerCase()));
}

/**
 * A route matches when its segments are a suffix of the request's, because
 * servers usually mount routers under prefixes we can't see from one file
 * (e.g. FastAPI's include_router(prefix="/api/v1")). Longest match wins.
 */
export function matchRoute(routes: RouteEntry[], method: string, req: string[]): RouteEntry | null {
  if (!req.length) return null;
  let best: RouteEntry | null = null;
  let bestScore = -1;
  for (const r of routes) {
    if (r.method !== '*' && r.method !== method) continue;
    if (!r.segs.length || r.segs.length > req.length) continue;
    const off = req.length - r.segs.length;
    let literal = 0;
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const a = r.segs[i];
      const b = req[off + i];
      if (a === '*' || b === '*') continue;
      if (a !== b) {
        ok = false;
        break;
      }
      literal++;
    }
    if (!ok || literal === 0) continue;
    const score = r.segs.length * 10 + literal;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

function nextPath(dir: string): string {
  const segs = dir
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map((s) => s.replace(/^\[\[?\.{0,3}(.+?)\]?\]$/, '{$1}'));
  return '/' + segs.join('/');
}
