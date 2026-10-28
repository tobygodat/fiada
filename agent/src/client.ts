// Talks to the Fiada indexer: sends events, and asks the map questions for
// the MCP server's read tools. An agent must never wait on Fiada or fail
// because it's down, so every call is short and swallows errors.

import './env.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AgentEvent, AgentRef, FenceCheck, FenceVerdict } from '@fiada/shared';
import { checkout, real, type Checkout } from './git.ts';

const exec = promisify(execFile);

export const FIADA_URL = (process.env.FIADA_URL ?? `http://127.0.0.1:${process.env.FIADA_INDEXER_PORT ?? 4178}`).replace(/\/+$/, '');

/** The person's agent token for an indexer people sign in to, or a shared indexer's access key. */
const KEY = process.env.FIADA_TOKEN || process.env.FIADA_API_KEY;

/** What the indexer made of the files in a batch. */
export interface IngestReply {
  files?: { path: string; repo?: string; node?: string; kind: string; symbols?: number }[];
}

export async function send(events: AgentEvent[], timeoutMs = 1500): Promise<IngestReply | null> {
  if (!events.length) return null;

  try {
    const res = await fetch(`${FIADA_URL}/api/agent/events`, {
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

/** What the indexer said to a question, or why there's no answer. */
export type Asked<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

/** Asks the indexer's map a question (GET /api/agent/<route>). Never throws: an indexer that's down is an answer too. */
export async function ask<T>(route: 'find' | 'dependents' | 'impact', params: Record<string, string | number | undefined>, timeoutMs = 8000): Promise<Asked<T>> {
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));

  try {
    const res = await fetch(`${FIADA_URL}/api/agent/${route}?${qs}`, {
      headers: KEY ? { authorization: `Bearer ${KEY}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;

    if (res.ok && body) return { ok: true, body };

    return { ok: false, status: res.status, error: body?.error ?? `Fiada answered ${res.status}.` };
  } catch {
    return { ok: false, status: 0, error: `Fiada isn't reachable at ${FIADA_URL}.` };
  }
}

/**
 * Asks the indexer whether the fences on the map let these files change.
 * Null when Fiada didn't answer in time: the edit goes ahead as if there were no fences.
 */
export async function check(body: FenceCheck, timeoutMs = 1500): Promise<FenceVerdict | null> {
  try {
    const res = await fetch(`${FIADA_URL}/api/agent/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return res.ok ? ((await res.json()) as FenceVerdict) : null;
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
