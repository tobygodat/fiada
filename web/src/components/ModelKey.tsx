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

  return (
    <section className="section">
      <div className="section-title">model key</div>
      {held && !replacing ? (
        <p className="small muted account-line">
          <span className="account-name">{held.provider}</span> key ending <span className="account-name num">{held.end}</span> sorts and summarises your map ·{' '}
          <button className="link" onClick={() => setReplacing(true)}>
            replace
          </button>
          {' · '}
          <button className="link danger" disabled={pending} onClick={() => change(null)}>
            remove
          </button>
        </p>
      ) : (
        <>
          <p className="small muted account-line">
            Without one, the rules sort your map. Add your own Anthropic or OpenAI API key to sort the rest and write summaries, on your account
            with that provider.
          </p>
          <form className="import key-form" onSubmit={save}>
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="sk-ant-… or sk-…"
              aria-label="Your Anthropic or OpenAI API key"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={pending || !input.trim()}>
              {pending ? 'checking…' : 'save'}
            </button>
          </form>
          {replacing && (
            <p className="small muted account-line">
              <button className="link" onClick={() => setReplacing(false)}>
                keep the current key
              </button>
            </p>
          )}
        </>
      )}
      <p className="small muted account-line">It stays in this browser. The indexer holds it in memory for your map alone, never on disk.</p>
      {error && (
        <p className="notice" role="alert">
          <span className="lead">Couldn't {held && !replacing ? 'remove' : 'save'} the key.</span> {error}
        </p>
      )}
    </section>
  );
}
