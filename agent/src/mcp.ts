// fiada-mcp: a stdio MCP server a coding agent is given, so it can tell the
// human watching Fiada what it's working on and which files it's changing,
// and ask Fiada's map about the code before it changes it.
//
// Tools that report:
//   status         one or two lines on what it's doing now; the task and plan too
//   flag_changes   files (or folders) added, modified or deleted, with symbols
// `report_task`, the older name for status, still works.
// Tools that ask the map (read-only):
//   where_is       where a feature, symbol, file or route lives: path, layer, domain, summary
//   who_uses       what calls, imports, renders or requests it, with file:line evidence
//   impact         what an edit to it reaches, following dependents across files and repos
// What it asked about is reported back as looked at, so the map can mark it.
//
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, which is all the
// MCP stdio transport is, and forwards reports to the indexer's
// /api/agent/events and questions to /api/agent/find, /dependents and
// /impact. Logging goes to stderr; stdout is the protocol.

import './env.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentRef,
  AgentStep,
  Ambiguous,
  ChangeKind,
  DependentsAnswer,
  FileChange,
  FindAnswer,
  ImpactAnswer,
  NodeRef,
  StepStatus,
} from '@fiada/shared';
import { ask, send, FIADA_URL, whoAndWhere } from './client.ts';
import { checkout, describe } from './git.ts';

const VERSION = '0.1.0';
/** Newest first. We answer with the client's version when we know it; tools work the same in all of them. */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Fiada is a live map of this codebase that the user watches while you work.
- Call status whenever you start something new or change what you're doing: \`now\` is one or two short, plain lines on what you're doing and why ("Reading the items routes to find where an item is created."). Add the task and your plan when you have them.
- Call flag_changes with the files you add, modify or delete, and the functions or classes you touched when you know them. Edits may also be picked up automatically, but deletions, renames and generated files are easy to miss, so flag them.
Both are cheap and never fail your work; if Fiada isn't running they do nothing.
- Before you search the code by hand, ask the map: where_is finds where a feature, function, file or route lives (path, layer, domain and a summary); who_uses lists what calls, imports or requests something, with the lines that prove it; impact shows what an edit to it reaches, across files and repositories. Pass the ids they return to the next one. The user sees what you looked at on the map.`;

/** Most lines, and characters per line, a status keeps: it's a headline, not a report. */
const NOW_LINES = 2;
const NOW_WIDTH = 160;

/** `now` as at most two trimmed lines, or null when there's nothing in it. */
export function nowLines(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const lines = v
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, NOW_LINES)
    .map((l) => (l.length > NOW_WIDTH ? `${l.slice(0, NOW_WIDTH - 1).trimEnd()}…` : l));
  return lines.length ? lines.join('\n') : null;
}

const STEP = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The step, as a short imperative phrase ("Add the items endpoint").' },
    status: { type: 'string', enum: ['pending', 'active', 'done'] },
  },
  required: ['text', 'status'],
} as const;

const TARGET = {
  type: 'string',
  description:
    'What to ask about: an id from where_is, a file path (absolute, or relative to the repository: "app/api/routes/items.py"), "path#symbol", or a function, class or component name.',
} as const;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const TOOLS = [
  {
    name: 'status',
    title: 'Tell the user what you are doing',
    description:
      "Show the user watching Fiada what you're doing right now. Call it when you start, and again whenever you start a new step or change what you're doing, not only at milestones. `now` is the headline of your entry in Fiada's agent queue; the task and plan are optional and go under it.",
    inputSchema: {
      type: 'object',
      properties: {
        now: {
          type: 'string',
          description:
            'One or two short lines (under about 20 words) on what you are doing right now and why, plain and specific: name the file, function or command. "Adding created_at to the Item model, then the migration." Not "Working on it" or "Using the Edit tool".',
        },
        task: { type: 'string', description: 'The whole task, under about 80 characters, when you start it.' },
        steps: { type: 'array', items: STEP, description: 'Your plan, in order, with statuses. Replaces the previous plan.' },
        done: { type: 'boolean', description: 'True when the task is finished; `now` then says what you did.' },
      },
      required: ['now'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'flag_changes',
    title: 'Flag changed files on the Fiada map',
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
  {
    name: 'where_is',
    title: 'Find where something lives in the codebase',
    description:
      "Search Fiada's map of the codebase for a feature, function, class, component, file or HTTP route by name or words (\"create item\", \"ItemsService\", \"POST /items\", \"auth\"). Returns where each match lives (repository, path and lines), its layer and domain, and a one-line summary, best match first, with ids to pass to who_uses or impact. Covers every repository imported on the map, not only this one.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name, path, route or a few words for the feature.' },
        limit: { type: 'number', description: 'Most matches to return (default 10, at most 100).' },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'who_uses',
    title: 'Find what uses a piece of code',
    description:
      'List what calls, imports, renders, references or sends HTTP requests to a function, class, file or folder, across every imported repository. Each user comes with the file:line and the code that proves the link, and whether the link is proven or inferred.',
    inputSchema: {
      type: 'object',
      properties: { target: TARGET, limit: { type: 'number', description: 'Most users to return (default 25, at most 100).' } },
      required: ['target'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'impact',
    title: 'See what an edit would reach',
    description:
      'Before changing a function, class, file or route, see what the change reaches: what uses it, what uses those, and so on, across files and repositories (HTTP clients included). Returns the reached code nearest first, with counts by repository, layer and domain.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        depth: { type: 'number', description: 'How many links out to follow (default 3, at most 6).' },
        limit: { type: 'number', description: 'Most reached places to list (default 50, at most 100).' },
      },
      required: ['target'],
    },
    annotations: READ_ONLY,
  },
];

// ── answers, as the agent reads them ──

/** "items.py:68-86" style place: repository, path and lines. */
export function place(r: NodeRef): string {
  if (r.kind === 'repo') return `repository ${r.repo}`;
  const at = r.path ? `${r.repo}/${r.path}` : r.repo;
  return r.lines ? `${at}:${r.lines[0]}${r.lines[1] > r.lines[0] ? `-${r.lines[1]}` : ''}` : at;
}

const kindWord = (r: NodeRef) => r.symbolKind ?? r.kind;
const where = (r: NodeRef) => [r.layer && `${r.layer} layer`, r.domain && `${r.domain} domain`].filter(Boolean).join(', ');

export function formatFind(a: FindAnswer): string {
  if (!a.hits.length) return `Nothing on the map matches "${a.query}". Try another name, a path, or fewer words.`;
  const lines = [`${a.hits.length}${a.more ? ` of ${a.hits.length + a.more}` : ''} match${a.hits.length + a.more === 1 ? '' : 'es'} for "${a.query}", best first:`];
  a.hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.name} (${kindWord(h)}) in ${place(h)}`);
    const placed = [where(h), h.routes?.length ? `serves ${h.routes.join(', ')}` : ''].filter(Boolean).join('; ');
    if (placed) lines.push(`   ${placed}`);
    if (h.summary) lines.push(`   ${h.summary}`);
    lines.push(`   id: ${h.id}`);
  });
  return lines.join('\n');
}

export function formatAmbiguous(a: Ambiguous): string {
  const lead = a.candidates.length === 1 ? `Nothing is "${a.query}" exactly; the closest is this one` : `"${a.query}" could be any of these`;
  return [`${lead}; ask again with one of their ids:`, ...a.candidates.map((c) => `- ${c.id} (${kindWord(c)} in ${place(c)})`)].join('\n');
}

export function formatDependents(a: DependentsAnswer): string {
  const t = a.target;
  const n = a.dependents.length + a.more;
  if (!n) return `Nothing on the map uses ${t.name} (${kindWord(t)} in ${place(t)}). It may be an entry point, used dynamically, or used from code Fiada hasn't imported.`;
  const lines = [`${n} place${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} ${t.name} (${kindWord(t)} in ${place(t)})${a.more ? `; the first ${a.dependents.length}` : ''}:`];
  for (const d of a.dependents) {
    lines.push(`- ${d.name} (${kindWord(d)}) in ${place(d)}${d.crossRepo ? `, another repository` : ''}`);
    for (const l of d.links.slice(0, 3)) {
      const into = l.to === t.id ? '' : ` ${l.to.slice(l.to.lastIndexOf('#') + 1 || l.to.lastIndexOf('/') + 1)}`;
      lines.push(`  ${l.kind}${into}, ${l.basis === 'inferred' ? `inferred${l.reason ? `: ${l.reason}` : ''}` : 'proven'}`);
      for (const e of l.evidence.slice(0, 2)) lines.push(`    ${e.file}:${e.line}${e.code ? `  ${e.code}` : ''}`);
    }
    lines.push(`  id: ${d.id}`);
  }
  return lines.join('\n');
}

const counts = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

export function formatImpact(a: ImpactAnswer): string {
  const t = a.target;
  const n = a.reached.length + a.more;
  if (!n) return `Nothing on the map uses ${t.name} (${kindWord(t)} in ${place(t)}), so an edit to it reaches nothing else that Fiada can see.`;
  const repos = Object.keys(a.byRepo).length;
  const lines = [
    `An edit to ${t.name} (${kindWord(t)} in ${place(t)}) reaches ${n} place${n === 1 ? '' : 's'} within ${a.depth} link${a.depth === 1 ? '' : 's'}${repos > 1 ? `, in ${repos} repositories` : ''}.`,
    `By repository: ${counts(a.byRepo)}.`,
    `By layer: ${counts(a.byLayer)}.`,
    `By domain: ${counts(a.byDomain)}.`,
  ];
  let depth = 0;
  for (const r of a.reached) {
    if (r.depth !== depth) {
      depth = r.depth;
      lines.push(depth === 1 ? 'Uses it directly:' : `${depth} links away:`);
    }
    lines.push(`- ${r.name} (${kindWord(r)}) in ${place(r)}: ${r.link}${r.basis === 'inferred' ? ' (inferred)' : ''}${r.crossRepo ? ', another repository' : ''}`);
  }
  if (a.more) lines.push(`…and ${a.more} more; ask with a larger limit, or a smaller depth.`);
  return lines.join('\n');
}

/** Find matches the agent is shown that count as looked at. */
const LOOKED_HITS = 5;

type Json = Record<string, any>;

const write = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const log = (...args: unknown[]) => process.stderr.write(`[fiada-mcp] ${args.join(' ')}\n`);

/** Stable client names, so the hook's events and these land on the same agent. */
export function clientId(name?: string): string {
  const n = (name ?? '').toLowerCase();
  if (n.includes('claude-code') || n === 'claude code') return 'claude-code';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('codex')) return 'codex';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp';
}

export class FiadaMcp {
  private client = 'mcp';
  private cwd = process.env.FIADA_CWD ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  private agent: Promise<AgentRef> | null = null;
  private rootsSupported = false;
  private nextId = 1;
  private pending = new Map<string, (result: Json | null) => void>();

  private out: (msg: Json) => void;
  private post: typeof send;
  private ask: typeof ask;

  constructor(out: (msg: Json) => void = write, post: typeof send = send, asker: typeof ask = ask) {
    this.out = out;
    this.post = post;
    this.ask = asker;
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
          return void reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fiada', title: 'Fiada', version: VERSION }, instructions: INSTRUCTIONS });
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
    const id = `fiada-${this.nextId++}`;
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
    if (name === 'status' || name === 'report_task') {
      const now = nowLines(args.now);
      if (name === 'status' && !now) return this.text('Pass now: one or two short lines on what you are doing.', true);
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
      // The plan first, so the line said with it is the newer of the two.
      const events: AgentEvent[] = [];
      if (ev.task !== undefined || steps || ev.step !== undefined || ev.note !== undefined || args.done || !now) events.push(ev);
      if (now) events.push({ agent, type: 'status', text: now });
      if (args.done && now) events.push({ agent, type: 'state', state: 'waiting' });
      const ok = await this.post(events);
      if (!ok) return this.text(`Fiada isn't reachable at ${FIADA_URL}; nothing to do, carry on.`);
      if (now) return this.text(args.done ? 'Shown in Fiada as done.' : 'Shown in Fiada.');
      const active = steps?.findIndex((s) => s.status === 'active') ?? -1;
      return this.text(
        args.done ? 'Marked done in Fiada.' : `Fiada shows: ${ev.task ?? 'your task'}${steps?.length ? ` (${active >= 0 ? `step ${active + 1} of ${steps.length}` : `${steps.length} steps`})` : ''}.`,
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
      if (!res) return this.text(`Fiada isn't reachable at ${FIADA_URL}; nothing to do, carry on.`);
      const mapped = res.files ?? [];
      const on = mapped.filter((m) => m.repo);
      const off = mapped.filter((m) => !m.repo);
      const parts = [];
      if (on.length) parts.push(`On the map: ${on.map((m) => `${m.path} (${m.kind}${m.symbols ? `, ${m.symbols} symbol${m.symbols === 1 ? '' : 's'}` : ''})`).join(', ')}.`);
      if (off.length) parts.push(`Not in any repository Fiada has imported: ${off.map((m) => m.path).join(', ')}.`);
      return this.text(parts.join(' ') || 'Flagged.');
    }
    if (name === 'where_is' || name === 'who_uses' || name === 'impact') return this.askMap(name, args, agent);
    return this.text(`Unknown tool ${name}.`, true);
  }

  /** A path the agent gave relative to its checkout, as the map knows it: relative to the repository. */
  private targetOf(raw: string, agent: AgentRef): string {
    const t = raw.trim();
    const hash = t.indexOf('#');
    const p = hash >= 0 ? t.slice(0, hash) : t;
    if (!path.isAbsolute(p)) return t;
    const base = agent.root ?? this.cwd;
    const rel = path.relative(base, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return t;
    return rel.split(path.sep).join('/') + (hash >= 0 ? t.slice(hash) : '');
  }

  private async askMap(name: 'where_is' | 'who_uses' | 'impact', args: Json, agent: AgentRef) {
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    let looked: string[] = [];
    let text: string;
    if (name === 'where_is') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return this.text('Pass query: a name, path, route or a few words for the feature.', true);
      const res = await this.ask<FindAnswer>('find', { q: query, limit });
      if (!res.ok) return this.text(res.error, res.status !== 0 && res.status !== 404);
      text = formatFind(res.body);
      looked = res.body.hits.slice(0, LOOKED_HITS).map((h) => h.id);
    } else {
      const target = typeof args.target === 'string' ? this.targetOf(args.target, agent) : '';
      if (!target) return this.text('Pass target: an id from where_is, a file path, "path#symbol" or a name.', true);
      const route = name === 'who_uses' ? 'dependents' : 'impact';
      const res = await this.ask<DependentsAnswer | ImpactAnswer | Ambiguous>(route, { node: target, limit, depth: name === 'impact' && typeof args.depth === 'number' ? args.depth : undefined });
      if (!res.ok) return this.text(res.error, res.status !== 0 && res.status !== 404);
      const body = res.body;
      if (body.target === null) return this.text(formatAmbiguous(body as Ambiguous));
      text = name === 'who_uses' ? formatDependents(body as DependentsAnswer) : formatImpact(body as ImpactAnswer);
      looked = [body.target.id];
    }
    // What it asked about shows on the map; never held up by it.
    if (looked.length) void this.post([{ agent, type: 'looked', nodes: looked }]);
    return this.text(text);
  }
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** Runs the MCP server (`fiada mcp`) on stdin and stdout until the client closes it. */
export async function runMcp() {
  const server = new FiadaMcp();
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
  log(`ready; sending to ${FIADA_URL}`);
}

