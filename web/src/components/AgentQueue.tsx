// The task window: a floating panel at the top right with, for each coding
// agent, a line or two on what it's doing right now, its task and plan folded
// under that, the files it has changed, and how much it has looked at. Clicking an agent lights up what
// it changed on the map and dims the rest; clicking one of its files or
// functions takes the map to it, where the detail panel shows the diff. While
// the detail panel is open the window folds to one line above it.

import { useEffect, useState } from 'react';
import type { ActivityState, AgentActivity, AgentFile, AgentNow, AgentStep } from '@fiada/shared';
import { ago } from './ago.ts';
import './agent.css';

interface Props {
  state: ActivityState | null;
  /** The detail panel is open below: fold to one line unless it's opened on purpose. */
  compact: boolean;
  /** The agent whose changes are lit on the map. */
  lit: string | null;
  /** Lights up one agent's changes on the map, or puts the map back when it's the lit one. */
  onShow(agentId: string): void;
  onSelect(nodeId: string, agentId: string): void;
  /** Dismisses an agent; absent when this browser can't change the project. */
  onClear?(agentId: string): void;
}

const SIGN = { added: '+', modified: '~', deleted: '−' } as const;
const STATE_LABEL = { working: 'working', waiting: 'waiting for you', ended: 'session ended' } as const;
/** Said for a status line the agent didn't write itself. */
const DERIVED = { plan: 'from the plan', prompt: 'from your prompt' } as const;
const MAX_STEPS = 6;
/** Changed functions listed under a file before "and N more". */
const MAX_SYMBOLS = 5;

const COLLAPSED_KEY = 'strata.queueCollapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

export function AgentQueue({ state, compact, lit, onShow, onSelect, onClear }: Props) {
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
  // An ended session with nothing left to review, and nothing it looked at, has nothing to show.
  const agents = (state?.agents ?? []).filter((a) => a.state !== 'ended' || a.files.length || a.looked?.count);
  if (!agents.length) return null;

  if (collapsed) {
    const lead = agents.find((a) => a.id === lit) ?? agents[0];
    const { state: word, text } = currentLine(lead);
    return (
      <button className="queue queue-folded" onClick={() => setCollapsed(false)} aria-expanded={false} title={`${agents.length > 1 ? `${agents.length} agents. ` : ''}Show what the agents are doing`}>
        <StateDot a={lead} />
        <span className="queue-folded-line">
          {word && <span className={`queue-state ${lead.state}`}>{word}</span>}
          {word && text ? ' · ' : ''}
          {text}
        </span>
        {agents.length > 1 && <span className="queue-folded-more">{agents.length} agents</span>}
        <span className="queue-act">show</span>
      </button>
    );
  }

  const working = agents.some((a) => a.state === 'working');
  const looked = agents.some((a) => a.looked);
  return (
    <aside className={`queue${compact ? ' over' : ''}`} aria-label="Agents">
      <div className="queue-head">
        <h2 className="queue-title">agents</h2>
        <button className="queue-act" onClick={() => setCollapsed(true)} aria-expanded>
          hide
        </button>
      </div>
      <div className="queue-list">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            a={a}
            lit={a.id === lit}
            onShow={a.files.length ? () => onShow(a.id) : undefined}
            onSelect={(id) => onSelect(id, a.id)}
            onClear={onClear && (() => onClear(a.id))}
          />
        ))}
      </div>
      <div className="queue-key" title="How the map marks what agents changed">
        <span>
          <span className="swatch-ring added" /> added
        </span>
        <span>
          <span className="swatch-ring modified" /> changed
        </span>
        <span>
          <span className="swatch-ring deleted" /> deleted
        </span>
        {working && (
          <span>
            <span className="swatch-ring working" /> working here
          </span>
        )}
        {looked && (
          <span>
            <span className="swatch-ring looked" /> looked at
          </span>
        )}
      </div>
    </aside>
  );
}

/**
 * One line for the folded window: while it works, the status line, which already says what the
 * agent is doing; else its state in words and the task.
 */
function currentLine(a: AgentActivity): { state: string | null; text: string } {
  const now = a.now?.text.split('\n')[0];
  if (a.state === 'working' && now) return { state: null, text: now };
  return { state: STATE_LABEL[a.state], text: now ?? a.task ?? a.prompt ?? '' };
}

/** Where the plan is, in words: "step 2 of 4", "4 steps done". */
function planWords(steps: AgentStep[]): string {
  const active = steps.findIndex((s) => s.status === 'active');
  if (active >= 0) return `step ${active + 1} of ${steps.length}`;
  const done = steps.filter((s) => s.status === 'done').length;
  if (done === steps.length) return `${steps.length} step${steps.length === 1 ? '' : 's'} done`;
  return `${done} of ${steps.length} done`;
}

function StateDot({ a }: { a: AgentActivity }) {
  return <span className={`queue-dot ${a.state}`} aria-hidden />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev${open ? ' open' : ''}`} viewBox="0 0 18 18" aria-hidden>
      <path d="M7 4.5 11.5 9 7 13.5" />
    </svg>
  );
}

interface CardProps {
  a: AgentActivity;
  lit: boolean;
  /** Absent when it has changed nothing there is to show. */
  onShow?(): void;
  onSelect(id: string): void;
  onClear?(): void;
}

function AgentCard({ a, lit, onShow, onSelect, onClear }: CardProps) {
  const [showFiles, setShowFiles] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showLooked, setShowLooked] = useState(false);
  // Lit on the map: its files open, to go through one by one.
  useEffect(() => {
    if (lit) setShowFiles(true);
  }, [lit]);
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const f of a.files) counts[f.kind]++;
  // The headline says what it's doing now; under it, what it was asked, unless the headline is that already.
  const asked = a.task ?? a.prompt;
  const now: AgentNow | null = a.now ?? (asked ? { text: asked, from: a.task ? 'agent' : 'prompt', at: a.updatedAt } : null);
  const context = now?.from === 'prompt' ? null : (a.task ?? (a.prompt ? `asked: ${a.prompt}` : null));
  const from = now && now.from !== 'agent' ? DERIVED[now.from] : null;
  return (
    // Anywhere on the entry but its own buttons lights it on the map; the "show on map" word below is the same for keyboards.
    <div
      className={`queue-card${lit ? ' lit' : ''}${onShow ? ' can-show' : ''}`}
      onClick={
        onShow &&
        ((e) => {
          // Not when the click ends selecting some of its words to copy.
          if (!(e.target as Element).closest('button, a') && window.getSelection()?.type !== 'Range') onShow();
        })
      }
    >
      <div className="queue-card-head">
        <StateDot a={a} />
        <span className="queue-name">{a.name}</span>
        <span className={`queue-state ${a.state}`}>{STATE_LABEL[a.state]}</span>
      </div>
      {now && (
        <p key={now.text} className={`queue-now${from ? ' derived' : ''}`} title={`${now.text}\n${from ?? 'said'} ${ago(now.at)}`} aria-live="polite">
          {now.text}
        </p>
      )}
      {(from || context) && (
        <div className="queue-task" title={a.prompt && a.task ? `Asked: ${a.prompt}` : undefined}>
          {from}
          {from && context ? ' · ' : ''}
          {context}
        </div>
      )}
      {a.note && <div className="queue-note">{a.note}</div>}
      {!!a.steps.length && (
        <div className="queue-fold">
          <button className="queue-fold-toggle" onClick={() => setShowPlan((s) => !s)} aria-expanded={showPlan}>
            <Chevron open={showPlan} />
            <span className="queue-fold-words">plan</span>
            <span className="queue-fold-count">{planWords(a.steps)}</span>
          </button>
          {showPlan && <Steps steps={a.steps} />}
        </div>
      )}
      {!!a.files.length && (
        <div className="queue-fold">
          <button className="queue-fold-toggle" onClick={() => setShowFiles((s) => !s)} aria-expanded={showFiles}>
            <Chevron open={showFiles} />
            <span className="queue-fold-words">
              {a.files.length} file{a.files.length === 1 ? '' : 's'} changed
            </span>
            <span className="queue-fold-count">
              {(['added', 'modified', 'deleted'] as const).map((k) =>
                counts[k] ? (
                  <span key={k} className={`chg ${k}`}>
                    {SIGN[k]}
                    {counts[k]}
                  </span>
                ) : null,
              )}
            </span>
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
      {a.looked && (
        <div className="queue-fold">
          <button className="queue-fold-toggle" onClick={() => setShowLooked((s) => !s)} aria-expanded={showLooked}>
            <Chevron open={showLooked} />
            <span className="queue-fold-words">
              looked at {a.looked.count} place{a.looked.count === 1 ? '' : 's'}
            </span>
          </button>
          {showLooked && (
            <div className="queue-file-list">
              {a.looked.nodes.map((id) => (
                <LookedRow key={id} id={id} onSelect={onSelect} />
              ))}
              {a.looked.count > a.looked.nodes.length && <span className="queue-sym-more">and {a.looked.count - a.looked.nodes.length} earlier</span>}
            </div>
          )}
        </div>
      )}
      <div className="queue-meta">
        <span className="queue-meta-where" title={a.cwd}>
          {a.where} · {ago(a.updatedAt)}
        </span>
        <span className="queue-acts">
          {onShow && (
            <button className="queue-act" onClick={onShow} aria-pressed={lit} title={lit ? 'Show the whole map again' : 'Light up what this agent changed on the map'}>
              {lit ? 'show all' : 'show on map'}
            </button>
          )}
          {onClear && (
            <button className="queue-act" onClick={onClear} title="Dismiss this agent and clear its changes from the map">
              dismiss
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: AgentStep['status'] }) {
  return (
    <svg className="step-icon" viewBox="0 0 18 18" aria-hidden>
      {status === 'done' ? <path d="M4.5 9.5 7.5 12.5 13.5 5.5" /> : <circle cx="9" cy="9" r={status === 'active' ? 4 : 3} />}
    </svg>
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
          <StepIcon status="done" />
          <span>{done} done</span>
        </li>
      )}
      {shown.map((s, i) => (
        <li key={s.id ?? `${i}|${s.text}`} className={`step ${s.status}`} aria-current={s.status === 'active' ? 'step' : undefined}>
          <StepIcon status={s.status} />
          <span>{s.status === 'active' ? (s.activeText ?? s.text) : s.text}</span>
        </li>
      ))}
      {hidden > 0 && <li className="step-more">and {hidden} more</li>}
    </ol>
  );
}

/** Something it looked at, by name and where it is; a way onto the map like a changed file. */
function LookedRow({ id, onSelect }: { id: string; onSelect(id: string): void }) {
  const hash = id.indexOf('#');
  const where = hash >= 0 ? id.slice(0, hash) : id.slice(0, Math.max(0, id.lastIndexOf('/')));
  const name = hash >= 0 ? id.slice(hash + 1).replace(/~\d+$/, '') : id.slice(id.lastIndexOf('/') + 1);
  return (
    <div className="queue-file-item">
      <button className="queue-file" onClick={() => onSelect(id)} title={`${id}\nlooked at, not changed`}>
        <span className="swatch-ring looked" aria-hidden />
        <span className="queue-file-name">
          <span className="queue-file-base">{name}</span>
          {where && <span className="queue-file-dir">{where}</span>}
        </span>
      </button>
    </div>
  );
}

function FileRow({ f, onSelect }: { f: AgentFile; onSelect(id: string): void }) {
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash) : '';
  const base = f.path.slice(slash + 1);
  // A deleted file isn't on the map; selecting its id lands on the folder that stands in for it.
  const target = f.node ?? (f.repo ? `${f.repo}/${f.path}` : null);
  const symbols = f.symbols.slice(0, MAX_SYMBOLS);
  return (
    <div className="queue-file-item">
      <button
        className="queue-file"
        disabled={!target}
        onClick={() => target && onSelect(target)}
        title={`${f.path}${f.symbols.length ? `\n${f.symbols.map((s) => `${SIGN[s.kind]} ${s.name}`).join('\n')}` : ''}\n${ago(f.at)}`}
      >
        <span className={`chg ${f.kind}`}>{SIGN[f.kind]}</span>
        <span className="queue-file-name">
          <span className="queue-file-base">{base}</span>
          {dir && <span className="queue-file-dir">{dir}</span>}
        </span>
        {!!(f.additions || f.deletions) && (
          <span className="queue-file-stat">
            {f.additions ? `+${f.additions}` : ''}
            {f.additions && f.deletions ? ' ' : ''}
            {f.deletions ? `−${f.deletions}` : ''}
          </span>
        )}
      </button>
      {/* The functions it changed, each one a way onto the map too. */}
      {!!symbols.length && (
        <div className="queue-syms">
          {symbols.map((s) => {
            // A deleted function isn't on the map any more: its file is, with the diff.
            const to = s.kind === 'deleted' ? target : s.id;
            return (
              <button key={s.id} className="queue-sym" disabled={!to} onClick={() => to && onSelect(to)} title={`${s.name}: ${s.kind}`}>
                <span className={`chg ${s.kind}`}>{SIGN[s.kind]}</span>
                {s.name}
              </button>
            );
          })}
          {f.symbols.length > symbols.length && <span className="queue-sym-more">and {f.symbols.length - symbols.length} more</span>}
        </div>
      )}
    </div>
  );
}

