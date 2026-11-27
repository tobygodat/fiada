# 0004. Run the indexer on Render's free plan, with projects in Supabase

Status: Accepted, 2026-11-27. Supersedes [0001](0001-file-store-not-supabase.md) and [0002](0002-indexer-in-a-container.md).

## Context

The hosted indexer ran on Railway with its data as files on a 500 MB volume (ADR 0001 and 0002). Railway's 30-day trial ended on 2026-10-27, and on 2026-10-28 Railway removed the indexer's deployment, so fiada.tech could draw nothing and import nothing. The volume held 37 MB and wasn't close to full. Keeping it would mean a paid plan, and Fiada has to run for free.

The indexer runs `git`, keeps clones on disk, parses with tree-sitter (WASM), holds each open project's graph in memory and streams agent activity over SSE. Workers can't run git or keep clones, and Cloudflare's containers need the paid Workers plan. Hugging Face's free Docker Spaces allow outbound connections only on ports 80, 443 and 8080, so they can't reach a hosted database. Render's free web service runs the root `Dockerfile` as it is, from a GitHub branch.

A free host has an ephemeral disk, so what a project keeps has to live elsewhere. `MongoProjectStore` was unused in production after 2026-10-25. Supabase is the default data stack, and its free Postgres is reachable from Render.

## Decision

- The map stays a static build on Cloudflare Workers (`wrangler.jsonc`, Worker `fiada-web`).
- The indexer runs from the root `Dockerfile` as the free Render web service `fiada-indexer`, at https://fiada-indexer.onrender.com. The map reaches it through `VITE_API_URL` in `web/.env.production`.
- Projects and accounts live in Postgres on the free Supabase project `fiada` (us-west-1), through `PostgresProjectStore` (`indexer/src/postgres-store.ts`), which `createStore()` picks when `DATABASE_URL` is set. It keeps its tables in the schema `fiada`, which Supabase's REST API doesn't serve. `FileProjectStore` stays the default for an indexer on your own machine. `MongoProjectStore` is gone.
- Sign-in stays GitHub OAuth with signed sessions, since the indexer needs each person's GitHub token to clone their private repositories. Supabase Auth isn't used.
- Clones stay on the indexer's disk and are cloned again when a project opens after a restart. The graph is derived and never stored.

## Consequences

- Render's free service sleeps after 15 minutes without a request and takes about a minute to wake, so the first visit after a quiet spell waits for it. Nothing keeps it awake on purpose.
- Render's disk is ephemeral: every wake, restart and deploy starts with no clones, so the first open of a project re-clones its repositories. Uploaded folders live only on that disk, so after a restart their rows say to upload the folder again.
- Supabase pauses a free project with too little database activity over a week. `.github/workflows/keepalive.yml` calls the indexer's `/api/health` three times a day, which wakes it and makes one real query each time. Supabase says a few queries a day is typically enough, so this lowers the risk of a pause rather than ruling it out.
- Free Supabase gives 500 MB of database, far more than accounts, repository lists, groupings, fences and summaries take.
- Anything new a project keeps gets a method on `ProjectStore`, implemented in both stores and deleted by `deleteProject` in both.
- The Postgres store tests run when `FIADA_TEST_DATABASE_URL` is set. CI sets it with a Postgres service, so CI exercises both stores.
- If the indexer moves again, `web/.env.production` and the CSP's `connect-src` in `web/public/_headers` change with it, and so does the GitHub OAuth app's callback URL.
- Hosting spans three providers, and a merge to `main` deploys the map and the indexer.
