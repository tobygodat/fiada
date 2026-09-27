# Strata

A codebase map for working at the middle altitude: above file-by-file reading, below a one-paragraph architecture summary. One graph spans several repositories; zooming changes the level of abstraction, from systems to modules to files to symbols.

This is the first scaffold of the prototype. It covers the graph view, the floating sidebar with the **Code · read-only** / **By function** toggle, importing real repositories, and per-project layers. The agent overlay, search, edge filtering and domain editing come later.

## Run it

```sh
npm install
npm run dev          # indexer on :4178, web on http://localhost:5178
```

Open http://localhost:5178 and add a repository in the sidebar. Anything git can clone works (`org/repo`, `github.com/org/repo`, an https or ssh URL), and so does an absolute path to a local checkout, which is read in place. Add several and they share one map; imports, calls and HTTP requests that cross repositories become dashed edges.

Scroll to zoom, drag to pan, click a circle to select and focus it, click an edge or its letter tag to read the contract between two parts, Esc to clear.

## How it's put together

```
shared/    the graph contract (nodes, edges, layers) both sides import
indexer/   clone → parse → link → classify → graph, behind a small HTTP API
web/       React + SVG map, floating sidebar, detail panel
```

The indexer pipeline:

1. **Sources** (`indexer/src/sources.ts`): lists files with `git ls-files`, skips vendored and generated directories and (by default) tests, and reads `package.json`, `tsconfig*.json`, `pyproject.toml` and `requirements*.txt`.
2. **Parse** (`indexer/src/parse/`): tree-sitter (WASM, no native build) extracts imports, top-level symbols, the identifiers each symbol uses, server routes and client HTTP requests. TypeScript, TSX, JavaScript and Python today; a language is a grammar plus one extractor.
3. **Link** (`indexer/src/link.ts`): resolves imports (relative paths, tsconfig `paths`, workspace packages, Python packages, across every imported repo), binds identifiers to the symbols they name through re-exports and barrels, and matches requests like `fetch(\`${API}/items/${id}\`)` to routes like FastAPI's `@router.get("/{id}")` under `APIRouter(prefix="/items")`.
4. **Facts** (`indexer/src/facts.ts`): detectors turn what the parser saw into language-neutral facts on every file and symbol: the routes it serves, the requests it makes, JSX, ORM tables, base classes, decorators, imports, and whether it's type-only.
5. **Build** (`indexer/src/build.ts`): emits the node tree (single-child folder chains collapsed) and edges.
6. **Classify** (`indexer/src/classify/`): places every file and symbol in one of the project's layers and a domain, each with evidence. This step only reads facts, paths and edges, so a grouping change reclassifies in milliseconds without re-parsing.

The web app rebuilds the tree for the chosen view, lays it out with circle packing, opens circles once they're big enough on screen, and lifts every edge to the nearest visible ancestor of each end, so edge thickness is the number of underlying interactions.

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

Everything a project keeps (its repositories and its grouping) goes through the `ProjectStore` interface in `indexer/src/store.ts`. The default `FileProjectStore` writes under `.strata/projects/<id>/`; a database-backed store implements the same five methods and is selected in `createStore()`. The graph itself is always derived, never stored.

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
| `STRATA_INCLUDE_TESTS` | off | set to `1` to index test files |
| `STRATA_MAX_FILES` | `4000` | per-repo file budget; the shallowest files are kept |
| `STRATA_GITHUB_TOKEN` | unset | token for private GitHub repos, passed per git command and never written to disk |

The indexer binds to 127.0.0.1: importing a local path reads that directory, so it's a single-user development tool.

## Tests

```sh
npm test             # indexer: route matching, layer matchers, rules and pins, the file store, and a two-repo fixture end to end
npm run typecheck
```
