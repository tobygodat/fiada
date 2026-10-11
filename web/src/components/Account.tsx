// The sidebar's last section: connecting a coding agent to this map, and who
// is signed in. The setup command carries the indexer's address and the
// person's agent token, so running it once is all an agent needs: no
// variables to set by hand.

import { useState } from 'react';
import type { AgentConnection, Workspace } from '@fiada/shared';
import { api, sharedKey, signOut } from '../api.ts';
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
      setError((err as Error).message);
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
      setSaid('select the command and copy it');
    }
  };
  const remove = async () => {
    if (!window.confirm('Delete your Fiada account? Your map, its imports, clones and summaries go too, and GitHub stops listing Fiada as an app you use. This cannot be undone.')) return;
    try {
      await api.deleteAccount();
      forgetRead();
      forgetMarks();
      signOut();
    } catch (err) {
      setDeleteError((err as Error).message);
    }
  };
  const reset = async () => {
    try {
      setConn(await api.resetAgentToken());
      setSaid('new token: agents set up with the old one have stopped reporting');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="section">
      <div className="section-title">agents</div>
      <p className="small muted account-line">
        Show what Claude Code is doing on this map.{' '}
        <button className="link" aria-expanded={open} onClick={show}>
          {open ? 'hide the setup' : 'connect an agent'}
        </button>
      </p>
      {open && (
        <div className="connect">
          <p className="small muted">In your project's folder, run this, then start claude there:</p>
          {command ? <div className="setup-command">{command}</div> : !error && <p className="small muted busy">loading…</p>}
          {command && (
            <p className="small muted">
              <button className="link" onClick={copy}>
                copy
              </button>
              {account && (
                <>
                  {' · '}
                  <button className="link" onClick={reset} title="Stop agents set up with the current token from reporting">
                    new token
                  </button>
                </>
              )}
              {said && <> · {said}</>}
            </p>
          )}
          {account && <p className="small muted">The token lets agents report to your map and nothing else. Keep it to yourself.</p>}
          {error && (
            <p className="notice" role="alert">
              <span className="lead">Couldn't get the setup.</span> {error}
            </p>
          )}
        </div>
      )}
      {account && (
        <p className="small muted account-line">
          signed in as <span className="account-name">{account.login}</span>
          {!account.privateRepos && ' (public repositories only)'} ·{' '}
          <button className="link" onClick={signOut}>
            sign out
          </button>
          {' · '}
          <button className="link danger" onClick={remove}>
            delete account
          </button>
        </p>
      )}
      {deleteError && (
        <p className="notice" role="alert">
          <span className="lead">Couldn't delete your account.</span> {deleteError}
        </p>
      )}
      <p className="small muted account-line">
        <a className="link" href="/privacy">
          privacy
        </a>
      </p>
    </section>
  );
}
