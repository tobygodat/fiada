# Hosting, storage and configuration

How fiada.tech is hosted, where a project is kept, how sign-in works, every variable the indexer and agent read, and how to deploy your own copy. The [README](../README.md) has the short version.

## Hosted demo

The map is at https://fiada.tech, a static build on Cloudflare Workers. It talks to the indexer at https://fiada-indexer.onrender.com, a Docker container on Render's free plan, which keeps accounts and projects in Postgres on Supabase and clones on its own disk. After 15 quiet minutes the indexer sleeps, so the first visit after that waits about a minute for it to wake. Without GitHub sign-in configured, anyone can browse it and adding repositories needs the project's key; with it, everyone signs in and works in a project of their own ([Signing in with GitHub](#signing-in-with-github)). [Deploy](#deploy) explains the split.

## Storage

Everything a project keeps (its repositories, its grouping and its generated summaries), and the accounts of people who sign in with GitHub, goes through the `ProjectStore` interface in `indexer/src/store.ts`. The default `FileProjectStore` writes under `.fiada/projects/<id>/`. When `DATABASE_URL` is set, `createStore()` picks `PostgresProjectStore` (`indexer/src/postgres-store.ts`) instead. The graph itself is always derived, never stored.

### Postgres

With Postgres, each project is one row in `fiada.projects`, keyed by project id, with the repo list, the grouping and the fences side by side as `jsonb`; accounts and summaries have tables of their own. The indexer makes the schema `fiada` and its tables on first connect. Restarting the indexer, or running it on another machine with the same connection string, brings the project back.

1. In [Supabase](https://supabase.com/dashboard), create a free project. Any Postgres works.
2. Under **Connect**, copy the **Session pooler** connection string, put the database password in it, and save it as `DATABASE_URL=...` in a `.env` file at the repo root (gitignored; `.env.example` lists the variables).
3. `bun run dev`. The indexer logs `saving projects to Postgres at …`, never the password.

The tables live in `fiada`, not `public`, so Supabase's REST API doesn't serve them, and row level security is on with no policies, so only the role the indexer connects as can read them. If Postgres can't be reached or read at startup, an indexer on loopback says why and saves under `$FIADA_HOME/projects/` (`.fiada/` by default) for that run, so the map still works offline. An indexer listening anywhere else stops with `Fiada can't start without its database at <host>.` Clones and parsed code stay on local disk either way.

Two indexers can serve one project. Saving the repo list never touches the grouping and vice versa, and each carries a revision: if another indexer saved after this one loaded, the save is refused with a message to restart instead of silently undoing the other's change. Grouping edits made elsewhere don't apply live the way edits to `fiada.grouping.json` do; restart to pick them up.

## Signing in with GitHub

Set `FIADA_GITHUB_CLIENT_ID` and `FIADA_GITHUB_CLIENT_SECRET` on the indexer and it becomes a place many people can use at once:

- **Everyone signs in.** The map opens on a sign-in screen. Every API route answers only a signed-in browser, with these exceptions. `/api/health`, `/api/auth` and the GitHub sign-in steps under `/api/auth/github/` answer without a session. `/api/admin/stats` takes `FIADA_API_KEY`, which opens nothing else (see [Using it](#3-using-it)). `POST /api/agent/events` and `POST /api/agent/check` take only an agent token, and the three read routes an agent's tools ask take an agent token or a session (see the last item). The shared project isn't used.
- **Each person has their own project.** Their repositories, clones (`$FIADA_HOME/clones/gh-<GitHub user id>/`), grouping, summaries and agent activity are theirs alone: what one person imports or has an agent do never shows on anyone else's map. A project opens on its owner's first request and is let go after 30 idle minutes; opening it again re-indexes from its clones.
- **Private repositories work.** The sign-in asks GitHub for the `repo` scope, and the person's own token clones and pulls what they import (passed per git command, never written to disk). Their recently pushed repositories are offered under the import box. The token is kept on their account encrypted with AES-GCM; `FIADA_GITHUB_TOKEN` is never used for anyone's project.
- **Nobody can use it up for everyone else.** Each person may make 60 changes a minute, their agents 600 report and fence-check requests a minute, and the person and their agents together 300 questions to the map a minute. Each person may hold 20 repositories of at most 500 MB each, and spend 200 model requests a day on sorting and summaries; past that, the map says so and summaries fall back to lines from the graph. Clones come over https only, from GitHub, GitLab and Bitbucket unless `FIADA_GIT_HOSTS` says otherwise, and nothing in a clone is read through a link that leads out of it. The variables are in [Configuration](#configuration).
- **People can leave.** **delete account** in the sidebar withdraws Fiada's access at GitHub and deletes the account, the project, its clones, fences and summaries. The map's [/privacy](https://fiada.tech/privacy) page says what is kept; change it with the code.
- **Agents need one command.** **connect an agent** in the sidebar shows one `npx -y --package=@fiadatech/agent fiada setup --write . --url=<indexer> --token=<token>` command to run in the project. The token lets an agent do three things on that person's map and nothing else: report what it does (`POST /api/agent/events`), ask whether an edit is fenced (`POST /api/agent/check`), and query the graph with its read tools (`GET /api/agent/find`, `/api/agent/dependents` and `/api/agent/impact`). **new token** revokes the old one.

To set it up, create an OAuth app at GitHub under **Settings > Developer settings > OAuth Apps** with the callback URL `<indexer>/api/auth/github/callback`: `http://localhost:5178/api/auth/github/callback` for `bun run dev` (the dev server forwards the address it was reached at), or `https://<indexer>/api/auth/github/callback` hosted. Put its client id and a client secret in `.env` or the host's variables. The map's origin must be allowed to receive the session: its own origin, the fiada.tech domains, or one in `FIADA_ALLOWED_ORIGINS`. If a proxy in front of the indexer doesn't forward the scheme and host, set `FIADA_PUBLIC_URL`.

Sessions and agent tokens are signed rather than stored, with a key derived from `FIADA_SESSION_SECRET`, or else the client secret. A session lasts 30 days in one browser; **sign out** forgets it there. Changing the secret signs everyone out and they sign in again, keeping their projects. Accounts go through `ProjectStore` like everything else (`$FIADA_HOME/accounts/<id>.json`, or the `fiada.accounts` table in Postgres).

## Configuration

Fiada used to be called Strata. Every `FIADA_*` variable is also read under its old `STRATA_*` name (the old name wins if both are set), and a checkout that already has a `.strata/` folder keeps using it, so existing deployments keep working unchanged.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4178` | indexer port (the web dev server proxies `/api` to it; set `FIADA_INDEXER_PORT` for the proxy if you change it) |
| `HOST` | `127.0.0.1` | address the indexer listens on (`0.0.0.0` in the container, and by default on Railway, Render and Fly) |
| `FIADA_HOME` | `.fiada/` (or `.strata/` if that exists) | where clones and project files live |
| `FIADA_PROJECT` | `default` | which project the indexer serves |
| `DATABASE_URL` | unset | save projects to Postgres (Supabase) instead of `.fiada/projects/`; see [Postgres](#postgres) |
| `FIADA_SUMMARIES` | on | `off` writes no generated [node summaries](USING.md#node-summaries) even with a key set; the lines stay |
| `FIADA_INCLUDE_TESTS` | off | set to `1` to index test files |
| `FIADA_MAX_FILES` | `4000` | per-repo file budget; the shallowest files are kept |
| `FIADA_GITHUB_CLIENT_ID`, `FIADA_GITHUB_CLIENT_SECRET` | unset | a GitHub OAuth app: turns on [signing in with GitHub](#signing-in-with-github), with a project per person |
| `FIADA_SESSION_SECRET` | the client secret | signs sessions and agent tokens and encrypts GitHub tokens; changing it signs everyone out |
| `FIADA_GITHUB_SCOPE` | `read:user repo` | what the sign-in asks GitHub for; `repo` is what reading private repositories takes |
| `FIADA_PUBLIC_URL` | the address the request came to | the indexer's public URL, for the sign-in callback and the agent setup command, when a proxy doesn't forward it |
| `FIADA_GITHUB_TOKEN` | unset | without sign-in: token for private GitHub repos, passed per git command and never written to disk |
| `FIADA_GIT_HOSTS` | `github.com,gitlab.com,bitbucket.org` | where an indexer with local folder imports off may clone from: one with sign-in, one others can reach (unless `FIADA_ALLOW_LOCAL=1`), or one with `FIADA_ALLOW_LOCAL=0`. `*` allows any host, still over https only. With local folder imports on, the indexer clones from anywhere |
| `FIADA_MAX_REPOS` | `20` | repositories one project may hold, on an indexer others can reach |
| `FIADA_MAX_CLONE_MB` | `500` | largest clone kept on an indexer others can reach; a larger one is removed and its row says why |
| `FIADA_MIN_FREE_MB` | `100` | disk an indexer others can reach keeps free for accounts and projects; below it, imports and uploads are refused with a message, and a clone under way is stopped and removed |
| `FIADA_RATE_LIMIT` | `60` | changes (imports, layers, removals) one person, or one address without sign-in, may make a minute. Calls to `/api/health`, and calls to `/api/admin/stats` without the right key on an indexer that has one, count against it per address. Other reads aren't limited, except the agent read routes below, and without sign-in neither are changes on loopback |
| `FIADA_AGENT_RATE_LIMIT` | `600` | with sign-in: requests to `/api/agent/events` and `/api/agent/check` one person's agents may make a minute (a report request can carry a batch of events). Without sign-in they count as changes |
| `FIADA_AGENT_READ_LIMIT` | `300` | questions to `/api/agent/find`, `/api/agent/dependents` and `/api/agent/impact` (an agent's read tools) one person and their agents together, or one address without sign-in, may make a minute. Not limited on loopback without sign-in |
| `FIADA_LLM_DAILY` | `200` | with sign-in: model requests (sorting and summaries) each person's map may make a UTC day |
| `FIADA_UPLOAD_MB` | `50` | most megabytes of source one folder upload may carry (20,000 files at most) |
| `ANTHROPIC_API_KEY` | unset | lets the indexer sort each import with Claude and write [node summaries](USING.md#node-summaries); see [Sorted on import](USING.md#sorted-on-import) |
| `OPENAI_API_KEY` | unset | the same with OpenAI; with both keys set, Claude answers unless `FIADA_LLM_MODEL` names an OpenAI model |
| `FIADA_LLM_MODEL` | `claude-haiku-5-5`, or `gpt-5.5` for OpenAI | the model it sorts with; without one, OpenAI falls back to `gpt-5`, then `gpt-4.1`, when the key can't use `gpt-5.5` |
| `FIADA_SUMMARY_MODEL` | the sort's model on Claude, or `gpt-5-mini` on OpenAI | the model that writes [node summaries](USING.md#node-summaries), which are many and short; with both keys set, it also picks the provider for summaries. OpenAI falls back to the models above when the key can't use `gpt-5-mini` |
| `FIADA_ALLOWED_ORIGINS` | unset | comma-separated origins whose pages may call the API (the map hosted elsewhere); `*` in an entry matches one run of letters, digits and hyphens |
| `FIADA_API_KEY` | unset | without sign-in: anything that changes the project (imports, layers, agent events) needs `Authorization: Bearer <key>`; reads stay open. With or without sign-in, it opens the usage numbers (`/api/admin/stats`) |
| `FIADA_ALLOW_LOCAL` | on for `127.0.0.1` | `1` or `0`: whether local folders can be imported. Off by default when `HOST` isn't loopback |
| `VITE_API_URL` | unset; `web/.env.production` sets the Render indexer for production builds | build time, web: the indexer's URL when the map is served apart from it; unset, the map calls its own origin |
| `FIADA_URL` | the saved config, else `http://127.0.0.1:4178` | where the agent hook and MCP server send events |
| `FIADA_TOKEN` (agent) | the saved config's, for its URL only | the person's agent token, for an indexer people sign in to |
| `FIADA_API_KEY` (agent) | unset | the hook and MCP server send it to a shared indexer that has one |
| `FIADA_CONFIG` (agent) | `~/.config/fiada/agent.json` | where `agent:setup --url … --token …` saves them |
| `FIADA_AGENT_STATE` | `$TMPDIR/fiada-agent` | where the hook keeps each session's last view of the working tree |
| `FIADA_HOOK_LOG` | unset | append every payload the hook receives to this file, one JSON object per line |

The indexer also reads a `.env` file at the repo root; variables already set in your shell win.

The indexer binds to 127.0.0.1 by default: importing a local path reads that directory, so on your own machine it's a single-user tool. [Deploy](#deploy) covers running it where others can reach it.

## Deploy

The map is a static build; the indexer is a long-running server that clones repositories to disk, parses them with tree-sitter, keeps the graph in memory and streams agent activity. So they live apart: **the map on Cloudflare Workers, the indexer in a container** on a host that runs one (Render, Fly.io or Railway; the `Dockerfile` at the root works on each). fiada.tech runs the indexer on Render's free plan with its data in Supabase's free Postgres ([ADR 0004](adr/0004-render-and-supabase.md)). Workers are short-lived and stateless, with no git and nowhere to keep clones, so the indexer can't run there.

```
browser ── https://fiada.tech ─────────────── static map (web/dist)
   └────── VITE_API_URL ── https://<indexer> ── indexer container ── its own disk: clones
                                                     └── Postgres (Supabase), if DATABASE_URL is set: accounts, projects
```

### 1. The indexer (Render)

In the Render dashboard, **New > Web Service**, pick this repository (a public one can go in as **Public Git Repository**), language **Docker**, instance type **Free**, and health check path `/api/auth`. Render builds the root `Dockerfile` and serves it at `https://<name>.onrender.com`. Then set the service's variables:

| Variable | Value |
| --- | --- |
| `PORT` | `4178` |
| `DATABASE_URL` | the Postgres connection string, as in `.env`; for Supabase, the **Session pooler** one, which works over IPv4, ending in `?sslmode=verify-full` |
| `NODE_EXTRA_CA_CERTS` | `/etc/secrets/supabase-ca.crt`: Supabase's root certificate (**Database > SSL Configuration**), added under Render's **Secret Files**, so `verify-full` can check the pooler's certificate. Without an `sslmode`, the indexer still uses TLS to any host but this machine, without checking the certificate |
| `FIADA_PROJECT` | a project of its own, e.g. `demo`, so it doesn't share (and fight over) the repo list with the indexer on your laptop, whose local folders it can't read |
| `FIADA_ALLOWED_ORIGINS` | `https://fiada.tech,https://fiada-web.<account>.workers.dev,https://*-fiada-web.<account>.workers.dev` (production, the Worker's own address, and its preview versions) |
| `FIADA_GITHUB_CLIENT_ID`, `FIADA_GITHUB_CLIENT_SECRET` | a GitHub OAuth app with the callback `https://<indexer>/api/auth/github/callback`: everyone signs in and gets a project of their own (see [Signing in with GitHub](#signing-in-with-github)); `FIADA_PROJECT` is then unused, and `FIADA_API_KEY` opens only `/api/admin/stats` |
| `FIADA_API_KEY` | a long random string (`openssl rand -hex 24`). Without sign-in, without it anyone with the URL can import repos into your project or remove them; with sign-in, it opens only the usage numbers (`/api/admin/stats`) |
| `FIADA_GITHUB_TOKEN` | without sign-in only, to import private repos by URL; uploading the folder from the map needs no token. Either way, without sign-in reads need no key, so anyone with the map's URL can read that code. With sign-in, each person's own GitHub token clones their repositories and this one is never used |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | to sort each import with a model and write node summaries; without one the map keeps the classifier's result and one-line summaries |

The container starts with `HOST=0.0.0.0` and `FIADA_HOME=/data`, runs as the `node` user, and turns local folder imports off. With `DATABASE_URL` set, a fresh container re-clones a project's repositories when the project opens, so no volume is needed; a host with one can mount it on `/data` to skip that. Uploaded folders are the exception: their files live only on the indexer's disk, so without a volume every restart loses them, and their rows say to upload the folder again. It idles at about 100 MB and used about 200 MB with the FastAPI template and Excalidraw indexed, so Render's free 512 MB is enough.

Render's free service sleeps after 15 minutes without a request and takes about a minute to wake. Supabase pauses a free project with too little database activity over a week, so `.github/workflows/keepalive.yml` calls `/api/health`, which makes one query, three times a day. Supabase says a few queries a day is typically enough. `curl https://<indexer>/api/health` answers `{"ok":true}` once the database does.

Check it: `curl https://<indexer>/api/auth` answers `{"mode":"github"}` with sign-in on; without it, `curl https://<indexer>/api/workspace` should answer with `"access":{"localPaths":false,"keyRequired":true}`.

On Fly.io: `fly launch` (it finds the Dockerfile; internal port 4178), then `fly secrets set DATABASE_URL=… FIADA_API_KEY=…` and the rest. On Railway, mount a volume on `/data` and set `RAILWAY_RUN_UID=0` so the `node` user can write there.

### 2. The map (Cloudflare Workers)

The map is an assets-only Worker: `wrangler.jsonc` at the root serves `web/dist`, with no Worker script. In the Cloudflare dashboard, **Workers & Pages > Create > Import a repository**, pick `tobygodat/fiada`, and set:

| Setting | Value |
| --- | --- |
| Root directory | the repository root (leave it empty) |
| Build command | `bun install --frozen-lockfile --filter @fiada/web && bun run build` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` (the preview builds' deploy command, under **Settings > Builds**) |
| Build variable `BUN_VERSION` | `1.4.2`, the version CI uses, so `--frozen-lockfile` reads `bun.lock` |
| Build variable `SKIP_DEPENDENCY_INSTALL` | `1`, so the build command's filtered install is the only one and the map can't lean on indexer packages |

The Worker's name in the dashboard must be `fiada-web`, the `name` in `wrangler.jsonc`, or the deploy step fails.

With preview builds on, every other branch gets its own Preview of the Worker at `https://<preview-name>-fiada-web.<account>.workers.dev`, where the Preview name is the branch name made URL-safe. Previews need the `previews` block in `wrangler.jsonc`. The preview command must be `npx wrangler preview`: `npx wrangler versions upload` fails on a Preview with "The name in your wrangler.jsonc file (fiada-web) must match the name of your Worker", because Cloudflare pins each Preview build to the Preview's own id.

Every push to `main` then builds and deploys. No build variable is needed: `web/.env.production` sets `VITE_API_URL` to `https://fiada-indexer.onrender.com`, and Vite writes it into the bundle at build time. If your indexer lives elsewhere, change that file, or set `VITE_API_URL` as a build variable, which wins. Without either, the deployed map calls `/api` on its own origin and gets `index.html` back instead of the indexer's answers.

Paths that aren't files, such as `/privacy`, get `index.html` (`not_found_handling` in `wrangler.jsonc`). `web/public/_headers`, which Vite copies into `web/dist`, sends the site's security headers. Its Content-Security-Policy lets the page call only its own origin and the indexer at `https://fiada-indexer.onrender.com`, so **if the indexer moves, change `connect-src` there too**, or the map can't reach it. Builds also carry Cloudflare's Web Analytics beacon (added in `web/vite.config.ts`, not in dev), so the CSP allows `static.cloudflareinsights.com` to load it and `cloudflareinsights.com` to receive its reports; visits show under Analytics, Web analytics in the Cloudflare dashboard. It allows `index.html`'s inline theme script by its hash; `web/src/csp.test.ts` fails when that script changes without a new hash.

The Worker answers at `https://fiada-web.<account>.workers.dev`; add that origin to the indexer's `FIADA_ALLOWED_ORIGINS` so the map can call the indexer from there too. The custom domain `fiada.tech` needs its zone on Cloudflare: add the site under **Websites**, point the registrar at Cloudflare's nameservers, then add `fiada.tech` under the Worker's **Settings > Domains & Routes**.

### 3. Using it

With GitHub sign-in, open `https://fiada.tech`, sign in, and import your repositories, private ones included; **connect an agent** in the sidebar gives the command that points Claude Code at your map. Its changes land on the clone of the same repository (matched by `origin` remote), ringed on files and symbols that exist at HEAD.

With `FIADA_API_KEY` set, either way, the indexer counts its use for the owner: how many people have accounts, sign-ups by month, how many signed in within 7 and 30 days, and how many repositories their projects keep. Counts only; no logins or names.

```sh
curl -H "Authorization: Bearer $FIADA_API_KEY" https://fiada-indexer.onrender.com/api/admin/stats
```

Without the key set the route answers 404, and without the key sent, 401. Deleted accounts are gone, so they count nowhere.

Without sign-in, one shared project:

- Open `https://fiada.tech/?key=<FIADA_API_KEY>` once. The map keeps the key in that browser and drops it from the address bar; then add repositories as usual (`org/repo` or a git URL). `?key=` with nothing forgets it.
- Everyone else gets the plain URL: the same map, read-only, without the import box, the layer presets or the dismiss buttons.
- To show a coding agent on the hosted map, run `bun run agent:setup --url https://<indexer> --token <key>` once (or start it with `FIADA_URL` and `FIADA_API_KEY` in its environment). Its changes land on the clone of the same repository (matched by `origin` remote), ringed on files and symbols that exist at HEAD. Files and symbols it adds only appear as new circles on an indexer that reads the checkout in place, i.e. one on your own machine.

To try the split locally: `docker build -t fiada-indexer . && docker run -p 4178:4178 -e FIADA_ALLOWED_ORIGINS=http://localhost:5199 -e FIADA_API_KEY=dev fiada-indexer`, then `VITE_API_URL=http://localhost:4178 bun run build && bun run --cwd web preview --port 5199`.
