# 0005. Each signed-in person brings their own model key, held in memory only

Status: Accepted, 2026-11-28.

## Context

On fiada.tech, the model sort and the generated summaries ran on one Anthropic key set on the Render indexer, in a workspace capped at $1 a month. Every signed-in person spent that one key, and the cap ran out. Raising it would make Toby pay for everyone's sorts. The alternative is for each person to bring their own Anthropic or OpenAI key.

The model work runs off the request path. A sort starts when a rebuild finds repositories it hasn't sorted, and summaries are written in batches for minutes after an import. So the indexer needs the key after the request that brought it has ended. There are two ways to give it the key:

1. **Store the key, sealed, per account.** Seal it with AES-GCM like the GitHub token, through `ProjectStore` in both stores, and delete it with the account and the project. This needs a new column and a new method in each store, and it puts every key in the database, where a leak of the store and the secret together would give them all away.
2. **Keep the key in the browser.** The browser sends the key with each request. The indexer holds it in memory for that person's open project only.

## Decision

Option 2. The map keeps the key in the browser's local storage, the same place as the session, and sends it in an `x-fiada-model-key` header on every signed-in request to the indexer, over HTTPS. The indexer never writes the key to disk, to the database or to a log.

- `PUT /api/model-key` checks a new key once with a request that costs nothing: it lists the provider's models. The indexer reports the provider's status as a sentence and never repeats the provider's answer. `DELETE /api/model-key` drops the key.
- On each signed-in request, the server sets the key on `req.tenant`, that person's own project (`Tenant.useModelKey`). The key is whatever the request carries, and a request without a key means no key. The map polls every few seconds, so after a restart or a wake the key is back within one poll. The sort that a new key unlocks starts at once.
- A key that is replaced or removed sends nothing more: each model that a key makes checks that its key is still the one in use before each request. A request already sent finishes. Closing the project, after 30 idle minutes or on account deletion, drops the key the same way.
- The models go through `indexer/src/llm.ts` (`personalLLM`) and pick a model the way the indexer's own key does. Each request still counts against `LLMBudget`, and saving a key counts against the change `RateLimit`. Errors tell the person to replace their key, and anything shaped like a key is taken out of them.
- With sign-in on, the indexer's `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are unused. Without a key of their own, a person's map is sorted by the rules. Without sign-in, the shared project uses the indexer's key as before, so `bun run dev` with a key in `.env` works as it did.

## Consequences

- Nothing in the store changes, and `deleteProject` has nothing new to delete.
- The key travels with every request, not only with the ones that start model work. It goes only to the indexer, over HTTPS, so the CSP needs no new origin.
- A script on fiada.tech could read the key from local storage, as it could the session. The CSP allows no inline script except the hashed theme script, and no other script origin except Cloudflare's analytics.
- Someone signed in from two browsers with a key in only one sees the key come and go as each browser polls. Adding the key in both browsers fixes it.
- Signing out drops the key in the browser and at the indexer. A new sign-in starts without a key.
- After a restart, model work waits until the person's map makes its next request. Work that was under way when the indexer stopped is lost, as before.
- Taking the host's key off Render after this ships changes nothing for anyone.
