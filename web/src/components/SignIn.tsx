// The door to an indexer people sign in to: asks the indexer whether it needs
// a sign-in, shows the GitHub sign-in when it does and nobody is signed in,
// and the map otherwise. Signing out, or a session the indexer no longer
// takes, brings the door back.

import { useEffect, useState } from 'react';
import { api, dropSession, onSignedOut, signInError, signInUrl } from '../api.ts';
import { App } from '../App.tsx';
import { Wordmark } from './Logo.tsx';

type Door = 'checking' | 'open' | 'sign-in';

export function Gate() {
  const [door, setDoor] = useState<Door>('checking');
  useEffect(() => {
    const off = onSignedOut(() => setDoor('sign-in'));
    api.auth().then(
      (a) => {
        // A session left from when this indexer had sign-in would stand in for the access key.
        if (a.mode === 'off') dropSession();
        setDoor(a.mode === 'github' && !a.account ? 'sign-in' : 'open');
      },
      // Can't ask (the indexer is down, or predates sign-in): the map says what's wrong.
      () => setDoor('open'),
    );
    return off;
  }, []);
  if (door === 'checking') return <div className="app" />;
  if (door === 'sign-in') return <SignIn error={signInError} />;
  return <App />;
}

function SignIn({ error }: { error: string | null }) {
  return (
    <main className="sign-in">
      <div className="sign-in-body">
        <Wordmark height={28} />
        <h1 className="sign-in-title">a map of your codebase</h1>
        <p>
          Sign in with GitHub to import your repositories, private ones too. Your map is yours alone: what you import, and what your agents do,
          shows on no one else's.
        </p>
        {error && (
          <p className="notice" role="alert">
            <span className="lead">Couldn't sign you in.</span> {error}
          </p>
        )}
        <a className="sign-in-button" href={signInUrl()}>
          sign in with github
        </a>
        <p className="small muted">
          GitHub asks you to let Fiada read your repositories. Fiada clones only the ones you import, and keeps your GitHub token encrypted on
          the indexer.
        </p>
      </div>
    </main>
  );
}
