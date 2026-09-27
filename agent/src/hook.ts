// strata-hook: tells Strata what an agent did, from the agent's own tool
// hooks, so the map is right even when the agent never calls the MCP tools.
//
// With no arguments it reads a hook payload on stdin and works out who sent it:
//   Claude Code  SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd
//   Cursor       beforeSubmitPrompt, afterFileEdit, stop
//
// Commands, for other agents and scripts:
//   strata-hook changed <file>... [--kind added|modified|deleted]
//   strata-hook task "<task>" [--step "<step text>"]
//   strata-hook sweep     report whatever changed in the working tree since the last call
//   strata-hook done      the agent finished its turn
//   strata-hook codex '<json>'   Codex's `notify` program (it appends the JSON)
// Options: --client <name> (default "cli"), --session <id>, --cwd <dir>
//
// It always exits 0 and prints nothing an agent would read, so a missing or
// broken Strata never gets in the agent's way.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, AgentEventBody, AgentRef, AgentStep, ChangeKind, FileChange, StepStatus } from '@strata/shared';
import { send, startedAt, whoAndWhere } from './client.ts';
import { checkout, describe, real, type Checkout } from './git.ts';
import { changedSince, compare, forget, load, save, take } from './snapshot.ts';

type Payload = Record<string, any>;
type Out = { events: AgentEventBody[]; stdout?: string };

/** Claude Code tools that write the file named in their input. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools that can't change files; no need to look at the working tree after them. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'TaskList', 'TaskGet', 'TaskOutput', 'ExitPlanMode', 'AskUserQuestion']);

const TODO_STATUS: Record<string, StepStatus | 'removed'> = { pending: 'pending', in_progress: 'active', completed: 'done', deleted: 'removed' };

const oneLine = (s: unknown, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * What changed in the working tree since the last call, plus `explicit`
 * files a tool just wrote (which may be in another checkout entirely).
 * The first call in a session has nothing to compare with, so it only
 * records the tree and reports the explicit files, unless `since` says when
 * the session began: then files changed after that count too.
 */
export async function sweep(key: string, co: Checkout | null, explicit: string[] = [], told?: ChangeKind, since?: () => Promise<number | null>): Promise<FileChange[]> {
  const found = new Map<string, { kind?: ChangeKind | 'reverted'; swept: boolean }>();
  for (const f of explicit) found.set(await real(f), { kind: told, swept: false });
  if (co) {
    const [prev, cur] = await Promise.all([load(key, co.root), take(co)]);
    if (cur) {
      const start = !prev && since ? await since() : null;
      const seen = prev ? compare(prev, cur) : start != null ? await changedSince(co, cur, start) : [];
      for (const c of seen) if (!found.has(path.join(co.root, c.path))) found.set(path.join(co.root, c.path), { kind: c.kind, swept: true });
      await save(key, co.root, cur);
    }
  }
  const out: FileChange[] = [];
  for (const [abs, { kind, swept }] of found) {
    const inOwn = co && (abs + path.sep).startsWith(co.root + path.sep);
    const fileCo = inOwn ? co : await checkout(path.dirname(abs)).catch(() => null);
    const change = await describe(fileCo, abs, kind === 'reverted' ? undefined : kind);
    if (!change) continue;
    if (fileCo && !inOwn) change.checkout = { root: fileCo.root, remote: fileCo.remote };
    // Another agent in the same checkout may have made it: the indexer decides.
    if (swept) change.swept = true;
    out.push(change);
  }
  return out;
}

/** Records the tree without reporting it: changes made before this point aren't the agent's. */
async function remember(key: string, co: Checkout | null) {
  if (!co) return;
  const cur = await take(co);
  if (cur) await save(key, co.root, cur);
}

const changes = (files: FileChange[]): Out['events'] => (files.length ? [{ type: 'changes', files }] : []);

/** A Claude Code task id, wherever the tool's response keeps it. */
function taskId(response: unknown): string | undefined {
  const seen = new Set<unknown>();
  const find = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of ['taskId', 'id']) if (typeof o[k] === 'string' || typeof o[k] === 'number') return String(o[k]);
    for (const x of Object.values(o)) {
      const hit = find(x);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(response) ?? /Task #?(\w+)/.exec(typeof response === 'string' ? response : JSON.stringify(response ?? ''))?.[1];
}

async function claudeToolUse(p: Payload, key: string, co: Checkout | null): Promise<Out['events']> {
  const tool = String(p.tool_name ?? '');
  const input = (p.tool_input ?? {}) as Payload;
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const steps: AgentStep[] = input.todos.map((t: Payload) => ({
      id: t.id == null ? undefined : String(t.id),
      text: oneLine(t.content, 200),
      activeText: t.activeForm ? oneLine(t.activeForm, 200) : undefined,
      status: TODO_STATUS[t.status] === 'removed' ? 'done' : ((TODO_STATUS[t.status] ?? 'pending') as StepStatus),
    }));
    return [{ type: 'task', steps }];
  }
  if (tool === 'TaskCreate') {
    const id = taskId(p.tool_response);
    return id ? [{ type: 'step', id, text: oneLine(input.subject, 200), activeText: input.activeForm ? oneLine(input.activeForm, 200) : undefined, status: 'pending' }] : [];
  }
  if (tool === 'TaskUpdate' && input.taskId != null) {
    return [
      {
        type: 'step',
        id: String(input.taskId),
        text: input.subject ? oneLine(input.subject, 200) : undefined,
        activeText: input.activeForm ? oneLine(input.activeForm, 200) : undefined,
        status: TODO_STATUS[input.status],
      },
    ];
  }
  if (READ_ONLY.has(tool)) return [];
  const file = EDIT_TOOLS.has(tool) ? (input.file_path ?? input.notebook_path) : undefined;
  const cwd = p.cwd ?? process.cwd();
  const explicit = typeof file === 'string' ? [path.resolve(cwd, file)] : [];
  // Write says whether it created the file; git has the final word when it can see the file.
  const told = tool === 'Write' && p.tool_response?.type === 'create' ? 'added' : undefined;
  return changes(await sweep(key, co, explicit, told));
}

async function fromClaude(p: Payload): Promise<{ agent: AgentRef; out: Out }> {
  const { agent, co } = await whoAndWhere('claude-code', p.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), p.session_id);
  const key = `claude-code:${p.session_id ?? agent.cwd}`;
  const events: Out['events'] = [];
  switch (p.hook_event_name) {
    case 'SessionStart':
      await remember(key, co);
      events.push({ type: 'session', phase: 'start' });
      break;
    case 'UserPromptSubmit':
      await remember(key, co);
      events.push({ type: 'prompt', text: oneLine(p.prompt) });
      break;
    case 'PostToolUse':
      events.push({ type: 'state', state: 'working' }, ...(await claudeToolUse(p, key, co)));
      break;
    case 'Stop':
      events.push(...changes(await sweep(key, co)), { type: 'state', state: 'waiting' });
      break;
    case 'SessionEnd':
      events.push(...changes(await sweep(key, co)), { type: 'session', phase: 'end' });
      if (co) await forget(key, co.root);
      break;
    default:
      break;
  }
  return { agent, out: { events } };
}

async function fromCursor(p: Payload): Promise<{ agent: AgentRef; out: Out }> {
  const cwd = (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || process.cwd();
  const { agent, co } = await whoAndWhere('cursor', cwd, p.conversation_id);
  const key = `cursor:${p.conversation_id ?? agent.cwd}`;
  const events: Out['events'] = [];
  let stdout: string | undefined;
  switch (p.hook_event_name) {
    case 'beforeSubmitPrompt':
      await remember(key, co);
      events.push({ type: 'prompt', text: oneLine(p.prompt) }, { type: 'state', state: 'working' });
      stdout = JSON.stringify({ continue: true });
      break;
    case 'afterFileEdit':
      events.push({ type: 'state', state: 'working' }, ...changes(await sweep(key, co, typeof p.file_path === 'string' ? [path.resolve(cwd, p.file_path)] : [])));
      break;
    case 'stop':
      events.push(...changes(await sweep(key, co)), { type: 'state', state: 'waiting' });
      break;
    default:
      events.push(...changes(await sweep(key, co)));
  }
  return { agent, out: { events, stdout } };
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (a === '--done') opts.done = '1';
      else opts[a.slice(2)] = argv[++i] ?? '';
    } else rest.push(a);
  }
  return { opts, rest };
}

async function fromCommand(argv: string[]): Promise<{ agent: AgentRef; out: Out } | null> {
  const [cmd, ...more] = argv;
  if (cmd === 'codex') {
    // Codex runs its notify program with the event as the last argument.
    let p: Payload = {};
    try {
      p = JSON.parse(more[more.length - 1] ?? '{}');
    } catch {
      return null;
    }
    const { agent, co } = await whoAndWhere('codex', process.cwd());
    const key = `codex:${agent.cwd}`;
    const inputs = Array.isArray(p['input-messages']) ? p['input-messages'] : [];
    const events: Out['events'] = [];
    if (inputs.length) events.push({ type: 'prompt', text: oneLine(inputs[inputs.length - 1]) });
    // Codex only calls this after a turn, so the first call has no earlier tree to compare with:
    // count what changed since Codex itself started.
    events.push(...changes(await sweep(key, co, [], undefined, () => startedAt(process.ppid))), { type: 'state', state: 'waiting' });
    return { agent, out: { events } };
  }

  const { opts, rest } = parseArgs(more);
  const client = opts.client || process.env.STRATA_AGENT || 'cli';
  const { agent, co } = await whoAndWhere(client, opts.cwd || process.cwd(), opts.session);
  const key = `${client}:${opts.session ?? agent.cwd}`;
  const cwd = opts.cwd || process.cwd();
  switch (cmd) {
    case 'changed': {
      const kind = ['added', 'modified', 'deleted'].includes(opts.kind) ? (opts.kind as ChangeKind) : undefined;
      return { agent, out: { events: [{ type: 'state', state: 'working' }, ...changes(await sweep(key, co, rest.map((f) => path.resolve(cwd, f)), kind))] } };
    }
    case 'task':
      return { agent, out: { events: [{ type: 'task', task: rest.join(' ') || undefined, step: opts.step || undefined, state: opts.done ? 'waiting' : 'working' }] } };
    case 'sweep':
      return { agent, out: { events: changes(await sweep(key, co)) } };
    case 'done':
      return { agent, out: { events: [...changes(await sweep(key, co)), { type: 'state', state: 'waiting' }] } };
    default:
      process.stderr.write(`strata-hook: unknown command "${cmd}". Commands: changed, task, sweep, done, codex.\n`);
      return null;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const argv = process.argv.slice(2);
  let result: { agent: AgentRef; out: Out } | null = null;
  if (argv.length) result = await fromCommand(argv);
  else {
    const raw = await readStdin();
    if (!raw.trim()) return;
    // Every payload, one per line, for seeing what an agent actually sends.
    if (process.env.STRATA_HOOK_LOG) await fs.appendFile(process.env.STRATA_HOOK_LOG, `${raw.replace(/\n/g, ' ')}\n`).catch(() => undefined);
    const p = JSON.parse(raw) as Payload;
    result = p.conversation_id != null || Array.isArray(p.workspace_roots) ? await fromCursor(p) : await fromClaude(p);
  }
  if (!result) return;
  const { agent, out } = result;
  await send(out.events.map((e): AgentEvent => ({ ...e, agent })));
  if (out.stdout) process.stdout.write(out.stdout);
}

// Imported by the tests for `sweep`; run when started as the hook.
if (process.argv[1] && /strata-hook(\.mjs)?$|hook\.ts$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      if (process.env.STRATA_DEBUG) process.stderr.write(`strata-hook: ${(err as Error).stack}\n`);
    })
    .finally(() => process.exit(0));
}
