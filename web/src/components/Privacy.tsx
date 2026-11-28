// What Fiada keeps about the people who sign in, and where it goes: a page of
// its own at /privacy, reachable signed out, from the sign-in screen and the
// sidebar. It says only what the indexer actually does; change it with the code.

import { Wordmark } from './Logo.tsx';

export function Privacy() {
  return (
    <main className="page">
      <article className="page-body">
        <a href="/" aria-label="Fiada">
          <Wordmark height={28} />
        </a>
        <h1 className="sign-in-title">privacy</h1>
        <p>What Fiada stores, where it goes, how long it is kept, and how to delete it.</p>

        <h2>sign-in</h2>
        <p>
          Fiada stores your GitHub user id, login, name, avatar URL, granted scopes, sign-in time, and encrypted GitHub access token (to clone
          imported private repositories). GitHub's private-repo scope includes write access, but Fiada only reads repositories you import. The
          operator's usage numbers are totals with no names; the indexer log records your login when you sign in or delete your account.
        </p>

        <h2>repositories</h2>
        <p>
          Fiada clones each repository you import, or unpacks the folder you upload, on the indexer server and reads its source to draw your map.
          It keeps your import list, layers, rules, fences and summaries. The map itself is rebuilt from the code each time and never stored.
          Nobody else's map shows your repositories.
        </p>

        <h2>summaries and sorting</h2>
        <p>
          Without a model key, rules sort your code, summaries come from the map, and no code is sent to a model. If you add an Anthropic or OpenAI
          API key, Fiada sends file paths, names and code to that provider to sort your code and write summaries, on your account under its API
          terms. Saved summaries are reused, not asked for again. Removing your key stops new requests and keeps existing results.
        </p>
        <p>
          Your model key stays in your browser and goes over HTTPS with each request. On save, the indexer lists provider models once to verify it.
          The indexer holds it in memory for your map only, never on disk, in the database, or in logs, and forgets it on removal, sign-out, a
          request without it, 30 minutes idle, or restart. Self-hosted indexers without sign-in use their own configured key instead.
        </p>

        <h2>coding agents</h2>
        <p>
          Connected agents send changed files, diffs, status text, the first line of your latest prompt, and files read or queried. The indexer
          holds this in memory only, never on disk, until you clear it, your map sits unused for 30 minutes, or the indexer restarts. Agent queries read your map only.
        </p>

        <h2>browser storage</h2>
        <p>
          Local storage holds your session, optional model key, preferences (theme, open panels), and review read marks. The session and model key
          are sent to the indexer; preferences and marks stay local. Signing out clears the key; deleting your account clears the key and marks.
          Signing in sets one cookie for a few minutes. No ads; nothing is sold.
        </p>

        <h2>third parties</h2>
        <p>
          GitHub handles sign-in and repository hosting. Cloudflare serves the site and runs cookie-free Web Analytics (pages, load speed,
          referrer, country, browser, OS, device type; it doesn't identify you). Render hosts the indexer and keeps clones and uploaded folders on its disk; a restart loses uploads, so you upload them again.
          Supabase stores accounts and projects. Anthropic or OpenAI processes code only if you add a key. Google Fonts serves the typeface and
          sees your IP on page load.
        </p>

        <h2>deleting your data</h2>
        <p>
          Sign in and click "delete account" in the sidebar to delete your account, project, clones and summaries. Fiada also asks GitHub to revoke
          its access; to be sure, revoke it under GitHub Settings, Applications, Authorized OAuth Apps.
        </p>

        <p className="small muted">
          <a className="link" href="/">
            back to map
          </a>
        </p>
      </article>
    </main>
  );
}
