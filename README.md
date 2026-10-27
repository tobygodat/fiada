# Fiada

[![ci](https://github.com/tobygodat/fiada/actions/workflows/ci.yml/badge.svg)](https://github.com/tobygodat/fiada/actions/workflows/ci.yml)

A map of your codebase that sorts itself, explains itself, and lights up where your coding agent is working.

Reading code file by file loses the big picture, and a one-paragraph architecture summary can't tell you what a change touches. Fiada sits in the middle. It turns one or more real repositories into a single zoomable map: circles nest from repository to folder to file to function, and the lines between them are contracts (imports, calls, HTTP requests, shared models), each with the code that proves it. Connect Claude Code and every file and function it touches rings on the map as it works, so you review agent work where it lives in the system instead of in a wall of diff.

**Try it:** https://fiada.tech (hosted, read-only) · [demo script](docs/demo-script.md) · [Devpost write-up](docs/devpost.md)

Built at HackGT 13 for the Oracle of the Deep track (ML/AI + visualization).

![The map: two repositories, opened into their modules](docs/screenshots/map.png)

## What it does

- **Sorts the code for you on import.** Every file and function lands in a layer (UI, Client, API, Service, Data, ...) and a feature domain (Items, Users, Login). Rules seed the domains from routes, ORM models and folder names and follow the call graph from there; a Claude model names the domains, merges duplicates and places what the rules couldn't, each with a one-line reason.
- **Says what each circle does.** Selecting a node shows a short generated summary above its calls and callers, cached by content hash.
- **Separates what it knows from what it guessed.** Every contract lists the lines of code behind it. Links the indexer only inferred are dotted, with a `?`, a confidence and a reason.
- **Shows your coding agent working.** Claude Code's hooks and an MCP server report each edit; the map rings what was added, changed or deleted, counts changes on closed circles, and shows the diff when you click.
- **Answers your coding agent's questions.** The same MCP server lets the agent ask the map where a feature lives, what uses a function (with the lines that prove it) and what an edit would reach across repositories, before it changes anything. What it looked at gets a faint dotted ring.
- **Two views of the same code.** **Code** is the structure as it is on disk. **By function** regroups the same functions by feature, then layer, so a feature that spans a React page, a generated client, a FastAPI route and a table reads as one circle.

| Following an HTTP contract to the code behind it | An agent at work: rings, counts, task and plan |
| --- | --- |
| ![Contract panel: 23 HTTP requests from the frontend to the backend, with the request line and the route it matched](docs/screenshots/contract.png) | ![Two Claude Code sessions on the FastAPI template, with rings on the files they changed](docs/screenshots/agent.png) |

![A selected function with its code in the detail panel](docs/screenshots/symbol.png)

## Run it locally

Needs Node 20.19 or later, [bun](https://bun.sh) 1.4 or later and git.

```sh
git clone https://github.com/tobygodat/fiada && cd fiada
bun install
bun run dev          # indexer on :4178, map on http://localhost:5178
```

Open http://localhost:5178, type `fastapi/full-stack-fastapi-template` in the box under **repositories**, and press **import**. For a private repository, use **upload a folder** under the box instead: the browser sends only the source files (it honours `.gitignore` and skips `node_modules` and the git history), up to 50 MB. Then:

1. Click a circle to see what it is; click it again to open it.
2. Under **view**, switch to **by function** and open the **Items** domain.
3. Click the **HTTP** tag between Client and API to read the contract, and click either end of an interaction to jump to its code.

Optional, in a `.env` at the repo root (`.env.example` lists them):

- `ANTHROPIC_API_KEY` turns on the AI sorting and the generated summaries, with Claude Haiku 5.5 (`OPENAI_API_KEY` works too). Without it, Fiada still sorts by rules and writes plain one-line summaries.
- `MONGODB_URI` saves projects to MongoDB Atlas instead of `.fiada/` on disk. See [MongoDB Atlas](#mongodb-atlas).

## Connect a Claude Code session

Import the repository you'll work in by its local path (so edits re-index in place), then:

```sh
bun run agent:setup --write /path/to/your/repo
cd /path/to/your/repo && claude
```

`--write` adds Fiada's hooks to that repo's `.claude/settings.local.json` and registers the Fiada MCP server with `claude mcp add`. For a map you signed in to, open **agents** in the sidebar and choose **connect an agent**: it gives one command to run in your project, no checkout of Fiada needed, which runs the published [`@fiadatech/agent`](agent/README.md) package:

```sh
npx -y --package=@fiadatech/agent fiada setup --write . --url=https://<indexer> --token=<token>
```

It saves where to report, and your token, in `~/.config/fiada/agent.json`, so no variables need setting. `npm install -g @fiadatech/agent`, then `fiada setup …`, does the same with a faster hook. Give Claude a task and watch the map: its task and plan appear in the agents window, each file or function it touches gets a ring, and what it reads or [asks the map about](#asking-the-map) gets a faint dotted one. If you start `claude` from inside another Claude Code session, `unset CLAUDE_CODE_SESSION_ID` first. Cursor, Codex and scripts are covered in [Watching a coding agent](#watching-a-coding-agent).

## Hosted demo

The map is at https://fiada.tech, a static build on Cloudflare Workers. It talks to the indexer at https://strataindexer-production.up.railway.app, a Docker container on Railway, which keeps accounts, projects and clones on a volume mounted at `/data`. Without GitHub sign-in configured, anyone can browse it and adding repositories needs the project's key; with it, everyone signs in and works in a project of their own ([Signing in with GitHub](#signing-in-with-github)). [Deploy](#deploy) explains the split.

## Using the map

Open http://localhost:5178 and add a repository in the sidebar. Anything git can clone works (`org/repo`, `github.com/org/repo`, an https or ssh URL), and so does an absolute path to a local checkout, which is read in place. For a private repository, or any folder the indexer can't reach, **upload a folder** under the import box: the browser walks it and sends only the source the indexer reads (up to 50 MB), leaving behind whatever its `.gitignore` files ignore, `node_modules` and the other dependency and build folders, and the git history. The indexer unpacks that into its own storage and indexes it like a clone, keeping the folder's `origin` remote, branch and HEAD from its `.git` so agents working in the real checkout still find it. Uploading the same folder again (same remote, else same name, or **upload again** on its row) replaces it. Add several and they share one map; imports, calls and HTTP requests that cross repositories become dashed edges.

Until you point at something the map draws only a few links: each open circle's strongest two or three, at most six in all (HTTP requests and cross-repository links count for more), untagged. That holds at every depth, so opening a big circle shows its own few key links rather than everything crossing its rim. Point at a circle, or select it, to see its strongest eight links, tagged with what they are ("HTTP · 23", "552 calls +40"); its tooltip says when more were left off, and its panel lists them all. (`?links=all` in the URL draws every link and tag, `?links=none` none until you point; the rules live in `web/src/render/edges.ts`.) Click a circle to select it: the detail panel says what it is, what it depends on and what depends on it. Click it again (or press Enter) to open it in place: its neighbours stay on screen as small closed circles, and edges reattach to the specific file or symbol inside that each one comes from. Click an open circle's name tab (or a breadcrumb) to close it again. Scroll only zooms and drag pans; neither opens or closes anything. Click an edge or its tag to read the contract between two parts, and click either end of any interaction listed there to go straight to the code responsible. Each interaction's **why** lists the code behind it (the request, the route and router mounts it matched, the import or call) and clicking a line shows that code in place. Contracts the indexer only guessed are dotted, with a `?` on their tag, and interactions it recorded without the code behind them say "no evidence found". The detail panel shows the selected file's or symbol's code. Back (the ← button, or Backspace) returns to where you were; Esc clears the selection.

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
2. **Parse** (`indexer/src/parse/`): tree-sitter (WASM, no native build) extracts imports, top-level symbols, the identifiers each symbol uses, server routes and the routers they hang off, client HTTP requests, client page routes (React Router, TanStack Router) and ORM links (SQLAlchemy relationships and foreign keys, GORM fields). TypeScript, TSX, JavaScript, Python and Go in the most depth; Java, Kotlin, C#, Rust, C, C++, Ruby and Swift get their types and methods (as `Type.method`), what each uses, and the routes of Spring, JAX-RS, ASP.NET controllers and minimal APIs, and actix/Rocket attributes. A language is a grammar plus one extractor.
3. **Link** (`indexer/src/link.ts`): resolves imports (relative paths, tsconfig `paths`, workspace packages, Python packages, Go modules, Java and Kotlin packages, C# namespaces, Rust `use` paths and `mod` files by Cargo crate, C and C++ includes, Ruby requires, across every imported repo), finds the names a language shares without an import (a Java package's classes, a C# namespace and its parents, a Swift module's files, Ruby's global constants, whatever a header declares), binds identifiers to the symbols they name through re-exports and barrels, follows router mounts (`include_router`, `register_blueprint`, `app.use`, gin groups) to give every route its full path, and matches requests like `fetch(\`${API}/items/${id}\`)` to routes like FastAPI's `@router.get("/{id}")` under `APIRouter(prefix="/items")`. Every edge records the code behind it (file, line and that line's text) and whether it's **evidenced** (the code names the target, or a request's full path equals the route's) or **inferred** (a heuristic linked them, such as a URL that only matches a route's tail), with a confidence and a one-line reason.
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

The grouping lives in `.fiada/projects/default/fiada.grouping.json`. Edit it to rename layers, add matchers, or add `rules` (bulk moves by path, symbol name or current layer) and `pins` (single files or symbols); edits apply live, and the sidebar shows an error if the file doesn't validate. The sidebar also switches presets, and the detail panel shows why each file and symbol landed where it did.

Domains (the features that cut across layers and repos) come from the classification design's seed-and-propagate strategy (`indexer/src/classify/propagate.ts`). Routes (`GET /items/{id}`), ORM entities (`class Item`), page routes, and files in structural folders (`routes/items.py`, `components/Items/`) seed a domain when two or more files agree on it. Everything else takes the domain of the code it's connected to through calls, HTTP requests, renders and imports. A close split goes to **Shared**, and so does code that three or more features use directly. Code with no path to any seed joins the majority of its file, and anything left over is **Unsorted**. Domain pins in the grouping file act as seeds too, so they pull their unclaimed neighbours along. The older `feature-tokens` strategy is still available; strategies are swappable in `indexer/src/classify/index.ts`.

### Sorted on import

With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, a fresh import doesn't stop at the classifier. Once every repository is indexed, the indexer asks the model (Claude or OpenAI, through `indexer/src/llm.ts`; the steps are in `indexer/src/classify/model-sort.ts`, off the request path) to finish the job in two steps:

1. **Domains.** The model sees each domain the classifier found (its files, what seeded it, its biggest symbols) and an outline of what's left over. It gives each a plain product name, merges domains that are one feature ("Shares" and "Sharing"), and adds the few domains the leftovers need ("Platform").
2. **Leftovers.** Every file with code in Unlayered or Unsorted goes to the model in batches, with its imports, detected facts, symbols, and the domains and layers of the code around it. It picks one of the project's layers and a domain, with a one-line reason.

The result is saved in the grouping as `sorted`, through the same `ProjectStore`, and the map redraws when it lands. It only fills gaps: code the classifier placed keeps its place, and your renames, rules and pins win over it, so you adjust from a sorted map exactly as before. Each placement the model made shows its reason in the detail panel, marked as inferred by Claude or OpenAI. A new repository or commit sorts again; the sidebar's **sort again** does it on demand (`POST /api/grouping/sort`). Delete `sorted` from the grouping to drop it. Without a key, imports keep the classifier's result and the sidebar says sorting is unavailable.

`bun run index <repos> --sort` runs the same sort from the command line and prints how much was left unsorted before and after.

## Node summaries

The first thing under a selected node's name in the detail panel is what it does. Every node gets a line straight away, built from what the indexer knows ("Handles POST /api/v1/items/. Called over HTTP by ItemsService.", "Defines list_items, create_item and unused. Used by items.py.") and led by the first sentence of the code's own docstring or doc comment when it has one. With `ANTHROPIC_API_KEY` set on the indexer, the model writes one or two sentences per node from its code and neighbours, through the same client the sort uses (`indexer/src/llm.ts`), with `claude-haiku-5-5` (or `FIADA_SUMMARY_MODEL`; on OpenAI, `gpt-5-mini` by default), marked "generated" with the model's name. Its uses and used-by lists sit folded under the summary with their counts.

Generated summaries are written in batches, off the request path: after each import or re-index, files first, then folders (deepest first, each reading its children's summaries), domains and their layers, then repositories; a symbol's whole file is written in one request when one of its symbols is first selected. Each summary is cached under a hash of what the model read and saved through the `ProjectStore`, so a restart costs nothing and a re-index rewrites only what changed and what contains it. `bun run index <repo> --summaries` prints sample lines and how many requests a fresh import would make, without calling a model: the FastAPI template takes 11 requests for 197 summaries of files, folders, groups and the repository (about 29,000 input tokens), and outline 70 requests for 2,566 (about 430,000); symbols cost one request per file, only as files are opened. The code lives in `indexer/src/summaries/`.

## Storage

Everything a project keeps (its repositories, its grouping and its generated summaries), and the accounts of people who sign in with GitHub, goes through the `ProjectStore` interface in `indexer/src/store.ts`. The default `FileProjectStore` writes under `.fiada/projects/<id>/`. When `MONGODB_URI` is set, `createStore()` picks `MongoProjectStore` (`indexer/src/mongo-store.ts`) instead. The graph itself is always derived, never stored.

### MongoDB Atlas

With Atlas, each project is one document in the `projects` collection, keyed by project id, with the repo list and the grouping side by side. Restarting the indexer, or running it on another machine with the same connection string, brings the project back.

1. In [Atlas](https://cloud.mongodb.com), create a free cluster, then a database user under **Database Access**.
2. Under **Network Access**, allow your IP address.
3. Under **Connect > Drivers**, copy the connection string, put your user's password in it, and save it as `MONGODB_URI=...` in a `.env` file at the repo root (gitignored; `.env.example` lists the variables).
4. `bun run dev`. The indexer logs `saving projects to MongoDB at …`, never the password.

If Atlas can't be reached or read at startup, the indexer says why and saves under `.fiada/` for that run, so the map still works offline. Clones and parsed code stay on local disk either way.

Two indexers can serve one project. Saving the repo list never touches the grouping and vice versa, and each carries a revision: if another indexer saved after this one loaded, the save is refused with a message to restart instead of silently undoing the other's change. Grouping edits made elsewhere don't apply live the way edits to `fiada.grouping.json` do; restart to pick them up. MongoDB field names can't contain dots and symbol ids do, so `.`, `$` and `%` in keys are percent-escaped in the database and restored on load.

To see classification results without the UI:

```sh
bun run index ../some-repo org/other-repo --layers --domains
bun run index ../some-repo --preset by-repo
bun run index ../some-repo --grouping my.grouping.json --layers
```

## Watching a coding agent

Fiada can follow a coding agent (Claude Code, Cursor, Codex, or anything that speaks MCP) while it works on a repository you've imported. A small window at the top right lists each agent's task and plan, with the step it's on, and the map marks what it touches: a ring just outside anything it added (ink), changed (ochre) or deleted (dashed brick), and a short pulse as each change lands. Those colours only ever mean a change on the map; in the window, a green dot means the agent is working and an ochre one means it's waiting for you. A closed circle shows a count of the changes inside it (`+2 ~3 −1`: files in the Code view, symbols By function) on whichever side of it is clear of links and tags, so you can see where an agent is working without opening anything. Click a changed file in the window, or any ringed circle, and the detail panel shows the diff (for a symbol, just the hunks that touch it).

There are two ways in, and they work best together:

- **Hooks** (deterministic). The agent's own tool hooks run `agent/bin/fiada-hook.mjs` after every edit, so changes show up even when the agent never mentions them. The hook asks git about the agent's working tree: edited files come with their changed lines and a diff against HEAD, and after a shell command it compares the tree with the last call, so files removed with `rm` or `git mv`, generated files and reverts are caught too. Changes already in the tree when the agent started, or made by you between prompts, aren't put on the agent. Claude Code's plan (`TodoWrite`, or `TaskCreate`/`TaskUpdate`) becomes the step list, and your prompt is the task until the agent names its own.
- **MCP** (the agent's own words). `agent/bin/fiada-mcp.mjs` is a stdio MCP server. Two tools report: `status` (one or two lines on what it's doing now, with the task and the plan as steps marked `pending`, `active` or `done`; `report_task` is its older name) and `flag_changes` (files or folders `added`, `modified` or `deleted`, optionally with the functions or classes it touched). Three more [ask the map](#asking-the-map). Its instructions ask the agent to call them as it goes; the hook covers whatever it forgets.

Both post to the indexer's `/api/agent/events`. A file maps to the graph by path when its repository was imported from a local directory, or by `origin` remote (then folder name) when the agent works in another checkout of an imported repository. When the agent edits a repository Fiada reads in place, the indexer re-parses just the changed files and relinks (about 10 ms on the FastAPI template), so new files and symbols appear on the map, and comparing each file's symbols with HEAD says which functions were added, changed or deleted. The map fetches the new graph without moving the camera. Agent activity isn't stored anywhere; dismissing an agent in the window clears its marks.

### Asking the map

The MCP server also gives the agent three read-only tools, so it can use the map before it changes anything instead of grepping its way around:

| tool | asks | answers with |
| --- | --- | --- |
| `where_is` | where a feature, function, class, file or route lives (`"create item"`, `"ItemsService"`, `"POST /items"`) | each match's repository, path and lines, its layer and domain, what it serves, a one-line summary, and an id to pass on |
| `who_uses` | what calls, imports, renders, references or requests a function, class, file or folder | each user with the `file:line` and code behind every link, whether the link is proven or inferred, and whether it is in another repository |
| `impact` | what an edit to it reaches: its users, their users, and so on (3 links by default, at most 6) | the reached code nearest first, with counts by repository, layer and domain; HTTP requests matched to routes carry it from a server into the clients that call it |

A target is an id from `where_is`, a path (absolute in the agent's checkout, or relative to the repository), `path#symbol`, or a name; a name that fits several things comes back as a short list to pick from. Every answer comes from the graph the map draws, evidence and all, across every repository imported on the map. The tools call the indexer's `GET /api/agent/find?q=`, `/api/agent/dependents?node=` and `/api/agent/impact?node=&depth=` (each with an optional `&limit=`) with the same `FIADA_URL` and token the reports use; on an indexer people sign in to, an agent token may read these three routes and nothing else besides reporting.

What the agent asked about, and every file it opens with Claude Code's Read tool, is reported as looked at (a `looked` event). The map draws it as a faint dotted ring in `--muted`, apart from the change rings: a changed node shows its change instead, and a closed circle with something looked at inside gets a fainter one. The detail panel says "looked at by Claude Code", and the agent's card lists what it looked at, each a way onto the map.

Each session is its own card, even when two run in the same checkout. The MCP server finds its session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the servers it starts; for other clients, from the parent process it shares with that session's hooks. A file that only turned up when one session compared the working tree goes to whichever session's own tool wrote it.

### Claude Code

```sh
bun run agent:setup                                   # prints the two snippets below with this checkout's paths
bun run agent:setup --write /path/to/your/project  # or writes them for you
```

`--write` merges the hooks into `/path/to/your/project/.claude/settings.local.json` (your own, git-ignored settings; other hooks there are kept) and registers the MCP server for that project with `claude mcp add`. To do it by hand, add the server:

```sh
claude mcp add fiada -- node /path/to/fiada/agent/bin/fiada-mcp.mjs
```

and the hooks, in `.claude/settings.local.json`, `.claude/settings.json` (shared with your team) or `~/.claude/settings.json` (every project):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|TodoWrite|TaskCreate|TaskUpdate|Read",
        "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }]
  }
}
```

Then run `bun run dev`, import the repository you're working in by its local path (so edits re-index), and start Claude Code there. The hook never fails the agent and blocks only what you fenced off: it gives up on the indexer after 1.5 s, always exits 0, and prints only the status brief and, for an edit inside a fence, Claude Code's own "ask" or "deny". It takes about 0.2 s per call on Node 22.18 or later, which runs the TypeScript directly; older Node goes through tsx and adds about 0.3 s.

The same package is on npm as [`@fiadatech/agent`](agent/README.md): `npx -y --package=@fiadatech/agent fiada setup --write .` in your project does what `bun run agent:setup` does here, without a checkout. Its commands are `fiada setup`, `fiada hook` and `fiada mcp` (the hook and MCP server are also `fiada-hook` and `fiada-mcp`).

To publish a new version: bump `version` in `agent/package.json`, then `npm publish -w @fiadatech/agent`. Publishing bundles `agent/src` into `agent/dist/cli.js` with esbuild (`bun run agent:build`): one file with no dependencies, since Node won't strip types from a package in `node_modules`. A checkout keeps running the TypeScript source.

### Fences and collisions

Select a repository, folder, file or symbol and set its **fence** in the detail panel: **ask first** or **off limits**. Fences are kept per project (`fences.json` beside the grouping, or the project's MongoDB document). The map draws a dashed ink line inside a circle marked ask first, and a closed line with hatching inside one marked off limits.

Before Claude Code's Edit, Write, MultiEdit or NotebookEdit lands, the `PreToolUse` hook asks the indexer (`POST /api/agent/check`) about the file and, for Edit and MultiEdit, the lines it replaces, so a fence on one function stops only edits that reach it. Lines count only where Fiada reads the checkout in place, placed against the file as it is on disk right then; in any other checkout (a clone on the hosted map, a second worktree) the edit counts as the whole file, so a fenced function's file asks or refuses. A checkout whose `origin` remote matches no imported repository is never fenced by folder name alone. Off limits answers `deny` with the reason, so Claude leaves the file alone; ask first answers `ask`, so Claude Code asks you. Outside every fence, or when Fiada doesn't answer, the hook says nothing and your own permission settings decide. Fences check Claude Code's edit tools only: a shell command (`sed -i`, `>`, `git checkout`) isn't parsed for the files it writes, so it isn't stopped, though what it changed still shows on the map afterwards. The agents window says when an agent was stopped or asked. `fiada-hook check <file>…` prints the verdict for scripts.

When two agents have changes in one file or folder, the agents window says so at the top ("two agents in api/app/routes", with their names) and the map writes "two agents" on that circle, or on the closed circle it's in.

### Other agents

- **Cursor**: add the MCP server in `.cursor/mcp.json` (`{ "mcpServers": { "fiada": { "command": "node", "args": ["/path/to/fiada/agent/bin/fiada-mcp.mjs"] } } }`) and the hook in `.cursor/hooks.json` under `afterFileEdit`, `beforeSubmitPrompt` and `stop` (`{ "version": 1, "hooks": { "afterFileEdit": [{ "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs" }], … } }`). The hook recognises Cursor's payloads by their `conversation_id` and `workspace_roots`.
- **Codex CLI**: add the MCP server under `[mcp_servers.fiada]` in `~/.codex/config.toml` (`command = "node"`, `args = ["/path/to/fiada/agent/bin/fiada-mcp.mjs"]`), and set `notify = ["node", "/path/to/fiada/agent/bin/fiada-hook.mjs", "codex"]` so each finished turn sweeps the working tree for changes (the first one counts what changed since Codex started).
- **Anything else**, scripts included: `fiada-hook changed <file>… [--kind added|modified|deleted]`, `fiada-hook task "Add tags" --step "Add the model"`, `fiada-hook sweep` (whatever changed in the working tree since the last call) and `fiada-hook done`, with `--client <name>` to name the agent.

The Cursor and Codex payloads are handled as their docs describe them; only Claude Code has been run end to end. Set `FIADA_HOOK_LOG` to a file to record every payload the hook receives.

## Signing in with GitHub

Set `FIADA_GITHUB_CLIENT_ID` and `FIADA_GITHUB_CLIENT_SECRET` on the indexer and it becomes a place many people can use at once:

- **Everyone signs in.** The map opens on a sign-in screen, and every API route answers only a signed-in browser. The shared project isn't used, and `FIADA_API_KEY` opens only the owner's usage numbers (see [Using it](#3-using-it)).
- **Each person has their own project.** Their repositories, clones (`$FIADA_HOME/clones/gh-<GitHub user id>/`), grouping, summaries and agent activity are theirs alone: what one person imports or has an agent do never shows on anyone else's map. A project opens on its owner's first request and is let go after 30 idle minutes; opening it again re-indexes from its clones.
- **Private repositories work.** The sign-in asks GitHub for the `repo` scope, and the person's own token clones and pulls what they import (passed per git command, never written to disk). Their recently pushed repositories are offered under the import box. The token is kept on their account encrypted with AES-GCM; `FIADA_GITHUB_TOKEN` is never used for anyone's project.
- **Nobody can use it up for everyone else.** Each person may make 60 changes a minute (agents 600 reports), hold 20 repositories of at most 500 MB each, and spend 200 model requests a day on sorting and summaries; past that, the map says so and summaries fall back to lines from the graph. Clones come over https from GitHub, GitLab and Bitbucket only, and nothing in a clone is read through a link that leads out of it. The variables are in [Configuration](#configuration).
- **People can leave.** **delete account** in the sidebar withdraws Fiada's access at GitHub and deletes the account, the project, its clones, fences and summaries. The map's [/privacy](https://fiada.tech/privacy) page says what is kept; change it with the code.
- **Agents need one command.** **connect an agent** in the sidebar shows `bun run agent:setup --write <project> --url <indexer> --token <token>`. The token lets an agent report to that person's map and nothing else; **new token** revokes the old one.

To set it up, create an OAuth app at GitHub under **Settings > Developer settings > OAuth Apps** with the callback URL `<indexer>/api/auth/github/callback`: `http://localhost:5178/api/auth/github/callback` for `bun run dev` (the dev server forwards the address it was reached at), or `https://<indexer>/api/auth/github/callback` hosted. Put its client id and a client secret in `.env` or the host's variables. The map's origin must be allowed to receive the session: its own origin, the fiada.tech domains, or one in `FIADA_ALLOWED_ORIGINS`. If a proxy in front of the indexer doesn't forward the scheme and host, set `FIADA_PUBLIC_URL`.

Sessions and agent tokens are signed rather than stored, with a key derived from `FIADA_SESSION_SECRET`, or else the client secret. A session lasts 30 days in one browser; **sign out** forgets it there. Changing the secret signs everyone out and they sign in again, keeping their projects. Accounts go through `ProjectStore` like everything else (`$FIADA_HOME/accounts/<id>.json`, or the `accounts` collection in MongoDB).

## Configuration

Fiada used to be called Strata. Every `FIADA_*` variable is also read under its old `STRATA_*` name (the old name wins if both are set), a checkout that already has a `.strata/` folder keeps using it, and the MongoDB database is still called `strata` by default, so existing deployments keep working unchanged.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4178` | indexer port (the web dev server proxies `/api` to it; set `FIADA_INDEXER_PORT` for the proxy if you change it) |
| `HOST` | `127.0.0.1` | address the indexer listens on (`0.0.0.0` in the container, and by default on Railway, Render and Fly) |
| `FIADA_HOME` | `.fiada/` (or `.strata/` if that exists) | where clones and project files live |
| `FIADA_PROJECT` | `default` | which project the indexer serves |
| `MONGODB_URI` | unset | save projects to MongoDB (Atlas) instead of `.fiada/projects/`; see [MongoDB Atlas](#mongodb-atlas) |
| `FIADA_MONGODB_DB` | `strata` | database that holds the `projects` collection |
| `FIADA_SUMMARIES` | on | `off` writes no generated [node summaries](#node-summaries) even with a key set; the lines stay |
| `FIADA_INCLUDE_TESTS` | off | set to `1` to index test files |
| `FIADA_MAX_FILES` | `4000` | per-repo file budget; the shallowest files are kept |
| `FIADA_GITHUB_CLIENT_ID`, `FIADA_GITHUB_CLIENT_SECRET` | unset | a GitHub OAuth app: turns on [signing in with GitHub](#signing-in-with-github), with a project per person |
| `FIADA_SESSION_SECRET` | the client secret | signs sessions and agent tokens and encrypts GitHub tokens; changing it signs everyone out |
| `FIADA_GITHUB_SCOPE` | `read:user repo` | what the sign-in asks GitHub for; `repo` is what reading private repositories takes |
| `FIADA_PUBLIC_URL` | the address the request came to | the indexer's public URL, for the sign-in callback and the agent setup command, when a proxy doesn't forward it |
| `FIADA_GITHUB_TOKEN` | unset | without sign-in: token for private GitHub repos, passed per git command and never written to disk |
| `FIADA_GIT_HOSTS` | `github.com,gitlab.com,bitbucket.org` | where an indexer others can reach may clone from; `*` for any host, still over https only. Your own indexer clones from anywhere |
| `FIADA_MAX_REPOS` | `20` | repositories one project may hold, on an indexer others can reach |
| `FIADA_MAX_CLONE_MB` | `500` | largest clone kept on an indexer others can reach; a larger one is removed and its row says why |
| `FIADA_RATE_LIMIT` | `60` | changes (imports, layers, removals) one person, or one address without sign-in, may make a minute; reads aren't limited, nor is an indexer on loopback |
| `FIADA_AGENT_RATE_LIMIT` | `600` | agent reports one person may post a minute |
| `FIADA_LLM_DAILY` | `200` | with sign-in: model requests (sorting and summaries) each person's map may make a UTC day |
| `FIADA_UPLOAD_MB` | `50` | most megabytes of source one folder upload may carry (20,000 files at most) |
| `ANTHROPIC_API_KEY` | unset | lets the indexer sort each import with Claude and write [node summaries](#node-summaries); see [Sorted on import](#sorted-on-import) |
| `OPENAI_API_KEY` | unset | the same with OpenAI; with both keys set, Claude answers unless `FIADA_LLM_MODEL` names an OpenAI model |
| `FIADA_LLM_MODEL` | `claude-haiku-5-5`, or `gpt-5.5` for OpenAI | the model it sorts with; without one, OpenAI falls back to `gpt-5`, then `gpt-4.1`, when the key can't use `gpt-5.5` |
| `FIADA_SUMMARY_MODEL` | Claude's default, or `gpt-5-mini` on OpenAI | the model that writes [node summaries](#node-summaries), which are many and short; OpenAI falls back to the models above when the key can't use `gpt-5-mini` |
| `FIADA_ALLOWED_ORIGINS` | unset | comma-separated origins whose pages may call the API (the map hosted elsewhere); `*` in an entry matches one run of letters, digits and hyphens |
| `FIADA_API_KEY` | unset | without sign-in: anything that changes the project (imports, layers, agent events) needs `Authorization: Bearer <key>`; reads stay open |
| `FIADA_ALLOW_LOCAL` | on for `127.0.0.1` | `1` or `0`: whether local folders can be imported. Off by default when `HOST` isn't loopback |
| `VITE_API_URL` | unset; `web/.env.production` sets the Railway indexer for production builds | build time, web: the indexer's URL when the map is served apart from it; unset, the map calls its own origin |
| `FIADA_URL` | the saved config, else `http://127.0.0.1:4178` | where the agent hook and MCP server send events |
| `FIADA_TOKEN` (agent) | the saved config's, for its URL only | the person's agent token, for an indexer people sign in to |
| `FIADA_API_KEY` (agent) | unset | the hook and MCP server send it to a shared indexer that has one |
| `FIADA_CONFIG` (agent) | `~/.config/fiada/agent.json` | where `agent:setup --url … --token …` saves them |
| `FIADA_AGENT_STATE` | `$TMPDIR/fiada-agent` | where the hook keeps each session's last view of the working tree |
| `FIADA_HOOK_LOG` | unset | append every payload the hook receives to this file, one JSON object per line |

The indexer also reads a `.env` file at the repo root; variables already set in your shell win.

The indexer binds to 127.0.0.1 by default: importing a local path reads that directory, so on your own machine it's a single-user tool. [Deploy](#deploy) covers running it where others can reach it.

## Deploy

The map is a static build; the indexer is a long-running server that clones repositories to disk, parses them with tree-sitter, keeps the graph in memory and streams agent activity. So they live apart: **the map on Cloudflare Workers, the indexer in a container** on a host that runs one (Railway, Fly.io or Render; the `Dockerfile` at the root works on each). Workers are short-lived and stateless, with no git and nowhere to keep clones, so the indexer can't run there.

```
browser ── https://fiada.tech ─────────────── static map (web/dist)
   └────── VITE_API_URL ── https://<indexer> ── indexer container ── /data: accounts, projects, clones
                                                     └── MongoDB Atlas, if MONGODB_URI is set
```

### 1. The indexer (Railway, for example)

New project, **Deploy from GitHub repo**, pick this repository; Railway builds the root `Dockerfile`. Railway may offer a service for every package in the workspace: keep only `@strata/indexer` (the map is on Cloudflare and the agent runs beside your editor), and clear its custom start command so the `Dockerfile`'s runs. Then set the service's variables and, under **Networking**, generate a public domain on port 4178.

| Variable | Value |
| --- | --- |
| `PORT` | `4178` |
| `MONGODB_URI` | the Atlas connection string, as in `.env` |
| `FIADA_PROJECT` | a project of its own, e.g. `demo`, so it doesn't share (and fight over) the repo list with the indexer on your laptop, whose local folders it can't read |
| `FIADA_ALLOWED_ORIGINS` | `https://fiada.tech,https://fiada-web.<account>.workers.dev,https://*-fiada-web.<account>.workers.dev` (production, the Worker's own address, and its preview versions) |
| `FIADA_GITHUB_CLIENT_ID`, `FIADA_GITHUB_CLIENT_SECRET` | a GitHub OAuth app with the callback `https://<indexer>/api/auth/github/callback`: everyone signs in and gets a project of their own (see [Signing in with GitHub](#signing-in-with-github)); `FIADA_PROJECT` is then unused, and `FIADA_API_KEY` opens only `/api/admin/stats` |
| `FIADA_API_KEY` | a long random string (`openssl rand -hex 24`). Without sign-in, without it anyone with the URL can import repos into your project or remove them; with sign-in, it opens only the usage numbers (`/api/admin/stats`) |
| `FIADA_GITHUB_TOKEN` | only to import private repos by URL; uploading the folder from the map needs no token. Either way reads need no key, so anyone with the map's URL can read their code |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | to sort each import with a model and write node summaries; without one the map keeps the classifier's result and one-line summaries |

In Atlas, **Network Access** must allow the host: Railway has no fixed outbound addresses on its standard plans, so that means `0.0.0.0/0`. The container starts with `HOST=0.0.0.0` and `FIADA_HOME=/data`, runs as the `node` user, and turns local folder imports off. With `MONGODB_URI` set, a fresh container re-clones the project's repositories on start, so no volume is needed; mount one on `/data` to skip that (on Railway, also set `RAILWAY_RUN_UID=0` so it can write there). Uploaded folders are the exception: their files live only on the indexer's disk, so without a volume every deploy loses them, and their rows say to upload the folder again. It idles at about 100 MB and used about 200 MB with the FastAPI template and Excalidraw indexed, so 512 MB is enough.

Check it: `curl https://<indexer>/api/auth` answers `{"mode":"github"}` with sign-in on; without it, `curl https://<indexer>/api/workspace` should answer with `"access":{"localPaths":false,"keyRequired":true}`.

On Fly.io: `fly launch` (it finds the Dockerfile; internal port 4178), then `fly secrets set MONGODB_URI=… FIADA_API_KEY=…` and the rest. Render's free instances sleep when idle and take a while to wake, which a demo will notice.

### 2. The map (Cloudflare Workers)

The map is an assets-only Worker: `wrangler.jsonc` at the root serves `web/dist`, with no Worker script. In the Cloudflare dashboard, **Workers & Pages > Create > Import a repository**, pick `tobygodat/fiada`, and set:

| Setting | Value |
| --- | --- |
| Root directory | the repository root (leave it empty) |
| Build command | `bun install --frozen-lockfile --filter @fiada/web && bun run build` |
| Deploy command | `npx wrangler deploy` |
| Build variable `BUN_VERSION` | `1.4.2`, the version CI uses, so `--frozen-lockfile` reads `bun.lock` |
| Build variable `SKIP_DEPENDENCY_INSTALL` | `1`, so the build command's filtered install is the only one and the map can't lean on indexer packages |

The Worker's name in the dashboard must be `fiada-web`, the `name` in `wrangler.jsonc`, or the deploy step fails.

Every push to `main` then builds and deploys. No build variable is needed: `web/.env.production` sets `VITE_API_URL` to `https://strataindexer-production.up.railway.app`, and Vite writes it into the bundle at build time. If your indexer lives elsewhere, change that file, or set `VITE_API_URL` as a build variable, which wins. Without either, the deployed map calls `/api` on its own origin and gets `index.html` back instead of the indexer's answers.

Paths that aren't files, such as `/privacy`, get `index.html` (`not_found_handling` in `wrangler.jsonc`). `web/public/_headers`, which Vite copies into `web/dist`, sends the site's security headers. Its Content-Security-Policy lets the page call only its own origin and the indexer at `https://strataindexer-production.up.railway.app`, so **if the indexer moves, change `connect-src` there too**, or the map can't reach it. Builds also carry Cloudflare's Web Analytics beacon (added in `web/vite.config.ts`, not in dev), so the CSP allows `static.cloudflareinsights.com` to load it and `cloudflareinsights.com` to receive its reports; visits show under Analytics, Web analytics in the Cloudflare dashboard. It allows `index.html`'s inline theme script by its hash; `web/src/csp.test.ts` fails when that script changes without a new hash.

The Worker answers at `https://fiada-web.<account>.workers.dev`; add that origin to the indexer's `FIADA_ALLOWED_ORIGINS` so the map can call the indexer from there too. The custom domain `fiada.tech` needs its zone on Cloudflare: add the site under **Websites**, point the registrar at Cloudflare's nameservers, then add `fiada.tech` under the Worker's **Settings > Domains & Routes**.

### 3. Using it

With GitHub sign-in, open `https://fiada.tech`, sign in, and import your repositories, private ones included; **connect an agent** in the sidebar gives the command that points Claude Code at your map. Its changes land on the clone of the same repository (matched by `origin` remote), ringed on files and symbols that exist at HEAD.

With `FIADA_API_KEY` set, either way, the indexer counts its use for the owner: how many people have accounts, sign-ups by month, how many signed in within 7 and 30 days, and how many repositories their projects keep. Counts only; no logins or names.

```sh
curl -H "Authorization: Bearer $FIADA_API_KEY" https://strataindexer-production.up.railway.app/api/admin/stats
```

Without the key set the route answers 404, and without the key sent, 401. Deleted accounts are gone, so they count nowhere.

Without sign-in, one shared project:

- Open `https://fiada.tech/?key=<FIADA_API_KEY>` once. The map keeps the key in that browser and drops it from the address bar; then add repositories as usual (`org/repo` or a git URL). `?key=` with nothing forgets it.
- Everyone else gets the plain URL: the same map, read-only, without the import box, the layer presets or the dismiss buttons.
- To show a coding agent on the hosted map, run `bun run agent:setup --url https://<indexer> --token <key>` once (or start it with `FIADA_URL` and `FIADA_API_KEY` in its environment). Its changes land on the clone of the same repository (matched by `origin` remote), ringed on files and symbols that exist at HEAD. Files and symbols it adds only appear as new circles on an indexer that reads the checkout in place, i.e. one on your own machine.

To try the split locally: `docker build -t fiada-indexer . && docker run -p 4178:4178 -e FIADA_ALLOWED_ORIGINS=http://localhost:5199 -e FIADA_API_KEY=dev fiada-indexer`, then `VITE_API_URL=http://localhost:4178 bun run build && bun run --cwd web preview --port 5199`.

## Tests

```sh
bun run test             # indexer: route matching, layer matchers, rules and pins, the file store, a two-repo fixture end to end,
                     #          agent changes mapped to files and symbols with incremental re-indexing
                     # web: edge lifting, click-mode layout, camera framing, agent change roll-ups
                     # agent: diff and status parsing, working-tree sweeps on a real git repo, the MCP handshake and tools,
                     #        the read tools against a stand-in indexer
                     # ask: where_is, who_uses and impact over a two-repo fixture, and the read routes on a running indexer
                     # sign-in: signed sessions and agent tokens, sealed GitHub tokens, one person's project apart from another's
FIADA_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 bun run test   # also runs the MongoDB store tests
bun run typecheck
```

To measure how smoothly the map zooms and pans on a real graph (headless Chromium, both modes):

```sh
bun run build
bun run index vercel/next.js --out "$PWD/next.graph.json"
bun run --cwd web bench "$PWD/next.graph.json"   # needs bunx playwright install chromium, or CHROMIUM_PATH
```

## License

MIT; see [LICENSE](LICENSE).
