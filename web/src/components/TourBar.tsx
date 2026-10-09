// The review tour's controls: a floating panel at the foot of the map while
// you walk through one agent's changes. It says which change you're on and
// how many you've read, draws one tick per change (read, unread, here), and
// steps back and forth with buttons or the arrow keys; the map and the
// detail panel show the change itself.

import { useEffect } from 'react';
import { isRead, type ReadMarks, type TourStop } from '../graph/tour.ts';
import './agent.css';
import './tour.css';

interface Props {
  agent: string;
  stops: readonly TourStop[];
  /** Index of the stop you're on. */
  at: number;
  marks: ReadMarks;
  layers: readonly { id: string; name: string }[];
  /** Detail panel open on the right: keep to the map between the panels. */
  besideDetail: boolean;
  /** The change you're on is what the map has selected; else you've gone to look at something else. */
  showing: boolean;
  onGo(i: number): void;
  onRead(i: number, read: boolean): void;
  onEnd(): void;
}

const SIGN = { added: '+', modified: '~', deleted: '−' } as const;
const VERB = { added: 'added', modified: 'changed', deleted: 'deleted' } as const;
/** More changes than this and the ticks would be too fine to point at. */
const MAX_TICKS = 80;

export function TourBar({ agent, stops, at, marks, layers, besideDetail, showing, onGo, onRead, onEnd }: Props) {
  const stop = stops[at];
  const read = stops.filter((s) => isRead(marks, s)).length;
  const here = !!stop && isRead(marks, stop);
  // Away looking at something else, you can't mark the change read unseen: r takes you back to it first.
  const readOrBack = () => (showing ? onRead(at, !here) : onGo(at));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      // Arrows belong to whatever you're typing in or stepping through (the outline).
      if (el && (el.closest('input, textarea, select, [role="tree"], [role="listbox"]') || el.isContentEditable)) return;
      if (e.key === 'ArrowRight' && at < stops.length - 1) onGo(at + 1);
      else if (e.key === 'ArrowLeft' && at > 0) onGo(at - 1);
      else if (e.key === 'r' && stop) readOrBack();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, stops.length, stop, here, showing, onGo, onRead]);

  if (!stop) return null;
  const layer = stop.layer ? layers.find((l) => l.id === stop.layer)?.name : null;
  return (
    <section className={`tour${besideDetail ? ' beside-detail' : ''}`} aria-label="Review tour">
      <div className="tour-head">
        <h2 className="tour-title">review</h2>
        <span className="tour-who">{agent}’s changes, in the order data flows</span>
        <button className="queue-act" onClick={onEnd} title="End the review (esc)">
          end
        </button>
      </div>
      {stops.length <= MAX_TICKS && (
        <div className="tour-ticks" role="group" aria-label="Changes">
          {stops.map((s, i) => (
            <button
              key={s.id}
              className={`tour-tick${isRead(marks, s) ? ' read' : ''}${i === at ? ' here' : ''}`}
              onClick={() => onGo(i)}
              aria-current={i === at ? 'step' : undefined}
              aria-label={`${i + 1}: ${s.name}, ${isRead(marks, s) ? 'read' : 'unread'}`}
              title={`${i + 1}. ${s.name} · ${VERB[s.kind]}${isRead(marks, s) ? ' · read' : ''}`}
            />
          ))}
        </div>
      )}
      <div className="tour-stop" aria-live="polite">
        <span className={`chg ${stop.kind}`} aria-label={VERB[stop.kind]}>
          {SIGN[stop.kind]}
        </span>
        <span className="tour-name">{stop.name}</span>
        {layer && <span className="tour-layer">{layer}</span>}
      </div>
      <div className="tour-path" title={`${stop.repo}/${stop.path}`}>
        <bdi>{stop.path}</bdi>
      </div>
      <div className="tour-row">
        <span className="tour-count">
          change {at + 1} of {stops.length}
          {' · '}
          {read === stops.length ? `all ${read} read` : `${read} read`}
          {here && <span className="tour-read-word"> · read</span>}
        </span>
        <span className="tour-acts">
          <button className="queue-act" onClick={() => onGo(at - 1)} disabled={at === 0} title="Previous change (←)">
            previous
          </button>
          {showing ? (
            <button className="queue-act" onClick={readOrBack} title={here ? 'Mark this change unread (r)' : 'Mark this change read and go on (r)'}>
              {here ? 'mark unread' : 'mark read'}
            </button>
          ) : (
            <button className="queue-act" onClick={readOrBack} title="Show this change again (r)">
              back to it
            </button>
          )}
          <button className="tour-next" onClick={() => onGo(at + 1)} disabled={at === stops.length - 1} title="Next change (→)">
            next
          </button>
        </span>
      </div>
      <div className="tour-keys">← → to step · r to mark read · esc to end</div>
    </section>
  );
}
