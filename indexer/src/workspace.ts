// The set of imported repositories: where they came from, their clones on
// disk, their parsed facts, and the combined graph. Persisted to
// .strata/workspace.json so a restart re-indexes without re-cloning.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Graph, RepoInfo, Workspace as WorkspaceState } from '@strata/shared';
import { buildGraph } from './build.ts';
import type { ParsedRepo } from './model.ts';
import { loadRepo } from './sources.ts';

const exec = promisify(execFile);

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const STRATA_HOME = process.env.STRATA_HOME ?? path.join(PROJECT_ROOT, '.strata');
const CLONES = path.join(STRATA_HOME, 'repos');
const STATE = path.join(STRATA_HOME, 'workspace.json');

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
  private graph: Graph | null = null;
  private graphVersion = 0;
  private queue: Promise<unknown> = Promise.resolve();

  async init() {
    await fs.mkdir(CLONES, { recursive: true });
    const saved = await fs.readFile(STATE, 'utf8').then(JSON.parse, () => null);
    this.repos = (saved?.repos ?? []).map((r: RepoInfo) => ({ ...r, status: 'queued' as const, error: undefined }));
    for (const r of this.repos) this.enqueue(r.id, false);
  }

  state(): WorkspaceState {
    return {
      repos: this.repos,
      busy: this.repos.some((r) => r.status !== 'ready' && r.status !== 'error'),
      graphVersion: this.graphVersion,
      suggestions: [PROJECT_ROOT, 'fastapi/full-stack-fastapi-template'].filter((s) => !this.repos.some((r) => r.source === s || r.source.endsWith(`/${s}`))),
    };
  }

  getGraph(): Graph {
    return (
      this.graph ?? {
        version: 1,
        generatedAt: new Date().toISOString(),
        repos: [],
        nodes: [],
        edges: [],
        classifiers: { layer: [], domain: [] },
      }
    );
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
    await this.save();
    this.enqueue(id, false);
    return info;
  }

  async remove(id: string) {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) return;
    this.repos = this.repos.filter((r) => r.id !== id);
    this.parsed.delete(id);
    if (repo.kind === 'git') await fs.rm(path.join(CLONES, id), { recursive: true, force: true });
    await this.save();
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
    await this.save();
    this.rebuild();
  }

  private rebuild() {
    const ordered = this.repos.map((r) => this.parsed.get(r.id)).filter((p): p is ParsedRepo => !!p);
    const started = Date.now();
    this.graph = buildGraph(ordered);
    this.graphVersion++;
    console.log(`[strata] graph v${this.graphVersion}: ${this.graph.nodes.length} nodes, ${this.graph.edges.length} edges in ${Date.now() - started}ms`);
  }

  private async save() {
    const repos = this.repos.map(({ id, name, source, kind }) => ({ id, name, source, kind }));
    await fs.mkdir(STRATA_HOME, { recursive: true });
    await fs.writeFile(STATE, JSON.stringify({ repos }, null, 2));
  }
}
