#!/usr/bin/env bash
# Plays one agent session for the review tour's end-to-end check: a prompt, a plan, then nine
# real edits to a clone of the FastAPI template (imported on the map first), each reported
# through Fiada's own hook CLI the way Claude Code's PostToolUse hook would.
set -euo pipefail
REPO=${1:?usage: agent-session.sh <clone of fastapi/full-stack-fastapi-template>}
HERE=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=$(cd "$HERE/../.." && pwd)
S=demo-review
agent="{\"client\":\"claude-code\",\"session\":\"$S\",\"cwd\":\"$REPO\",\"root\":\"$REPO\"}"
post() { curl -s -o /dev/null -XPOST localhost:4178/api/agent/events -H 'content-type: application/json' -d "$1"; }
post "[{\"type\":\"session\",\"phase\":\"start\",\"agent\":$agent},{\"type\":\"prompt\",\"text\":\"Let people give items a priority and list the urgent ones first\",\"agent\":$agent},{\"type\":\"task\",\"task\":\"Item priority, from the table to the items page\",\"steps\":[{\"text\":\"Add priority to the models and a migration\",\"status\":\"active\"},{\"text\":\"Sort by priority in crud and the items route\",\"status\":\"pending\"},{\"text\":\"Regenerate the client and show it on the page\",\"status\":\"pending\"}],\"agent\":$agent}]"
hook() { node "$CHECKOUT/agent/bin/fiada-hook.mjs" changed --client claude-code --session "$S" --cwd "$REPO" "$@"; }
step() { python3 "$HERE/agent-edits.py" "$REPO" "$1"; hook "$2"; sleep "${PAUSE:-1.2}"; }
step models backend/app/models.py
step migration backend/app/alembic/versions/b7c1e2d3f4a5_add_item_priority.py
step crud backend/app/crud.py
step route backend/app/api/routes/items.py
step types frontend/src/client/types.gen.ts
step sdk frontend/src/client/sdk.gen.ts
step page frontend/src/routes/_layout/items.tsx
step form frontend/src/components/Items/AddItem.tsx
step columns frontend/src/components/Items/columns.tsx
post "[{\"type\":\"task\",\"steps\":[{\"text\":\"Add priority to the models and a migration\",\"status\":\"done\"},{\"text\":\"Sort by priority in crud and the items route\",\"status\":\"done\"},{\"text\":\"Regenerate the client and show it on the page\",\"status\":\"done\"}],\"state\":\"waiting\",\"agent\":$agent},{\"type\":\"status\",\"text\":\"Priority is in: the table, the route, the client and the items page. Ready for you to review.\",\"agent\":$agent}]"
