// fiada-hook: tells Fiada what an agent did, from the agent's own tool
// hooks, so the map is right even when the agent never calls the MCP tools.
//
// With no arguments it reads a hook payload on stdin and works out who sent it:
//   Claude Code  SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd
//   Cursor       beforeSubmitPrompt, afterFileEdit, stop
//
// Commands, for other agents and scripts:
//   fiada-hook changed <file>... [--kind added|modified|deleted]
//   fiada-hook task "<task>" [--step "<step text>"]
//   fiada-hook status "<what it's doing now>"
//   fiada-hook sweep     report whatever changed in the working tree since the last call
//   fiada-hook done      the agent finished its turn
//   fiada-hook codex '<json>'   Codex's `notify` program (it appends the JSON)
//   fiada-hook check <file>...  what the fences on the map say about changing these files
// Options: --client <name> (default "cli"), --session <id>, --cwd <dir>
//
// It always exits 0, so a missing or broken Fiada never gets in the agent's
// way. What it prints for the agent: the status brief on Claude Code's
// SessionStart and UserPromptSubmit, and on PreToolUse, when an edit is about
// to land inside a fence on the map, Claude Code's own decision for it ("ask"
// the person, or "deny" with the reason). Both only when Fiada answered; an
// edit outside every fence gets no answer, so the person's own permission
// settings decide as before.

import './env.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, AgentEventBody, AgentRef, AgentStep, ChangeKind, FenceCheck, FenceVerdict, FileChange, LineRange, StepStatus } from '@fiada/shared';
import { check, send, startedAt, whoAndWhere } from './client.ts';
import { checkout, describe, real, type Checkout } from './git.ts';
import { changedSince, compare, forget, load, save, take } from './snapshot.ts';

type Payload = Record<string, any>;
/** `context` is added to the agent's context, once Fiada has answered: Claude Code reads it from these hooks' output. */
type Out = { events: AgentEventBody[]; stdout?: string; context?: { event: 'SessionStart' | 'UserPromptSubmit'; text: string } };

/** What the agent is told once a session starts, so its entry in the queue always says what it's doing. */
export const STATUS_BRIEF = `The user is watching this session on Fiada, a live map of the codebase. Keep them posted: whenever you start something new or change what you're doing, call the Fiada status tool (mcp__fiada__status) with \`now\` set to one or two short, plain lines on what you're doing and why, naming the file, function or command. For example: "Reading app/api/routes/items.py to find where an item is created." Call it before your first step and at each change of step, not only at milestones; don't repeat a line that still holds. If that tool isn't available, ignore this.`;

/** The reminder with each prompt: short, since the brief came at the start. */
export const STATUS_NUDGE = `Fiada: call mcp__fiada__status with one or two short lines on what you're doing now, before you start on this and whenever that changes.`;

/** Claude Code tools that write the file named in their input. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools that can't change files; no need to look at the working tree after them. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'TaskList', 'TaskGet', 'TaskOutput', 'ExitPlanMode', 'AskUserQuestion']);

const TODO_STATUS: Record<string, StepStatus | 'removed'> = { pending: 'pending', in_progress: 'active', completed: 'done', deleted: 'removed' };

const oneLine = (s: unknown, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** The first line with anything on it: a prompt's opening says what it asks, before any pasted text. */
export const firstLine = (s: unknown, max = 300) => oneLine(String(s ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '', max);

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

/** 1-based line ranges where `needle` sits in `text`: the first place, or every place with `all`. */
export function linesOf(text: string, needle: string, all = false): LineRange[] {
  const out: LineRange[] = [];
  if (!needle) return out;
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  for (let i = text.indexOf(needle); i >= 0; i = all ? text.indexOf(needle, i + needle.length) : -1) {
    out.push([lineAt(i), lineAt(i) + needle.split('\n').length - 1]);
  }
  return out;
}

/**
 * The file a Claude Code edit tool is about to change, and the lines it
 * replaces when the tool says (Edit and MultiEdit name the text they replace).
 * Absent lines mean the whole file: Write, a notebook, or text not found.
 */
export async function aboutToEdit(tool: string, input: Payload, cwd: string): Promise<FenceCheck['files'][number] | null> {
  const file = input.file_path ?? input.notebook_path;
  if (!EDIT_TOOLS.has(tool) || typeof file !== 'string') return null;
  const abs = path.resolve(cwd, file);
  const edits: Payload[] = tool === 'Edit' ? [input] : tool === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [];
  if (!edits.length) return { path: abs };
  const text = await fs.readFile(abs, 'utf8').catch(() => null);
  if (text == null) return { path: abs };
  const lines: LineRange[] = [];
  for (const e of edits) {
    const found = typeof e.old_string === 'string' ? linesOf(text, e.old_string, e.replace_all === true) : [];
    // Text the file doesn't hold (yet: an earlier edit of the batch writes it) could be anywhere.
    if (!found.length) return { path: abs };
    lines.push(...found);
  }
  return { path: abs, lines };
}

/**
 * A file outside the agent's own checkout carries the checkout it is in, so
 * the indexer can match that one by its remote, as the post-edit sweep does.
 * A file that doesn't exist yet is placed by the nearest folder that does.
 */
export async function placed(file: FenceCheck['files'][number], co: Checkout | null): Promise<FenceCheck['files'][number]> {
  const abs = await real(file.path);
  if (co && (abs + path.sep).startsWith(co.root + path.sep)) return file;
  let dir = path.dirname(abs);
  while (dir !== path.dirname(dir) && !(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) dir = path.dirname(dir);
  const theirs = await checkout(dir).catch(() => null);
  return theirs ? { ...file, checkout: { root: theirs.root, remote: theirs.remote } } : file;
}

/** Claude Code's answer to PreToolUse for an edit inside a fence; nothing for one outside every fence. */
export function fenceAnswer(v: FenceVerdict | null): string | undefined {
  if (!v || v.decision === 'allow') return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, permissionDecisionReason: v.reason ?? 'Fenced on the Fiada map.' } });
}

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
      return { agent, out: { events, context: { event: 'SessionStart', text: STATUS_BRIEF } } };
    case 'UserPromptSubmit':
      await remember(key, co);
      events.push({ type: 'prompt', text: firstLine(p.prompt) });
      return { agent, out: { events, context: { event: 'UserPromptSubmit', text: STATUS_NUDGE } } };
    case 'PreToolUse': {
      // Before an edit lands: the fences on the map may stop it or have the person asked.
      const file = await aboutToEdit(String(p.tool_name ?? ''), (p.tool_input ?? {}) as Payload, p.cwd ?? process.cwd());
      const stdout = file ? fenceAnswer(await check({ agent, tool: p.tool_name, files: [await placed(file, co)] })) : undefined;
      return { agent, out: { events, stdout } };
    }
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
      events.push({ type: 'prompt', text: firstLine(p.prompt) }, { type: 'state', state: 'working' });
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
  const client = opts.client || process.env.FIADA_AGENT || 'cli';
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
    case 'status': {
      const text = rest.join(' ').trim();
      return text ? { agent, out: { events: [{ type: 'status', text }] } } : null;
    }
    case 'sweep':
      return { agent, out: { events: changes(await sweep(key, co)) } };
    case 'check': {
      const v = await check({ agent, files: await Promise.all(rest.map((f) => placed({ path: path.resolve(cwd, f) }, co))) });
      return { agent, out: { events: [], stdout: `${JSON.stringify(v ?? { decision: 'allow', reason: "Fiada didn't answer." })}\n` } };
    }
    case 'done':
      return { agent, out: { events: [...changes(await sweep(key, co)), { type: 'state', state: 'waiting' }] } };
    default:
      process.stderr.write(`fiada-hook: unknown command "${cmd}". Commands: changed, task, status, sweep, done, check, codex.\n`);
      return null;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv: string[]) {
  let result: { agent: AgentRef; out: Out } | null = null;
  if (argv.length) result = await fromCommand(argv);
  else {
    const raw = await readStdin();
    if (!raw.trim()) return;
    // Every payload, one per line, for seeing what an agent actually sends.
    if (process.env.FIADA_HOOK_LOG) await fs.appendFile(process.env.FIADA_HOOK_LOG, `${raw.replace(/\n/g, ' ')}\n`).catch(() => undefined);
    const p = JSON.parse(raw) as Payload;
    result = p.conversation_id != null || Array.isArray(p.workspace_roots) ? await fromCursor(p) : await fromClaude(p);
  }
  if (!result) return;
  const { agent, out } = result;
  const heard = await send(out.events.map((e): AgentEvent => ({ ...e, agent })));
  if (out.stdout) process.stdout.write(out.stdout);
  // Only when Fiada is up: otherwise the agent would be asked to report to nobody.
  if (out.context && heard) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: out.context.event, additionalContext: out.context.text } }));
}

/** Runs the hook (`fiada hook`): with no arguments it reads a payload on stdin. Always exits 0. */
export function runHook(argv: string[]) {
  main(argv)
    .catch((err) => {
      if (process.env.FIADA_DEBUG) process.stderr.write(`fiada-hook: ${(err as Error).stack}\n`);
    })
    .finally(() => process.exit(0));
}
