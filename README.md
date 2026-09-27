# Strata

A codebase map for working at the middle altitude: above file-by-file reading, below a one-paragraph architecture summary. One graph spans several repositories; opening a circle takes you down a level of abstraction, from systems to modules to files to symbols.

This is the first scaffold of the prototype. It covers the graph view, the floating sidebar with the **Code · read-only** / **By function** toggle, importing real repositories, per-project layers, and the agent overlay: coding agents report their task and the files they change, and the map shows it live. Search, edge filtering and domain editing come later.

## Run it

```sh
npm install
npm run dev          # indexer on :4178, web on http://localhost:5178
```

Open http://localhost:5178 and add a repository in the sidebar. Anything git can clone works (`org/repo`, `github.com/org/repo`, an https or ssh URL), and so does an absolute path to a local checkout, which is read in place. Add several and they share one map; imports, calls and HTTP requests that cross repositories become dashed edges.

Until you point at something the map draws only the few strongest links between what's on screen (HTTP requests and cross-repository links count for more), with no letter tags. Point at a circle to see all of its links, tagged; they stay while it is selected. (`?links=all` in the URL draws every link and tag as before, `?links=none` none until you point; the rules live in `web/src/render/edges.ts`.) Click a circle to select it: the detail panel says what it is, what it depends on and what depends on it. Click it again (or press Enter) to open it in place: its neighbours stay on screen as small closed circles, and edges reattach to the specific file or symbol inside that each one comes from. Click an open circle's name tab (or a breadcrumb) to close it again. Scroll only zooms and drag pans; neither opens or closes anything. Click an edge or its letter tag to read the contract between two parts, and click either end of any interaction listed there to go straight to the code responsible. Each interaction's **why** lists the code behind it (the request, the route and router mounts it matched, the import or call) and clicking a line shows that code in place. Contracts the indexer only guessed are dotted, with a `?` on their tag. The detail panel shows the selected file's or symbol's code. Back (the ← button, or Backspace) returns to where you were; Esc clears the selection.

The sidebar's **open** setting switches to the prototype's semantic zoom, where circles open by themselves as you zoom into them.

## How it's put together

```
shared/    the graph contract (nodes, edges, layers, agent events) both sides import
indexer/   clone → parse → link → classify → graph, behind a small HTTP API
web/       React app: canvas map, floating sidebar, detail panel, task queue
agent/     what a coding agent runs: a stdio MCP server and a tool-hook CLI
```

The indexer pipeline:

1. **Sources** (`indexer/src/sources.ts`): lists files with `git ls-files`, skips vendored and generated directories and (by default) tests, and reads `package.json`, `tsconfig*.json`, `pyproject.toml` and `requirements*.txt`.
2. **Parse** (`indexer/src/parse/`): tree-sitter (WASM, no native build) extracts imports, top-level symbols, the identifiers each symbol uses, server routes and the routers they hang off, client HTTP requests, client page routes (React Router, TanStack Router) and ORM links (SQLAlchemy relationships and foreign keys, GORM fields). TypeScript, TSX, JavaScript, Python and Go today; a language is a grammar plus one extractor.
3. **Link** (`indexer/src/link.ts`): resolves imports (relative paths, tsconfig `paths`, workspace packages, Python packages, Go modules, across every imported repo), binds identifiers to the symbols they name through re-exports and barrels, follows router mounts (`include_router`, `register_blueprint`, `app.use`, gin groups) to give every route its full path, and matches requests like `fetch(\`${API}/items/${id}\`)` to routes like FastAPI's `@router.get("/{id}")` under `APIRouter(prefix="/items")`. Every edge records the code behind it (file, line and that line's text) and whether it's **evidenced** (the code names the target, or a request's full path equals the route's) or **inferred** (a heuristic linked them, such as a URL that only matches a route's tail), with a confidence and a one-line reason.
4. **Facts** (`indexer/src/facts.ts`): detectors turn what the parser saw into language-neutral facts on every file and symbol: the routes it serves, the requests it makes, JSX, ORM tables, base classes, decorators, imports, and whether it's type-only.
5. **Build** (`indexer/src/build.ts`): emits the node tree (single-child folder chains collapsed) and edges.
6. **Classify** (`indexer/src/classify/`): places every file and symbol in one of the project's layers and a domain, each with evidence. This step only reads facts, paths and edges, so a grouping change reclassifies in milliseconds without re-parsing.

The web app rebuilds the tree for the chosen view and decides which circles are open: the ones you opened (click mode), or the ones big enough on screen (zoom mode). It packs only the open part of the tree, giving each closed circle a compact size so an opened one grows and its neighbours stay visible, and lifts every edge to the nearest visible ancestor of each end, so edge thickness follows the number of underlying interactions. Each edge bends whichever way takes it through the fewest closed circles, worked out once per layout. Edges are resolved to tree indices once per graph, so re-lifting them when something opens takes a couple of milliseconds even on next.js.

The map draws to a canvas (`web/src/render/renderer.ts`), which owns the camera, animation, pointer input and hit testing; React hands it a new scene only when what's open or selected changes, so zooming and panning never re-render the app. The SVG map it replaced dropped to 15–20 fps on next.js (13k nodes, 10k edges), with stalls of up to 1.7 s whenever circles opened, most of it the browser painting SVG and label DOM.

## Layers are per project

Each project defines its own layers. A layer is an id, a name and a list of matchers; a matcher names a fact, an imported package, a path glob or a whole repo (every field it sets must match) and a priority. Across all of a project's layers, the highest-priority match wins:

```json
{
  "id": "api",
  "name": "API",
  "rank": 3,
  "match": [
    { "fact": { "type": "route" }, "priority": 300 },
    { "import": "fastapi", "priority": 200 },
    { "path": "**/controllers/**", "priority": 100 }
  ]
}
```

Files nothing matches take the layer most of their callers have; anything still unplaced lands in **Unlayered**, which the sidebar counts so you can see what needs a rule. Symbols inherit their file's layer unless one of their own facts matches (a schema class in a models file, a fetch helper in a component file).

A new project starts from a preset, which is just data you then own:

| Preset | Layers |
| --- | --- |
| `roles` (default) | UI, Client, API, Service, Data, Job, Contract, Test, matched by code facts first (routes, JSX, ORM tables, requests), then imports, then file and folder names |
| `by-repo` | one layer per repository |
| `empty` | none; everything starts Unlayered |

The grouping lives in `.strata/projects/default/strata.grouping.json`. Edit it to rename layers, add matchers, or add `rules` (bulk moves by path, symbol name or current layer) and `pins` (single files or symbols); edits apply live, and the sidebar shows an error if the file doesn't validate. The sidebar also switches presets, and the detail panel shows why each file and symbol landed where it did.

Domains (the features that cut across layers and repos) come from the classification design's seed-and-propagate strategy (`indexer/src/classify/propagate.ts`). Routes (`GET /items/{id}`), ORM entities (`class Item`), page routes, and files in structural folders (`routes/items.py`, `components/Items/`) seed a domain when two or more files agree on it. Everything else takes the domain of the code it's connected to through calls, HTTP requests, renders and imports. A close split goes to **Shared**, and so does code that three or more features use directly. Code with no path to any seed joins the majority of its file, and anything left over is **Unsorted**. Domain pins in the grouping file act as seeds too, so they pull their unclaimed neighbours along. The older `feature-tokens` strategy is still available; strategies are swappable in `indexer/src/classify/index.ts`.

## Storage

Everything a project keeps (its repositories and its grouping) goes through the `ProjectStore` interface in `indexer/src/store.ts`. The default `FileProjectStore` writes under `.strata/projects/<id>/`. When `MONGODB_URI` is set, `createStore()` picks `MongoProjectStore` (`indexer/src/mongo-store.ts`) instead. The graph itself is always derived, never stored.

### MongoDB Atlas

With Atlas, each project is one document in the `projects` collection, keyed by project id, with the repo list and the grouping side by side. Restarting the indexer, or running it on another machine with the same connection string, brings the project back.

1. In [Atlas](https://cloud.mongodb.com), create a free cluster, then a database user under **Database Access**.
2. Under **Network Access**, allow your IP address.
3. Under **Connect > Drivers**, copy the connection string, put your user's password in it, and save it as `MONGODB_URI=...` in a `.env` file at the repo root (gitignored; `.env.example` lists the variables).
4. `npm run dev`. The indexer logs `saving projects to MongoDB at …`, never the password.

If Atlas can't be reached or read at startup, the indexer says why and saves under `.strata/` for that run, so the map still works offline. Clones and parsed code stay on local disk either way.

Two indexers can serve one project. Saving the repo list never touches the grouping and vice versa, and each carries a revision: if another indexer saved after this one loaded, the save is refused with a message to restart instead of silently undoing the other's change. Grouping edits made elsewhere don't apply live the way edits to `strata.grouping.json` do; restart to pick them up. MongoDB field names can't contain dots and symbol ids do, so `.`, `$` and `%` in keys are percent-escaped in the database and restored on load.

To see classification results without the UI:

```sh
npm run index -- ../some-repo org/other-repo --layers --domains
npm run index -- ../some-repo --preset by-repo
npm run index -- ../some-repo --grouping my.grouping.json --layers
```

## Watching a coding agent

Strata can follow a coding agent (Claude Code, Cursor, Codex, or anything that speaks MCP) while it works on a repository you've imported. A small window at the top right lists each agent's task and plan, with the step it's on, and the map marks what it touches: a mint ring on anything it added, amber on anything it changed, and a short pulse as each change lands. A closed circle shows a count of the changes inside it (`+2 ~3 −1`: files in the Code view, symbols By function), so you can see where an agent is working without opening anything. Click a changed file in the window, or any ringed circle, and the detail panel shows the diff (for a symbol, just the hunks that touch it).

There are two ways in, and they work best together:

- **Hooks** (deterministic). The agent's own tool hooks run `agent/bin/strata-hook.mjs` after every edit, so changes show up even when the agent never mentions them. The hook asks git about the agent's working tree: edited files come with their changed lines and a diff against HEAD, and after a shell command it compares the tree with the last call, so files removed with `rm` or `git mv`, generated files and reverts are caught too. Changes already in the tree when the agent started, or made by you between prompts, aren't put on the agent. Claude Code's plan (`TodoWrite`, or `TaskCreate`/`TaskUpdate`) becomes the step list, and your prompt is the task until the agent names its own.
- **MCP** (the agent's own words). `agent/bin/strata-mcp.mjs` is a stdio MCP server with two tools: `report_task` (the task, the plan as steps marked `pending`, `active` or `done`, the step it's on, a note) and `flag_changes` (files or folders `added`, `modified` or `deleted`, optionally with the functions or classes it touched). Its instructions ask the agent to call them as it goes; the hook covers whatever it forgets.

Both post to the indexer's `/api/agent/events`. A file maps to the graph by path when its repository was imported from a local directory, or by `origin` remote (then folder name) when the agent works in another checkout of an imported repository. When the agent edits a repository Strata reads in place, the indexer re-parses just the changed files and relinks (about 10 ms on the FastAPI template), so new files and symbols appear on the map, and comparing each file's symbols with HEAD says which functions were added, changed or deleted. The map fetches the new graph without moving the camera. Agent activity isn't stored anywhere; dismissing an agent in the window clears its marks.

Each session is its own card, even when two run in the same checkout. The MCP server finds its session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the servers it starts; for other clients, from the parent process it shares with that session's hooks. A file that only turned up when one session compared the working tree goes to whichever session's own tool wrote it.

### Claude Code

```sh
npm run agent:setup                                   # prints the two snippets below with this checkout's paths
npm run agent:setup -- --write /path/to/your/project  # or writes them for you
```

`--write` merges the hooks into `/path/to/your/project/.claude/settings.local.json` (your own, git-ignored settings; other hooks there are kept) and registers the MCP server for that project with `claude mcp add`. To do it by hand, add the server:

```sh
claude mcp add strata -- node /path/to/hackgt13/agent/bin/strata-mcp.mjs
```

and the hooks, in `.claude/settings.local.json`, `.claude/settings.json` (shared with your team) or `~/.claude/settings.json` (every project):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs", "timeout": 10 }] }],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|TodoWrite|TaskCreate|TaskUpdate",
        "hooks": [{ "type": "command", "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs", "timeout": 10 }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs", "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs", "timeout": 10 }] }]
  }
}
```

Then run `npm run dev`, import the repository you're working in by its local path (so edits re-index), and start Claude Code there. The hook never blocks or fails the agent: it gives up on the indexer after 1.5 s, always exits 0, and prints nothing Claude reads. It takes about 0.2 s per call on Node 22.18 or later, which runs the TypeScript directly; older Node goes through tsx and adds about 0.3 s.

### Other agents

- **Cursor**: add the MCP server in `.cursor/mcp.json` (`{ "mcpServers": { "strata": { "command": "node", "args": ["/path/to/hackgt13/agent/bin/strata-mcp.mjs"] } } }`) and the hook in `.cursor/hooks.json` under `afterFileEdit`, `beforeSubmitPrompt` and `stop` (`{ "version": 1, "hooks": { "afterFileEdit": [{ "command": "node /path/to/hackgt13/agent/bin/strata-hook.mjs" }], … } }`). The hook recognises Cursor's payloads by their `conversation_id` and `workspace_roots`.
- **Codex CLI**: add the MCP server under `[mcp_servers.strata]` in `~/.codex/config.toml` (`command = "node"`, `args = ["/path/to/hackgt13/agent/bin/strata-mcp.mjs"]`), and set `notify = ["node", "/path/to/hackgt13/agent/bin/strata-hook.mjs", "codex"]` so each finished turn sweeps the working tree for changes.
- **Anything else**, scripts included: `strata-hook changed <file>… [--kind added|modified|deleted]`, `strata-hook task "Add tags" --step "Add the model"`, `strata-hook sweep` (whatever changed in the working tree since the last call) and `strata-hook done`, with `--client <name>` to name the agent.

The Cursor and Codex payloads are handled as their docs describe them; only Claude Code has been run end to end. Set `STRATA_HOOK_LOG` to a file to record every payload the hook receives.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4178` | indexer port (the web dev server proxies `/api` to it; set `STRATA_INDEXER_PORT` for the proxy if you change it) |
| `STRATA_HOME` | `.strata/` | where clones and project files live |
| `STRATA_PROJECT` | `default` | which project the indexer serves |
| `MONGODB_URI` | unset | save projects to MongoDB (Atlas) instead of `.strata/projects/`; see [MongoDB Atlas](#mongodb-atlas) |
| `STRATA_MONGODB_DB` | `strata` | database that holds the `projects` collection |
| `STRATA_INCLUDE_TESTS` | off | set to `1` to index test files |
| `STRATA_MAX_FILES` | `4000` | per-repo file budget; the shallowest files are kept |
| `STRATA_GITHUB_TOKEN` | unset | token for private GitHub repos, passed per git command and never written to disk |
| `STRATA_URL` | `http://127.0.0.1:4178` | where the agent hook and MCP server send events |
| `STRATA_AGENT_STATE` | `$TMPDIR/strata-agent` | where the hook keeps each session's last view of the working tree |
| `STRATA_HOOK_LOG` | unset | append every payload the hook receives to this file, one JSON object per line |

The indexer also reads a `.env` file at the repo root; variables already set in your shell win.

The indexer binds to 127.0.0.1: importing a local path reads that directory, so it's a single-user development tool.

`vercel.json` builds only the web app (`web/dist`) for preview deployments. The indexer clones repositories and runs a long-lived server, so a Vercel preview shows the UI without an indexer behind it.

## Tests

```sh
npm test             # indexer: route matching, layer matchers, rules and pins, the file store, a two-repo fixture end to end,
                     #          agent changes mapped to files and symbols with incremental re-indexing
                     # web: edge lifting, click-mode layout, camera framing, agent change roll-ups
                     # agent: diff and status parsing, working-tree sweeps on a real git repo, the MCP handshake and tools
STRATA_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test   # also runs the MongoDB store tests
npm run typecheck
```

To measure how smoothly the map zooms and pans on a real graph (headless Chromium, both modes):

```sh
npm run build
npm run index -- vercel/next.js --out "$PWD/next.graph.json"
npm run bench -w @strata/web -- "$PWD/next.graph.json"   # needs npx playwright install chromium, or CHROMIUM_PATH
```
