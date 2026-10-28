# Upstream

- Source: https://github.com/tobygodat/TGstack, `skills/install-anti-slop/assets/anti-slop/`, at commit `9050c5466961bfaba6831166f3cedafb13a5689f`. Copied unchanged by that skill's `scripts/install.mjs` on 2026-10-27.
- Installed paths: the generic plugin at `tools/oxlint/anti-slop/index.ts`, registered in `.oxlintrc.json`. The Effect plugin in `effect/` came with the copy and is not registered, since no package depends on `effect`.
- Dependencies: `oxlint` and `@oxlint/plugins`, both pinned at `1.90.0` in the root `package.json`.
- Deviations: none in these files. `.oxlintrc.json` turns off the rules that found code written before the linter, each with its reason (TOB-222).
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.
