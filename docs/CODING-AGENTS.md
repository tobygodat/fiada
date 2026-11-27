# Coding agents

How Fiada follows a coding agent, what the agent can ask the map, and how to connect Claude Code, Cursor, Codex or a script. The [README](../README.md) has the short version.

## Connect Claude Code

Import the repository you'll work in by its local path (so edits re-index in place), then:

```sh
bun run agent:setup --write /path/to/your/repo
cd /path/to/your/repo && claude
```

A relative path after `--write` counts from the folder you run the command in.

`--write` adds Fiada's hooks, and a rule allowing the Fiada MCP server's tools (`mcp__fiada`), to that repo's `.claude/settings.local.json` and registers the Fiada MCP server with `claude mcp add`. For a map you signed in to, open **agents** in the sidebar and choose **connect an agent**: it gives one command to run in your project, no checkout of Fiada needed, which runs the published [`@fiadatech/agent`](../agent/README.md) package:

```sh
npx -y --package=@fiadatech/agent fiada setup --write . --url=https://<indexer> --token=<token>
```

It saves where to report, and your token, in `~/.config/fiada/agent.json`, so no variables need setting. `npm install -g @fiadatech/agent`, then `fiada setup …`, does the same with a faster hook. Give Claude a task and watch the map: its task and plan appear in the agents window, each file or function it touches gets a ring, and what it reads or [asks the map about](#asking-the-map) gets a faint dotted one. If you start `claude` from inside another Claude Code session, `unset CLAUDE_CODE_SESSION_ID` first. Cursor, Codex and scripts are covered in [Watching a coding agent](#watching-a-coding-agent).

## Watching a coding agent

Fiada can follow a coding agent (Claude Code, Cursor, Codex, or anything that speaks MCP) while it works on a repository you've imported. A small window at the top right lists each agent's task and plan, with the step it's on, and the map marks what it touches: a ring just outside anything it added (ink), changed (ochre) or deleted (dashed brick), and a short pulse as each change lands. Those colours only ever mean a change on the map; in the window, a green dot means the agent is working and an ochre one means it's waiting for you. A closed circle shows a count of the changes inside it (`+2 ~3 −1`: files in the Code view, symbols By function) on whichever side of it is clear of links and tags, so you can see where an agent is working without opening anything. Click a changed file in the window, or any ringed circle, and the detail panel shows the diff (for a symbol, just the hunks that touch it).

There are two ways in, and they work best together:

- **Hooks** (deterministic). The agent's own tool hooks run `agent/bin/fiada-hook.mjs` after every edit, so changes show up even when the agent never mentions them. The hook asks git about the agent's working tree: edited files come with their changed lines and a diff against HEAD, and after a shell command it compares the tree with the last call, so files removed with `rm` or `git mv`, generated files and reverts are caught too. Changes already in the tree when the agent started, or made by you between prompts, aren't put on the agent. Claude Code's plan (`TodoWrite`, or `TaskCreate`/`TaskUpdate`) becomes the step list, and your prompt is the task until the agent names its own.
- **MCP** (the agent's own words). `agent/bin/fiada-mcp.mjs` is a stdio MCP server. Two tools report: `status` (one or two lines on what it's doing now, with the task and the plan as steps marked `pending`, `active` or `done`; `report_task` is its older name) and `flag_changes` (files or folders `added`, `modified` or `deleted`, optionally with the functions or classes it touched). Three more [ask the map](#asking-the-map). Its instructions ask the agent to call them as it goes; the hook covers whatever it forgets.

Both post to the indexer's `/api/agent/events`. A file maps to the graph by path when its repository was imported from a local directory, or by `origin` remote (then folder name) when the agent works in another checkout of an imported repository. When the agent edits a repository Fiada reads in place, the indexer re-parses just the changed files and relinks (about 10 ms on the FastAPI template), so new files and symbols appear on the map, and comparing each file's symbols with HEAD says which functions were added, changed or deleted. The map fetches the new graph without moving the camera. Agent activity isn't stored anywhere; dismissing an agent in the window clears its marks.

Everything that depends on an agent's change gets a quiet ring of paired dots, across repositories, rolled up onto closed circles, and the detail panel says what reaches a changed node ("1 request from frontend calls this route."). Deleting code ripples to what called it, using the links from before the re-index.

Changes you haven't opened are unread: a dot on the ring, "N unread" on count badges, and "12 of 19 changes read" with **mark read** and **mark all read** in the agents window. Each changed function keeps its own change time, so editing one function marks only that one unread. Read marks live in your browser, counted per agent.

**review** on an agent's entry steps through its changes one function or file at a time, in data-flow order (page, client, route, table, shared types). The map opens to each stop and the detail panel shows its diff; ← and → move, and `r` marks a stop read.

### Asking the map

The MCP server also gives the agent three read-only tools, so it can use the map before it changes anything instead of grepping its way around:

| tool | asks | answers with |
| --- | --- | --- |
| `where_is` | where a feature, function, class, file or route lives (`"create item"`, `"ItemsService"`, `"POST /items"`) | each match's repository, path and lines, its layer and domain, what it serves, a one-line summary, and an id to pass on |
| `who_uses` | what calls, imports, renders, references or requests a function, class, file or folder | each user with the `file:line` and code behind every link, whether the link is proven or inferred, and whether it is in another repository |
| `impact` | what an edit to it reaches: its users, their users, and so on (3 links by default, at most 6) | the reached code nearest first, with counts by repository, layer and domain; HTTP requests matched to routes carry it from a server into the clients that call it |

A target is an id from `where_is`, a path (absolute in the agent's checkout, or relative to the repository), `path#symbol`, or a name; a name that fits several things comes back as a short list to pick from. Every answer comes from the graph the map draws, evidence and all, across every repository imported on the map. The tools call the indexer's `GET /api/agent/find?q=`, `/api/agent/dependents?node=` and `/api/agent/impact?node=&depth=` (each with an optional `&limit=`) with the same `FIADA_URL` and token the reports use; on an indexer people sign in to, an agent token may call these three routes, `POST /api/agent/events` to report and `POST /api/agent/check` to ask about fences, and nothing else.

What the agent asked about, and every file it opens with Claude Code's Read tool, is reported as looked at (a `looked` event). The map draws it as a faint dotted ring in `--muted`, apart from the change rings: a changed node shows its change instead, and a closed circle with something looked at inside gets a fainter one. The detail panel says "looked at by Claude Code", and the agent's card lists what it looked at, each a way onto the map.

Each session is its own card, even when two run in the same checkout. The MCP server finds its session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the servers it starts; for other clients, from the parent process it shares with that session's hooks. A file that only turned up when one session compared the working tree goes to whichever session's own tool wrote it.

### Claude Code

```sh
bun run agent:setup                                   # prints the two snippets below with this checkout's paths
bun run agent:setup --write /path/to/your/project  # or writes them for you
```

`--write` merges the hooks into `/path/to/your/project/.claude/settings.local.json` (your own, git-ignored settings; other hooks and rules there are kept), adds `mcp__fiada` to its `permissions.allow` so Claude Code doesn't ask before each call to Fiada's tools, which only report to the map and read it, and registers the MCP server for that project with `claude mcp add`. To do it by hand, add the server:

```sh
claude mcp add fiada -- node /path/to/fiada/agent/bin/fiada-mcp.mjs
```

and the hooks and the rule, in `.claude/settings.local.json`, `.claude/settings.json` (shared with your team) or `~/.claude/settings.json` (every project):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|TodoWrite|TaskCreate|TaskUpdate|Read",
        "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs", "timeout": 10 }] }]
  },
  "permissions": { "allow": ["mcp__fiada"] }
}
```

Then run `bun run dev`, import the repository you're working in by its local path (so edits re-index), and start Claude Code there. The hook never fails the agent and blocks only what you fenced off: it gives up on the indexer after 1.5 s, always exits 0, and prints only the status brief and, for an edit inside a fence, Claude Code's own "ask" or "deny". It takes about 0.2 s per call on Node 22.18 or later, which runs the TypeScript directly; older Node goes through tsx and adds about 0.3 s.

The same package is on npm as [`@fiadatech/agent`](../agent/README.md): `npx -y --package=@fiadatech/agent fiada setup --write .` in your project does what `bun run agent:setup` does here, without a checkout. Its commands are `fiada setup`, `fiada hook` and `fiada mcp` (the hook and MCP server are also `fiada-hook` and `fiada-mcp`).

To publish a new version: bump `version` in `agent/package.json`, then `npm publish -w @fiadatech/agent`. Publishing bundles `agent/src` into `agent/dist/cli.js` with esbuild (`bun run agent:build`): one file with no dependencies, since Node won't strip types from a package in `node_modules`. A checkout keeps running the TypeScript source.

### Fences and collisions

Select a repository, folder, file or symbol and set its **fence** in the detail panel: **ask first** or **off limits**. Fences are kept per project (`fences.json` beside the grouping, or the project's row in Postgres). The map draws a dashed ink line inside a circle marked ask first, and a closed line with hatching inside one marked off limits.

Before Claude Code's Edit, Write, MultiEdit or NotebookEdit lands, the `PreToolUse` hook asks the indexer (`POST /api/agent/check`) about the file and, for Edit and MultiEdit, the lines it replaces, so a fence on one function stops only edits that reach it. Lines count only where Fiada reads the checkout in place, placed against the file as it is on disk right then; in any other checkout (a clone on the hosted map, a second worktree) the edit counts as the whole file, so a fenced function's file asks or refuses. A checkout whose `origin` remote matches no imported repository is never fenced by folder name alone. Off limits answers `deny` with the reason, so Claude leaves the file alone; ask first answers `ask`, so Claude Code asks you. Outside every fence, or when Fiada doesn't answer, the hook says nothing and your own permission settings decide. Fences check Claude Code's edit tools only: a shell command (`sed -i`, `>`, `git checkout`) isn't parsed for the files it writes, so it isn't stopped, though what it changed still shows on the map afterwards. The agents window says when an agent was stopped or asked. `fiada-hook check <file>…` prints the verdict for scripts.

When two agents have changes in one file or folder, the agents window says so at the top ("two agents in api/app/routes", with their names) and the map writes "two agents" on that circle, or on the closed circle it's in.

### Other agents

- **Cursor**: add the MCP server in `.cursor/mcp.json` (`{ "mcpServers": { "fiada": { "command": "node", "args": ["/path/to/fiada/agent/bin/fiada-mcp.mjs"] } } }`) and the hook in `.cursor/hooks.json` under `afterFileEdit`, `beforeSubmitPrompt` and `stop` (`{ "version": 1, "hooks": { "afterFileEdit": [{ "command": "node /path/to/fiada/agent/bin/fiada-hook.mjs" }], … } }`). The hook recognises Cursor's payloads by their `conversation_id` and `workspace_roots`.
- **Codex CLI**: add the MCP server under `[mcp_servers.fiada]` in `~/.codex/config.toml` (`command = "node"`, `args = ["/path/to/fiada/agent/bin/fiada-mcp.mjs"]`), and set `notify = ["node", "/path/to/fiada/agent/bin/fiada-hook.mjs", "codex"]` so each finished turn sweeps the working tree for changes (the first one counts what changed since Codex started).
- **Anything else**, scripts included: `fiada-hook changed <file>… [--kind added|modified|deleted]`, `fiada-hook task "Add tags" --step "Add the model"`, `fiada-hook sweep` (whatever changed in the working tree since the last call) and `fiada-hook done`, with `--client <name>` to name the agent.

The Cursor and Codex payloads are handled as their docs describe them; only Claude Code has been run end to end. Set `FIADA_HOOK_LOG` to a file to record every payload the hook receives.
