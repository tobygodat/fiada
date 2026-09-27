// The task queue: a small floating window at the top right with each coding
// agent's current task, its plan, and the files it has changed. Clicking a
// file takes the map to it, where the detail panel shows the diff.

import { useEffect, useState } from 'react';
import type { ActivityState, AgentActivity, AgentFile, AgentStep } from '@strata/shared';

interface Props {
  state: ActivityState | null;
  /** The detail panel is open below: show the one-line pill unless it's opened on purpose. */
  compact: boolean;
  onSelect(nodeId: string): void;
  onClear(agentId: string): void;
}

const SIGN = { added: '+', modified: '~', deleted: '−' } as const;
const STATE_LABEL = { working: 'working', waiting: 'waiting for you', ended: 'session ended' } as const;
const MAX_STEPS = 6;

const COLLAPSED_KEY = 'strata.queueCollapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

export function AgentQueue({ state, compact, onSelect, onClear }: Props) {
  const [pref, setPref] = useState(readCollapsed);
  // Opened while the detail panel is showing: stays open until closed or the panel goes.
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!compact) setPeek(false);
  }, [compact]);
  const collapsed = pref || (compact && !peek);
  const setCollapsed = (c: boolean) => {
    if (compact && !pref) return setPeek(!c);
    try {
      localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0');
    } catch {
      // private mode: remembered for this tab only
    }
    setPref(c);
  };
  // An ended session with nothing left to review has nothing to show.
  const agents = (state?.agents ?? []).filter((a) => a.state !== 'ended' || a.files.length);
  if (!agents.length) return null;

  if (collapsed) {
    const lead = agents[0];
    return (
      <button className="panel queue queue-pill" onClick={() => setCollapsed(false)} title="Show the task queue">
        <StateDot a={lead} />
        <span className="queue-pill-text">
          {agents.length > 1 ? `${agents.length} agents · ` : ''}
          {currentLine(lead)}
        </span>
      </button>
    );
  }

  return (
    <aside className={`panel queue${compact ? ' over' : ''}`}>
      <div className="queue-head">
        <span className="section-title">Agents</span>
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Collapse">
          –
        </button>
      </div>
      <div className="queue-list">
        {agents.map((a) => (
          <AgentCard key={a.id} a={a} onSelect={onSelect} onClear={() => onClear(a.id)} />
        ))}
      </div>
    </aside>
  );
}

/** One line for a collapsed queue: the active step, else the task. */
function currentLine(a: AgentActivity) {
  const active = a.steps.find((s) => s.status === 'active');
  return active ? (active.activeText ?? active.text) : (a.task ?? a.prompt ?? STATE_LABEL[a.state]);
}

function StateDot({ a }: { a: AgentActivity }) {
  return <span className={`queue-dot ${a.state}`} title={STATE_LABEL[a.state]} />;
}

function AgentCard({ a, onSelect, onClear }: { a: AgentActivity; onSelect(id: string): void; onClear(): void }) {
  const [showFiles, setShowFiles] = useState(false);
  const title = a.task ?? a.prompt;
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const f of a.files) counts[f.kind]++;
  return (
    <div className="queue-card">
      <div className="queue-card-head">
        <StateDot a={a} />
        <span className="queue-name">{a.name}</span>
        <span className="queue-where" title={a.cwd}>
          {a.where}
        </span>
        <span className="grow" />
        <span className="queue-state">{STATE_LABEL[a.state]}</span>
        <button className="icon-btn" onClick={onClear} title="Dismiss this agent and clear its changes from the map">
          ×
        </button>
      </div>
      {title && (
        <div className="queue-task" title={a.prompt && a.task ? `Asked: ${a.prompt}` : title}>
          {title}
        </div>
      )}
      {a.note && <div className="queue-note">{a.note}</div>}
      {!!a.steps.length && <Steps steps={a.steps} />}
      {!!a.files.length && (
        <div className="queue-files">
          <button className="queue-files-toggle" onClick={() => setShowFiles((s) => !s)}>
            <span>{showFiles ? '▾' : '▸'}</span>
            <span>
              {a.files.length} file{a.files.length === 1 ? '' : 's'} changed
            </span>
            <span className="grow" />
            {(['added', 'modified', 'deleted'] as const).map((k) =>
              counts[k] ? (
                <span key={k} className={`chg ${k}`}>
                  {SIGN[k]}
                  {counts[k]}
                </span>
              ) : null,
            )}
          </button>
          {showFiles && (
            <div className="queue-file-list">
              {a.files.map((f) => (
                <FileRow key={`${f.repo}|${f.path}`} f={f} onSelect={onSelect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: AgentStep[] }) {
  // Long plans: fold the finished steps into one line and keep the rest.
  const done = steps.filter((s) => s.status === 'done').length;
  const fold = steps.length > MAX_STEPS && done > 1;
  const shown = fold ? steps.filter((s) => s.status !== 'done').slice(0, MAX_STEPS - 1) : steps;
  const hidden = steps.length - (fold ? done : 0) - shown.length;
  return (
    <ol className="queue-steps">
      {fold && (
        <li className="step done">
          <span className="step-icon">✓</span>
          {done} done
        </li>
      )}
      {shown.map((s, i) => (
        <li key={s.id ?? `${i}|${s.text}`} className={`step ${s.status}`}>
          <span className="step-icon">{s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○'}</span>
          <span>{s.status === 'active' ? (s.activeText ?? s.text) : s.text}</span>
        </li>
      ))}
      {hidden > 0 && <li className="step pending">… {hidden} more</li>}
    </ol>
  );
}

function FileRow({ f, onSelect }: { f: AgentFile; onSelect(id: string): void }) {
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
  const base = f.path.slice(slash + 1);
  // A deleted file isn't on the map; selecting its id lands on the folder that stands in for it.
  const target = f.node ?? (f.repo ? `${f.repo}/${f.path}` : null);
  return (
    <button
      className="queue-file"
      disabled={!target}
      onClick={() => target && onSelect(target)}
      title={`${f.path}${f.symbols.length ? `\n${f.symbols.map((s) => `${SIGN[s.kind]} ${s.name}`).join('\n')}` : ''}\n${ago(f.at)}`}
    >
      <span className={`chg ${f.kind}`}>{SIGN[f.kind]}</span>
      <span className="queue-file-name">
        {base}
        {dir && <span className="muted">{dir.slice(0, -1)}</span>}
      </span>
      {(f.additions != null || f.deletions != null) && (
        <span className="queue-file-stat">
          {f.additions ? <span className="chg added">+{f.additions}</span> : null}
          {f.deletions ? <span className="chg deleted">−{f.deletions}</span> : null}
        </span>
      )}
    </button>
  );
}

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
