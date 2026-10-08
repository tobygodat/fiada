// "Changed by Claude Code": the diff an agent made to the selected file, or
// the hunks of it that touch the selected symbol.

import { useEffect, useState } from 'react';
import type { ChangeKind } from '@fiada/shared';
import { api, type AgentDiff } from '../api.ts';
import { diffRows, hunksFor } from './diff.ts';
import './agent.css';

interface Props {
  /** File or symbol id; the diff is the file's. */
  node: string;
  /** For a symbol: its lines, to show only the hunks that touch it. */
  lines?: [number, number];
  /** Changes when the agent changes the file again, to refetch. */
  rev: number;
  kind: ChangeKind;
  /** Only this agent's diff (on a review tour); otherwise every agent's that changed the file. */
  agent?: string;
}

const MAX_LINES = 500;

const VERB = { added: 'added', modified: 'changed', deleted: 'deleted' } as const;

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function AgentChange({ node, lines, rev, kind, agent }: Props) {
  const [diffs, setDiffs] = useState<{ node: string; list: AgentDiff[] } | null>(null);
  const key = `${node}|${rev}`;
  useEffect(() => {
    let live = true;
    api.agentDiffs(node).then(
      (r) => live && setDiffs({ node, list: r.diffs }),
      () => live && setDiffs({ node, list: [] }),
    );
    return () => {
      live = false;
    };
  }, [key, node]);

  // Only this node's diffs: the last node's stay in state until the new request lands.
  // (An older diff of this same node is fine to show while a newer one loads.)
  const mine = diffs?.node === node ? diffs.list.filter((d) => !agent || d.agent === agent) : null;
  const list = mine ?? [];
  return (
    <div className="detail-block agent-change">
      <div className="block-title">{VERB[kind]} by an agent</div>
      {!mine && <div className="agent-note">loading the diff…</div>}
      {mine && !list.length && <div className="agent-note">No diff was recorded for this change.</div>}
      {list.map((d) => {
        const shown = d.diff ? diffRows(hunksFor(d.diff, lines)) : [];
        return (
          <div key={d.agent} className="agent-diff">
            <div className="agent-diff-head">
              <span className={`swatch-ring ${d.kind}`} aria-hidden />
              <span>
                <b>{d.name}</b> {VERB[d.kind]} this file
                {d.additions || d.deletions ? ` · ${[d.additions ? `+${d.additions}` : '', d.deletions ? `−${d.deletions}` : ''].filter(Boolean).join(' ')}` : ''} · {ago(d.at)}
              </span>
            </div>
            {!!shown.length && (
              <pre className="code diff">
                {shown.slice(0, MAX_LINES).map((r, i) =>
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
                {shown.length > MAX_LINES && <div className="more">and {shown.length - MAX_LINES} more lines</div>}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
