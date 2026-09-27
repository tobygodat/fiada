// What git says about the agent's working tree: which checkout a path is in,
// what changed in a file compared to HEAD, and the tree's dirty files.
// Everything here runs in the agent's own checkout, which can be a different
// clone or worktree from the one Fiada indexed.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ChangeKind, FileChange, LineRange } from '@fiada/shared';

const exec = promisify(execFile);

/** Diffs bigger than this are cut; the map only needs enough to review. */
export const MAX_DIFF = 64 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 32 << 20,
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}
const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => null);

export interface Checkout {
  /** Absolute top level, symlinks resolved. */
  root: string;
  remote?: string;
  /** HEAD commit, when there is one. */
  head?: string;
}

/** The checkout `dir` is in, or null when it isn't in one (or git isn't installed). */
export async function checkout(dir: string): Promise<Checkout | null> {
  const top = await tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = await real(top.trim());
  const [remote, head] = await Promise.all([tryGit(root, ['remote', 'get-url', 'origin']), tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])]);
  return { root, remote: remote?.trim() || undefined, head: head?.trim() || undefined };
}

/** Resolves symlinks in as much of the path as exists (a deleted file's directory still resolves). */
export async function real(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(await real(parent), path.basename(abs));
  }
}

export interface StatusEntry {
  /** Two-letter porcelain status, e.g. " M", "??", "A ", "R ". */
  xy: string;
  /** Repo-relative, forward slashes. */
  path: string;
  /** For renames and copies, the old path. */
  from?: string;
}

/** Dirty and untracked files, from `git status --porcelain -z`. */
export async function status(root: string, only?: string[]): Promise<StatusEntry[] | null> {
  const out = await tryGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(only ? ['--', ...only] : [])]);
  return out == null ? null : parseStatus(out);
}

export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const e: StatusEntry = { xy, path: p.slice(3) };
    if (xy[0] === 'R' || xy[0] === 'C') e.from = parts[++i];
    entries.push(e);
  }
  return entries;
}

/** What a porcelain status means for the map. */
export function kindOf(xy: string): ChangeKind {
  if (xy === '??' || xy === '!!') return 'added';
  if (xy[1] === 'D' || (xy[0] === 'D' && xy[1] !== 'A')) return 'deleted';
  if (xy[0] === 'A' || xy[0] === 'R' || xy[0] === 'C') return 'added';
  return 'modified';
}

/** Changed lines, counts and a capped diff, parsed from a unified diff. */
export function parseDiff(diff: string): Pick<FileChange, 'lines' | 'oldLines' | 'additions' | 'deletions'> {
  const lines: LineRange[] = [];
  const oldLines: LineRange[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  // One run of consecutive +/- lines at a time, so a replacement is one range on each side.
  let run: { oldStart: number; newStart: number; plus: number; minus: number } | null = null;
  const flush = () => {
    if (!run) return;
    lines.push(run.plus ? [run.newStart, run.newStart + run.plus - 1] : [run.newStart, run.newStart - 1]);
    oldLines.push(run.minus ? [run.oldStart, run.oldStart + run.minus - 1] : [run.oldStart, run.oldStart - 1]);
    run = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      inHunk = false;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      flush();
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      // A hunk that starts at 0 on one side (a new or emptied file) counts from 1.
      if (oldNo === 0) oldNo = 1;
      if (newNo === 0) newNo = 1;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    const c = line[0];
    if (c === '+' || c === '-') {
      run ??= { oldStart: oldNo, newStart: newNo, plus: 0, minus: 0 };
      if (c === '+') {
        run.plus++;
        newNo++;
        additions++;
      } else {
        run.minus++;
        oldNo++;
        deletions++;
      }
    } else {
      flush();
      oldNo++;
      newNo++;
    }
  }
  flush();
  return { lines: merge(lines), oldLines: merge(oldLines), additions, deletions };
}

/** Sorts and joins overlapping or touching ranges. Empty ranges (pure removals) survive unless covered. */
export function merge(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1 && (r[1] >= r[0] || last[1] >= last[0])) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const cap = (diff: string) => (diff.length > MAX_DIFF ? `${diff.slice(0, diff.lastIndexOf('\n', MAX_DIFF))}\n… diff cut at ${MAX_DIFF / 1024} KB` : diff);

/**
 * What changed in one file compared to HEAD. `kind` is what the caller was
 * told (the agent's word, or the tool that wrote the file); git's view wins
 * when it has one. Returns null for a path git knows nothing about that
 * doesn't exist either.
 */
export async function describe(co: Checkout | null, abs: string, told?: ChangeKind): Promise<FileChange | null> {
  const exists = await fs.stat(abs).then((s) => s.isFile(), () => false);
  if (!co) return exists || told ? { path: abs, kind: told ?? 'modified' } : null;
  const rel = path.relative(co.root, abs).split(path.sep).join('/');
  if (rel.startsWith('../') || path.isAbsolute(rel)) return exists || told ? { path: abs, kind: told ?? 'modified' } : null;

  const st = await status(co.root, [rel]);
  const entry = st?.find((e) => e.path === rel);
  let kind: FileChange['kind'];
  if (entry) kind = kindOf(entry.xy);
  else if (!exists) {
    // In neither the tree nor git's status, so not in HEAD either: a new file removed again, back to what HEAD has.
    if (st) return { path: abs, kind: 'reverted' };
    return told === 'deleted' ? { path: abs, kind: 'deleted' } : null;
  } else {
    const tracked = await tryGit(co.root, ['ls-files', '--error-unmatch', '--', rel]);
    // Tracked and not in the status: it's back to what HEAD has. Untracked and not in the status: ignored.
    kind = tracked ? 'reverted' : 'added';
  }
  const change: FileChange = { path: abs, kind };
  if (kind === 'reverted') return change;

  let diff: string | null = null;
  if (kind === 'added' || !co.head) {
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text != null && !text.includes('\0')) {
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      const added = text ? body.split('\n').map((l) => `+${l}\n`) : [];
      diff = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${added.length} @@\n${added.join('')}`;
    }
  } else {
    diff = await tryGit(co.root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3', '--', rel]);
  }
  if (diff) Object.assign(change, parseDiff(diff), { diff: cap(diff) });
  return change;
}
