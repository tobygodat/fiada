// Catches changes an agent makes without an edit tool: `rm`, `git mv`, a
// code generator, `npm install` rewriting a lockfile. Each hook call records
// the working tree's dirty files; the next one reports what's different.
// State lives in a small file per agent session and checkout, because every
// hook call is a separate process.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChangeKind } from '@strata/shared';
import { kindOf, status, type Checkout } from './git.ts';

export interface Snapshot {
  head?: string;
  /** Repo-relative path → porcelain status and mtime (0 when the file is gone). */
  files: Record<string, { xy: string; mtime: number }>;
}

export const STATE_DIR = process.env.STRATA_AGENT_STATE ?? path.join(os.tmpdir(), 'strata-agent');

const stateFile = (key: string, root: string) =>
  path.join(STATE_DIR, `${createHash('sha1').update(`${key}\0${root}`).digest('hex').slice(0, 16)}.json`);

export async function take(co: Checkout): Promise<Snapshot | null> {
  const entries = await status(co.root);
  if (!entries) return null;
  const files: Snapshot['files'] = {};
  await Promise.all(
    entries.map(async (e) => {
      const mtime = await fs.stat(path.join(co.root, e.path)).then((s) => s.mtimeMs, () => 0);
      files[e.path] = { xy: e.xy, mtime };
      // A rename's old path is gone; record it so it isn't reported as reverted later.
      if (e.from) files[e.from] = { xy: ' D', mtime: 0 };
    }),
  );
  return { head: co.head, files };
}

export async function load(key: string, root: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile(key, root), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export async function save(key: string, root: string, snap: Snapshot) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const file = stateFile(key, root);
  // Write then rename, so a hook running alongside never reads half a file.
  const tmp = `${file}.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(snap));
  await fs.rename(tmp, file);
}

export async function forget(key: string, root: string) {
  await fs.rm(stateFile(key, root), { force: true });
}

/**
 * With no earlier snapshot to compare against: the dirty files changed at or
 * after `since`, going by their mtimes (for a deleted file, its folder's,
 * which moves when an entry is removed). Anything older was already there.
 */
export async function changedSince(co: Checkout, cur: Snapshot, since: number): Promise<{ path: string; kind: ChangeKind }[]> {
  const out: { path: string; kind: ChangeKind }[] = [];
  const dirs = new Map<string, Promise<number>>();
  const dirTime = (d: string) => {
    let t = dirs.get(d);
    if (!t) dirs.set(d, (t = fs.stat(path.join(co.root, d)).then((s) => s.mtimeMs, () => 0)));
    return t;
  };
  for (const [p, e] of Object.entries(cur.files)) {
    const at = e.mtime || (await dirTime(path.dirname(p)));
    if (at >= since) out.push({ path: p, kind: kindOf(e.xy) });
  }
  return out;
}

/**
 * Files whose state differs between two snapshots: newly dirty, dirty in a
 * different way, or touched again. Files that went clean without a commit
 * in between were reverted; after a commit they're just committed, and not
 * reported.
 */
export function compare(prev: Snapshot, cur: Snapshot): { path: string; kind: ChangeKind | 'reverted' }[] {
  const out: { path: string; kind: ChangeKind | 'reverted' }[] = [];
  for (const [p, e] of Object.entries(cur.files)) {
    const before = prev.files[p];
    if (!before || before.xy !== e.xy || before.mtime !== e.mtime) out.push({ path: p, kind: kindOf(e.xy) });
  }
  if (prev.head === cur.head) {
    for (const p of Object.keys(prev.files)) if (!(p in cur.files)) out.push({ path: p, kind: 'reverted' });
  }
  return out;
}
