# Fiada

A map of your codebase that sorts itself, explains itself, and lights up where your coding agent is working; for developers reviewing agent work across real repositories.

- Linear: https://linear.app/tobygodat/project/fiada-a497b12d159c. Every change starts from an issue there.
- Notion: https://www.notion.so/406935c51fac8188a386e2e4de2bd44d

## Read first

1. The Linear issue you're working on.
2. `docs/ARCHITECTURE.md` for where things live.
3. `docs/CONVENTIONS.md` before you add a file, a test or a variable.
4. `PRODUCT.md` and `DESIGN.md` before you change anything a user sees.
5. `docs/adr/` before you change the stack, hosting or storage.

## Before asking to merge

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run lint`
- `bun run test` (never `bun test`)
- `bun run build`
- Run `bun run dev`, then drive these flows at http://localhost:5178 with `agent-browser` and attach screenshots:
  - Import `fastapi/full-stack-fastapi-template`: its row under **repositories** gives files and symbols, and its circle fills the map.
  - Click a circle: the detail panel names it and says what it does. Click it again: it opens in place with its children.
  - Switch **view** to **by function**, open **Items**, and click the link from Client to API: the contract panel lists 5 HTTP requests, and **why** shows the request, route and mounts behind one.
  - For a visible change, repeat it under both **theme** words, **dark** and **light**.

## Rules

- **Real repositories only.** Never add a synthetic or hand-built dataset to the product; fixtures belong in tests.
- **The map is a canvas.** Map features go in the renderer and its scene, not DOM or SVG overlays. Zooming and panning never re-render React.
- **Links stay quiet.** The rules are one `EdgePolicy` in `web/src/render/edges.ts`. Circles have no hover text; only links get the one-line tip.
- **Agent overlay drawing stays in `web/src/render/activity.ts`**, roll-ups in `web/src/graph/activity.ts`. Change colours mean added, modified or deleted and nothing else.
- **Edges carry evidence** (`evidenced` or `inferred`, `confidence`, `reason`, `evidence`). New detectors add edges through `ev()` and `addEdge` in `indexer/src/link.ts`. The web app never re-derives these fields.
- **Layers are per project.** Never hard-code a layer name. Classification reads only facts, paths and edges.
- **Persistence goes through `ProjectStore`.** Anything new a project keeps gets a method in both stores and is deleted by `deleteProject` in both. The graph is never stored.
- **Models go through `indexer/src/llm.ts`.** Don't call a provider directly or add a feature that needs another key. Everything must work without a key.
- **Each signed-in person's project is theirs alone.** With sign-in on, handlers work only through `req.tenant`. Never use a module-level workspace, a shared clone folder or `FIADA_GITHUB_TOKEN` in that mode. Agent tokens reach only what `whoMayCall` in `indexer/src/access.ts` allows.
- **Imported code is untrusted.** Read a clone or upload only through `fileWithin` (`indexer/src/sources.ts`). A hosted indexer clones over https from `FIADA_GIT_HOSTS` only.
- **People can leave.** `web/src/components/Privacy.tsx` must stay true about what is kept and who handles it.
- **Nobody can use it up for everyone else.** A new route that does real work goes through `RateLimit` (`access.ts`), the repository and clone limits, and `LLMBudget` (`llm.ts`).
- **Writes use a method other than GET.** Without sign-in, `FIADA_API_KEY` guards everything but GET, HEAD and OPTIONS.
- **New origins go in the CSP.** A new script, font, image or API origin goes in `web/public/_headers`, and a change to `index.html`'s inline script needs its new hash.
- **The web app can't import indexer packages**, and a new workspace goes in the `Dockerfile`.
- **Don't rename the names that keep "strata"** (listed in `docs/CONVENTIONS.md`).
- **Colours come only from `web/src/theme/tokens.css`**; follow `DESIGN.md`.
- **Never commit `.env`**, and never print or copy a key or connection string.
- **Remaining work and known bugs are Linear issues**, not repo files.
