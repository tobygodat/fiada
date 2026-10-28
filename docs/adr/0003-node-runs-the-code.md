# 0003. bun installs and runs scripts; Node runs the indexer, agent and tests

Status: Accepted, 2026-10-27

## Context

The default stack uses bun as the runtime and `bun test` for unit tests. Fiada moved from npm to bun as its package manager in PR #46, after the code was written. The indexer runs through `tsx`, the agent through Node's type stripping, and every test uses `node:test` and `node:assert/strict`. The published `@fiadatech/agent` must run under the Node that a user's coding agent starts, from Node 20.19 up. The indexer's container runs Node 22.

## Decision

bun installs dependencies (`bun.lock`, hoisted linker in `bunfig.toml`) and runs the root scripts. Node runs the indexer, the agent and the tests. `bun run test` runs `node --import tsx --test` in each workspace. Don't use `bun test`.

## Consequences

- Contributors need both Node 20.19 or later and bun 1.4 or later. CI installs both.
- `bun test` finds no tests, because bun's runner doesn't run `node:test`.
- `agent/` keeps `erasableSyntaxOnly`, because Node strips its types: no enums, namespaces or constructor parameter properties there.
- Node 20.19 lacks iterator helpers, so lint fixes that need them wait for the engines floor to rise.
