// Sends events to the Strata indexer. An agent must never wait on Strata or
// fail because it's down, so every send is short and swallows errors.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AgentEvent, AgentRef } from '@strata/shared';
import { checkout, real, type Checkout } from './git.ts';

const exec = promisify(execFile);

export const STRATA_URL = (process.env.STRATA_URL ?? `http://127.0.0.1:${process.env.STRATA_INDEXER_PORT ?? 4178}`).replace(/\/+$/, '');

/** The indexer's access key, for a hosted indexer that has one. */
const KEY = process.env.STRATA_API_KEY;

/** What the indexer made of the files in a batch. */
export interface IngestReply {
  files?: { path: string; repo?: string; node?: string; kind: string; symbols?: number }[];
}

export async function send(events: AgentEvent[], timeoutMs = 1500): Promise<IngestReply | null> {
  if (!events.length) return null;
  try {
    const res = await fetch(`${STRATA_URL}/api/agent/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as IngestReply) : null;
  } catch {
    return null;
  }
}

/**
 * Who's working where: the agent's client name, the checkout its directory
 * is in, and the processes above this one (`depth` of them), which an MCP
 * server and the hooks of the same session have in common.
 */
export async function whoAndWhere(client: string, cwd: string, session?: string, depth = 3): Promise<{ agent: AgentRef; co: Checkout | null }> {
  const dir = await real(cwd);
  const [co, procs] = await Promise.all([checkout(dir), ancestors(depth)]);
  return { agent: { client, session, cwd: dir, root: co?.root, remote: co?.remote, procs: procs.length ? procs : undefined }, co };
}

/** This process's nearest ancestor pids, nearest first; empty where they can't be read. */
export async function ancestors(depth: number): Promise<number[]> {
  const out: number[] = [];
  for (let pid = process.ppid; pid > 1 && out.length < depth; ) {
    out.push(pid);
    const up = await parentOf(pid);
    if (!up) break;
    pid = up;
  }
  return out;
}

/** When a process started (ms since the epoch), or null where that can't be read. */
export async function startedAt(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    // "Sun Sep 27 10:11:07 2026", local time; C locale for English names.
    const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 1000, env: { ...process.env, LC_ALL: 'C' } });
    const t = Date.parse(stdout.trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

async function parentOf(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    // "pid (comm) state ppid …"; comm can hold spaces and parentheses.
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
  } catch {
    // No /proc (macOS): ask ps.
  }
  try {
    const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 1000 });
    return Number(stdout.trim()) || null;
  } catch {
    return null;
  }
}
