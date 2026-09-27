// Hand edits. The indexer reads a local repository in place, so a file saved
// there in an editor should reach the map as it happens, the way an agent's
// edits do. One watcher per local repository re-indexes what changed and puts
// the files no agent reported on their own record, "You", with a diff against
// HEAD. Git's ignore rules keep dependencies and build output out. Clones
// aren't watched: nobody edits Strata's copy.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkout, describe } from '@strata/agent/git';
import type { ChangeKind, FileChange } from '@strata/shared';
import { watch, type FSWatcher } from 'chokidar';
import type { AgentHub } from './agents.ts';
import { gitIgnored, isIgnored } from './sources.ts';
import type { Workspace } from './workspace.ts';

const exec = promisify(execFile);

/**
 * Quiet time after the last save before a burst is handled. It also gives an
 * agent's hook, which reports right after its tool writes, time to claim its
 * own edits before they're taken for yours.
 */
export const SETTLE_MS = 800;
/** More files than this at once is a checkout, a pull or a build, not someone typing: re-indexed, not marked. */
const MAX_MARKED = 200;
/** Editors' swap, backup and lock files, which come and go while a file is open. */
const EDITOR_TEMP = /(^|\/)(\.[^/]*\.sw[a-p]|[^/]*~|\.#[^/]*|#[^/]*#|4913)$/;

interface Watched {
  root: string;
  watcher: FSWatcher;
  /** Repo-relative path → when it was first seen changing and how, since the last flush. */
  pending: Map<string, { seen: number; kind?: ChangeKind }>;
  timer?: NodeJS.Timeout;
}

/** Paths git ignores under `root` (folders once, not their contents), without the trailing slash; null outside a checkout. */
async function ignoredPaths(root: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await exec('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { maxBuffer: 64 << 20 });
    return new Set(stdout.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));
  } catch {
    return null;
  }
}

export class LocalWatcher {
  private watched = new Map<string, Watched | 'starting'>();
  private closed = false;

  constructor(
    private ws: Workspace,
    private hub: AgentHub,
    private settleMs = SETTLE_MS,
  ) {
    ws.onGraph(() => this.sync());
    this.sync();
  }

  /** Watches each local repository once it's indexed, and stops watching the ones removed. */
  sync() {
    if (this.closed || !this.ws.allowLocal) return;
    for (const r of this.ws.repos) {
      if (r.kind === 'local' && r.status === 'ready' && !this.watched.has(r.id)) {
        this.watched.set(r.id, 'starting');
        this.start(r.id, r.source).catch((err) => {
          this.watched.delete(r.id);
          console.error(`[strata] couldn't watch ${r.id}: ${(err as Error).message}`);
        });
      }
    }
    for (const [id, w] of this.watched) {
      if (!this.ws.repos.some((r) => r.id === id)) {
        this.watched.delete(id);
        if (w !== 'starting') this.stop(w);
      }
    }
  }

  /** Whether a repository's watcher is up. */
  isWatching(id: string): boolean {
    const w = this.watched.get(id);
    return !!w && w !== 'starting';
  }

  async close() {
    this.closed = true;
    const all = [...this.watched.values()].filter((w): w is Watched => w !== 'starting');
    this.watched.clear();
    await Promise.all(all.map((w) => this.stop(w)));
  }

  private async start(id: string, source: string) {
    const root = await fs.realpath(source);
    const ignored = await ignoredPaths(root);
    const skip = (abs: string) => {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('../')) return false;
      if (isIgnored(rel) || EDITOR_TEMP.test(rel)) return true;
      // Outside a checkout, hidden folders stay out, as they do on a full load.
      if (!ignored) return rel.split('/').some((seg) => seg.startsWith('.'));
      for (let d = rel; d && d !== '.'; d = path.posix.dirname(d)) if (ignored.has(d)) return true;
      return false;
    };
    const watcher = watch(root, { ignored: skip, ignoreInitial: true, followSymlinks: false });
    const w: Watched = { root, watcher, pending: new Map() };
    watcher.on('all', (event, abs) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const cur = w.pending.get(rel);
      // What the events say, for a folder that isn't a checkout; in one, git has the final word.
      const kind: ChangeKind | undefined = event === 'unlink' ? 'deleted' : event === 'add' ? (cur?.kind === 'deleted' ? 'modified' : 'added') : cur?.kind;
      w.pending.set(rel, { seen: cur?.seen ?? Date.now(), kind });
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => void this.flush(id, w), this.settleMs);
    });
    watcher.on('error', (err) => console.error(`[strata] watching ${id}: ${(err as Error).message}`));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    // Removed, or everything closed, while it started.
    if (this.watched.get(id) !== 'starting') return this.stop(w);
    this.watched.set(id, w);
    console.log(`[strata] watching ${id} for hand edits`);
  }

  private async stop(w: Watched) {
    if (w.timer) clearTimeout(w.timer);
    await w.watcher.close();
  }

  private async flush(id: string, w: Watched) {
    w.timer = undefined;
    const batch = [...w.pending];
    w.pending.clear();
    if (this.watched.get(id) !== w || !batch.length) return;
    if (batch.length > MAX_MARKED) {
      await this.ws.updateFiles(id, batch.map(([rel]) => rel));
      return;
    }
    const co = await checkout(w.root);
    // Ignored since the watcher started (a new build folder, say): out, as on a full load.
    const ignored = co ? await gitIgnored(w.root, batch.map(([rel]) => rel)) : new Set<string>();
    const files: FileChange[] = [];
    for (const [rel, { seen, kind }] of batch) {
      // An agent's hook reported it: the agent's edit, already on the map.
      if (ignored.has(rel) || this.hub.reportedSince(id, rel, seen - 1000)) continue;
      const change = await describe(co, path.join(w.root, rel), kind);
      if (change) files.push(change);
    }
    if (files.length) await this.hub.handEdits(w.root, files);
  }
}
