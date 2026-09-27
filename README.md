# Strata

A codebase map for working at the middle altitude: above file-by-file reading, below a one-paragraph architecture summary. One graph spans several repositories; zooming changes the level of abstraction, from systems to modules to files to symbols.

This is the first scaffold of the prototype. It covers the graph view, the floating sidebar with the **Code · read-only** / **By function** toggle, and importing real repositories. The agent overlay, search, edge filtering and domain editing come later.

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
4. **Classify** (`indexer/src/classify/`): assigns every file and symbol a layer and a domain, each with a confidence and a reason.
5. **Build** (`indexer/src/build.ts`): emits the node tree (single-child folder chains collapsed) and edges.

The web app rebuilds the tree for the chosen view, lays it out with circle packing, opens circles once they're big enough on screen, and lifts every edge to the nearest visible ancestor of each end, so edge thickness is the number of underlying interactions.

## Classification is pluggable

Layers (UI, Client, API, Services, Storage, Pipeline, Contracts) and domains are decided by chains of small classifiers. Each one abstains or votes with a confidence and a reason; the highest confidence wins. The default layer chain is:

| Classifier | Evidence |
| --- | --- |
| `repo-config` | globs in a checked-in `strata.config.json` (always wins) |
| `code-signals` | what the code does: declares routes, renders JSX, defines ORM models, makes HTTP requests, only declares types |
| `path-conventions` | where it lives: `routes/`, `components/`, `models.py`, `*.service.ts`, read differently in frontend and backend packages |
| `graph-position` | second pass for leftovers: a file whose callers are mostly API handlers is a service |

Symbols inherit their file's layer unless a classifier has symbol-level evidence (a `models.py` that mixes ORM tables with request schemas splits into Storage and Contracts). The default domain classifier, `feature-tokens`, looks for words that recur across paths in several files, such as `items` in `components/Items/`, `routes/items.py` and `crud.py#create_item`.

To try another strategy, write a `Classifier` (see `indexer/src/classify/types.ts`) and put it in the chain in `indexer/src/classify/index.ts`. The detail panel shows the winning classifier and its reason for every file and symbol, and "color by layer" in the sidebar paints the whole map.

To pin things down in a repo, add `strata.config.json` at its root:

```json
{
  "layers": { "src/server/**": "API", "src/db/**": "Storage" },
  "domains": { "src/billing/**": "Billing" }
}
```

To see classification results without the UI:

```sh
npm run index -- ../some-repo org/other-repo --layers --domains
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4178` | indexer port (the web dev server proxies `/api` to it; set `STRATA_INDEXER_PORT` for the proxy if you change it) |
| `STRATA_HOME` | `.strata/` | where clones and the workspace file live |
| `STRATA_INCLUDE_TESTS` | off | set to `1` to index test files |
| `STRATA_MAX_FILES` | `4000` | per-repo file budget; the shallowest files are kept |
| `STRATA_GITHUB_TOKEN` | unset | token for private GitHub repos, passed per git command and never written to disk |

The indexer binds to 127.0.0.1: importing a local path reads that directory, so it's a single-user development tool.

## Tests

```sh
npm test             # indexer: route matching, source parsing, and a two-repo fixture end to end
npm run typecheck
```
