# 0002. Run the indexer in a container on Railway, outside Cloudflare

Status: Accepted, 2026-10-27

## Context

The default stack hosts everything on Cloudflare Workers. Fiada has two halves. The map is a static React build. The indexer runs `git clone` and `git pull`, keeps clones and uploads on disk, parses them with tree-sitter (WASM), holds each open project's graph in memory, and streams agent activity to the map over SSE. Workers are short-lived and stateless, with no git and nowhere to keep clones, so the indexer can't run there.

The map moved from Vercel to Cloudflare Workers static assets on 2026-10-26 (PR #61). The indexer was rebuilt on Railway on 2026-10-25 as one service in project `aware-ambition`.

## Decision

Serve the map from Cloudflare Workers as static assets (`wrangler.jsonc`, Worker `fiada-web`). Run the indexer from the root `Dockerfile` in a container on Railway, with a volume on `/data`. The map reaches it through `VITE_API_URL`, set in `web/.env.production`.

## Consequences

- Hosting spans two providers, and a merge to `main` deploys both.
- If the indexer moves, `web/.env.production` and the CSP's `connect-src` in `web/public/_headers` must change with it.
- The Workers build installs only `@fiada/web`, so the web app can't depend on indexer packages.
- The `Dockerfile` copies every workspace's `package.json`, so a new workspace must be added there.
- The Dockerfile also runs on Fly.io or Render.
