// The sidebar's last section: connecting a coding agent to this map, and who
// is signed in. The setup command carries the indexer's address and the
// person's agent token, so running it once is all an agent needs: no
// variables to set by hand.

import { useState } from 'react';
import { messageOf, type AgentConnection, type Workspace } from '@fiada/shared';
import { api, heldModelKey, sharedKey, signOut } from '../api.ts';
import { forgetRead } from '../graph/unread.ts';
import { setupCommand } from '../connect.ts';
import { forgetMarks } from '../graph/tour.ts';

export function Account({ workspace }: { workspace: Workspace | null }) {
  const [open, setOpen] = useState(false);
  const [conn, setConn] = useState<AgentConnection | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const account = workspace?.account;

  const show = async () => {
    setOpen((o) => !o);

    if (conn) return;

    try {
      setConn(await api.agentConnection());
    } catch (err) {
      setError(messageOf(err));
    }
  };

  // A shared indexer with a key: the agent needs the key this browser was given.
  const command = conn && setupCommand(conn, conn.token ?? sharedKey() ?? undefined);

  const copy = async () => {
    if (!command) return;

    try {
      await navigator.clipboard.writeText(command);
      setSaid('copied');
    } catch {
      setSaid('select and copy it');
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete your Fiada account? This permanently removes your map, imports, clones and summaries, and asks GitHub to revoke access.')) return;

    try {
      await api.deleteAccount();
      forgetRead();
      forgetMarks();
      signOut();
    } catch (err) {
      setDeleteError(messageOf(err));
    }
  };

  // The indexer forgets the model key now, rather than when the project next closes.
  const leave = async () => {
    if (heldModelKey()) await api.removeModelKey().catch(() => undefined);
    signOut();
  };

  const reset = async () => {
    try {
      setConn(await api.resetAgentToken());
      setSaid('token rotated; old agents disconnected');
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">agents</div>
        <button className="link" aria-expanded={open} aria-label={open ? 'hide setup' : undefined} onClick={show}>
          {open ? 'hide' : 'connect an agent'}
        </button>
        {!account && (
          <a className="link" href="/privacy">
            privacy
          </a>
        )}
      </div>
      {open && (
        <div className="connect">
          <p className="small muted">Run in project folder, then start Claude:</p>
          {command ? <div className="setup-command">{command}</div> : !error && <p className="small muted busy">loading…</p>}
          {command && (
            <p className="small muted">
              <button className="link" onClick={copy}>
                copy
              </button>
              {account && (
                <>
                  {' · '}
                  <button className="link" onClick={reset} title="Revoke the current token and generate a new one">
                    new token
                  </button>
                </>
              )}
              {said && <> · {said}</>}
            </p>
          )}
          {account && <p className="small muted">Keep this token private; map access only.</p>}
          {error && (
            <p className="notice" role="alert">
              <span className="lead">Couldn't load setup.</span> {error}
            </p>
          )}
        </div>
      )}
      {account && (
        <p className="small muted account-line">
          <span className="account-name">{account.login}</span>
          {!account.privateRepos && ' (public only)'} ·{' '}
          <button className="link" onClick={leave}>
            sign out
          </button>
          {' · '}
          <button className="link danger" onClick={remove}>
            delete account
          </button>
          {' · '}
          <a className="link" href="/privacy">
            privacy
          </a>
        </p>
      )}
      {deleteError && (
        <p className="notice" role="alert">
          <span className="lead">Couldn't delete account.</span> {deleteError}
        </p>
      )}
    </section>
  );
}
