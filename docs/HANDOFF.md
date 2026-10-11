# Fiada handoff

Written 2026-10-08 for whoever picks Fiada up next, and updated 2026-10-11 once the 2026-10-08 batch had merged. It says what the product is, where it runs, what the latest batch added and what is known to be broken. The [README](../README.md) is the full reference, and [AGENTS.md](../AGENTS.md) and [DESIGN.md](../DESIGN.md) are the rules for changing code and anything visible.

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
- CI (`.github/workflows/ci.yml`, from #47) runs typecheck, test and build as three parallel jobs on every PR and every push to `main`. Run the same three yourself before you push.
- Codex (`chatgpt-codex-connector`) reviews every PR when it opens and after each push. On the 2026-10-08 batch it found real bugs on most PRs, so read its comments before merging.
- Before changing code, read [AGENTS.md](../AGENTS.md). Its rules include: real repositories only, map features go in the canvas renderer, every edge carries evidence, persistence goes through `ProjectStore`, and models go through `indexer/src/llm.ts`. Before changing anything visible, read [DESIGN.md](../DESIGN.md).

## The 2026-10-08 batch (merged 2026-10-11)

Toby asked for each change to be built end to end, with unit tests, a browser end-to-end run, and screenshots and video in the PR. Each one was held unmerged until Toby said on 2026-10-11 to merge them all once they were ready. Every Codex finding on these PRs was fixed before or as it merged. Each PR's media is committed under `docs/pr-media/<branch>/`.

| PR | What it added |
| --- | --- |
| [#47](https://github.com/tobygodat/hackgt13/pull/47) CI checks | GitHub Actions: typecheck, test and build on every PR and every push to `main`. |
| [#48](https://github.com/tobygodat/hackgt13/pull/48) Map search | A search box in the top bar (`/` or Ctrl-K focuses it) that finds repositories, folders, files and symbols by name and opens the map to the pick. It finds only what the current view draws. On narrow screens the altitude words give way, so back, the breadcrumb and search fit. |
| [#49](https://github.com/tobygodat/hackgt13/pull/49) Unread code | Marks agent changes you haven't opened as unread: a dot on the ring, "N unread" on badges, and "12 of 19 changes read" with mark read and mark all read in the agents window. Read marks live in the browser (`fiada.read.<project>`), are counted per agent, and are cleared when the account is deleted. |
| [#50](https://github.com/tobygodat/hackgt13/pull/50) Sort places nothing | Fixes the hosted sort ending with "0 placements". The prompt labelled files F1, F2, … but never said `ref` meant that label, so Haiku answered with paths and nothing matched. Refs are now in the schema, and paths, names and "[F1]" are matched back to their file. A ref two files share picks neither. |
| [#51](https://github.com/tobygodat/hackgt13/pull/51) Review tour | A **review** word on each agent entry steps through its changes one function at a time, in data-flow order (page, client, route, table, shared types). The map opens to each stop, the detail panel shows its diff, and you move with ← → and `r` to mark read. |
| [#52](https://github.com/tobygodat/hackgt13/pull/52) Link labels at rest | Resting links get a quiet count and verb ("23 requests"), so the map says what links are without pointing at them. |
| [#53](https://github.com/tobygodat/hackgt13/pull/53) Fences and collisions | Any circle can be fenced "ask first" or "off limits" from the detail panel, and fences are saved per project. A PreToolUse hook checks them before an agent's file edit: off limits is refused, and ask first makes Claude Code ask. Shell commands aren't checked, but what they change still shows on the map. When two agents work in one file or folder, the agents window and map say "two agents". |
| [#55](https://github.com/tobygodat/hackgt13/pull/55) Ripple rings | Everything that depends on an agent's change gets a quiet ring of paired dots, across repositories, rolled up onto closed circles. The detail panel says what reaches a changed node ("1 request from frontend calls this route."). |
| [#56](https://github.com/tobygodat/hackgt13/pull/56) Agents can ask Fiada | Three read-only MCP tools, `where_is`, `who_uses` and `impact`, let an agent ask the map before it edits. What an agent looked at gets a faint dotted ring. |
| [#57](https://github.com/tobygodat/hackgt13/pull/57) Function change times | Each changed function keeps its own change time, so editing one function marks only that one unread, in the tour and the unread marks. |
| [#58](https://github.com/tobygodat/hackgt13/pull/58) Ripples from deleted code | Deleting code ripples to what called it, using links kept from before the re-index. |
| [#59](https://github.com/tobygodat/hackgt13/pull/59) Fence follow-ups | Fence hatching draws only what's on screen, so zooming deep inside a fence no longer stalls the map. A `git clone` of a locally imported folder now meets that folder's fences. |

### Still open

- [#30](https://github.com/tobygodat/hackgt13/pull/30) Hand edits on the map: watches locally read repos with chokidar and shows your own saves as a **You** card in the agents window. It was opened on 2026-09-27 and is far behind `main` (it predates the rename, bun, sign-in and this batch). It still says `npm`. Merge `main` into it, or close it.

## Known issues

- **Hosted projects aren't saved to Atlas** (last seen 2026-10-08; not known to be fixed). The Railway log shows the indexer rejecting `MONGODB_URI` with "Invalid scheme, expected mongodb:// or mongodb+srv://", so it saves projects to its own disk instead. There is no volume on `/data`, so every push to `main` redeploys and wipes the hosted project. To fix it, re-paste the Atlas connection string in Railway's variables (no quotes or stray characters, starting `mongodb+srv://`), or mount a volume on `/data` and set `RAILWAY_RUN_UID=0`. Atlas Network Access must allow `0.0.0.0/0`.
- **The sort fix hasn't been run against real Haiku.** [#50](https://github.com/tobygodat/hackgt13/pull/50) was tested against a stand-in Claude that answers with paths, because the cloud threads have no key. Re-importing a repository on fiada.tech is the real check.
- **One untrue sidebar line:** when a sort places nothing, the sidebar says it "found nothing the classifier left unplaced" even if code is still unsorted (`web/src/components/Sidebar.tsx`).
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

**The shared hosted map without sign-in.** From a checkout, run `bun run agent:setup --write /path/to/your/repo --url https://strataindexer-production.up.railway.app --token <API key>`. Without `--write`, setup only saves the URL and token and installs no hooks or MCP server. Alternatively, set the repo up with `--write` and start `claude` with `FIADA_URL` and `FIADA_API_KEY` in its environment.

How it works:

- The hook runs on SessionStart, UserPromptSubmit, PostToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash, TodoWrite, task tools), Stop and SessionEnd. It trusts git, not the tool input: it diffs the working tree against a per-session snapshot, so shell `rm`/`mv` and generated files are caught.
- A PreToolUse hook on Edit, Write, MultiEdit and NotebookEdit asks the indexer about fences before the edit lands (#53).
- The MCP server gives the agent `status` (a required one-line "working on" line), `flag_changes`, and the read tools `where_is`, `who_uses` and `impact` (#56).
- The indexer's `AgentHub` (`indexer/src/agents.ts`) matches an agent to an imported repository by local path, then `origin` remote, then folder name. It diffs symbols against HEAD's parse and streams state to the map over SSE. Agent state is in memory only.
- On a hosted indexer, changes land on the clone of the same repository, matched by remote, and ring files and symbols that exist at HEAD. New files appear as new circles only on an indexer that reads the checkout in place, i.e. on your own machine.
- If you start `claude` from inside another Claude Code session, run `unset CLAUDE_CODE_SESSION_ID` first, or both sessions report as one agent.

## Where to start next

1. Fix `MONGODB_URI` on Railway, so the hosted map keeps what people import.
2. Re-import a repository on fiada.tech to confirm the sort places code with real Haiku, and fix the sidebar line above.
3. Run a real Claude Code session against the merged batch (fences, the read tools, the review tour), since the batch was tested by replaying hook payloads rather than with a live session.
4. Decide on #30.
