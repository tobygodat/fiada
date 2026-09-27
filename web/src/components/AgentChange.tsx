// "Changed by Claude Code": the diff an agent made to the selected file, or
// the hunks of it that touch the selected symbol.

import { useEffect, useState } from 'react';
import type { ChangeKind } from '@strata/shared';
import { api, type AgentDiff } from '../api.ts';

interface Props {
  /** File or symbol id; the diff is the file's. */
  node: string;
  /** For a symbol: its lines, to show only the hunks that touch it. */
  lines?: [number, number];
  /** Changes when the agent changes the file again, to refetch. */
  rev: number;
  kind: ChangeKind;
}

const MAX_LINES = 500;

/** Hunks of a unified diff whose new side overlaps `lines`; all of them when none does. */
export function hunksFor(diff: string, lines?: [number, number]): string[] {
  const out = diff.split('\n');
  const start = out.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return out;
  const hunks: string[][] = [];
  for (const l of out.slice(start)) {
    if (l.startsWith('@@')) hunks.push([l]);
    else hunks[hunks.length - 1].push(l);
  }
  const last = hunks[hunks.length - 1];
  if (last[last.length - 1] === '') last.pop();
  if (!lines) return hunks.flat();
  const [a, b] = lines;
  const hit = hunks.filter((h) => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h[0]);
    if (!m) return true;
    const s = Number(m[1]);
    const e = s + Math.max(1, m[2] == null ? 1 : Number(m[2])) - 1;
    return s <= b && e >= a;
  });
  return (hit.length ? hit : hunks).flat();
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function AgentChange({ node, lines, rev, kind }: Props) {
  const [diffs, setDiffs] = useState<{ key: string; list: AgentDiff[] } | null>(null);
  const key = `${node}|${rev}`;
  useEffect(() => {
    let live = true;
    api.agentDiffs(node).then(
      (r) => live && setDiffs({ key, list: r.diffs }),
      () => live && setDiffs({ key, list: [] }),
    );
    return () => {
      live = false;
    };
  }, [key, node]);

  const list = diffs?.list ?? [];
  return (
    <div className="detail-block agent-change">
      <div className="block-title row gap">
        <span className={`chg ${kind}`}>●</span>
        <span>{kind === 'added' ? 'Added by an agent' : kind === 'deleted' ? 'Deleted by an agent' : 'Changed by an agent'}</span>
      </div>
      {!diffs && <div className="muted small">Loading the diff…</div>}
      {diffs && !list.length && <div className="muted small">No diff recorded for this change.</div>}
      {list.map((d) => {
        const shown = d.diff ? hunksFor(d.diff, lines) : [];
        return (
          <div key={d.agent} className="agent-diff">
            <div className="mono small muted agent-diff-head">
              {d.name} · {d.kind}
              {d.additions ? <span className="chg added"> +{d.additions}</span> : null}
              {d.deletions ? <span className="chg deleted"> −{d.deletions}</span> : null} · {ago(d.at)}
            </div>
            {!!shown.length && (
              <pre className="code diff">
                {shown.slice(0, MAX_LINES).map((l, i) => (
                  <div key={i} className={l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}>
                    {l || ' '}
                  </div>
                ))}
                {shown.length > MAX_LINES && <div className="muted">… {shown.length - MAX_LINES} more lines</div>}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
