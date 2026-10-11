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
        <h1 className="sign-in-title">what fiada keeps</h1>
        <p>
          Fiada draws a map of the repositories you import. To do that it has to read your code, and to let you back in it has to remember who you
          are. This page says what it keeps, where, and how to make it forget.
        </p>

        <h2>when you sign in</h2>
        <p>
          You sign in with GitHub. Fiada keeps your GitHub user id, login, name, the address of your avatar, the permissions you granted and when
          you signed in. It also keeps the access token GitHub gives it, encrypted, so it can clone the private repositories you import. GitHub's
          permission for private repositories covers reading and writing them; Fiada only reads, and only the repositories you import.
        </p>

        <h2>when you import a repository</h2>
        <p>
          Fiada clones it, or unpacks the folder you upload, on the server that runs the indexer, and reads its source files to draw the map. It
          keeps the list of what you imported, the layers and rules you set, and the summaries it wrote, so your map is there when you come back.
          The map itself is worked out again from the code each time and never stored. Nobody else's map shows your repositories.
        </p>

        <h2>summaries and sorting</h2>
        <p>
          To sort files into layers and write the one-line summaries, Fiada sends parts of your code (file paths, names and file contents) to
          the model provider its indexer is set up with, under that provider's terms for API data. On fiada.tech that is Anthropic (Claude); an indexer
          set up with OpenAI sends them to OpenAI instead, and one with neither sends them nowhere. Summaries are kept so the same code isn't sent
          twice.
        </p>

        <h2>coding agents</h2>
        <p>
          If you connect a coding agent, it reports the files it changes, their diffs, what it says it is doing, the first line of your latest
          prompt, and the files it reads or asks your map about. Fiada holds these in memory to draw them on your map, never on disk, and forgets
          them when you clear them or the indexer restarts. Its questions are answered from your own map only.
        </p>

        <h2>in your browser</h2>
        <p>
          Your browser keeps your sign-in, a few preferences (the theme, which panels are open) and which agent changes you have opened in
          local storage. The sign-in goes with each request to the indexer; the preferences and what you have opened stay in the browser.
          Signing in sets one cookie
          for the few minutes it takes. There are no analytics, no advertising, and nothing is sold.
        </p>

        <h2>who else handles it</h2>
        <p>
          GitHub signs you in and hosts the repositories you import. Vercel serves this site. Railway runs the indexer, which holds the clones.
          MongoDB Atlas stores accounts and projects. Anthropic (or OpenAI, for an indexer set up with it) writes summaries and sorts.
          Google Fonts serves the typeface, so Google sees your address when the page loads.
        </p>

        <h2>making fiada forget</h2>
        <p>
          Sign in and choose "delete account" at the foot of the sidebar. That deletes your account, your project, its clones and summaries, and
          withdraws Fiada's access at GitHub. You can also withdraw that access yourself on GitHub, under Settings, Applications, Authorized OAuth
          Apps; Fiada can then no longer clone your repositories.
        </p>

        <p className="small muted">
          <a className="link" href="/">
            back to the map
          </a>
        </p>
      </article>
    </main>
  );
}
