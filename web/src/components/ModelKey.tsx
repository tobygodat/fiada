// The sidebar's model key section, on an indexer people sign in to: the
// person's own Anthropic or OpenAI key, which sorts what the rules can't
// place and writes the summaries. The indexer checks it once with its
// provider; after that it stays in this browser (api.ts) and goes with each
// request, so the indexer never has to store it.

import { useState, type FormEvent } from 'react';
import { messageOf } from '@fiada/shared';
import { heldModelKey } from '../api.ts';

export function ModelKey({ onModelKey }: { onModelKey(key: string | null): Promise<void> }) {
  // Read on every render, which each poll of the workspace brings, so a key added or removed in another tab shows here too.
  const held = heldModelKey();
  const [replacing, setReplacing] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (key: string | null) => {
    setPending(true);
    setError(null);

    try {
      await onModelKey(key);
      setInput('');
      setReplacing(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();

    if (input.trim()) change(input.trim());
  };

  const keyNotice = 'Billed to your provider account. Stored in this browser only; held in indexer memory, never on disk.';

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">model key</div>
        {held && !replacing ? (
          <>
            <span className="tag" title={keyNotice}>
              {held.provider} …{held.end}
            </span>
            <button className="link" onClick={() => setReplacing(true)}>
              replace
            </button>
            <button className="link danger" disabled={pending} onClick={() => change(null)}>
              remove
            </button>
          </>
        ) : replacing ? (
          <button className="link" onClick={() => setReplacing(false)}>
            cancel
          </button>
        ) : (
          <span className="tag" title="Anthropic or OpenAI key for sorting and summaries">
            optional
          </span>
        )}
      </div>
      {(!held || replacing) && (
        <>
          <form className="import" onSubmit={save}>
            <input
              type="text"
              className="key-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="sk-ant-… or sk-…"
              aria-label="Anthropic or OpenAI API key"
              title={keyNotice}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              spellCheck={false}
            />
            <button type="submit" disabled={pending || !input.trim()}>
              {pending ? 'checking…' : 'save'}
            </button>
          </form>
          <p className="small muted account-line">Kept in this browser, never on disk · billed to your provider account.</p>
        </>
      )}
      {error && (
        <p className="notice" role="alert">
          <span className="lead">Couldn't {held && !replacing ? 'remove' : 'save'} the key.</span> {error}
        </p>
      )}
    </section>
  );
}
