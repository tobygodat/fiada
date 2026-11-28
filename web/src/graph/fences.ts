// Fences and where agents meet, for the map and the agents window. Which fence a node sits in. A fence covers its own circle and everything
// inside it; node ids nest ("repo/folder/file.ts#symbol"), so the fences round
// a node are the ones whose id begins its own. Off limits beats ask first,
// and on a tie the nearest wins, as the indexer decides (indexer/src/fences.ts).

import type { Collision, Fence, FenceHit } from '@fiada/shared';

/** Whether `fence` is round `id`, not on it. */
export const encloses = (fence: Fence, id: string) => id.startsWith(`${fence.node}/`) || id.startsWith(`${fence.node}#`);

/** The fence that decides for edits inside a fenced ancestor of `id`; null when none is round it. */
export function fenceAround(fences: readonly Fence[], id: string): Fence | null {
  let best: Fence | null = null;

  for (const f of fences) {
    if (!encloses(f, id)) continue;

    if (!best || (f.rule !== best.rule ? f.rule === 'off' : f.node.length > best.node.length)) best = f;
  }

  return best;
}

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five'];
const count = (n: number) => COUNT[n] ?? String(n);
const RULE_WORDS = { ask: 'ask-first', off: 'off-limits' } as const;

/** "two agents in fastapi/backend/app/api/routes": where agents' changes meet, as the map names it; `short` names only the last part. */
export const collisionWords = (c: Collision, short = false) => `${count(c.agents.length)} agents in ${short ? c.node.slice(c.node.lastIndexOf('/') + 1) : c.node}`;

/** What happened at a fence, in words: "blocked edit to config.py: off-limits (api/app/core)". */
export function fenceWords(h: FenceHit): string {
  const base = h.file.slice(h.file.lastIndexOf('/') + 1);
  const where = h.node === h.file ? '' : ` (${h.node})`;

  return h.decision === 'deny' ? `blocked edit to ${base}: ${RULE_WORDS[h.rule]}${where}` : `asked before editing ${base}: ${RULE_WORDS[h.rule]}${where}`;
}
