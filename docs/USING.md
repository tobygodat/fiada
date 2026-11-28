# Using the map

How to import code, read the map, and change how Fiada sorts it. The [README](../README.md) has the short version.

## A first tour

Import `fastapi/full-stack-fastapi-template`, then:

1. Click a circle to see what it is. Click it again to open it.
2. Under **view**, switch to **by function** and open the **Items** domain.
3. Click the **HTTP** tag between Client and API to read the contract, and click either end of an interaction to jump to its code.

## Using the map

Open http://localhost:5178 and add a repository in the sidebar. Anything git can clone works (`org/repo`, `github.com/org/repo`, an https or ssh URL), and so does an absolute path to a local checkout, which is read in place. For a private repository, or any folder the indexer can't reach, **upload a folder** under the import box: the browser walks it and sends only the source the indexer reads (up to 50 MB), leaving behind whatever its `.gitignore` files ignore, `node_modules` and the other dependency and build folders, and the git history. The indexer unpacks that into its own storage and indexes it like a clone, keeping the folder's `origin` remote, branch and HEAD from its `.git` so agents working in the real checkout still find it. Uploading the same folder again (same remote, else same name, or **upload again** on its row) replaces it. Add several and they share one map; imports, calls and HTTP requests that cross repositories become dashed edges.

Until you point at something the map draws only a few links: each open circle's strongest two or three, at most six in all (HTTP requests and cross-repository links count for more), untagged. That holds at every depth, so opening a big circle shows its own few key links rather than everything crossing its rim. Point at a circle, or select it, to see its strongest eight links, tagged with what they are ("HTTP · 23", "552 calls +40"); its panel lists them, the first 40 each way with a count of the rest. (`?links=all` in the URL draws every link and tag, `?links=none` none until you point; the rules live in `web/src/render/edges.ts`.) Click a circle to select it: the detail panel says what it is, what it depends on and what depends on it. Click it again (or press Enter) to open it in place: its neighbours stay on screen as small closed circles, and edges reattach to the specific file or symbol inside that each one comes from. Click an open circle's name tab (or a breadcrumb) to close it again. Scroll only zooms and drag pans; neither opens or closes anything. Click an edge or its tag to read the contract between two parts, and click either end of any interaction listed there to go straight to the code responsible. Each interaction's **why** lists the code behind it (the request, the route and router mounts it matched, the import or call) and clicking a line shows that code in place. Contracts the indexer only guessed are dotted, with a `?` on their tag, and interactions it recorded without the code behind them say "no evidence found". The detail panel shows the selected file's or symbol's code. Back (the ← button, or Backspace) returns to where you were; Esc clears the selection.

The sidebar's **open** setting switches to the prototype's semantic zoom, where circles open by themselves as you zoom into them.

The search box in the top bar (`/` or Ctrl-K focuses it) finds repositories, folders, files and symbols by name among what the current view draws, and opens the map to the one you pick. Resting links carry a quiet count and verb where there's room ("23 requests"), so the map says what links are without pointing at them.

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

With the file store, the grouping lives in `$FIADA_HOME/projects/<project>/fiada.grouping.json`, which on a fresh checkout without sign-in is `.fiada/projects/default/fiada.grouping.json` (a project saved before the rename keeps `strata.grouping.json`). Edit it to rename layers, add matchers, or add `rules` (bulk moves by path, symbol name or current layer) and `pins` (single files or symbols); edits apply live, and the sidebar shows an error if the file doesn't validate. With the Postgres store, the grouping is in the project's row instead, and an edit made there applies after a restart. The sidebar also switches presets, and the detail panel shows why each file and symbol landed where it did.

Domains (the features that cut across layers and repos) come from the classification design's seed-and-propagate strategy (`indexer/src/classify/propagate.ts`). Routes (`GET /items/{id}`), ORM entities (`class Item`), page routes, and files in structural folders (`routes/items.py`, `components/Items/`) seed a domain when two or more files agree on it. Everything else takes the domain of the code it's connected to through calls, HTTP requests, renders and imports. A close split goes to **Shared**, and so does code that three or more features use directly. Code with no path to any seed joins the majority of its file, and anything left over is **Unsorted**. Domain pins in the grouping file act as seeds too, so they pull their unclaimed neighbours along. The older `feature-tokens` strategy is still available; strategies are swappable in `indexer/src/classify/index.ts`.

To see classification results without the UI (the script runs from `indexer/`, so give absolute paths):

```sh
bun run index /path/to/some-repo org/other-repo --layers --domains
bun run index /path/to/some-repo --preset by-repo
bun run index /path/to/some-repo --grouping /path/to/my.grouping.json --layers
```

### Sorted on import

With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, a fresh import doesn't stop at the classifier. Once every repository is indexed, the indexer asks the model (Claude or OpenAI, through `indexer/src/llm.ts`; the steps are in `indexer/src/classify/model-sort.ts`, off the request path) to finish the job in two steps:

1. **Domains.** The model sees each domain the classifier found (its files, what seeded it, its biggest symbols) and an outline of what's left over. It gives each a plain product name, merges domains that are one feature ("Shares" and "Sharing"), and adds the few domains the leftovers need ("Platform").
2. **Leftovers.** Every file with code in Unlayered or Unsorted goes to the model in batches, with its imports, detected facts, symbols, and the domains and layers of the code around it. It picks one of the project's layers and a domain, with a one-line reason.

The result is saved in the grouping as `sorted`, through the same `ProjectStore`, and the map redraws when it lands. It only fills gaps: code the classifier placed keeps its place, and your renames, rules and pins win over it, so you adjust from a sorted map exactly as before. Each placement the model made shows its reason in the detail panel, marked as inferred by Claude or OpenAI. A new repository or commit sorts again; the sidebar's **sort again** does it on demand (`POST /api/grouping/sort`). Delete `sorted` from the grouping to drop it. Without a key, imports keep the classifier's result and the sidebar says sorting is unavailable.

On fiada.tech, and on any indexer with [GitHub sign-in](HOSTING.md#signing-in-with-github), the indexer's own key is unused: each person brings theirs. Paste an Anthropic (`sk-ant-…`) or OpenAI (`sk-…`) API key under **model key** in the sidebar and press **save**. The indexer checks it once by listing the provider's models, which costs nothing, and says what's wrong if the provider refuses it. Then your sorts and summaries run on that key, on your account with that provider, and the rest of what's left unsorted sorts at once. **replace** swaps it and **remove** stops its use. The key stays in your browser's local storage and goes with each request to the indexer, which holds it in memory for your own map and nobody else's, never on disk or in the database ([ADR 0005](adr/0005-bring-your-own-model-key.md)). Without one, the rules sort your map and the sidebar says where to add a key. The daily limit of model requests still applies.

`bun run index <repos> --sort` runs the same sort from the command line and prints how much was left unsorted before and after.

## Node summaries

The first thing under a selected node's name in the detail panel is what it does. Every node gets a line straight away, built from what the indexer knows ("Handles POST /api/v1/items/. Called over HTTP by ItemsService.", "Defines list_items, create_item and unused. Used by items.py.") and led by the first sentence of the code's own docstring or doc comment when it has one. A first sentence of 90 characters or more replaces the line instead. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set on the indexer (or, with sign-in, your own key under **model key**), and summaries not turned off with `FIADA_SUMMARIES`, the model writes one or two sentences per node from its code and neighbours, through the same client the sort uses (`indexer/src/llm.ts`), with `FIADA_SUMMARY_MODEL` when it is set. Otherwise Claude uses the sort's model (`FIADA_LLM_MODEL`, else `claude-haiku-5-5`), and OpenAI uses `gpt-5-mini`, falling back to the sort's models when the key can't use it. [Configuration](HOSTING.md#configuration) says which provider answers. Generated summaries are marked "generated" with the model's name. A node's uses and used-by lists sit folded under the summary with their counts.

Generated summaries are written in batches, off the request path: after each import or re-index, files first, then domains and their layers, then folders (deepest first, each reading its children's summaries), then repositories; a file's symbols are written together when one of them is first selected, in one request unless the file is large. Each summary is cached under a hash of what the model read and saved through the `ProjectStore`, so a restart costs nothing and a re-index rewrites only what changed and what contains it. `bun run index <repo> --summaries` prints sample lines and how many requests a fresh import would make, without calling a model: the FastAPI template takes 11 requests for 197 summaries of files, folders, groups and the repository (about 29,000 input tokens), and outline 70 requests for 2,566 (about 430,000); symbols cost about one request per file, only as their symbols are selected. The code lives in `indexer/src/summaries/`.
