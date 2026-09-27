# Strata: 90-second demo script

Repo on the map: `fastapi/full-stack-fastapi-template` (React frontend, generated TypeScript client, FastAPI backend, SQLModel tables). Lines marked [pending: thread name] depend on a feature still landing; skip the line if it didn't ship.

## Before you record

Record on your own machine, not the hosted map: new files the agent creates only appear as circles when the indexer reads the checkout in place.

```sh
git clone https://github.com/fastapi/full-stack-fastapi-template ~/demo/fastapi
cd ~/hackgt13 && npm run dev                      # map on http://localhost:5178
npm run agent:setup -- --write ~/demo/fastapi     # hooks + MCP server for that checkout
```

1. Open http://localhost:5178, type the full path of `~/demo/fastapi` (for example `/Users/toby/demo/fastapi`) in the sidebar box under **repositories**, and press **import**. Wait for "124 files" to appear.
2. Check the domains are named and nothing big is left in Unsorted.
3. Open a terminal in `~/demo/fastapi`, run `unset CLAUDE_CODE_SESSION_ID` if you're inside another Claude session, and have `claude` ready but not started.
4. Arrange the screen: browser on the left two thirds, terminal on the right third. Sidebar view set to **code**, colour by **layer**, open **on click**.
5. Do one practice run, then remove the repo and add it again so the map starts clean (or `git stash` the agent's changes in `~/demo/fastapi`).

## The run

| Time | Do this | Say this |
| --- | --- | --- |
| 0:00 to 0:10 | Map on screen, one repository, closed circles for frontend and backend. | "Coding agents change more code than I can read. Strata is a map of the codebase, so I can see what's there and what the agent is touching. This is the FastAPI full-stack template, which I've never worked in." |
| 0:10 to 0:22 | In the sidebar under **view**, click **by function**. The map regroups into feature circles. | "On import, Strata sorts every function into a layer and a feature. Rules do most of it from routes, models and imports, and Claude names the features and places what the rules couldn't, with a reason for each." |
| 0:22 to 0:32 | Click the **Items** circle once. Point at the summary at the top of the panel. Click it again to open it: UI, Client, API and Data layers appear inside. | "Every circle says what it does in one line. Items opens into its layers: the React page, the generated client, the API routes, and the database model." [pending: Short summary for every node] |
| 0:32 to 0:47 | Click the **HTTP** tag on the line from Client to API. The contract panel opens. Point at one interaction, then at its **why**: the request line and the route it matched. | "Lines are contracts. This one is HTTP: every request the frontend makes to the items routes, and for each one, the exact line of code and the route it matched. Solid means the code proves it. Dotted means Strata guessed, and it tells you how sure it is." |
| 0:47 to 0:57 | In the interaction list, click `read_items` to jump to the backend route. Then click the **Item** model in the Data layer. The panel shows its code. | "One click takes me to the route, and from there to the table it reads. That's how creating and listing items works, end to end, without opening a file tree." |
| 0:57 to 1:05 | Switch to the terminal, start `claude`, and type: `Add a CSV export button to the items page, with a GET /items/export route`. | "Now the part I care about. I start Claude Code in this repo. It's connected to Strata with a hook and an MCP server, one setup command." |
| 1:05 to 1:22 | Switch back to the map. The agents window shows the task and plan. Rings appear on the items route and the items page as files change; counts show on closed circles. | "As it works, its task and plan show up here, and every file and function it touches rings on the map: ink for added, ochre for changed. The green ring is where it's working right now. I can see it's touching the API and the page, and nothing else." |
| 1:22 to 1:30 | Click a ringed circle. The diff shows in the panel. | "Click a ring and I get the diff, right where it lives in the system. That's Strata: review agent work on the map, not in a wall of diff. It's live at hackgt13.vercel.app." |

## If something goes wrong

- The agent is slow to make its first edit: keep talking over the plan in the agents window, it appears before any file changes.
- No rings: check the terminal where `npm run dev` runs for `POST /api/agent/events`. If nothing arrives, the hooks weren't written for this folder; rerun `npm run agent:setup -- --write ~/demo/fastapi` and restart `claude`.
- By function shows mostly Unsorted: record the 0:10 to 0:32 steps in the **code** view instead (frontend, then `src/client`, then backend `api/routes`), and cut the sorting line.
