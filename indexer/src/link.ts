// Turns per-file facts into edges: resolves imports (relative, tsconfig
// paths, workspace packages, Python packages, Go modules, across every
// indexed repo), binds each identifier a symbol uses to the symbol it names,
// works out the full path of every server route by following router mounts,
// and matches client HTTP requests to the routes that serve them.
//
// Every edge carries its evidence: the lines of code that establish it, and
// whether the link is proven by those lines or guessed by a heuristic.

import path from 'node:path';
import type { EdgeBasis, EdgeEvidence, EdgeEvidenceSource, EdgeKind, GraphEdge } from '@strata/shared';
import type { ImportSpec, MountDecl, ParsedFile, ParsedRepo, Ref, RefKind, RouteDecl, UrlPart } from './model.ts';
import { isTable, tableNames } from './orm.ts';

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
  /** Symbol ids aligned with file.symbols. */
  ids: string[];
  symbols: Map<string, string>; // name → symbol id (first declaration wins)
  defaultSymbol?: string;
  bindings: Map<string, { spec: ImportSpec; imported: string }>;
  /** Go: the package this file belongs to (its folder's node id). */
  pkg?: string;
}

interface GoPackage {
  name?: string;
  files: FileEntry[];
  symbols: Map<string, string>;
}

export interface RouteEntry {
  method: string;
  /** As declared, including the router's own prefix. */
  path: string;
  /** With every mount above it applied, when they lead to an application root. */
  fullPath?: string;
  /** What serves it: the named handler, else the enclosing symbol, else the file. */
  node: string;
  /** File that declares it. */
  file: string;
  segs: string[];
  /** The declaration, the router's prefix and the mounts above it. */
  evidence: EdgeEvidence[];
}

export interface PageEntry {
  path: string;
  /** The component rendered for it, or the declaring file. */
  node: string;
}

export interface LinkResult {
  edges: GraphEdge[];
  routes: RouteEntry[];
  pages: PageEntry[];
  /** Per file: module specifiers it imports that don't resolve to any indexed repo, e.g. "sqlalchemy.orm", "next/server". */
  externalImports: Map<string, string[]>;
}

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const KIND_OF: Record<RefKind, EdgeKind> = { call: 'calls', new: 'calls', jsx: 'renders', type: 'type', ref: 'references' };
const SOURCE_OF: Record<RefKind, EdgeEvidenceSource> = { call: 'call', new: 'call', jsx: 'jsx', type: 'type-ref', ref: 'reference' };
const VERB_OF: Record<RefKind, string> = { call: 'calls', new: 'creates', jsx: 'renders', type: 'uses type', ref: 'uses' };
const RANK: Record<EdgeKind, number> = { http: 6, calls: 5, renders: 4, type: 3, references: 2, imports: 1 };
const MAX_EVIDENCE = 6;
/** Distinct mount chains kept per router; a router mounted in more places than this is shared plumbing. */
const MAX_PREFIXES = 8;
/** Folders that hold server-side code. */
const SERVER_PATH = /(^|\/)(server|backend)\//;

/** How one piece of code supports an edge. */
interface Support {
  basis: EdgeBasis;
  confidence: number;
  reason: string;
  evidence: EdgeEvidence[];
}

interface Resolved {
  to: string;
  /** Import statement the name came through. */
  spec?: ImportSpec;
  how: 'local' | 'package' | 'import';
  /** Set when a heuristic was involved. */
  guess?: string;
  /** Set when the imported name wasn't found and the edge points at the module. */
  unresolved?: string;
  /** Modules this use touched, so their imports don't also become bare `imports` edges. */
  modules: string[];
}

export function link(repos: ParsedRepo[]): LinkResult {
  const files = new Map<string, FileEntry>();
  const goPkgs = new Map<string, GoPackage>();
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
      const entry: FileEntry = { id, repo, file, ids, symbols, defaultSymbol, bindings };
      if (file.lang === 'go') {
        const dir = posix.dirname(file.path);
        entry.pkg = dir === '.' ? repo.info.id : `${repo.info.id}/${dir}`;
        let pkg = goPkgs.get(entry.pkg);
        if (!pkg) goPkgs.set(entry.pkg, (pkg = { name: file.goPackage, files: [], symbols: new Map() }));
        pkg.files.push(entry);
        for (const [name, sid] of symbols) if (!pkg.symbols.has(name)) pkg.symbols.set(name, sid);
      }
      files.set(id, entry);
    }
  }

  const ev = (e: FileEntry, source: EdgeEvidenceSource, line: number, note?: string): EdgeEvidence => {
    const out: EdgeEvidence = { source, file: e.id, line };
    const code = e.file.code[line];
    if (code) out.code = code;
    if (note) out.note = note;
    return out;
  };

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

  /** Python modules; an absolute import found only in another repository is a guess. */
  const resolvePy = (e: FileEntry, source: string, level: number): { id: string; guess?: string } | null => {
    const parts = source ? source.split('.') : [];
    if (level > 0) {
      let base = posix.dirname(e.file.path);
      for (let i = 1; i < level; i++) base = posix.dirname(base);
      if (base === '.') base = '';
      const id = parts.length ? tryPy(e.repo, posix.join(base, ...parts)) : exists(e.repo, posix.join(base, '__init__.py'));
      return id ? { id } : null;
    }
    if (!parts.length) return null;
    const ordered = [e.repo, ...repos.filter((r) => r !== e.repo)];
    for (const repo of ordered) {
      for (const root of repo.pyRoots) {
        const id = tryPy(repo, posix.join(root || '.', ...parts));
        if (id) return repo === e.repo ? { id } : { id, guess: `module ${source} isn't in this repository; found by path in ${repo.info.name}` };
      }
    }
    return null;
  };

  /** Go import paths, through the go.mod module path of any indexed repo. */
  const goModules = repos.flatMap((r) => (r.goModules ?? []).map((m) => ({ repo: r, ...m })));
  const resolveGo = (e: FileEntry, source: string): string | null => {
    const mods = goModules
      .filter((m) => source === m.module || source.startsWith(m.module + '/'))
      .sort((a, b) => b.module.length - a.module.length || (a.repo === e.repo ? -1 : b.repo === e.repo ? 1 : 0));
    for (const m of mods) {
      const dir = posix.join(m.dir || '.', source.slice(m.module.length + 1) || '.');
      const key = dir === '.' ? m.repo.info.id : `${m.repo.info.id}/${dir}`;
      if (goPkgs.has(key)) return key;
    }
    return null;
  };

  const moduleCache = new Map<string, { id: string; guess?: string } | null>();
  const resolveModuleInfo = (e: FileEntry, spec: ImportSpec): { id: string; guess?: string } | null => {
    const key = `${e.id}|${spec.level}|${spec.source}`;
    if (moduleCache.has(key)) return moduleCache.get(key)!;
    let hit: { id: string; guess?: string } | null = null;
    if (e.file.lang === 'python') hit = resolvePy(e, spec.source, spec.level);
    else if (e.file.lang === 'go') {
      const id = resolveGo(e, spec.source);
      hit = id ? { id } : null;
    } else {
      const id = resolveTs(e, spec.source);
      hit = id ? { id } : null;
    }
    moduleCache.set(key, hit);
    return hit;
  };
  const resolveModule = (e: FileEntry, spec: ImportSpec) => resolveModuleInfo(e, spec)?.id ?? null;

  // A Go package's declared name can differ from its import path's last segment.
  for (const e of files.values()) {
    if (e.file.lang !== 'go') continue;
    for (const spec of e.file.imports) {
      const pkg = spec.names.length ? goPkgs.get(resolveModule(e, spec) ?? '') : undefined;
      if (pkg?.name && !e.bindings.has(pkg.name)) e.bindings.set(pkg.name, { spec, imported: '*' });
    }
  }

  /** Find what `name` means inside module `fid`, following re-exports and barrels. */
  const resolveName = (fid: string, name: string, depth = 0): string | null => {
    const pkg = goPkgs.get(fid);
    if (pkg) return pkg.symbols.get(name) ?? null;
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
    e.file.lang === 'python' ? (resolvePy(e, spec.source ? `${spec.source}.${name}` : name, spec.level)?.id ?? null) : null;

  const fileOf = (id: string) => id.split('#')[0];

  const resolveRef = (e: FileEntry, r: Pick<Ref, 'name' | 'member'>): Resolved | null => {
    const pkgSymbol = (name: string) => (e.pkg ? goPkgs.get(e.pkg)?.symbols.get(name) : undefined);
    if (!r.member) {
      const local = e.symbols.get(r.name);
      if (local) return { to: local, how: 'local', modules: [] };
      const inPkg = pkgSymbol(r.name);
      if (inPkg) return { to: inPkg, how: 'package', modules: [] };
    }
    const b = e.bindings.get(r.name);
    if (!b) {
      if (!r.member) return null;
      const own = e.symbols.get(r.name);
      if (own) return { to: own, how: 'local', modules: [] };
      const inPkg = pkgSymbol(r.name);
      return inPkg ? { to: inPkg, how: 'package', modules: [] } : null;
    }
    const mod = resolveModuleInfo(e, b.spec);
    if (!mod) return null;
    const modules = [mod.id];
    let target: string | null = b.imported === '*' ? mod.id : (resolveName(mod.id, b.imported) ?? submodule(e, b.spec, b.imported));
    let unresolved = target ? undefined : b.imported;
    if (target && !target.includes('#') && target !== mod.id) modules.push(target);
    if (r.member && target && !target.includes('#')) {
      const m = resolveName(target, r.member);
      if (m) target = m;
      else unresolved = r.member;
    }
    return { to: target ?? mod.id, spec: b.spec, how: 'import', guess: mod.guess, unresolved, modules };
  };

  // ── edges ────────────────────────────────────────────────────────────
  const edgeMap = new Map<string, GraphEdge>();
  const sameEvidence = (a: EdgeEvidence, b: EdgeEvidence) => a.file === b.file && a.line === b.line && a.source === b.source;
  const addEdge = (from: string, to: string, kind: EdgeKind, s: Support, detail?: string) => {
    if (from === to || fileOf(from) === to) return;
    // One edge per pair, except HTTP: each distinct request→route is its own interaction.
    const key = kind === 'http' ? `${from}|${to}|${detail}` : `${from}|${to}`;
    const prev = edgeMap.get(key);
    if (!prev) {
      const edge: GraphEdge = { from, to, kind, basis: s.basis, confidence: round(s.confidence), reason: s.reason, evidence: s.evidence.slice(0, MAX_EVIDENCE) };
      if (detail) edge.detail = detail;
      edgeMap.set(key, edge);
      return;
    }
    // Several pieces of code support the same pair: the strongest kind names the
    // edge, and the best-supported explanation leads.
    const stronger = RANK[kind] > RANK[prev.kind];
    const better = (s.basis === 'evidenced' && prev.basis === 'inferred') || (s.basis === prev.basis && s.confidence > (prev.confidence ?? 0));
    const fresh = s.evidence.filter((x) => !prev.evidence!.some((y) => sameEvidence(x, y)));
    prev.evidence = (stronger || better ? [...fresh, ...prev.evidence!] : [...prev.evidence!, ...fresh]).slice(0, MAX_EVIDENCE);
    if (stronger) {
      prev.kind = kind;
      if (detail) prev.detail = detail;
      else delete prev.detail;
    }
    if (stronger || better) {
      prev.reason = s.reason;
      prev.basis = s.basis === 'evidenced' || prev.basis === 'evidenced' ? 'evidenced' : 'inferred';
      prev.confidence = round(Math.max(s.confidence, prev.confidence ?? 0));
    }
  };

  const describe = (e: FileEntry, r: Ref, res: Resolved): Support => {
    const name = r.member ? `${r.name}.${r.member}` : r.name;
    const evidence = [ev(e, SOURCE_OF[r.kind], r.line, `${VERB_OF[r.kind]} ${name}`)];
    if (res.spec) evidence.push(ev(e, 'import', res.spec.line));
    if (res.guess) return { basis: 'inferred', confidence: 0.6, reason: res.guess, evidence };
    if (res.unresolved) {
      const via = files.get(fileOf(res.to))?.bindings.get(res.unresolved)?.spec.source;
      return {
        basis: 'evidenced',
        confidence: 0.7,
        reason: via
          ? `${res.unresolved} comes through "${specText(res.spec!)}" from "${via}", outside the indexed code, so this points at the module`
          : `imports "${specText(res.spec!)}", but ${res.unresolved} isn't declared there, so this points at the module`,
        evidence,
      };
    }
    if (res.how === 'local') return { basis: 'evidenced', confidence: 0.9, reason: `${VERB_OF[r.kind]} ${name}, declared in the same file`, evidence };
    if (res.how === 'package') return { basis: 'evidenced', confidence: 0.9, reason: `${VERB_OF[r.kind]} ${name}, declared in the same Go package`, evidence };
    return { basis: 'evidenced', confidence: 0.95, reason: `${VERB_OF[r.kind]} ${name}, imported from "${specText(res.spec!)}"`, evidence };
  };

  const externalImports = new Map<string, string[]>();
  for (const e of files.values()) {
    const usedModules = new Set<string>();
    const sources: [string, Ref[]][] = [[e.id, e.file.fileRefs], ...e.file.symbols.map((s, i) => [e.ids[i], s.refs] as [string, Ref[]])];
    for (const [from, refs] of sources) {
      for (const r of refs) {
        const res = resolveRef(e, r);
        if (!res) continue;
        for (const m of res.modules) usedModules.add(m);
        usedModules.add(fileOf(res.to));
        addEdge(from, res.to, KIND_OF[r.kind], describe(e, r, res));
      }
    }
    // Imports nothing visibly uses (side effects, re-exports, barrels) still connect the files.
    const external = new Set<string>();
    for (const spec of e.file.imports) {
      const mod = resolveModuleInfo(e, spec);
      if (!mod && spec.level === 0 && spec.source && !spec.source.startsWith('.')) external.add(spec.source.replace(/^node:/, ''));
      if (mod && !usedModules.has(mod.id)) {
        const names = spec.names.map((n) => n.imported).filter((n) => n !== '*');
        const support: Support = mod.guess
          ? { basis: 'inferred', confidence: 0.6, reason: mod.guess, evidence: [ev(e, 'import', spec.line)] }
          : { basis: 'evidenced', confidence: 0.95, reason: `imports "${specText(spec)}"${spec.reexport || spec.reexportAll ? ' and re-exports it' : ''}`, evidence: [ev(e, 'import', spec.line)] };
        addEdge(e.id, mod.id, 'imports', support, names.length ? names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '') : undefined);
      }
    }
    externalImports.set(e.id, [...external]);
  }

  // ── constants (for URL prefixes and base URLs) ───────────────────────
  const goFiles = (e: FileEntry) => (e.pkg ? (goPkgs.get(e.pkg)?.files ?? [e]) : [e]);
  /** `API_V1_STR`, `settings.API_V1_STR`, `config.Prefix`: a string constant we can read, and where it is. */
  const resolveConst = (e: FileEntry, expr: string): { value: string; at: EdgeEvidence } | null => {
    const found = (t: FileEntry, name: string, anyOwner: boolean) => {
      const c = t.file.constants.find((k) => k.name === name && (anyOwner || !k.owner));
      return c ? { value: c.value, at: ev(t, 'constant', c.line, `${expr} = "${c.value}"`) } : null;
    };
    const parts = expr.split('.');
    if (parts.length === 1) {
      for (const t of goFiles(e)) {
        const hit = found(t, expr, false);
        if (hit) return hit;
      }
      const b = e.bindings.get(expr);
      const mod = b && b.imported !== '*' ? resolveModule(e, b.spec) : null;
      const t = mod ? files.get(mod) : undefined;
      return t ? found(t, b!.imported, false) : null;
    }
    const name = parts[parts.length - 1];
    const b = e.bindings.get(parts[0]);
    let targets: FileEntry[] = goFiles(e);
    if (b) {
      const mod = resolveModule(e, b.spec);
      if (!mod) return null;
      const sub = b.imported !== '*' ? submodule(e, b.spec, b.imported) : null;
      targets = goPkgs.get(mod)?.files ?? [files.get(sub ?? mod)].filter((x): x is FileEntry => !!x);
    }
    for (const t of targets) {
      const hit = found(t, name, true);
      if (hit) return hit;
    }
    return null;
  };
  const resolveParts = (e: FileEntry, parts: UrlPart[]): { text: string; evidence: EdgeEvidence[] } | null => {
    let text = '';
    const evidence: EdgeEvidence[] = [];
    for (const p of parts) {
      if ('lit' in p) text += p.lit;
      else {
        const c = resolveConst(e, p.expr);
        if (!c) return null;
        text += c.value;
        evidence.push(c.at);
      }
    }
    return { text, evidence };
  };

  // ── routers and mounts ───────────────────────────────────────────────
  // A router is known by the scope that declares it: "<file>::name" for
  // module-level objects, "<symbol>::name" for locals, "<symbol>::#n" for a
  // function's n-th parameter, "<symbol>::@line" for a chi Route closure.
  const declared = new Set<string>();
  const roots = new Set<string>();
  const scopeId = (e: FileEntry, i: number | null) => (i == null ? e.id : e.ids[i]);
  const eachScope = (e: FileEntry, fn: (i: number | null, x: { routes?: RouteDecl[]; mounts?: MountDecl[]; routers?: { name: string; root: boolean }[] }) => void) => {
    fn(null, e.file);
    e.file.symbols.forEach((s, i) => fn(i, s));
  };
  for (const e of files.values()) {
    eachScope(e, (i, x) => {
      for (const r of x.routers ?? []) {
        const key = `${scopeId(e, i)}::${r.name}`;
        declared.add(key);
        if (r.root) roots.add(key);
      }
    });
    if (e.file.lang === 'go') roots.add(`${e.repo.info.id}::http`); // net/http's DefaultServeMux
  }

  const routerKey = (e: FileEntry, i: number | null, name: string): string => {
    if (name === 'http' && e.file.lang === 'go') return `${e.repo.info.id}::http`;
    if (name.includes('.')) return childKey(e, i, name) ?? `${e.id}::${name}`;
    if (name.startsWith('#') || name.startsWith('@')) return `${scopeId(e, i)}::${name}`;
    if (i != null && declared.has(`${e.ids[i]}::${name}`)) return `${e.ids[i]}::${name}`;
    const own = `${e.id}::${name}`;
    if (declared.has(own)) return own;
    for (const t of goFiles(e)) if (declared.has(`${t.id}::${name}`)) return `${t.id}::${name}`;
    const b = e.bindings.get(name);
    const mod = b ? resolveModule(e, b.spec) : null;
    if (b && mod) return exportedRouter(mod, b.imported === '*' ? 'default' : b.imported);
    return own;
  };
  /** The router a module exports as `name`, through `export { default } from "./documents"` and `import r from …; export default r`. */
  const exportedRouter = (mod: string, name: string, depth = 0): string => {
    const e = files.get(mod);
    const local = name === 'default' ? (e?.file.defaultExport ?? name) : name;
    const key = `${mod}::${local}`;
    if (!e || declared.has(key) || depth > 6) return key;
    for (const spec of e.file.imports) {
      const n = spec.reexport ? spec.names.find((x) => x.local === name) : undefined;
      const target = (n || spec.reexportAll) && resolveModule(e, spec);
      if (!target) continue;
      const k = exportedRouter(target, n ? n.imported : name, depth + 1);
      if (declared.has(k)) return k;
    }
    const b = e.bindings.get(local);
    const target = b && resolveModule(e, b.spec);
    if (b && target) {
      const k = exportedRouter(target, b.imported === '*' ? 'default' : b.imported, depth + 1);
      if (declared.has(k)) return k;
    }
    return key;
  };
  /** "items.router" (a router inside an imported module), "api_router", or "require:./routes/items". */
  const childKey = (e: FileEntry, i: number | null, child: MountDecl['child']): string | null => {
    if (typeof child !== 'string') {
      const [name, ...rest] = child.fn.split('.');
      const res = resolveRef(e, { name, member: rest.length ? rest.join('.') : undefined });
      return res?.to.includes('#') ? `${res.to}::#${child.arg}` : null;
    }
    if (child.startsWith('require:')) {
      const spec = e.file.imports.find((s) => s.source === child.slice(8));
      const mod = spec && resolveModule(e, spec);
      return mod ? exportedRouter(mod, 'default') : null;
    }
    const dot = child.indexOf('.');
    if (dot < 0) return routerKey(e, i, child);
    const b = e.bindings.get(child.slice(0, dot));
    const mod = b ? resolveModule(e, b.spec) : null;
    if (b && mod) {
      const target = b.imported === '*' ? mod : (submodule(e, b.spec, b.imported) ?? resolveName(mod, b.imported));
      if (target && !target.includes('#')) return exportedRouter(target, child.slice(dot + 1));
    }
    return `${e.id}::${child}`;
  };

  interface Mount {
    parent: string;
    prefix: UrlPart[];
    e: FileEntry;
    line: number;
  }
  const mountsOf = new Map<string, Mount[]>();
  for (const e of files.values()) {
    eachScope(e, (i, x) => {
      for (const m of x.mounts ?? []) {
        const child = childKey(e, i, m.child);
        if (!child) continue;
        const list = mountsOf.get(child) ?? [];
        list.push({ parent: routerKey(e, i, m.parent), prefix: m.prefix, e, line: m.line });
        mountsOf.set(child, list);
      }
    });
  }

  type Prefix = { path: string; evidence: EdgeEvidence[] };
  const prefixCache = new Map<string, Prefix[]>();
  /**
   * Every path above a router: [""] for an application root, one entry per
   * distinct mount chain that reaches a root (a router mounted at /api/v1 and
   * /api/v2 serves both), [] when no chain does.
   */
  const fullPrefixes = (key: string, stack = new Set<string>()): Prefix[] => {
    const cached = prefixCache.get(key);
    if (cached) return cached;
    // An app mounted inside another (`app.use(mount("/api", api))`) takes the outer prefix; one mounted nowhere is served at its root.
    const own: Prefix[] = roots.has(key) ? [{ path: '', evidence: [] }] : [];
    if (stack.has(key)) return own;
    stack.add(key);
    const out: Prefix[] = [];
    for (const m of mountsOf.get(key) ?? []) {
      const p = resolveParts(m.e, m.prefix);
      if (!p) continue;
      const note = p.text ? `mounted under ${p.text}` : 'mounted here';
      for (const parent of fullPrefixes(m.parent, stack)) {
        const path = joinUrl(parent.path, p.text);
        if (out.length >= MAX_PREFIXES || out.some((o) => o.path === path)) continue;
        out.push({ path, evidence: [...parent.evidence, ev(m.e, 'mount', m.line, note), ...p.evidence] });
      }
    }
    stack.delete(key);
    const result = out.length ? out : own;
    prefixCache.set(key, result);
    return result;
  };

  // ── routes ───────────────────────────────────────────────────────────
  const routes: RouteEntry[] = [];
  const addRoute = (e: FileEntry, node: string, method: string, p: string, evidence: EdgeEvidence[], fullPath?: string) =>
    routes.push({ method, path: p, fullPath, node, file: e.id, segs: segments(fullPath ?? p), evidence });

  for (const e of files.values()) {
    eachScope(e, (i, x) => {
      for (const r of x.routes ?? []) {
        let node = scopeId(e, i);
        if (r.handler) {
          const [name, ...rest] = r.handler.split('.');
          const res = resolveRef(e, { name, member: rest.length ? rest.join('.') : undefined });
          if (res?.to.includes('#')) node = res.to;
        }
        const evidence = [ev(e, 'route', r.line, `declares ${r.method === '*' ? 'ANY' : r.method} ${r.path || '/'}`)];
        if (r.prefixLine) evidence.push(ev(e, 'mount', r.prefixLine, "router's own prefix"));
        const pres = r.router ? fullPrefixes(routerKey(e, i, r.router)) : [];
        if (!pres.length) addRoute(e, node, r.method, r.path, evidence);
        for (const pre of pres) addRoute(e, node, r.method, r.path, [...evidence, ...pre.evidence], joinUrl(pre.path, r.path));
      }
    });
    // Next.js route handlers: app/**/route.ts exporting GET/POST/…; their path is their folder.
    const appRoute = e.file.path.match(/(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/);
    if (appRoute && e.file.lang !== 'python' && e.file.lang !== 'go') {
      e.file.symbols.forEach((s, i) => {
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name)) return;
        const p = nextPath(appRoute[1]);
        addRoute(e, e.ids[i], s.name, p, [ev(e, 'route', s.lines[0], `Next.js route handler for ${p}`)], p);
      });
    }
    // Next.js pages/api/**.
    const pagesApi = e.file.path.match(/(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/);
    if (pagesApi && e.defaultSymbol) {
      const p = nextPath(pagesApi[1].replace(/\/index$/, ''));
      const line = e.file.symbols[e.ids.indexOf(e.defaultSymbol)]?.lines[0] ?? 1;
      addRoute(e, e.defaultSymbol, '*', p, [ev(e, 'route', line, `Next.js API route for ${p}`)], p);
    }
  }

  // ── HTTP: client requests → server routes ────────────────────────────
  /** The base URL a client object adds: `client` imported from a module doing `export const client = new ApiClient()`. */
  const clientBase = (e: FileEntry, name: string): { path: string; evidence: EdgeEvidence[] } | null => {
    let owner: FileEntry | undefined = e;
    let local = name;
    let c = e.file.clients?.find((x) => x.name === name);
    if (!c) {
      const b = e.bindings.get(name);
      const mod = b && b.imported !== '*' ? resolveModule(e, b.spec) : null;
      owner = mod ? files.get(mod) : undefined;
      local = b?.imported === 'default' ? (owner?.file.defaultExport ?? '') : (b?.imported ?? '');
      c = owner?.file.clients?.find((x) => x.name === local);
    }
    if (!owner || !c) return null;
    const evidence = [ev(owner, 'constant', c.line, `the HTTP client ${local} requests go through`)];
    let parts = c.base;
    let at: { t: FileEntry; line: number } = { t: owner, line: c.line };
    if (!parts && c.ctor) {
      const cls = resolveRef(owner, { name: c.ctor })?.to;
      const t = cls ? files.get(fileOf(cls)) : undefined;
      const sym = t?.file.symbols[t.ids.indexOf(cls!)];
      if (!t || !sym?.clientBase) return null;
      parts = sym.clientBase.parts;
      at = { t, line: sym.clientBase.line };
    }
    const r = parts && resolveParts(at.t, parts);
    const path = r ? basePath(r.text) : null;
    if (path == null) return null;
    evidence.push(ev(at.t, 'constant', at.line, `base URL "${path || '/'}"`), ...r!.evidence);
    return { path, evidence };
  };

  for (const e of files.values()) {
    const reqs = [
      ...e.file.requests.map((r) => [e.id, r] as const),
      ...e.file.symbols.flatMap((s, i) => (s.requests ?? []).map((r) => [e.ids[i], r] as const)),
    ];
    for (const [from, req] of reqs) {
      let reqPath = req.path;
      const evidence = [ev(e, 'request', req.line, `${req.method} ${req.base ? `{${req.base}}` : ''}${req.path}`)];
      let baseKnown = !req.base;
      if (req.base) {
        const c = resolveConst(e, req.base);
        const bp = c ? basePath(c.value) : null;
        if (c && bp != null) {
          reqPath = joinUrl(bp, req.path);
          baseKnown = true;
          evidence.push(c.at);
        }
      }
      const viaBase = req.via ? clientBase(e, req.via) : null;
      if (viaBase) reqPath = joinUrl(viaBase.path, req.path);
      const m = matchRequest(routes, req.method, segments(reqPath), baseKnown);
      if (!m) continue;
      // Server code requesting a URL is calling some other service (`fetch(GitLabUtils.getOauthUrl(url) + "/token")`),
      // not its own routes; only an exact full-path match links it to a route in its own repository.
      if (!m.exact && SERVER_PATH.test(e.file.path) && files.get(m.route.file)?.repo === e.repo) continue;
      const shown = m.route.fullPath ?? m.route.path;
      // The route's declaration, then the client's base URL, then the mounts: the cap keeps what matters most.
      evidence.push(...m.route.evidence.slice(0, 1), ...(viaBase?.evidence ?? []), ...m.route.evidence.slice(1));
      const through = viaBase ? `the base URL ${viaBase.path || '/'} of ${req.via}` : undefined;
      addEdge(from, m.route.node, 'http', explainMatch(m, req.method, reqPath, req.base && !baseKnown ? req.base : undefined, evidence, through), `${req.method} ${shown}`);
    }
  }

  // ── ORM: relationships and foreign keys between entities ────────────
  const entities = new Map<string, string[]>(); // class name → symbol ids
  const byTable = new Map<string, { id: string; certain: boolean }[]>();
  for (const e of files.values()) {
    e.file.symbols.forEach((s, i) => {
      if (!isTable(s)) return;
      entities.set(s.name, [...(entities.get(s.name) ?? []), e.ids[i]]);
      tableNames(e.file, s).forEach((t, k) => byTable.set(t, [...(byTable.get(t) ?? []), { id: e.ids[i], certain: k === 0 && !!s.tableName }]));
    });
  }
  for (const e of files.values()) {
    e.file.symbols.forEach((s, i) => {
      for (const o of s.orm ?? []) {
        const evidence = [ev(e, 'orm', o.line, o.kind === 'relationship' ? `relationship to ${o.target}` : `foreign key ${o.target}`)];
        if (o.kind === 'relationship') {
          const res = resolveRef(e, { name: o.target });
          if (res?.to.includes('#') && !res.unresolved) {
            addEdge(e.ids[i], res.to, 'type', { basis: 'evidenced', confidence: 0.95, reason: `ORM relationship to ${o.target}`, evidence });
            continue;
          }
          const cands = (entities.get(o.target) ?? []).filter((id) => id !== e.ids[i]);
          if (!cands.length) continue;
          const pick = cands.find((id) => id.startsWith(`${e.repo.info.id}/`)) ?? cands[0];
          const unique = cands.length === 1;
          addEdge(e.ids[i], pick, 'type', {
            basis: unique ? 'evidenced' : 'inferred',
            confidence: unique ? 0.85 : 0.5,
            reason: unique ? `ORM relationship to ${o.target}, the only entity by that name` : `ORM relationship to ${o.target}; ${cands.length} entities share that name`,
            evidence,
          });
        } else if (/^[A-Z]\w*\./.test(o.target)) {
          // ForeignKey(User.id): the class is named directly.
          const cls = o.target.split('.')[0];
          const res = resolveRef(e, { name: cls });
          const to = res?.to.includes('#') && !res.unresolved ? res.to : (entities.get(cls)?.length === 1 ? entities.get(cls)![0] : null);
          if (to) addEdge(e.ids[i], to, 'references', { basis: 'evidenced', confidence: 0.95, reason: `foreign key to ${o.target}`, evidence });
        } else {
          const table = o.target.split('.')[0];
          const cands = (byTable.get(table) ?? []).filter((c) => c.id !== e.ids[i]);
          if (!cands.length) continue;
          const certain = cands.filter((c) => c.certain);
          const pick = certain[0] ?? cands.find((c) => c.id.startsWith(`${e.repo.info.id}/`)) ?? cands[0];
          const evidenced = certain.length === 1;
          const decl = files.get(fileOf(pick.id));
          const target = decl?.file.symbols[decl.ids.indexOf(pick.id)];
          if (evidenced && decl && target) evidence.push(ev(decl, 'orm', target.lines[0], `declares table ${table}`));
          addEdge(e.ids[i], pick.id, 'references', {
            basis: evidenced ? 'evidenced' : 'inferred',
            confidence: evidenced ? 0.9 : 0.65,
            reason: evidenced ? `foreign key to table ${table}` : `foreign key to table ${table}, matched to an entity by its default table name`,
            evidence,
          });
        }
      }
    });
  }

  // ── client-side pages ────────────────────────────────────────────────
  const pages: PageEntry[] = [];
  for (const e of files.values()) {
    for (const p of e.file.pages) {
      const res = p.component ? resolveRef(e, { name: p.component }) : null;
      pages.push({ path: p.path, node: res && !res.unresolved ? res.to : e.id });
    }
  }

  return { edges: [...edgeMap.values()], routes, pages, externalImports };
}

const round = (n: number) => Math.round(n * 100) / 100;
/** An import as written: "./api", "app.models", ".notes". */
const specText = (spec: ImportSpec) => '.'.repeat(spec.level) + spec.source;

/** Join URL paths: ("/api/v1", "/items/") → "/api/v1/items/". */
export function joinUrl(a: string, b: string): string {
  if (!b) return a || '/';
  if (!a) return b.startsWith('/') ? b : `/${b}`;
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`.replace(/\/{2,}/g, '/');
}

/** The path part of a base URL constant: "http://localhost:8000/api/v1" → "/api/v1", "https://x.io" → "". */
function basePath(value: string): string | null {
  const s = value.trim();
  const abs = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i);
  if (abs) return (abs[1] ?? '').replace(/\/$/, '');
  if (s.startsWith('/')) return s.replace(/\/$/, '');
  return null;
}

/** "/api/v1/items/{id}" → ["api","v1","items","*"]. Every param style collapses to "*". */
export function segments(p: string): string[] {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(\{.*\}|:.+|\[.*\]|<.*>|\*)$/.test(s) ? '*' : s.toLowerCase()));
}

export interface MatchableRoute {
  method: string;
  segs: string[];
  node: string;
  /** Set when every mount above the route is known, so `segs` is its whole path. */
  fullPath?: string;
}

export interface RouteMatch<R extends MatchableRoute = MatchableRoute> {
  route: R;
  /** The request's whole path equals the route's whole path. */
  exact: boolean;
  /** Segments compared, aligned from the end. */
  aligned: number;
  /** Literal segments that agreed. */
  literal: number;
  /** Leading segments only one side has: an unseen mount prefix or base URL. */
  extra: number;
  /** Which side had the extra segments. */
  longer: 'request' | 'route' | 'neither';
  /** Other routes, served by other nodes, that matched as well. */
  ties: number;
}

/**
 * Match a request to a route by aligning their segments from the end, since
 * either side may be missing a prefix we couldn't see: a server mounts
 * routers under prefixes set elsewhere (FastAPI's include_router), and a
 * client prepends a base URL held in a variable. The best match has the most
 * agreeing literal segments, then the fewest unmatched ones.
 */
export function matchRequest<R extends MatchableRoute>(routes: R[], method: string, req: string[], baseKnown = true): RouteMatch<R> | null {
  if (!req.length) return null;
  let best: RouteMatch<R> | null = null;
  let bestScore = -Infinity;
  const score = (m: RouteMatch<R>) => (m.exact ? 10_000 : 0) + m.literal * 100 + m.aligned * 10 - m.extra;
  for (const r of routes) {
    if (r.method !== '*' && r.method !== method) continue;
    if (!r.segs.length) continue;
    const n = Math.min(req.length, r.segs.length);
    let literal = 0;
    let dynamicVsLiteral = false;
    let ok = true;
    for (let k = 1; k <= n; k++) {
      const a = r.segs[r.segs.length - k];
      const b = req[req.length - k];
      if (a === '*' || b === '*') {
        if (b === '*' && a !== '*') dynamicVsLiteral = true;
        continue;
      }
      if (a !== b) {
        ok = false;
        break;
      }
      literal++;
    }
    if (!ok || literal === 0) continue;
    const extra = Math.abs(req.length - r.segs.length);
    const m: RouteMatch<R> = {
      route: r,
      exact: baseKnown && r.fullPath !== undefined && extra === 0 && !dynamicVsLiteral,
      aligned: n,
      literal,
      extra,
      longer: req.length > r.segs.length ? 'request' : req.length < r.segs.length ? 'route' : 'neither',
      ties: 0,
    };
    const s = score(m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    } else if (s === bestScore && best && best.route.node !== r.node) best.ties++;
  }
  return best;
}

/** Back-compatible form: the best route, or null. */
export function matchRoute<R extends MatchableRoute>(routes: R[], method: string, req: string[]): R | null {
  return matchRequest(routes, method, req)?.route ?? null;
}

function explainMatch(m: RouteMatch<RouteEntry>, method: string, reqPath: string, unknownBase: string | undefined, evidence: EdgeEvidence[], through?: string): Support {
  const shown = m.route.fullPath ?? m.route.path;
  if (m.exact && !m.ties) {
    const mounts = m.route.evidence.filter((x) => x.source === 'mount' && x.note?.startsWith('mounted')).length;
    const how = [through ? `with ${through}` : '', mounts ? `through ${mounts} router mount${mounts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
    return {
      basis: 'evidenced',
      // A client's base URL is its default; a caller could pass another one.
      confidence: through ? 0.9 : 0.95,
      reason: `matches the route's full path ${method} ${shown} exactly${how ? `, ${how}` : ''}`,
      evidence,
    };
  }
  let reason: string;
  const tail = `matched the last ${m.aligned} segment${m.aligned > 1 ? 's' : ''} of ${shown}`;
  if (m.exact) reason = `matches the route's full path ${method} ${shown}`;
  else if (unknownBase) reason = `the request's base URL comes from ${unknownBase}, which isn't a constant we could read; ${tail}`;
  else if (m.longer === 'request' && m.route.fullPath === undefined) reason = `${tail}; the router's mount prefix wasn't found, so the rest of ${reqPath} is assumed to be it`;
  else if (m.longer === 'request') reason = `${reqPath} is longer than the route's full path; ${tail}`;
  else if (m.longer === 'route') reason = `${reqPath} is the tail of ${shown}; the rest is assumed to come from a base URL`;
  else if (m.route.fullPath === undefined) reason = `${reqPath} matches the route as declared, but the router's mount prefix wasn't found`;
  else reason = `${reqPath} matches ${shown} only where the request has a dynamic segment`;
  if (m.ties) reason += `; ${m.ties} other route${m.ties > 1 ? 's' : ''} matched as well`;
  let confidence = 0.45 + 0.15 * Math.min(m.literal, 3) - 0.03 * m.extra;
  if (m.exact) confidence = 0.8;
  if (m.ties) confidence *= 0.7;
  return { basis: 'inferred', confidence: Math.max(0.3, Math.min(0.9, confidence)), reason, evidence };
}

export function nextPath(dir: string): string {
  const segs = dir
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map((s) => s.replace(/^\[\[?\.{0,3}(.+?)\]?\]$/, '{$1}'));
  return '/' + segs.join('/');
}
