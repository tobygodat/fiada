# 0001. Keep projects in the file store, with MongoDB as the option, not Supabase

Status: Accepted, 2026-10-27

## Context

The default stack for a web app is Supabase for data and auth. Fiada was built at HackGT 13 before that default existed. It keeps each project (repositories, grouping, summaries, fences) and each account behind one interface, `ProjectStore` in `indexer/src/store.ts`. There are two implementations: `FileProjectStore`, which writes JSON under `$FIADA_HOME`, and `MongoProjectStore`, picked when `MONGODB_URI` is set. MongoDB Atlas came from the hackathon's MLH Atlas add-on.

The data is small and per project: a list of repositories, a grouping file, cached summaries, fences and accounts. Nothing is queried across projects except the owner's usage counts. The graph is derived on every start and never stored. Clones have to live on the indexer's disk whichever store is used. Sign-in is GitHub OAuth with signed sessions, because the indexer needs each person's GitHub token to clone private repositories.

On 2026-10-25 the hosted indexer moved from Atlas to the file store on a Railway volume, after a malformed `MONGODB_URI` had broken hosted saves. Since then nothing in production uses MongoDB.

## Decision

Keep `ProjectStore` with the file store as the default and in production, and keep `MongoProjectStore` as an option for an indexer that runs without a volume. Don't move to Supabase, and keep GitHub OAuth for sign-in.

## Consequences

- Hosted data is files on one 500 MB volume. The volume is the backup story and the size limit (TOB-209).
- Anything new a project keeps gets a method on `ProjectStore`, implemented in both stores and deleted by `deleteProject` in both.
- The MongoDB store tests run only when `FIADA_TEST_MONGODB_URI` is set, so CI doesn't exercise that store.
- Supabase's migrations, generated types and auth don't apply here.
