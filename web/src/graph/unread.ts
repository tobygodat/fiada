// What you have read of the agents' changes. Opening a node in the detail
// panel records the latest change you saw there; a change an agent makes after
// that is unread until you open the node again. Kept in this browser, per
// project, apart from anything else that marks things read (a review tour
// keeps its own). Times are the indexer's, as the changes carry them, so a
// browser clock that runs fast or slow can't hide a change.

import type { AgentActivity, AgentFile, NodeChange } from '@fiada/shared';

/** Node id → the time (epoch ms, the indexer's clock) of the latest change seen there when it was last opened. */
export type ReadMarks = Record<string, number>;

/** Kept at most this many nodes per project; the oldest go first. */
const MAX_MARKS = 4000;

const storageKey = (project: string) => `fiada.read.${project}`;

export function loadRead(project: string): ReadMarks {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(project)) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ReadMarks = {};
    for (const [id, at] of Object.entries(raw)) if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    return out;
  } catch {
    return {};
  }
}

/** Forgets every project's read marks in this browser: the account they belonged to is gone. */
export function forgetRead(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith('fiada.read.')) localStorage.removeItem(key);
    }
  } catch {
    // storage blocked: nothing was kept
  }
}

export function saveRead(project: string, marks: ReadMarks): void {
  let entries = Object.entries(marks);
  if (entries.length > MAX_MARKS) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_MARKS);
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // private mode or full: read marks last for this tab only
  }
}

/** The file a symbol id is in (`repo/path#name` → `repo/path`); null for anything that isn't a symbol. */
const fileOf = (id: string) => {
  const hash = id.indexOf('#');
  return hash > 0 ? id.slice(0, hash) : null;
};

/**
 * Whether a change was seen: its own node was opened since, or the node that
 * shows it (the file a function is in, whose diff covers it, or the circle
 * standing in for something deleted).
 */
function seen(id: string, c: NodeChange, marks: ReadMarks): boolean {
  const file = fileOf(id);
  const at = Math.max(marks[id] ?? 0, c.anchor ? (marks[c.anchor] ?? 0) : 0, file ? (marks[file] ?? 0) : 0);
  return at >= c.at;
}

/**
 * The changed nodes you haven't seen since their latest change. A file whose
 * changed functions you've each opened counts as read too, and one with an
 * unread function in it doesn't.
 */
export function unreadIds(nodes: Record<string, NodeChange>, marks: ReadMarks): Set<string> {
  const out = new Set<string>();
  for (const [id, c] of Object.entries(nodes)) if (!seen(id, c, marks)) out.add(id);
  // Files with every changed function read, and none of the file's own change newer than theirs, are read.
  const symbols = new Map<string, { read: boolean; at: number }>();
  for (const [id, c] of Object.entries(nodes)) {
    const file = fileOf(id);
    if (!file) continue;
    const s = symbols.get(file) ?? { read: true, at: 0 };
    symbols.set(file, { read: s.read && !out.has(id), at: Math.max(s.at, c.at) });
  }
  // A file with an unread function in it is unread itself.
  for (const [file, s] of symbols) {
    if (!s.read) {
      if (nodes[file]) out.add(file);
    } else if (s.at >= (nodes[file]?.at ?? 0)) out.delete(file);
  }
  return out;
}

/**
 * Opening `id`: records the latest change shown there (its own, its functions', and anything
 * deleted it stands in for). Returns the new marks, or null when nothing new was seen.
 */
export function markRead(marks: ReadMarks, id: string, nodes: Record<string, NodeChange>): ReadMarks | null {
  let latest = 0;
  const prefix = `${id}#`;
  for (const [nid, c] of Object.entries(nodes)) {
    if (nid === id || c.anchor === id || nid.startsWith(prefix)) latest = Math.max(latest, c.at);
  }
  if (!latest || (marks[id] ?? 0) >= latest) return null;
  return { ...marks, [id]: latest };
}

/** Every change marked read. Returns the new marks, or null when everything was read already. */
export function markAllRead(marks: ReadMarks, nodes: Record<string, NodeChange>): ReadMarks | null {
  let out: ReadMarks | null = null;
  for (const [id, c] of Object.entries(nodes)) {
    if ((marks[id] ?? 0) >= c.at) continue;
    out ??= { ...marks };
    out[id] = c.at;
  }
  return out;
}

/**
 * One agent's changes marked read, at the time of its own last change to each
 * file: a node another agent changed after it stays unread. Returns the new
 * marks, or null when there was nothing new to mark.
 */
export function markAgentRead(marks: ReadMarks, a: AgentActivity): ReadMarks | null {
  let out: ReadMarks | null = null;
  for (const f of a.files) {
    const at = Date.parse(f.at);
    const file = fileTarget(f);
    if (!Number.isFinite(at) || !file) continue;
    for (const id of [file, ...f.symbols.map((s) => s.id)]) {
      if ((marks[id] ?? 0) >= at) continue;
      out ??= { ...marks };
      out[id] = at;
    }
  }
  return out;
}

/** The map id a changed file is shown at. */
export const fileTarget = (f: AgentFile) => f.node ?? (f.repo ? `${f.repo}/${f.path}` : null);

/**
 * Whether one agent's change to a file is unread for that agent: its file is
 * unread overall and you haven't opened it (or each function the agent changed
 * in it, or the circle standing in for it) since this agent's own last change.
 * Another agent's later change to the same file shows on that agent instead.
 */
export function agentFileUnread(f: AgentFile, unread: ReadonlySet<string>, marks: ReadMarks, nodes: Record<string, NodeChange>): boolean {
  const id = fileTarget(f);
  if (!id || !unread.has(id)) return false;
  const at = Date.parse(f.at);
  if (!Number.isFinite(at)) return true;
  const anchor = nodes[id]?.anchor;
  if (Math.max(marks[id] ?? 0, anchor ? (marks[anchor] ?? 0) : 0) >= at) return false;
  return !(f.symbols.length && f.symbols.every((s) => (marks[s.id] ?? 0) >= at));
}

/** How many of an agent's changed files you've read: "12 of 19 changes read". */
export function agentRead(a: AgentActivity, unread: ReadonlySet<string>, marks: ReadMarks, nodes: Record<string, NodeChange>): { read: number; total: number } {
  let read = 0;
  for (const f of a.files) if (!agentFileUnread(f, unread, marks, nodes)) read++;
  return { read, total: a.files.length };
}
