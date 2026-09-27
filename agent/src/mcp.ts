// strata-mcp: a stdio MCP server a coding agent is given, so it can tell the
// human watching Strata what it's working on and which files it's changing.
//
// Two tools:
//   report_task    the task, the plan as steps, which step is active
//   flag_changes   files (or folders) added, modified or deleted, with symbols
//
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, which is all the
// MCP stdio transport is, and forwards everything to the indexer's
// /api/agent/events. Logging goes to stderr; stdout is the protocol.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRef, AgentStep, ChangeKind, FileChange, StepStatus } from '@strata/shared';
import { send, STRATA_URL, whoAndWhere } from './client.ts';
import { checkout, describe } from './git.ts';

const VERSION = '0.1.0';
/** Newest first. We answer with the client's version when we know it; tools work the same in all of them. */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Strata is a live map of this codebase that the user watches while you work.
- Call report_task when you start a task: a short task title and your plan as steps. Call it again each time a step starts or finishes, so the user can follow along.
- Call flag_changes with the files you add, modify or delete, and the functions or classes you touched when you know them. Edits may also be picked up automatically, but deletions, renames and generated files are easy to miss, so flag them.
Both are cheap and never fail your work; if Strata isn't running they do nothing.`;

const STEP = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The step, as a short imperative phrase ("Add the items endpoint").' },
    status: { type: 'string', enum: ['pending', 'active', 'done'] },
  },
  required: ['text', 'status'],
} as const;

const TOOLS = [
  {
    name: 'report_task',
    title: 'Report your task to Strata',
    description:
      "Show the user what you're working on in Strata's task queue. Send the task and your plan when you start, then call again whenever a step starts or finishes (send the whole plan with updated statuses, or just `step` for the one you're on). Set done when the task is finished.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What you are working on, under about 80 characters.' },
        steps: { type: 'array', items: STEP, description: 'Your plan, in order. Replaces the previous plan.' },
        step: { type: 'string', description: "The step you're on now, when you aren't sending the whole plan." },
        done: { type: 'boolean', description: 'True when the task is finished.' },
        note: { type: 'string', description: 'One line for the user, such as a blocker or a question.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'flag_changes',
    title: 'Flag changed files on the Strata map',
    description:
      "Mark files you added, modified or deleted so they light up on the user's map of the codebase. Paths can be absolute or relative to your working directory; a folder flags the module. Include the names of functions, classes or components you touched when you know them.",
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              change: { type: 'string', enum: ['added', 'modified', 'deleted'] },
              symbols: { type: 'array', items: { type: 'string' }, description: 'Function, class or component names in that file.' },
            },
            required: ['path', 'change'],
          },
        },
      },
      required: ['files'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

type Json = Record<string, any>;

const write = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const log = (...args: unknown[]) => process.stderr.write(`[strata-mcp] ${args.join(' ')}\n`);

/** Stable client names, so the hook's events and these land on the same agent. */
export function clientId(name?: string): string {
  const n = (name ?? '').toLowerCase();
  if (n.includes('claude-code') || n === 'claude code') return 'claude-code';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('codex')) return 'codex';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp';
}

export class StrataMcp {
  private client = 'mcp';
  private cwd = process.env.STRATA_CWD ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  private agent: Promise<AgentRef> | null = null;
  private rootsSupported = false;
  private nextId = 1;
  private pending = new Map<string, (result: Json | null) => void>();

  private out: (msg: Json) => void;
  private post: typeof send;

  constructor(out: (msg: Json) => void = write, post: typeof send = send) {
    this.out = out;
    this.post = post;
  }

  private who(): Promise<AgentRef> {
    // Claude Code tells the servers it starts which session they serve. Elsewhere the client
    // starts this server itself, so its nearest ancestors are the ones its hooks share.
    const session = this.client === 'claude-code' ? process.env.CLAUDE_CODE_SESSION_ID || undefined : undefined;
    return (this.agent ??= whoAndWhere(this.client, this.cwd, session, 2).then((w) => w.agent));
  }

  async handle(msg: Json): Promise<void> {
    if (msg.method == null) {
      // A response to a request we made.
      const done = this.pending.get(String(msg.id));
      this.pending.delete(String(msg.id));
      done?.(msg.result ?? null);
      return;
    }
    const reply = (result: Json) => msg.id != null && this.out({ id: msg.id, result });
    const fail = (code: number, message: string) => msg.id != null && this.out({ id: msg.id, error: { code, message } });
    try {
      switch (msg.method) {
        case 'initialize': {
          const p = msg.params ?? {};
          this.client = clientId(p.clientInfo?.name);
          this.rootsSupported = !!p.capabilities?.roots;
          const protocolVersion = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
          return void reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'strata', title: 'Strata', version: VERSION }, instructions: INSTRUCTIONS });
        }
        case 'notifications/initialized':
        case 'notifications/roots/list_changed':
          if (this.rootsSupported) void this.askRoots();
          return;
        case 'ping':
          return void reply({});
        case 'tools/list':
          return void reply({ tools: TOOLS });
        case 'tools/call':
          return void reply(await this.call(msg.params?.name, msg.params?.arguments ?? {}));
        default:
          if (String(msg.method).startsWith('notifications/')) return;
          return void fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      fail(-32603, (err as Error).message);
    }
  }

  /** The client's workspace folder beats our cwd, which some clients set to somewhere unrelated. */
  private async askRoots() {
    const id = `strata-${this.nextId++}`;
    const result = await new Promise<Json | null>((resolve) => {
      this.pending.set(id, resolve);
      this.out({ id, method: 'roots/list' });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), resolve(null)), 5000);
    });
    const uri = result?.roots?.find((r: Json) => typeof r?.uri === 'string' && r.uri.startsWith('file://'))?.uri;
    if (!uri) return;
    this.cwd = fileURLToPath(uri);
    this.agent = null;
  }

  private text(text: string, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
  }

  async call(name: string, args: Json) {
    const agent = await this.who();
    if (name === 'report_task') {
      const steps: AgentStep[] | undefined = Array.isArray(args.steps)
        ? args.steps
            .filter((s: Json) => s && typeof s.text === 'string')
            .map((s: Json) => ({ text: s.text.slice(0, 200), status: (['pending', 'active', 'done'].includes(s.status) ? s.status : 'pending') as StepStatus }))
        : undefined;
      const ev: AgentEvent = {
        agent,
        type: 'task',
        task: typeof args.task === 'string' ? args.task.slice(0, 200) : undefined,
        steps,
        step: typeof args.step === 'string' ? args.step.slice(0, 200) : undefined,
        note: typeof args.note === 'string' ? args.note.slice(0, 300) : undefined,
        state: args.done ? 'waiting' : 'working',
      };
      const ok = await this.post([ev]);
      if (!ok) return this.text(`Strata isn't reachable at ${STRATA_URL}; nothing to do, carry on.`);
      const active = steps?.findIndex((s) => s.status === 'active') ?? -1;
      return this.text(
        args.done ? 'Marked done in Strata.' : `Strata shows: ${ev.task ?? 'your task'}${steps?.length ? ` (${active >= 0 ? `step ${active + 1} of ${steps.length}` : `${steps.length} steps`})` : ''}.`,
      );
    }
    if (name === 'flag_changes') {
      const list = Array.isArray(args.files) ? args.files : [];
      if (!list.length) return this.text('Pass files: [{ path, change }].', true);
      const files: FileChange[] = [];
      for (const f of list) {
        if (!f || typeof f.path !== 'string') continue;
        const told: ChangeKind = ['added', 'modified', 'deleted'].includes(f.change) ? f.change : 'modified';
        const abs = path.resolve(agent.root && !path.isAbsolute(f.path) && !(await exists(path.resolve(this.cwd, f.path))) ? agent.root : this.cwd, f.path);
        const isDir = await fs.stat(abs).then((s) => s.isDirectory(), () => false);
        const co = await checkout(isDir ? abs : path.dirname(abs)).catch(() => null);
        let change = isDir ? null : await describe(co, abs, told);
        // Flagged before the edit landed, or git can't see it: the agent's word stands.
        if (!change || change.kind === 'reverted') change = { path: abs, kind: told };
        if (Array.isArray(f.symbols)) change.symbols = f.symbols.filter((s: unknown) => typeof s === 'string').slice(0, 50);
        if (co && co.root !== agent.root) change.checkout = { root: co.root, remote: co.remote };
        files.push(change);
      }
      const res = await this.post([{ agent, type: 'changes', files }, { agent, type: 'state', state: 'working' }]);
      if (!res) return this.text(`Strata isn't reachable at ${STRATA_URL}; nothing to do, carry on.`);
      const mapped = res.files ?? [];
      const on = mapped.filter((m) => m.repo);
      const off = mapped.filter((m) => !m.repo);
      const parts = [];
      if (on.length) parts.push(`On the map: ${on.map((m) => `${m.path} (${m.kind}${m.symbols ? `, ${m.symbols} symbol${m.symbols === 1 ? '' : 's'}` : ''})`).join(', ')}.`);
      if (off.length) parts.push(`Not in any repository Strata has imported: ${off.map((m) => m.path).join(', ')}.`);
      return this.text(parts.join(' ') || 'Flagged.');
    }
    return this.text(`Unknown tool ${name}.`, true);
  }
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function main() {
  const server = new StrataMcp();
  const inflight = new Set<Promise<void>>();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Batches are allowed by older protocol versions.
      for (const m of Array.isArray(msg) ? msg : [msg]) {
        const p = server.handle(m).finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  });
  // The client closed our stdin: answer what's in flight, then go.
  process.stdin.on('end', () => void Promise.allSettled([...inflight]).then(() => process.exit(0)));
  log(`ready; sending to ${STRATA_URL}`);
}

if (process.argv[1] && /strata-mcp(\.mjs)?$|mcp\.ts$/.test(process.argv[1])) void main();
