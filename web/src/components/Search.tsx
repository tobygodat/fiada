// The search box in the top bar: find a repo, folder, file or symbol by name and go to it on the map.
// "/" or Cmd/Ctrl-K focuses it, arrows move through the matches, Enter picks one, Esc lets go.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GraphNode } from '@fiada/shared';
import { searchNodes, type SearchHit } from '../graph/search.ts';

interface Props {
  nodes: GraphNode[];
  /** Open the way to `id` on the map and select it. */
  onPick(id: string): void;
}

export function Search({ nodes, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();
  const hits = useMemo(() => searchNodes(nodes, query), [nodes, query]);
  const shown = open && query.trim() !== '';
  // The matches can change under the same query (another view, a fresh graph): never point past them.
  const at = active < hits.length ? active : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Some IMEs use Ctrl-K themselves while composing (Japanese conversion): leave those keys alone.
      if (e.isComposing) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the row the arrows reach in sight when the list scrolls.
  useEffect(() => {
    if (shown) document.getElementById(`${list}-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [shown, list, at]);

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    onPick(h.id);
    setOpen(false);
    input.current?.blur();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // While an IME is composing, its keys (arrows to pick a candidate, Enter to commit, Esc to cancel) are still typing.
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();

      if (!hits.length) return;
      setOpen(true);
      setActive((at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      pick(hits[at]);
    } else if (e.key === 'Escape') {
      // Let go of the search, not the map's selection.
      e.stopPropagation();

      if (query) setQuery('');
      else input.current?.blur();
      setOpen(false);
    }
  };

  return (
    <div className="search">
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search the map"
        aria-expanded={shown}
        aria-controls={list}
        aria-activedescendant={shown && hits[at] ? `${list}-${at}` : undefined}
        aria-autocomplete="list"
        placeholder="search  /"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul className="search-hits" id={list} role="listbox" aria-label="Matches">
          {hits.length === 0 && <li className="search-none">nothing called that</li>}
          {hits.map((h, i) => (
            <li
              key={h.id}
              id={`${list}-${i}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'on' : ''}
              // Keep focus in the field so the list stays open until the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="search-name">
                <Name hit={h} />
              </span>
              <span className="search-kind">{h.kind}</span>
              {h.where && <span className="search-where">{h.where}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The name with the matched part set in the heavier weight. */
function Name({ hit }: { hit: SearchHit }) {
  if (!hit.span) return <>{hit.name}</>;
  const [a, b] = hit.span;

  return (
    <>
      {hit.name.slice(0, a)}
      <b>{hit.name.slice(a, b)}</b>
      {hit.name.slice(b)}
    </>
  );
}
