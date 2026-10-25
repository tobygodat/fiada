# Fiada: Devpost write-up

Track: Oracle of the Deep (ML/AI + visualization). Also entered for MLH Best Use of MongoDB Atlas, MLH Best Domain Name from .tech (https://fiada.tech), and the Create-X checkbox.

## Tagline

A map of your codebase that sorts itself, explains itself, and lights up where your coding agent is working.

## Inspiration

Coding agents now change more code in an hour than I can read in a day. The tools I have for keeping up are a file tree, a chat log and a diff. The file tree is too low: I read one file at a time and lose the shape of the system. A one-paragraph architecture summary is too high: it can't tell me what a change touches. I wanted something in the middle, a view where I can see the parts of a system, how they talk to each other, and where an agent is working right now, and then drop down to the code when I need to.

## What it does

Fiada turns one or more real repositories into a single zoomable map. Circles nest from repository to folder to file to function. Click a circle to see what it is, click again to open it in place, and the rest of the map stays on screen around it. Lines between circles are contracts: imports, calls, HTTP requests, shared types and database models, with thickness showing how many interactions sit underneath.

The AI part is what makes the map readable on a repo you've never seen:

- **It sorts the code for you on import.** Every file and function lands in a layer (UI, Client, API, Service, Data, and so on) and a feature domain (Items, Users, Login). Code facts do most of the work: routes, ORM models, JSX, HTTP requests and folder names seed the domains, and the rest follows the call graph. An OpenAI model then names the domains, merges ones that mean the same thing, and places the leftovers nothing else could, with a one-line reason you can read in the panel. You start from a sorted map and adjust it, rather than from a pile of "Unsorted".
- **Every circle says what it does in one line.** Selecting a node shows a short generated summary at the top of the panel, above the list of calls and callers, so you don't have to open the code to know what `ItemsService` is for. Summaries are cached by content hash, so they're only regenerated when the code changes.
- **It tells you which links it's sure of.** Every contract carries its evidence: the exact line of the request, the route and the router mounts it matched. Links the indexer could only infer (a URL that matches a route's tail, a model name shared by several classes) are drawn dotted with a `?`, with a confidence and a reason. On the FastAPI full-stack template all 23 frontend requests match their backend routes exactly.
- **It shows your coding agent working on the map.** Connect Claude Code with one command and every edit shows up live: a ring on each file or function the agent added, changed or deleted, change counts on closed circles so you can see where it's working without opening anything, the agent's task and plan in a small window, and the diff in the panel when you click a ring. Hooks report what changed (checked against git, so shell commands and generated files are caught), and an MCP server lets the agent say what it's doing and why.

Any repository git can clone works, and so do private ones: upload the folder from the map and the browser sends only the source files, honouring `.gitignore` and leaving out `node_modules` and the git history, and the indexer maps it like a clone.

There are two views of the same code. **Code** is the structural truth: repository, folder, file, function. **By function** regroups the same functions by feature and then by layer, so one feature that spans a React page, a generated client, a FastAPI router and a SQLModel table reads as one circle.

## How we built it

- **Indexer** (Node, TypeScript, Fastify). Tree-sitter (WASM) parses TypeScript, TSX, JavaScript, Python and Go. A linker resolves imports across repositories, follows router mounts (`include_router`, `app.use`, gin groups, koa-mount) to give every route its full path, and matches client requests like ``fetch(`${API}/items/${id}`)`` or a generated SDK call to the route that serves them. Every edge records the code behind it and whether it was evidenced or inferred.
- **Classifier.** Layers are per project: each layer is a list of matchers on code facts, imports and paths, with presets you then own. Domains come from a seed-and-propagate pass over the graph, and a language model step names, merges and fills the gaps. Everything the model decides carries a reason and can be overridden by a pin.
- **Summaries.** A deterministic one-liner for every node from its facts and doc comments, then generated one-to-two-sentence summaries, eagerly for folders and files, lazily for functions, batched and cached.
- **Map** (React 19, Vite, canvas). d3-hierarchy circle packing, with our own canvas renderer for the camera, hit testing, edge bending around closed circles and label fitting. The first version was SVG and dropped to 15 to 20 fps on next.js (13k nodes, 10k edges); the canvas holds 60 fps. At rest the map draws only each open circle's strongest few links, so a first look isn't a hairball.
- **Agent overlay.** A Claude Code hook CLI and a stdio MCP server (`report_task`, `flag_changes`) post to the indexer, which re-parses just the changed files (about 10 ms on the FastAPI template), diffs each file's functions against HEAD, and streams the result to the map over server-sent events.
- **MongoDB Atlas** stores each project as one document: its repositories and its layer and domain grouping, with per-field revisions so two indexers can't silently undo each other. A fresh container re-clones the project's repos from what Atlas remembers.
- **Hosting.** The map is a static build on Vercel at https://fiada.tech. The indexer is long-running (git clones, an in-memory graph, SSE), so it runs from a Dockerfile on Railway.

## Challenges we ran into

- **Links that lie.** Early on, a request in one repo matched the wrong route in another because only the tail of the URL lined up. We made every edge carry its evidence and split evidenced from inferred, and taught the linker router mounts and API client base URLs. On outline, the map went from one HTTP link, a false one, to 84, and 77 of those are evidenced.
- **The hairball.** Drawing every link made the first screen useless. The map now ranks links per open circle, draws at most six at rest, and shows a circle's own links when you point at it.
- **Performance.** SVG couldn't keep up with a real monorepo. Moving to canvas meant writing our own hit testing and label fitting, but zoom and pan no longer re-render React at all.
- **Knowing what an agent actually changed.** Agents edit through shell commands, generators and reverts, not just edit tools. The hook trusts git instead of the tool call: it snapshots the working tree per session and diffs against it, so pre-existing changes aren't blamed on the agent and deleted files still show up.
- **Unsorted code.** Rules alone left about a fifth of the FastAPI template's functions unsorted. That's where the language model earns its place: it only handles what the rules couldn't, and says why.

## Accomplishments that we're proud of

- Opening an unfamiliar full-stack repo and following "how does creating an item work" from the React page, through the generated client and the HTTP contract, to the FastAPI route and the SQLModel table, without opening a file tree.
- Watching two Claude Code sessions work on the same checkout at once and seeing each one's changes ring in place.

## What we learned

Most of understanding a codebase is knowing what talks to what, and a parser can get that right if it's honest about what it guessed. Language models are most useful on the part the rules can't reach, and much more trustworthy when every answer comes with a reason you can check.

## What's next

- A step-by-step trace for a feature: one list from the button to the table, with file and line for each hop.
- Search and filtering links by kind.
- Reviewing an agent's pull request on the map instead of in the diff: which contracts it changed, and what else depends on them.
- More languages (Java, Rust) and more frameworks.

## Built with

TypeScript, Node.js, Fastify, tree-sitter, React, Vite, d3-hierarchy, Canvas, MongoDB Atlas, Claude Code hooks, Model Context Protocol, OpenAI API, Vercel, Railway, Docker.

## Try it

- Hosted map (read-only): https://fiada.tech
- Code: https://github.com/tobygodat/fiada
