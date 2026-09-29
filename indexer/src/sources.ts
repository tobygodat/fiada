// Reads a repository on disk into ParsedRepo: which files count as source,
// what their manifests say, and the parsed facts for every file.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoInfo } from '@fiada/shared';
import type { PackageManifest, ParsedFile, ParsedRepo, TsConfigPaths } from './model.ts';
import { linkGoTableNames } from './parse/go.ts';
import { langOf, parseFile } from './parse/index.ts';

const exec = promisify(execFile);

export interface LoadOptions {
  includeTests: boolean;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_LOAD: LoadOptions = {
  includeTests: process.env.FIADA_INCLUDE_TESTS === '1',
  maxFiles: Number(process.env.FIADA_MAX_FILES ?? 4000),
  maxFileBytes: 400_000,
};

export const IGNORED_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'env', 'site-packages', 'target', '.mypy_cache',
  '.pytest_cache', '.tox', 'bower_components', '.idea', '.vscode',
]);

export const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright)(\/|$)|\.(test|spec|stories)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)conftest\.py$|(^|\/)test_helpers?\.go$|[a-z0-9]Tests?\.(java|kt|cs|swift)$|(^|\/)[\w.]+\.Tests?\/|_(spec|test)\.rb$|_test\.(c|cc|cpp)$/;

const isIgnored = (rel: string) => rel.split('/').some((seg) => IGNORED_DIR.has(seg));

/** Files that change how every other file resolves; a change to one means reloading the repo. */
export const MANIFEST = /(^|\/)(package\.json|[tj]sconfig(\..+)?\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements.*\.txt|setup\.py|__init__\.py)$/;

async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 64 << 20 });
    return stdout.split('\0').filter(Boolean);
  } catch {
    // Not a git checkout: walk the tree ourselves.
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!IGNORED_DIR.has(e.name) && !e.name.startsWith('.')) await walk(rel);
        } else if (e.isFile()) out.push(rel);
      }
    };
    await walk('');
    return out;
  }
}

/** JSON with comments and trailing commas, as tsconfig allows. */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const readText = (p: string) => fs.readFile(p, 'utf8').catch(() => null);

const FRAMEWORKS: [RegExp, string][] = [
  [/^react$/, 'react'], [/^next$/, 'next'], [/^vue$/, 'vue'], [/^svelte$/, 'svelte'], [/^@angular\/core$/, 'angular'],
  [/^react-native$/, 'react-native'], [/^express$/, 'express'], [/^fastify$/, 'fastify'], [/^hono$/, 'hono'],
  [/^@nestjs\/core$/, 'nestjs'], [/^koa$/, 'koa'], [/^@prisma\/client$|^prisma$/, 'prisma'], [/^drizzle-orm$/, 'drizzle'],
  [/^typeorm$/, 'typeorm'], [/^mongoose$/, 'mongoose'], [/^fastapi$/, 'fastapi'], [/^flask$/, 'flask'],
  [/^django$/, 'django'], [/^sqlalchemy$/, 'sqlalchemy'], [/^sqlmodel$/, 'sqlmodel'], [/^celery$/, 'celery'],
  [/^apache-airflow$/, 'airflow'], [/^pandas$/, 'pandas'], [/^torch$/, 'torch'], [/^pydantic$/, 'pydantic'],
  [/^github\.com\/gin-gonic\/gin$/, 'gin'], [/^github\.com\/labstack\/echo/, 'echo'], [/^github\.com\/go-chi\/chi/, 'chi'],
  [/^github\.com\/gofiber\/fiber/, 'fiber'], [/^github\.com\/gorilla\/mux$/, 'gorilla-mux'], [/^gorm\.io\/gorm$|^github\.com\/jinzhu\/gorm$/, 'gorm'],
  [/^entgo\.io\/ent$/, 'ent'], [/^github\.com\/jmoiron\/sqlx$/, 'sqlx'],
];

export async function loadRepo(info: RepoInfo, root: string, opts: LoadOptions = DEFAULT_LOAD): Promise<ParsedRepo> {
  const all = (await listFiles(root)).filter((f) => !isIgnored(f));

  const packages: PackageManifest[] = [];
  const tsconfigs = new Map<string, TsConfigPaths>();
  const pyDeps = new Set<string>();
  const goDeps = new Set<string>();
  const goModules: { dir: string; module: string }[] = [];
  const rustCrates: { dir: string; name: string }[] = [];
  for (const rel of all) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (base === 'package.json') {
      const text = await readText(path.join(root, rel));
      try {
        const pj = JSON.parse(text ?? '{}');
        const deps = Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies });
        packages.push({ dir, name: pj.name, main: typeof pj.module === 'string' ? pj.module : pj.main, deps });
      } catch { /* malformed manifest: skip */ }
    } else if (/^[tj]sconfig(\..+)?\.json$/.test(base)) {
      try {
        const co = parseJsonc((await readText(path.join(root, rel))) ?? '{}').compilerOptions ?? {};
        const cur = tsconfigs.get(dir) ?? { dir, paths: {} };
        if (co.baseUrl) cur.baseUrl = co.baseUrl;
        Object.assign(cur.paths, co.paths ?? {});
        tsconfigs.set(dir, cur);
      } catch { /* unreadable tsconfig: skip */ }
    } else if (base === 'go.mod') {
      const text = (await readText(path.join(root, rel))) ?? '';
      const mod = text.match(/^module\s+(\S+)/m)?.[1];
      if (mod) goModules.push({ dir, module: mod.replace(/^"|"$/g, '') });
      // require lines, in a block or one per line; indirect ones say nothing about the code.
      for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v[^\s]+(\s*\/\/\s*indirect)?/gm)) {
        if (!m[2]) goDeps.add(m[1]);
      }
    } else if (base === 'Cargo.toml') {
      // The [package] name, as `use` paths write it; a workspace-only manifest has none.
      const pkg = ((await readText(path.join(root, rel))) ?? '').split(/^\s*\[/m).find((sec) => /^package\s*\]/.test(sec));
      const name = pkg?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
      if (name) rustCrates.push({ dir, name: name.replace(/-/g, '_') });
    } else if (base === 'pyproject.toml' || /^requirements.*\.txt$/.test(base) || base === 'setup.py') {
      const text = (await readText(path.join(root, rel))) ?? '';
      if (base.endsWith('.txt')) {
        for (const l of text.split('\n')) {
          const name = l.trim().split(/[<>=~!\[; #]/)[0];
          if (name && !name.startsWith('-')) pyDeps.add(name.toLowerCase());
        }
      } else {
        for (const m of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(\[[^\]]*\])?\s*([<>=~!;][^"']*)?["']/g)) pyDeps.add(m[1].toLowerCase());
      }
    }
  }

  let candidates = all.filter((f) => langOf(f) && !f.endsWith('.min.js'));
  if (!opts.includeTests) candidates = candidates.filter((f) => !TEST_PATH.test(f));
  let truncated = 0;
  if (candidates.length > opts.maxFiles) {
    // Keep the shallowest files: they carry the structure; deep leaves are least informative.
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    truncated = candidates.length - opts.maxFiles;
    candidates = candidates.slice(0, opts.maxFiles);
  }

  const files: ParsedFile[] = [];
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size > opts.maxFileBytes) continue;
    const text = await readText(abs);
    if (text == null) continue;
    try {
      const f = await parseFile(rel, text);
      if (f) files.push(f);
    } catch (err) {
      console.warn(`[fiada] failed to parse ${info.id}/${rel}:`, (err as Error).message);
    }
  }

  linkGoTableNames(files);

  // A directory is a Python import root if it holds a top-level package.
  const pyRoots = new Set<string>(['']);
  const inits = new Set(files.filter((f) => f.path.endsWith('__init__.py')).map((f) => path.posix.dirname(f.path)));
  for (const pkg of inits) {
    const parent = path.posix.dirname(pkg);
    if (!inits.has(parent)) pyRoots.add(parent === '.' ? '' : parent);
  }
  for (const f of files) if (f.path.startsWith('src/') && f.lang === 'python') pyRoots.add('src');

  const deps = new Set([...packages.flatMap((p) => p.deps), ...pyDeps, ...goDeps]);
  const frameworks = FRAMEWORKS.filter(([re]) => [...deps].some((d) => re.test(d))).map(([, name]) => name);
  const languages: Record<string, number> = {};
  for (const f of files) {
    const l = f.lang === 'tsx' ? 'typescript' : f.lang;
    languages[l] = (languages[l] ?? 0) + 1;
  }

  return {
    info: {
      ...info,
      fileCount: files.length,
      symbolCount: files.reduce((n, f) => n + f.symbols.length, 0),
      languages,
      frameworks,
      truncated: truncated || undefined,
    },
    root,
    files,
    packages,
    pyDeps: [...pyDeps],
    tsconfigs: [...tsconfigs.values()],
    pyRoots: [...pyRoots],
    goModules: goModules.length ? goModules : undefined,
    rustCrates: rustCrates.length ? rustCrates : undefined,
    frameworks,
  };
}

/** Which of `paths` git ignores, so a file an agent writes under .gitignore stays out as it would on a full load. */
async function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', root, 'check-ignore', '--stdin', '-z'], (_err, stdout) => resolve(new Set(String(stdout ?? '').split('\0').filter(Boolean))));
    child.stdin?.end(paths.join('\0'));
  });
}

/**
 * Re-reads only `paths` (repo-relative) of a loaded repo: parses the ones that
 * changed or appeared, drops the ones that are gone or no longer count as
 * source, and updates the repo's counts. Returns false, touching nothing,
 * when one of them is a manifest or a Python package marker, which changes
 * how other files resolve; reload the whole repo then.
 */
export async function reloadFiles(repo: ParsedRepo, paths: string[], opts: LoadOptions = DEFAULT_LOAD): Promise<boolean> {
  if (paths.some((p) => MANIFEST.test(p))) return false;
  const ignored = await gitIgnored(repo.root, paths);
  for (const rel of new Set(paths)) {
    const counts = !!langOf(rel) && !rel.endsWith('.min.js') && !isIgnored(rel) && !ignored.has(rel) && (opts.includeTests || !TEST_PATH.test(rel));
    const abs = path.join(repo.root, rel);
    const stat = counts ? await fs.stat(abs).catch(() => null) : null;
    const text = stat?.isFile() && stat.size <= opts.maxFileBytes ? await readText(abs) : null;
    let parsed: ParsedFile | null = null;
    if (text != null) {
      try {
        parsed = await parseFile(rel, text);
      } catch (err) {
        console.warn(`[fiada] failed to parse ${repo.info.id}/${rel}:`, (err as Error).message);
      }
    }
    const i = repo.files.findIndex((f) => f.path === rel);
    if (parsed && i >= 0) repo.files[i] = parsed;
    else if (parsed) repo.files.push(parsed);
    else if (i >= 0) repo.files.splice(i, 1);
  }
  if (paths.some((p) => p.endsWith('.go'))) linkGoTableNames(repo.files);
  const languages: Record<string, number> = {};
  for (const f of repo.files) {
    const l = f.lang === 'tsx' ? 'typescript' : f.lang;
    languages[l] = (languages[l] ?? 0) + 1;
  }
  Object.assign(repo.info, {
    fileCount: repo.files.length,
    symbolCount: repo.files.reduce((n, f) => n + f.symbols.length, 0),
    languages,
  });
  return true;
}
