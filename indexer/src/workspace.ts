// One project: the repositories imported into it, their clones on disk, their
// parsed facts, its grouping (layers, rules, pins), and the combined graph.
// Repos and grouping persist through a ProjectStore, so a restart re-indexes
// without re-cloning and keeps the project's layers.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Graph, Grouping, LayerPreset, RepoInfo, Workspace as WorkspaceState } from '@strata/shared';
import { buildBase, classifyGraph, type BaseGraph } from './build.ts';
import { defaultGrouping, GroupingError, normalizeGrouping, presetLayers } from './classify/index.ts';
import type { ParsedRepo } from './model.ts';
import { loadRepo } from './sources.ts';
import type { ProjectStore } from './store.ts';

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

/**
 * Accepts what people paste: "org/repo", "github.com/org/repo",
 * "https://…/repo.git", "git@host:org/repo.git", or a local directory.
 */
export async function parseSource(input: string): Promise<RepoSource> {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('-')) throw new Error('Enter a git URL, org/repo, or a local path.');
  if (/^(~|\.{1,2})?\//.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
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

  constructor(
    private store: ProjectStore,
    readonly projectId = 'default',
  ) {}

  async init() {
    await fs.mkdir(CLONES, { recursive: true });
    await this.loadGrouping(true);
    this.store.watchGrouping?.(this.projectId, () => {
      this.loadGrouping(false).then(() => this.reclassify(), (err) => console.error('[strata]', err));
    });
    const saved = (await this.store.loadRepos(this.projectId)) ?? [];
    this.repos = saved.map(({ id, name, source, kind }) => ({ id, name, source, kind, status: 'queued' as const }));
    for (const r of this.repos) this.enqueue(r.id, false);
  }

  state(): WorkspaceState {
    return {
      repos: this.repos,
      busy: this.repos.some((r) => r.status !== 'ready' && r.status !== 'error'),
      graphVersion: this.graphVersion,
      suggestions: [PROJECT_ROOT, 'fastapi/full-stack-fastapi-template'].filter((s) => !this.repos.some((r) => r.source === s || r.source.endsWith(`/${s}`))),
      project: { id: this.projectId, groupingLocation: this.store.describe(this.projectId), groupingError: this.groupingError },
    };
  }

  getGraph(): Graph {
    return this.graph ?? classifyGraph(this.base, this.grouping);
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
    const src = await parseSource(input);
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
    if (repo.kind === 'git') await fs.rm(path.join(CLONES, id), { recursive: true, force: true });
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
      repo.commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD'], 10_000).then((r) => r.stdout.trim(), () => undefined);
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
  }

  private async save() {
    await this.store.saveRepos(
      this.projectId,
      this.repos.map(({ id, name, source, kind }) => ({ id, name, source, kind })),
    );
  }
}
