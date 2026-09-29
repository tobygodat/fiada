# @fiadatech/agent

Shows what your coding agent is doing on [Fiada](https://fiada.tech), a live map of your codebase. As Claude Code works, its task and plan appear in the map's agent window, and every file and function it adds, changes or deletes gets a ring on the map.

## Connect Claude Code

Sign in at your Fiada map, open **agents** in the sidebar and choose **connect an agent**. It gives you one command with your indexer and token filled in. Run it in your project's folder:

```sh
npx -y --package=@fiadatech/agent fiada setup --write . --url=https://<indexer> --token=<token>
```

That does three things:

- saves where to report, and your token, in `~/.config/fiada/agent.json` (readable only by you), and checks that the indexer accepts the token;
- adds Fiada's hooks to `.claude/settings.local.json` in the project (your own git-ignored settings; other hooks are kept);
- registers the `fiada` MCP server for the project with `claude mcp add`.

Then start `claude` there. Nothing else to set.

The package has several commands, so npx is told which one to run (`--package=@fiadatech/agent fiada`). Hooks run after every edit, and through npx each call starts a little slower. To skip that, install it once and run setup from the installed copy:

```sh
npm install -g @fiadatech/agent
fiada setup --write . --url=https://<indexer> --token=<token>
```

## Commands

```
fiada setup [--write <dir>] [--url <indexer> --token <token>]   connect Claude Code (without --write, prints the configuration)
fiada hook                                                       the tool hook: reads Claude Code's or Cursor's payload on stdin
fiada hook changed <file>… [--kind added|modified|deleted]       report files from a script
fiada hook status "<what it's doing>"                            say what it's doing
fiada hook sweep | done | codex '<json>'                         working-tree sweep, turn finished, Codex's notify
fiada mcp                                                        the stdio MCP server (tools: status, flag_changes)
```

The hook never gets in the agent's way: it gives up on the indexer after 1.5 s and always exits 0.

## Settings

The environment wins over the saved config.

| Variable | |
| --- | --- |
| `FIADA_URL` | where to report; default: the saved config, else `http://127.0.0.1:4178` |
| `FIADA_TOKEN` | your agent token; the saved one is only ever sent to the saved URL |
| `FIADA_API_KEY` | the access key of a shared indexer without sign-in |
| `FIADA_CONFIG` | where setup saves the config; default `~/.config/fiada/agent.json` |
| `FIADA_HOOK_LOG` | append every payload the hook receives to this file |

## Cursor, Codex and other agents

Install it once and save where to report, with the URL and token from **connect an agent** on your map (without `--write`, setup touches no project):

```sh
npm install -g @fiadatech/agent
fiada setup --url=https://<indexer> --token=<token>
```

- **Cursor**: add the MCP server in `.cursor/mcp.json` (`{ "mcpServers": { "fiada": { "command": "fiada-mcp" } } }`) and the hook in `.cursor/hooks.json` under `afterFileEdit`, `beforeSubmitPrompt` and `stop` (`{ "version": 1, "hooks": { "afterFileEdit": [{ "command": "fiada-hook" }], … } }`).
- **Codex CLI**: add the MCP server under `[mcp_servers.fiada]` in `~/.codex/config.toml` (`command = "fiada-mcp"`), and set `notify = ["fiada-hook", "codex"]` so each finished turn sweeps the working tree for changes.
- **Anything else**, scripts included: `fiada-hook changed <file>…`, `fiada-hook status "<what it's doing>"`, `fiada-hook sweep` and `fiada-hook done`, with `--client <name>` to name the agent.

The Cursor and Codex payloads are handled as their docs describe them; only Claude Code has been run end to end.
