# Strata

A codebase map for working at the middle altitude: above file-by-file reading, below a one-paragraph architecture summary. One graph spans several repositories; opening a circle takes you down a level of abstraction, from systems to modules to files to symbols.

This is the first scaffold of the prototype. It covers the graph view, the floating sidebar with the **Code · read-only** / **By function** toggle, importing real repositories, and per-project layers. The agent overlay, search, edge filtering and domain editing come later.

## Run it

```sh
npm install
npm run dev          # indexer on :4178, web on http://localhost:5178
```

Open http://localhost:5178 and add a repository in the sidebar. Anything git can clone works (`org/repo`, `github.com/org/repo`, an https or ssh URL), and so does an absolute path to a local checkout, which is read in place. Add several and they share one map; imports, calls and HTTP requests that cross repositories become dashed edges.

Until you point at something the map draws only the few strongest links between what's on screen (HTTP requests and cross-repository links count for more), with no letter tags. Point at a circle to see all of its links, tagged; they stay while it is selected. Click a circle to select it: the detail panel says what it is, what it depends on and what depends on it. Click it again (or press Enter) to open it in place: its neighbours stay on screen as small closed circles, and edges reattach to the specific file or symbol inside that each one comes from. Click an open circle's name tab (or a breadcrumb) to close it again. Scroll only zooms and drag pans; neither opens or closes anything. Click an edge or its letter tag to read the contract between two parts, and click either end of any interaction listed there to go straight to the code responsible. Each interaction's **why** lists the code behind it (the request, the route and router mounts it matched, the import or call) and clicking a line shows that code in place. Contracts the indexer only guessed are dotted, with a `?` on their tag. The detail panel shows the selected file's or symbol's code. Back (the ← button, or Backspace) returns to where you were; Esc clears the selection.

The sidebar's **open** setting switches to the prototype's semantic zoom, where circles open by themselves as you zoom into them.

## How it's put together

```
shared/    the graph contract (nodes, edges, layers) both sides import
indexer/   clone → parse → link → classify → graph, behind a small HTTP API
web/       React app: canvas map, floating sidebar, detail panel
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

The indexer also reads a `.env` file at the repo root; variables already set in your shell win.

The indexer binds to 127.0.0.1: importing a local path reads that directory, so it's a single-user development tool.

`vercel.json` builds only the web app (`web/dist`) for preview deployments. The indexer clones repositories and runs a long-lived server, so a Vercel preview shows the UI without an indexer behind it.

## Tests

```sh
npm test             # indexer: route matching, layer matchers, rules and pins, the file store, a two-repo fixture end to end
                     # web: edge lifting, click-mode layout, camera framing
STRATA_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test   # also runs the MongoDB store tests
npm run typecheck
```

To measure how smoothly the map zooms and pans on a real graph (headless Chromium, both modes):

```sh
npm run build
npm run index -- vercel/next.js --out "$PWD/next.graph.json"
npm run bench -w @strata/web -- "$PWD/next.graph.json"   # needs npx playwright install chromium, or CHROMIUM_PATH
```
