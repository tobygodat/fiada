# Conventions

## Run, test, deploy

Needs Node 20.19 or later, bun 1.4 or later (CI uses 1.4.2) and git. bun installs and runs the scripts; Node runs the indexer, the agent and the tests ([ADR 0003](adr/0003-node-runs-the-code.md)).

```sh
bun install
bun run dev          # indexer on :4178 and the map on http://localhost:5178
bun run typecheck    # tsc over shared, indexer, web and agent
bun run lint         # oxlint with the anti-slop plugin (.oxlintrc.json)
bun run test         # node:test in indexer, web and agent
bun run build        # the web app, into web/dist
bun run index <repo-or-path> [more…] --layers --domains   # print classification without the UI
bun run agent:setup --write /path/to/repo                 # hook a repo's Claude Code sessions up to Fiada
bun run agent:build  # bundle the agent for npm
```

- `bun run test`, not `bun test`: bun's own runner doesn't run `node:test`.
- The MongoDB store tests run only when `FIADA_TEST_MONGODB_URI` is set.
- `node web/e2e/fences.e2e.mjs <scratch clone> --scratch` drives fences and collisions end to end in Chromium against `bun run dev`, with the real agent hook. It edits the clone and puts it back. The other scripts in `web/e2e/` drive one feature each (the review tour, ripples, the sort, an agent session); read each one's header before running it.
- `bun run --cwd web bench <graph.json>` measures zoom and pan in headless Chromium. Set `CHROMIUM_PATH` if Playwright's browser isn't installed.
- In cloud containers, Playwright's bundled ffmpeg is missing, so the e2e scripts record with a CDP screencast and system ffmpeg, and launch Chromium from `/opt/pw-browsers/chromium`.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build as parallel jobs on every pull request and every push to `main`.
- Configuration lives in a gitignored `.env` at the repo root, from `.env.example`. The README's Configuration section is the full table. Every `FIADA_*` variable is also read as `STRATA_*`, and the old name wins when both are set. Never commit `.env`, and never print or copy a key or connection string into code, logs or docs.
- Deploys: a merge to `main` deploys the map to Cloudflare Workers and the indexer to Railway ([ADR 0002](adr/0002-indexer-in-a-container.md)). The README's Deploy section has the setup.
- Publishing the agent: bump `version` in `agent/package.json`, then `npm publish -w @fiadatech/agent`, which bundles it with esbuild first.

## Layout and naming

- Strict TypeScript with `verbatimModuleSyntax` and `allowImportingTsExtensions`: relative imports end in `.ts` or `.tsx`, and type-only imports use `import type`.
- `agent/` sets `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties there. It is published, so it may import only Node's built-ins and `import type` from `@fiada/shared`.
- Two-space indent, single quotes, semicolons. There is no formatter, so match the surrounding code.
- Each module opens with a short comment saying what it is and why. Keep that up when you add one.
- New code, copy and variables say **Fiada**: `@fiada/*`, `FIADA_*`, `.fiada/`, `fiada.grouping.json`, MCP server id `fiada`. On npm the agent is `@fiadatech/agent`, since the `fiada` scope isn't ours.
- These keep "strata" on purpose so existing hosts and checkouts keep working. Don't rename them:
  - the indexer package `@strata/indexer` (the Dockerfile, root scripts and the Railway service name it);
  - the `STRATA_*` aliases, an existing `.strata/` folder and `strata.grouping.json`;
  - the MongoDB database `strata`;
  - browser `localStorage` keys `strata.*` and `strata-theme`;
  - the `agent/bin/strata-*.mjs` shims and the Railway domain `strataindexer-production.up.railway.app`.

## Errors

- Missing keys degrade, they don't fail. Without a model key, sorting falls back to the rules and summaries to lines built from the graph. Over the daily model budget, the same.
- The agent hook never fails the agent: it always exits 0 and gives up on the indexer after 1.5 s.
- If MongoDB can't be reached at startup, the indexer says why and saves under `.fiada/` for that run.
- Errors a person sees are a sentence, in words as well as colour (see `DESIGN.md`).

## Tests

- Tests are `*.test.ts` beside the code they test, using `node:test` and `node:assert/strict`. Add or update one with any behaviour change.
- Fixtures belong in tests only, never in the product.
- `web/src/theme/tokens.test.ts` fails on colliding hues or low contrast. `web/src/csp.test.ts` fails when `index.html`'s inline script changes without a new hash in `web/public/_headers`.

## Commits and pull requests

- Commit subjects say what changed in plain words ("Map: no hover text over circles").
- PRs target `main` and merge with a merge commit. Never rewrite `main`.
- Codex (`chatgpt-codex-connector`) reviews every PR when it opens and after each push, and has found real bugs. Read its comments before merging.
