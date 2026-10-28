// "Changed by Claude Code": the diff an agent made to the selected file, or
// the hunks of it that touch the selected symbol.

import { useEffect, useState } from 'react';
import type { ChangeKind } from '@fiada/shared';
import { api, type AgentDiff } from '../api.ts';
import { shownRev, type FetchedDiffs, type ShownDiff } from '../graph/tour.ts';
import { behind, cutShort, diffRows, ownCounts, pickHunks, type HunkOwner, type Theirs } from './diff.ts';
import './agent.css';

interface Props {
  /** File or symbol id; the diff is the file's. */
  node: string;
  /** For a symbol: its lines (or, deleted, its name), to show only its own hunks. */
  own?: HunkOwner;
  /** Every changed symbol in the file: also show the hunks none of them accounts for. */
  rest?: readonly HunkOwner[];
  /** Another agent's changes in the file, whose rows are left out of this agent's diff. */
  peer?: Theirs;
  /** The changed file's path or function's name, when the panel is on something standing in for it (a deleted file's folder). */
  what?: string;
  /** Changes when the agent changes the file again, to refetch. */
  rev: number;
  kind: ChangeKind;
  /** Only this agent's diff (on a review tour); otherwise every agent's that changed the file. */
  agent?: string;
  /** Told which change of the node is on screen (null rev while it loads), and null when it goes. */
  onShown?(shown: ShownDiff | null): void;
  /** What the change reaches, in a sentence or two: who calls, imports or requests it. */
  reach?: string[];
}

const MAX_LINES = 500;

const VERB = { added: 'added', modified: 'changed', deleted: 'deleted' } as const;

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function AgentChange({ node, own, rest, peer, what, rev, kind, agent, onShown, reach = [] }: Props) {
  const [diffs, setDiffs] = useState<FetchedDiffs<AgentDiff> | null>(null);
  // Asking again after a failed request.
  const [attempt, setAttempt] = useState(0);
  // Another agent's tour of the same node is another request, whatever the file's time.
  const key = `${node}|${rev}|${agent ?? ''}`;
  // A long diff shows its first rows, and the rest on asking: nothing of the change is out of reach.
  const [whole, setWhole] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.agentDiffs(node).then(
      (r) => live && setDiffs({ node, agent, rev, list: r.diffs }),
      // Whatever of this node was on screen stays, said to be out of date.
      () => live && setDiffs((d) => ({ node, agent, rev, list: d?.node === node && d.agent === agent ? d.list : [], failed: true })),
    );

    return () => {
      live = false;
    };
  }, [key, node, agent, attempt]);

  // Only this node's diffs, fetched for this tour: the last ones stay in state until the new request lands.
  // (An older diff of this same node is fine to show while a newer one loads.)
  const ours = diffs?.node === node && diffs.agent === agent ? diffs : null;
  const mine = ours ? ours.list.filter((d) => !agent || d.agent === agent) : null;
  const list = mine ?? [];
  const picked = list.map((d) => (d.diff ? pickHunks(d.diff, own, rest, peer) : []));
  const cut = picked.some(cutShort);
  const old = list.some(behind);

  // Which change of it is on screen, so a review tour doesn't mark a newer one (or one it couldn't
  // load) read, and says when the agent cut short what it shows or sent no diff of its latest change.
  const loaded = shownRev(diffs, node, agent);
  useEffect(() => {
    onShown?.({ node, rev: loaded, ...(cut && { cut }), ...(old && { behind: old }) });
  }, [onShown, node, loaded, cut, old]);
  useEffect(() => () => onShown?.(null), [onShown]);

  return (
    <div className="detail-block agent-change">
      <div className="block-title">
        {VERB[kind]} by an agent
        {what && <bdi> · {what}</bdi>}
      </div>
      {reach.length > 0 && (
        <p className="agent-reach">
          <span className="swatch-ring reached" aria-hidden />
          <span>{reach.join(' ')}</span>
        </p>
      )}
      {!mine && <div className="agent-note">loading the diff…</div>}
      {ours?.failed && (
        <div className="agent-note">
          The diff couldn't be loaded{list.length ? '; this is the one from before' : ''}.{' '}
          <button className="link" onClick={() => setAttempt((n) => n + 1)}>
            try again
          </button>
        </div>
      )}
      {mine && !list.length && !ours?.failed && <div className="agent-note">No diff was recorded for this change.</div>}
      {list.map((d, k) => {
        const shown = diffRows(picked[k]);
        const n = ownCounts(d, peer, [...(own ? [own] : []), ...(rest ?? [])]);

        return (
          <div key={d.agent} className="agent-diff">
            <div className="agent-diff-head">
              <span className={`swatch-ring ${d.kind}`} aria-hidden />
              <span>
                <b>{d.name}</b> {VERB[d.kind]} this file
                {n?.additions || n?.deletions ? ` · ${[n.additions ? `+${n.additions}` : '', n.deletions ? `−${n.deletions}` : ''].filter(Boolean).join(' ')}` : ''} · {ago(d.at)}
                {behind(d) && ' · this diff is from before its latest change, which came without one'}
              </span>
            </div>
            {!!shown.length && (
              <pre className="code diff">
                {(whole === `${key}|${d.agent}` ? shown : shown.slice(0, MAX_LINES)).map((r, i) =>
                  r.t === 'hunk' ? (
                    <div key={i} className="hunk">
                      <span className="hunk-at">line {r.line}</span>
                      {r.context && <span>{r.context}</span>}
                    </div>
                  ) : (
                    <div key={i} className={r.t}>
                      <span className="gut">{r.sign}</span>
                      <span>{r.text || ' '}</span>
                    </div>
                  ),
                )}
                {shown.length > MAX_LINES && whole !== `${key}|${d.agent}` && (
                  <div className="more">
                    <button className="link" onClick={() => setWhole(`${key}|${d.agent}`)}>
                      show {shown.length - MAX_LINES} more lines
                    </button>
                  </div>
                )}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
