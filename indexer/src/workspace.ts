// One project: the repositories imported into it, their clones on disk, their
// parsed facts, its grouping (layers, rules, pins), and the combined graph.
// Repos and grouping persist through a ProjectStore, so a restart re-indexes
// without re-cloning and keeps the project's layers.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Graph, Grouping, LayerPreset, RepoInfo, Workspace as WorkspaceState } from '@strata/shared';
import { remoteKey } from './agents.ts';
import { buildBase, classifyGraph, type BaseGraph } from './build.ts';
import { defaultGrouping, GroupingError, normalizeGrouping, presetLayers } from './classify/index.ts';
import type { ParsedRepo } from './model.ts';
import { loadRepo, reloadFiles } from './sources.ts';
import type { ProjectStore, SavedRepo } from './store.ts';
import { folderName, unpackUpload, UPLOAD } from './upload.ts';

const exec = promisify(execFile);

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const STRATA_HOME = process.env.STRATA_HOME ?? path.join(PROJECT_ROOT, '.strata');
const CLONES = path.join(STRATA_HOME, 'repos');

export interface RepoSource {
  kind: 'git' | 'local';
  /** Clone URL, or absolute directory. */
  location: string;
  name: string;
}

const LOCAL_OFF = 'This indexer is hosted, so it imports git repositories only (org/repo or a git URL), not local folders.';

/** An uploaded folder whose files this indexer no longer has: a hosted container's disk starts empty on every deploy. */
const UPLOAD_GONE = "This indexer's copy of the folder is gone (a hosted indexer's disk is reset on each deploy). Upload the folder again.";

/** Where uploads unpack before they replace anything, beside the clones so the swap is a rename. */
const UPLOAD_TMP = '.upload-';

/**
 * Accepts what people paste: "org/repo", "github.com/org/repo",
 * "https://…/repo.git", "git@host:org/repo.git", or a local directory
 * (unless `allowLocal` is false).
 */
export async function parseSource(input: string, allowLocal = true): Promise<RepoSource> {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('-')) throw new Error(allowLocal ? 'Enter a git URL, org/repo, or a local path.' : 'Enter a git URL or org/repo.');
  if (/^(~|\.{1,2})?\//.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    if (!allowLocal) throw new Error(LOCAL_OFF);
    const abs = path.resolve(raw.replace(/^~(?=\/)/, os.homedir()));
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`No directory at ${abs}`);
    return { kind: 'local', location: abs, name: path.basename(abs) };
  }
  let url = raw;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) url = `https://github.com/${raw}`;
  else if (/^(github\.com|gitlab\.com|bitbucket\.org)\//.test(raw)) url = `https://${raw}`;
  if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(url)) throw new Error(`Not a git URL or path: ${input}`);
  const name = url.split(/[/:]/).pop()!.replace(/\.git$/, '');
  if (!name) throw new Error(`Can't tell the repository name from ${input}`);
  return { kind: 'git', location: url, name };
}

/** What the project keeps of a repository; an upload also keeps what its .git said, which only the upload knew. */
function saved({ id, name, source, kind, remote, branch, commit, uploadedAt }: RepoInfo): SavedRepo {
  if (kind !== 'upload') return { id, name, source, kind };
  const extra = Object.entries({ remote, branch, commit, uploadedAt }).filter(([, v]) => v !== undefined);
  return { id, name, source, kind, ...Object.fromEntries(extra) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';

/**
 * Token for private GitHub repos, passed per command so it never lands in
 * .git/config. Strata-specific on purpose: a GITHUB_TOKEN already in the
 * environment may be scoped to something else entirely.
 */
function authArgs(url: string): string[] {
  const token = process.env.STRATA_GITHUB_TOKEN;
  if (!token || !url.startsWith('https://github.com/')) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

const git = (args: string[], timeout = 300_000) =>
  exec('git', args, { timeout, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

export class Workspace {
  repos: RepoInfo[] = [];
  private parsed = new Map<string, ParsedRepo>();
  private base: BaseGraph = { repos: [], nodes: [], edges: [] };
  private graph: Graph | null = null;
  private graphVersion = 0;
  private grouping: Grouping = defaultGrouping();
  /** Set when the stored grouping is invalid; the last good one stays in use. */
  private groupingError?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private graphListeners = new Set<() => void>();

  constructor(
    private store: ProjectStore,
    readonly projectId = 'default',
    /** What clients may do: import local folders (off for an indexer others can reach), change things without the key. */
    readonly access: WorkspaceState['access'] = { localPaths: true, keyRequired: false },
  ) {}

  /** Whether local folders can be imported and read. */
  get allowLocal(): boolean {
    return this.access.localPaths;
  }

  async init() {
    await fs.mkdir(CLONES, { recursive: true });
    // Uploads a previous run didn't finish unpacking.
    for (const name of await fs.readdir(CLONES)) {
      if (name.startsWith(UPLOAD_TMP)) await fs.rm(path.join(CLONES, name), { recursive: true, force: true });
    }
    await this.loadGrouping(true);
    this.store.watchGrouping?.(this.projectId, () => {
      this.loadGrouping(false).then(() => this.reclassify(), (err) => console.error('[strata]', err));
    });
    const saved = (await this.store.loadRepos(this.projectId)) ?? [];
    this.repos = saved.map(({ id, name, source, kind, remote, branch, commit, uploadedAt }) =>
      kind === 'upload'
        ? { id, name, source, kind, remote, branch, commit, uploadedAt, status: 'queued' as const }
        : { id, name, source, kind, status: 'queued' as const },
    );
    for (const r of this.repos) this.enqueue(r.id, false);
  }

  state(): WorkspaceState {
    return {
      repos: this.repos,
      busy: this.repos.some((r) => r.status !== 'ready' && r.status !== 'error'),
      graphVersion: this.graphVersion,
      suggestions: [...(this.allowLocal ? [PROJECT_ROOT] : []), 'fastapi/full-stack-fastapi-template'].filter((s) => !this.repos.some((r) => r.source === s || r.source.endsWith(`/${s}`))),
      project: { id: this.projectId, groupingLocation: this.store.describe(this.projectId), groupingError: this.groupingError },
      access: this.access,
      upload: UPLOAD,
    };
  }

  /** Bumps whenever the graph is rebuilt or reclassified. */
  get version(): number {
    return this.graphVersion;
  }

  /** Called after every rebuild or reclassification. */
  onGraph(fn: () => void): () => void {
    this.graphListeners.add(fn);
    return () => this.graphListeners.delete(fn);
  }

  /** Where a repository's files are on disk: the local directory, or the clone. */
  rootOf(id: string): string | null {
    const repo = this.repos.find((r) => r.id === id);
    return repo ? this.checkout(repo) : null;
  }

  /**
   * Re-indexes just these files of a local repository (read in place), after
   * something like an agent changed them. Parsing only the changed files
   * and relinking is much cheaper than reloading the repo, which only
   * happens when a manifest changed. Resolves once the graph is rebuilt.
   * Clones aren't touched: an agent edits its own checkout, not Strata's.
   */
  updateFiles(id: string, paths: string[]): Promise<void> {
    const run = async () => {
      const repo = this.repos.find((r) => r.id === id);
      const parsed = this.parsed.get(id);
      if (!repo || !parsed || repo.kind !== 'local' || repo.status !== 'ready') return;
      const started = Date.now();
      if (!(await reloadFiles(parsed, paths))) return this.process(id, false);
      console.log(`[strata] re-indexed ${paths.length} file${paths.length === 1 ? '' : 's'} in ${id} in ${Date.now() - started}ms`);
      this.rebuild();
    };
    const done = this.queue.then(run);
    this.queue = done.catch((err) => console.error('[strata]', err));
    return done.catch(() => undefined);
  }

  getGraph(): Graph {
    return this.graph ?? classifyGraph(this.base, this.grouping);
  }

  /**
   * Text of one indexed file, for the map's code view. Only files the indexer
   * parsed can be read, so nothing else in a checkout (an .env, a key) is served.
   */
  async readSource(repoId: string, relPath: string): Promise<{ path: string; commit?: string; text: string } | null> {
    const parsed = this.parsed.get(repoId);
    if (!parsed || !parsed.files.some((f) => f.path === relPath)) return null;
    const text = await fs.readFile(path.join(parsed.root, relPath), 'utf8');
    return { path: relPath, commit: parsed.info.commit, text };
  }

  getGrouping(): Grouping {
    return this.grouping;
  }

  /** Replaces the project's grouping. Throws GroupingError when it doesn't validate. */
  async setGrouping(raw: unknown): Promise<Grouping> {
    const g = normalizeGrouping(raw);
    await this.store.saveGrouping(this.projectId, g);
    this.grouping = g;
    this.groupingError = undefined;
    this.reclassify();
    return g;
  }

  /** Starts the project's layers over from a preset. Rules and pins are kept; ones naming a layer that no longer exists stop applying. */
  async applyPreset(preset: LayerPreset): Promise<Grouping> {
    return this.setGrouping({ ...this.grouping, preset, layers: presetLayers(preset, this.repos) });
  }

  private async loadGrouping(first: boolean) {
    let raw: unknown;
    try {
      raw = await this.store.loadGrouping(this.projectId);
    } catch (err) {
      this.groupingError = `Couldn't read the grouping: ${(err as Error).message}`;
      console.error(`[strata] ${this.groupingError}`);
      return;
    }
    if (raw == null) {
      // A new project starts from the roles preset.
      if (first) await this.store.saveGrouping(this.projectId, this.grouping);
      return;
    }
    try {
      this.grouping = normalizeGrouping(raw);
      this.groupingError = undefined;
    } catch (err) {
      if (!(err instanceof GroupingError)) throw err;
      this.groupingError = err.message;
      console.error(`[strata] grouping not applied: ${err.message}`);
    }
  }

  async add(input: string): Promise<RepoInfo> {
    const src = await parseSource(input, this.allowLocal);
    const existing = this.repos.find((r) => r.source === src.location);
    if (existing) {
      this.refresh(existing.id);
      return existing;
    }
    let id = slug(src.name);
    for (let n = 2; this.repos.some((r) => r.id === id); n++) id = `${slug(src.name)}-${n}`;
    const info: RepoInfo = { id, name: src.name, source: src.location, kind: src.kind, status: 'queued' };
    this.repos.push(info);
    try {
      await this.save();
    } catch (err) {
      this.repos = this.repos.filter((r) => r !== info);
      throw err;
    }
    this.enqueue(id, false);
    return info;
  }

  /**
   * Adds a folder uploaded from the map (a gzipped tar, see upload.ts), or
   * replaces one uploaded before: the one `replace` names, else the upload
   * with the same `origin` remote, else the one with the same folder name.
   * The archive is unpacked beside the clones before anything changes, so a
   * bad upload leaves the project as it was; the swap and the indexing wait
   * their turn in the queue like any other import.
   */
  async upload(rawName: string, archive: Buffer, replace?: string): Promise<RepoInfo> {
    const name = folderName(rawName);
    const tmp = path.join(CLONES, `${UPLOAD_TMP}${randomUUID()}`);
    let unpacked;
    try {
      unpacked = await unpackUpload(archive, tmp);
      // Its own repository, so git lists its files (honouring its .gitignore) rather than whatever encloses STRATA_HOME.
      await git(['-C', tmp, 'init', '-q'], 30_000);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
    const { remote, branch, head } = unpacked.git;
    const uploads = this.repos.filter((r) => r.kind === 'upload');
    const existing =
      uploads.find((r) => r.id === replace) ??
      (remote ? uploads.find((r) => r.remote && remoteKey(r.remote) === remoteKey(remote)) : undefined) ??
      uploads.find((r) => r.name === name && !(remote && r.remote));
    const fields = { name, source: name, remote, branch, commit: head?.slice(0, 7), uploadedAt: new Date().toISOString() };
    let info: RepoInfo;
    const before = existing && { ...existing };
    if (existing) {
      info = Object.assign(existing, fields, { status: 'queued' as const, error: undefined });
    } else {
      let id = slug(name);
      for (let n = 2; this.repos.some((r) => r.id === id); n++) id = `${slug(name)}-${n}`;
      info = { id, kind: 'upload', status: 'queued', ...fields };
      this.repos.push(info);
    }
    try {
      await this.save();
    } catch (err) {
      if (before) Object.assign(existing!, before);
      else this.repos = this.repos.filter((r) => r !== info);
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
    console.log(`[strata] received ${name}: ${unpacked.files} files, ${(unpacked.bytes / 1024).toFixed(0)} KB${remote ? ` from ${remote}` : ''}`);
    this.queue = this.queue
      .then(async () => {
        if (!this.repos.includes(info)) return fs.rm(tmp, { recursive: true, force: true });
        const dir = path.join(CLONES, info.id);
        try {
          await fs.rm(dir, { recursive: true, force: true });
          await fs.rename(tmp, dir);
        } catch (err) {
          await fs.rm(tmp, { recursive: true, force: true });
          Object.assign(info, { status: 'error', error: `Couldn't store the upload: ${(err as Error).message}` });
          return;
        }
        await this.process(info.id, false);
      })
      .catch((err) => console.error('[strata]', err));
    return info;
  }

  async remove(id: string) {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) return;
    const index = this.repos.indexOf(repo);
    this.repos = this.repos.filter((r) => r !== repo);
    // Persist the removal before discarding anything, so a rejected save
    // (another indexer changed the list) leaves the repo in place.
    try {
      await this.save();
    } catch (err) {
      if (!this.repos.includes(repo)) this.repos.splice(Math.min(index, this.repos.length), 0, repo);
      throw err;
    }
    this.parsed.delete(id);
    if (repo.kind !== 'local') await fs.rm(path.join(CLONES, id), { recursive: true, force: true });
    this.rebuild();
  }

  refresh(id: string) {
    const repo = this.repos.find((r) => r.id === id);
    if (repo) {
      repo.status = 'queued';
      this.enqueue(id, true);
    }
  }

  private enqueue(id: string, pull: boolean) {
    this.queue = this.queue.then(() => this.process(id, pull)).catch((err) => console.error('[strata]', err));
  }

  private checkout(repo: RepoInfo) {
    return repo.kind === 'local' ? repo.source : path.join(CLONES, repo.id);
  }

  private async process(id: string, pull: boolean) {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) return; // removed while queued
    const dir = this.checkout(repo);
    try {
      // A local folder saved to this project by an indexer on someone's machine.
      if (repo.kind === 'local' && !this.allowLocal) throw new Error(LOCAL_OFF);
      if (repo.kind === 'upload' && !(await fs.stat(path.join(dir, '.git')).then(() => true, () => false))) throw new Error(UPLOAD_GONE);
      if (repo.kind === 'git') {
        const cloned = await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
        if (!cloned) {
          repo.status = 'cloning';
          await fs.rm(dir, { recursive: true, force: true });
          await git([...authArgs(repo.source), 'clone', '--depth', '1', '--single-branch', '--', repo.source, dir]);
        } else if (pull) {
          repo.status = 'cloning';
          await git([...authArgs(repo.source), '-C', dir, 'fetch', '--depth', '1', 'origin', 'HEAD']);
          await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
        }
      }
      repo.status = 'indexing';
      // An upload has no history here; its commit is the one its .git named.
      if (repo.kind !== 'upload') repo.commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD'], 10_000).then((r) => r.stdout.trim(), () => undefined);
      const started = Date.now();
      const parsed = await loadRepo(repo, dir);
      if (!this.repos.includes(repo)) return;
      Object.assign(repo, parsed.info, { status: 'ready', error: undefined, indexedAt: new Date().toISOString() });
      parsed.info = repo;
      this.parsed.set(id, parsed);
      console.log(`[strata] indexed ${id}: ${repo.fileCount} files, ${repo.symbolCount} symbols in ${Date.now() - started}ms`);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      repo.status = 'error';
      repo.error = (e.stderr?.trim().split('\n').pop() || e.message).slice(0, 300);
      console.error(`[strata] ${id}: ${repo.error}`);
    }
    // A failed save (the database dropped, or another indexer saved first) is
    // logged rather than thrown here, so the map still rebuilds. Adding and
    // removing repos report it to the caller instead.
    await this.save().catch((err) => console.error(`[strata] couldn't save repos for project "${this.projectId}": ${(err as Error).message}`));
    this.rebuild();
  }

  private rebuild() {
    const ordered = this.repos.map((r) => this.parsed.get(r.id)).filter((p): p is ParsedRepo => !!p);
    const started = Date.now();
    this.base = buildBase(ordered);
    console.log(`[strata] linked ${this.base.nodes.length} nodes, ${this.base.edges.length} edges in ${Date.now() - started}ms`);
    this.reclassify();
  }

  private reclassify() {
    const started = Date.now();
    this.graph = classifyGraph(this.base, this.grouping);
    this.graphVersion++;
    console.log(`[strata] graph v${this.graphVersion}: classified into ${this.grouping.layers.length} layers in ${Date.now() - started}ms`);
    for (const fn of this.graphListeners) fn();
  }

  private async save() {
    await this.store.saveRepos(this.projectId, this.repos.map(saved));
  }
}
