// Agents' changes placed on the tree the map is drawing: which nodes changed
// themselves, how many changes sit under each node, so a closed circle can say
// what's inside it, and where an agent is working right now.

import type { AgentActivity, AgentFile, ChangeKind, GraphNode, NodeChange } from '@fiada/shared';
import { locate, type Tree } from './tree.ts';

export interface Marks {
  /** The node itself was added, modified or deleted. */
  self: ChangeKind | null;
  /** Changes underneath, counted in the view's unit: files in Code, symbols in By function. */
  added: number;
  modified: number;
  deleted: number;
  /** Latest change at or under the node, epoch ms. */
  at: number;
  /** A working agent's latest change is this node ('self') or somewhere under it ('inside'). */
  here: 'self' | 'inside' | null;
}

export type TreeActivity = Map<string, Marks>;

export const changeCount = (m: Marks) => m.added + m.modified + m.deleted;

export function rollupActivity(
  tree: Tree,
  graphIndex: Map<string, GraphNode>,
  nodes: Record<string, NodeChange>,
  agents: readonly AgentActivity[] = [],
): TreeActivity {
  const out: TreeActivity = new Map();
  const get = (id: string) => {
    let m = out.get(id);
    if (!m) out.set(id, (m = { self: null, added: 0, modified: 0, deleted: 0, at: 0, here: null }));
    return m;
  };
  const unit = tree.view === 'code' ? 'file' : 'symbol';
  for (const [id, c] of Object.entries(nodes)) {
    const own = tree.nodes.get(id);
    // A node that isn't in this tree (deleted, not re-indexed yet, or a file By function
    // shows as its symbols) counts at the nearest ancestor that is.
    const at = own ? id : locate(tree, graphIndex, c.anchor ?? id);
    if (!at) continue;
    if (own) {
      const m = get(id);
      m.self = c.kind;
      m.at = Math.max(m.at, c.at);
    }
    // Symbols in Code view mark themselves but aren't counted: the file they're in is.
    const counted = c.unit === unit || (unit === 'symbol' && !!own && !own.children.length);
    for (let cur: string | null = own ? own.parent : at; cur; cur = tree.nodes.get(cur)?.parent ?? null) {
      const m = get(cur);
      if (counted) m[c.kind]++;
      m.at = Math.max(m.at, c.at);
    }
  }

  // Where each working agent is: the file it changed last (in By function, that file's changed
  // symbols), and every circle it's inside, so a closed one can show it too.
  for (const a of agents) {
    if (a.state !== 'working' || !a.files.length) continue;
    const last = Math.max(...a.files.map((f) => Date.parse(f.at)));
    for (const f of a.files) {
      if (Date.parse(f.at) !== last) continue;
      for (const id of hereIds(f, tree)) {
        const at = tree.nodes.has(id) ? id : locate(tree, graphIndex, nodes[id]?.anchor ?? id);
        if (!at || at === tree.root.id) continue;
        get(at).here = 'self';
        for (let cur = tree.nodes.get(at)?.parent ?? null; cur && cur !== tree.root.id; cur = tree.nodes.get(cur)?.parent ?? null) {
          const m = get(cur);
          m.here ??= 'inside';
        }
      }
    }
  }
  return out;
}

/** The ids that stand for a changed file in this view. */
function hereIds(f: AgentFile, tree: Tree): string[] {
  const file = f.node ?? (f.repo ? `${f.repo}/${f.path}` : null);
  if (tree.view !== 'code') {
    const symbols = f.symbols.map((s) => s.id).filter((id) => tree.nodes.has(id));
    if (symbols.length) return symbols;
  }
  return file ? [file] : [];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "2 files changed: 1 added, 1 modified" for a tooltip. */
export function describeMarks(m: Marks, view: Tree['view']): string {
  const parts: string[] = [];
  if (m.here) parts.push(m.here === 'self' ? 'an agent is working here' : 'an agent is working inside');
  if (m.self) parts.push(m.self);
  const n = changeCount(m);
  if (n) {
    const kinds = (['added', 'modified', 'deleted'] as const).filter((k) => m[k]).map((k) => `${m[k]} ${k}`);
    parts.push(`${plural(n, view === 'code' ? 'file' : 'symbol')} changed inside: ${kinds.join(', ')}`);
  }
  return parts.join(' · ');
}
