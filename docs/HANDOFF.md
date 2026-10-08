# Fiada handoff

Written 2026-10-08 (around 7 PM Eastern) for whoever picks Fiada up next. It says what the product is, where it runs, what was left open tonight and what is known to be broken. The [README](../README.md) is the full reference, and [AGENTS.md](../AGENTS.md) and [DESIGN.md](../DESIGN.md) are the rules for changing code and anything visible.

## What Fiada is

Fiada is a map of your codebase that sorts itself, explains itself, and lights up where your coding agent is working.

- It turns one or more real repositories into a single zoomable map. Circles nest from repository to folder to file to function.
- Links between circles are contracts (imports, calls, HTTP requests, shared types). Each one carries the code lines that prove it, or says it was inferred, with a confidence.
- On import, rules and then a Claude model sort every file and function into a layer (UI, Client, API, …) and a feature domain. Selecting a circle shows a short generated summary.
- Claude Code's hooks and the Fiada MCP server report each edit. The map rings what was added, changed or deleted, and the agents window shows each agent's task, plan and diff.

It was called Strata, and some names keep that spelling on purpose (`@strata/indexer`, the `STRATA_*` aliases, the MongoDB database `strata`, the Railway domain). [AGENTS.md § Names](../AGENTS.md#names) lists them. Don't rename them.

It was built at HackGT 13 and submitted to the Oracle of the Deep track (ML/AI + visualization), with the Create-X, MLH .tech domain (fiada.tech) and MLH MongoDB Atlas add-ons.

## Where it runs

| What | Where | Notes |
| --- | --- | --- |
| Map (static web app) | https://fiada.tech and https://hackgt13.vercel.app | Vercel Pro, project `hackgt13`. Every push to `main` deploys. Each PR gets a Vercel preview, which asks for a Vercel login. |
| Indexer (API server) | https://strataindexer-production.up.railway.app | Railway, one service built from the root `Dockerfile` (Node 22, bun for install). Only the indexer belongs there. |
| Repository | https://github.com/tobygodat/hackgt13 | Private. PRs target `main` and merge with a merge commit. |
| Agent package | [`@fiadatech/agent`](../agent/README.md) on npm | The `fiada` command: hook CLI, stdio MCP server and `setup`. |

The map's `VITE_API_URL` points at the Railway domain, and `vercel.json`'s Content-Security-Policy allows only that indexer in `connect-src`. If the indexer moves, change both.

The Railway service's variables are `PORT`, `MONGODB_URI`, `STRATA_PROJECT=demo`, `STRATA_ALLOWED_ORIGINS`, `STRATA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `FIADA_LLM_MODEL=claude-haiku-5-5`. Values live only in Railway and in Toby's local `.env`; never copy them anywhere else. GitHub sign-in (`FIADA_GITHUB_CLIENT_ID`/`_SECRET`, from PR #41) is in the code, but I could not confirm whether it is turned on in the hosted indexer. `curl https://strataindexer-production.up.railway.app/api/auth` answers `{"mode":"github"}` when it is.

Without sign-in, the hosted map is read-only for everyone. To add repositories, open `https://fiada.tech/?key=<the API key>` once in a browser; the key is kept in that browser's localStorage.

## Working on it

Needs Node 20.19 or later, bun 1.4 or later and git. The repo moved from npm to bun in PR #46.

```sh
bun install
bun run dev          # indexer on :4178, map on http://localhost:5178
bun run typecheck
bun run test         # not `bun test`: the tests use node:test
bun run build
```

- Put a `.env` at the repo root (`.env.example` lists the variables). `ANTHROPIC_API_KEY` turns on the model sort and generated summaries with `claude-haiku-5-5`. Without a key everything still works: sorting falls back to the rules and summaries to lines built from the graph.
- There is no CI on `main` yet. Until [PR #47](https://github.com/tobygodat/hackgt13/pull/47) merges, run typecheck, test and build yourself before every push.
- Codex (`chatgpt-codex-connector`) reviews every PR when it opens and after each push. Tonight it found real bugs on most PRs, so read its comments before merging.
- Before changing code, read [AGENTS.md](../AGENTS.md). Its rules include: real repositories only, map features go in the canvas renderer, every edge carries evidence, persistence goes through `ProjectStore`, and models go through `indexer/src/llm.ts`. Before changing anything visible, read [DESIGN.md](../DESIGN.md).

## Open pull requests

### The 2026-10-08 batch

Toby asked for each change to be built end to end, with unit tests, a browser end-to-end run, screenshots and video in the PR, and **not merged**. Each thread watched its PR for Codex reviews until 6:59 PM Eastern, then stopped. Toby merges. Each PR's media is committed under `docs/pr-media/<branch>/`.

State as of 23:00 UTC on 2026-10-08:

| PR | What it does | State |
| --- | --- | --- |
| [#47](https://github.com/tobygodat/hackgt13/pull/47) CI checks | Adds `.github/workflows/ci.yml`: bun install, typecheck, test and build on every PR and push to `main`, about 70 s. Adds a README badge and fixes the AGENTS.md line that says there is no CI. | Green, no conflicts, two Codex reviews with no findings. Ready to merge. |
| [#48](https://github.com/tobygodat/hackgt13/pull/48) Map search | A search box in the top bar (`/` focuses it) that finds repositories, folders, files and symbols by name and opens the map to the pick. It finds only what the current view draws. | Six Codex findings fixed. **One open:** at about 480px wide, the top bar runs out of room, so the breadcrumb and back button collapse and the zoom readout goes off screen. The proposed fix, left on the PR, is to hide the altitude labels below 760px. It was not pushed because it hadn't been checked in a browser. |
| [#49](https://github.com/tobygodat/hackgt13/pull/49) Unread code | Marks agent changes you haven't opened as unread: a dot on the ring, "N unread" on badges, and "12 of 19 changes read" with mark read and mark all read in the agents window. Read marks live in the browser (`fiada.read.<project>`). | All Codex findings fixed and resolved. The last fixes (`4ee18d4`: per-agent read counts when two agents touch one file, and clearing read marks when an account is deleted) were pushed at 23:00, so check Codex's review of that commit before merging. |
| [#50](https://github.com/tobygodat/hackgt13/pull/50) Sort places nothing | Fixes the hosted sort ending with "0 placements". The prompt labelled files F1, F2, … but never said `ref` meant that label, so Haiku answered with paths and nothing matched. Refs are now in the schema, and paths, names and "[F1]" are matched back to their file. Ambiguous matches pick neither file. | All Codex findings fixed and resolved, the last in `b5d028b` (pushed at 23:00, so check Codex's review of it). It was tested against a stand-in Claude that answers with paths; real Haiku hasn't been run because the cloud threads have no key. **The real check is re-importing a repo on fiada.tech after deploy.** One untrue sidebar line remains: it says the sort "found nothing the classifier left unplaced" even when the sort placed nothing and code is still unsorted. |
| [#51](https://github.com/tobygodat/hackgt13/pull/51) Review tour | A **review** word on each agent entry steps through its changes one function at a time, in data-flow order (page, client, route, table, shared types). The map opens to each stop, the detail panel shows its diff, and you move with ← → and `r` to mark read. | All five Codex findings fixed and resolved. Nothing open. |
| [#52](https://github.com/tobygodat/hackgt13/pull/52) Link labels at rest | Resting links get a quiet count and verb ("23 requests") so the map says what links are without pointing at them. The render bench is unchanged at 16.7 ms. | Both Codex findings fixed (labels no longer jump on hover, and leader rules no longer cross circles). Codex started another review of the last commit just before 6:59, so look for new comments before merging. |
| [#53](https://github.com/tobygodat/hackgt13/pull/53) Fences and collisions | Any circle can be fenced "ask first" or "off limits" from the detail panel, and fences are saved per project. A PreToolUse hook checks them before an agent's edit: off limits is refused, ask first makes Claude Code ask. When two agents work in one file or folder, the agents window and map say "two agents". | **Two Codex findings open, unanswered** (they came after watching stopped). P1: line ranges from an agent's feature-branch checkout are compared with the indexed clone's lines, so an edit to a fenced symbol can be allowed if lines moved above it. The fix is to check the whole file unless the checkout matches the indexed revision. P2: a checkout whose remote matches nothing falls back to matching by folder name, so an unrelated repo can be fenced. |
| Ripple rings (no PR yet) | Dotted rings on the code that depends on what an agent changed, rolled up onto closed circles, plus a sentence in the detail panel saying what reaches a changed contract. | At 22:56 UTC the thread was fixing a slowdown the render bench found in zoom-to-open mode, and the PR wasn't open yet. See its thread. |
| Agents can ask Fiada (no PR yet) | MCP read tools `where_is`, `who_uses` and `impact`, so an agent can ask the map before editing, with a faint dotted "looked at" mark on the map. | At 22:57 UTC, typecheck, 210 tests, build and the Chromium end-to-end run passed, and the thread was taking before shots on `main`. The PR wasn't open yet. See its thread. |

**Merging them.** Merged one after another onto `main` at 23:00 UTC, #47, #50, #48, #52 and #49 went in cleanly in that order. #51 then conflicts in `web/src/App.tsx` and `web/src/components/AgentQueue.tsx`. #53 conflicts in those two and in `web/src/render/renderer.ts`. #49, #51 and #53 all add controls to the agents window, so expect to merge their changes by hand. #48 and #53 both touch `styles.css`, and #47 and #53 both touch README and AGENTS.md. Run typecheck, test and build after each merge.

### Older

- [#30](https://github.com/tobygodat/hackgt13/pull/30) Hand edits on the map: watches locally read repos with chokidar and shows your own saves as a **You** card in the agents window. It was opened on 2026-09-27 and is far behind `main` (it predates the rename, bun and sign-in). It still says `npm`. Merge `main` into it, or close it.

## Known issues

- **Hosted projects aren't saved to Atlas.** The Railway log shows the indexer rejecting `MONGODB_URI` with "Invalid scheme, expected mongodb:// or mongodb+srv://", so it saves projects to its own disk instead. There is no volume on `/data`, so every push to `main` redeploys and wipes the hosted project. To fix it, re-paste the Atlas connection string in Railway's variables (no quotes or stray characters, starting `mongodb+srv://`), or mount a volume on `/data` and set `RAILWAY_RUN_UID=0`. Atlas Network Access must allow `0.0.0.0/0`.
- **The hosted sort may still place nothing** until [#50](https://github.com/tobygodat/hackgt13/pull/50) merges and deploys. It was seen on Toby's typingsite import on 2026-10-08.
- **Cursor and Codex agent paths are untested.** Only Claude Code has been run end to end with the hooks and MCP server.
- **Uploaded folders vanish on redeploy** without a volume, because their files exist only on the indexer's disk. Their rows say to upload again.
- **Playwright video in cloud containers:** Playwright's bundled ffmpeg is missing, so the e2e scripts record with a CDP screencast and system ffmpeg, and launch Chromium from `/opt/pw-browsers/chromium`.

## Hooking up a coding agent

The agent package reports edits to an indexer. It never gets in the agent's way: it gives up after 1.5 s and always exits 0.

**Local, from a checkout of this repo.** Run `bun run dev`, import the repository you'll work in by its local path (so edits re-index in place), then:

```sh
bun run agent:setup --write /path/to/your/repo
cd /path/to/your/repo && claude
```

`--write` adds Fiada's hooks to that repo's `.claude/settings.local.json` and registers the `fiada` MCP server with `claude mcp add`.

**A map you signed in to.** Open **agents** in the sidebar and choose **connect an agent**. It gives one command with the indexer and your token filled in:

```sh
npx -y --package=@fiadatech/agent fiada setup --write . --url=https://<indexer> --token=<token>
```

That saves the URL and token in `~/.config/fiada/agent.json` and checks the indexer accepts the token.

**The shared hosted map without sign-in.** Run `bun run agent:setup --url https://strataindexer-production.up.railway.app --token <API key>` once, or start `claude` with `FIADA_URL` and `FIADA_API_KEY` in its environment.

How it works:

- The hook runs on SessionStart, UserPromptSubmit, PostToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash, TodoWrite, task tools), Stop and SessionEnd. It trusts git, not the tool input: it diffs the working tree against a per-session snapshot, so shell `rm`/`mv` and generated files are caught.
- The MCP server gives the agent `status` (a required one-line "working on" line) and `flag_changes`.
- The indexer's `AgentHub` (`indexer/src/agents.ts`) matches an agent to an imported repository by local path, then `origin` remote, then folder name. It diffs symbols against HEAD's parse and streams state to the map over SSE. Agent state is in memory only.
- On a hosted indexer, changes land on the clone of the same repository, matched by remote, and ring files and symbols that exist at HEAD. New files appear as new circles only on an indexer that reads the checkout in place, i.e. on your own machine.
- If you start `claude` from inside another Claude Code session, run `unset CLAUDE_CODE_SESSION_ID` first, or both sessions report as one agent.

## Where to start next

1. Fix `MONGODB_URI` on Railway, so the hosted map keeps what people import.
2. Merge #47, so every later PR gets CI.
3. Merge #50 and re-import a repository on fiada.tech to confirm the sort places code with real Haiku.
4. Address the open findings on #48 and #53, then merge the rest of the batch in the order above, resolving the agents-window conflicts by hand.
5. Open or finish the ripple rings and agent read tools PRs.
6. Decide on #30.
