# Product

## Users

- Developers who hand work to a coding agent (Claude Code first, then Cursor, Codex or anything that speaks MCP) and need to review what it changed where it lives in the system, not in a wall of diff.
- Developers new to a codebase, or to several repositories that talk to each other, who need the big picture and what a change would touch.
- Coding agents themselves, which ask the map where a feature lives and what an edit would reach before they change anything.

## Purpose

Fiada is a map of your codebase that sorts itself, explains itself, and lights up where your coding agent is working. It turns one or more real repositories into one zoomable map, from repository to folder to file to symbol, drawn as nested circles. The links between them are contracts (imports, calls, HTTP requests, shared types), each backed by the code that proves it.

## Positioning

Reading code file by file loses the big picture, and a one-paragraph architecture summary can't tell you what a change touches. Fiada sits in the middle: a map you can zoom from the whole system to one line, where every claim points at code.

It was built at HackGT 13 for the Oracle of the Deep track (ML/AI and visualization), with the Create-X, MLH .tech domain and MLH MongoDB Atlas add-ons, and won first place in ML/AI Visualization. It was called Strata. It runs at https://fiada.tech, where people sign in with GitHub and each get a map of their own.

## Principles

- **Real code only.** The map shows what the indexer actually read. No synthetic or hand-built data.
- **Show the evidence.** Every link says whether it was proven or inferred, with the lines behind it. Every model placement says why.
- **Quiet by default.** At rest the map draws only the few links that matter. More appears when you point or select.
- **Works without a model.** A model key makes the sort and summaries better. Without one, everything still works.
- **Your map is yours.** Each person's project, clones and agent activity are theirs alone, and deleting an account deletes all of it.
- **Nobody can use it up for everyone else.** Hosted use is limited per person.

## Accessibility

- Nothing smaller than 13px. A map label that would be smaller isn't drawn.
- State is always said in words as well as colour.
- Map colours keep at least 3:1 contrast on the paper in both themes, and no two meanings share a hue.
- Everything works from the keyboard: `/` or Ctrl-K searches, Enter opens, Backspace goes back, Esc clears, and ← → step through a review.
- Controls are 36px to the eye with a 44px hit area on coarse pointers.
- Light and dark themes carry the same roles.
