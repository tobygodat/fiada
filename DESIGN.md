# Fiada design system

Fiada wears the Toby Godat design system: warm paper in two themes, one serif, one green that means "here", rules instead of boxes, words before icons. This page is enough to restyle any part of Fiada without asking. The values live in [`web/src/theme/tokens.css`](web/src/theme/tokens.css); the canvas reads them through [`web/src/theme/tokens.ts`](web/src/theme/tokens.ts).

Source: the [Toby Godat design system](https://claude.ai/artifact/XoJ7FUqR1v7ZKfTDkpfBV3) (its tokens, foundations and "building an application" rules), which was drawn from [`tobygodat/portfolio-website`](https://github.com/tobygodat/portfolio-website). What Fiada adds is marked **Fiada**.

## Fixed and free

Toby's direction for Fiada (27 Sep 2026):

- **Fixed: colour and type.** Only the colour tokens below, both themes, and Literata in the seven styles at 400 and 600. No colour is written anywhere but `tokens.css`.
- **Free: everything else.** Layout, panel widths, density, motion and component shapes are Fiada's to choose, inside the Don'ts at the end. Fiada keeps its own motion (panels rising in, change pulses, the working breath).

## Colour

Dark is the default; light is the same roles on light paper. Set `data-theme="dark|light"` on `<html>`.

| token | dark | light | in Fiada |
| --- | --- | --- | --- |
| `--ground` | `#1b1a19` | `#f4f1eb` | the app and the map's paper, flat: no gradient |
| `--ground-raised` | `#252422` | `#fbf9f5` | what floats over the map: sidebar, detail panel, agent window, tooltip, menus; the inside of fields |
| `--text` | `#e8e5df` | `#1b1a19` | names, values, the selected thing, the current crumb |
| `--muted` | `#a39e96` | `#6b665e` | labels, paths, counts, metadata, unselected words, legend |
| `--faint` | `#6f6b65` | `#9a948a` | disabled only |
| `--hairline` | `#3b3936` | `#d9d3c9` | rules between sections and rows |
| `--hairline-strong` | `#5a5752` | `#b8b1a5` | the 1px border of anything floating; rules on `--ground-raised`; scrollbar thumb |
| `--outline` | `#7d7972` | `#857f75` | the border of anything you type into or tick (the import field) |
| `--selection` | `#4a463f` | `#e3dccf` | selected text; the selected row in the outline; the fill of the selected map node and tag |
| `--accent` | `#8fd18a` | `#2e7d4f` | the one green, below |
| `--danger` | `#e8907c` | `#a63d2a` | errors and destructive words, always with a sentence |
| `--warning` | `#e0b565` | `#8a5a00` | needs attention, nothing failed, always with words |
| `--scrim` | `rgba(0,0,0,.55)` | `rgba(27,26,25,.32)` | behind a modal, nothing else |

**The one green** means "you can act here", "you are here", or "now". It draws link underlines, a hovered word, the 2px line under the selected word, the focus ring (2px, 3px offset, 2px corners), the `// ` before section headings, and on the map the agent working now. It is lines and words, never a filled area, never a status. There is no success colour: success is said in `--text` and gets out of the way.

**Two surfaces.** The map is `--ground`. Everything that floats over it is `--ground-raised` with a 1px `--hairline-strong` border and `--radius` corners. No shadow, no blur, no translucency.

## The map's three palettes (Fiada)

Three meanings, three palettes, no hue shared between them. They colour map marks (circles, rings, badges) and their legend and outline swatches only; words in panels stay in the inks above. `tokens.test.ts` fails if a hue collides or a colour drops below 3:1 on the paper.

**Change state** is built from the system's own roles, so it adds no hue:

| token | is | drawn as |
| --- | --- | --- |
| `--added` | `--text` | a solid ink ring outside the rim; `+2` in the badge |
| `--modified` | `--warning` | a solid ochre ring; `~1` |
| `--deleted` | `--danger` | a dashed brick ring, the node a ghost; `−1` |
| `--working` | `--accent` | the green pulse where an agent is working now; the "working" word in the agent window |
| `--unread` | `--text` | a small solid ink dot on the ring of a change you haven't opened since it was made; `3 unread` in the badge |

**Layers**, by position in the project's layer list (the roles preset's order). Quiet tints from the cool half of the wheel, clear of brick (33°), ochre (75°) and green (143–155°), then three cool greys:

| token | layer | dark | light |
| --- | --- | --- | --- |
| `--layer-1` | ui | `#d29fc0` | `#834f72` |
| `--layer-2` | client | `#b8a7da` | `#6b588d` |
| `--layer-3` | api | `#97b2e1` | `#486394` |
| `--layer-4` | service | `#7dbbd7` | `#206c89` |
| `--layer-5` | data | `#75c0c1` | `#017273` |
| `--layer-6` | job | `#b5bfc9` | `#4a545d` |
| `--layer-7` | contract | `#9099a3` | `#66707a` |
| `--layer-8` | test | `#747b83` | `#79818a` |
| `--layer-none` | unlayered, or a ninth layer | `--muted` | `--muted` |

**Repositories** are warm greys with no hue: `--repo-1` to `--repo-4` (dark `#cecac3 #aeaaa4 #8f8c85 #75716b`, light `#36322d #504d47 #6c6863 #86837d`), repeating after four. A repo is told apart by its name and its place on the map, not by colour.

**On the map:**

- A node's fill is its palette colour at about 12% (a leaf at up to 50%), its rim the colour itself.
- Hover: the rim turns `--text` and the label turns `--accent`, as a hovered word does. Selected: the rim is `--text` at 2px over a `--selection` fill.
- Links are `--muted` at rest, `--text` when selected. Dashed means cross-repository; dotted means inferred.
- A link's letter tag is `fine` Literata in a `--radius-sm` box on `--ground-raised` with a `--hairline-strong` border; selected, it takes `--selection` and a `--text` border.
- Change rings sit outside the rim. Count badges read `+2 ~1 −1` in `fine`, each count in its state's colour, in a `--radius-sm` box on `--ground-raised`.

## Type

Literata throughout, from Google Fonts with its optical-size axis (loaded in `web/index.html`). Kerning and ligatures on; tabular figures wherever numbers line up; `text-wrap: balance` on headings.

| style | size / leading | weight | in Fiada |
| --- | --- | --- | --- |
| display | 24px / 1.3, −0.01em | 600 | once per screen: an empty-state title |
| title | 20px / 1.3, −0.005em | 600 | the Fiada wordmark in the sidebar head (the logo SVG at 20px tall, letters in `currentColor`, see `web/src/components/Logo.tsx`); the detail panel's node name |
| heading | 17px / 1.3 | 600 | section headings, lowercase, with a green `// `: `// repositories` |
| body | 17px / 1.6 | 400 | prose: summaries, empty-state sentences |
| small | 15px / 1.6 | 400 | the working size of panels: rows, names, tasks, crumbs, controls |
| fine | 13px / 1.5 | 400 | the floor: paths, counts, timestamps, legend, badges, tags, code |
| caption | 15px / 1.6 | 400 italic | the only italic; rare |

- **Two weights, six sizes, nothing smaller than 13px.** On the map, container labels are 600 and leaf labels 400, sized 13 to 24px by the circle; a label that would be under 13px is not drawn.
- **Lowercase interface words**: "code", "by function", "import", "repositories", "working". Names keep their case: repos, files, symbols.
- **No uppercase, no letter-spaced kickers, no monospace labels.** Paths, symbols, routes and counts are Literata in `fine`.
- **One exception (Fiada):** quoted source code (snippets and diffs in the detail panel) is `--font-code`, IBM Plex Mono at 13px / 1.5, so its columns hold. Nothing else is monospace.

## Space, radius, size

- Space: 4 · 8 · 12 · 16 · 24 · 40, then 56 and 64 (`--space-xs`, `--space-8`, `--space-sm`, `--space-md`, `--space-24`, `--space-lg`, `--space-bottom`, `--space-top`). Closer means related: 4 inside a pair, 8 to 12 inside a row, 16 inside a panel, 24 between groups.
- Radius: `--radius` (6px) for panels, fields and the tooltip; `--radius-sm` (2px) for tags, badges, checkboxes and the focus ring. Nothing rounder, so no pills. Circles exist only as map data.
- Controls you press or type into are `--size-control` (36px) to the eye, with a `--size-hit` (44px) area on coarse pointers. Dense rows (the outline tree, file lists) may be shorter; that is Fiada's call.

## Idioms

- **Floating panel**: `--ground-raised`, 1px `--hairline-strong`, `--radius`, `--space-md` padding, sections divided by `--hairline`, each headed `// word`.
- **Actions are words**: underlined in `--accent`, turning `--accent` on hover. The one action that completes a group (import) is a button: `--size-control` tall, 1px `--accent` border, 600, no fill. Never two borders in one group.
- **Choosing one of a few** (code / by function, colour by repo / layer, links key / all / none): a row of words; the chosen one is `--text` over a 2px `--accent` line, the rest `--muted`. No segmented boxes.
- **Suggestions** (repos to import): words joined by ` · `, underlined like links. No chips.
- **Lists and the outline**: rows on hairlines; the selected row takes `--selection`; hover turns the name `--accent` and adds no background.
- **State is a sentence**: loading is "loading…" in `--muted`; an error starts with its words in `--danger`; an inferred link says "inferred" in `fine` `--muted`. Status is never colour alone.
- **Legend**: words in `fine` `--muted`, each beside its mark (a dot, a ring, a dashed line), no box.
- **Diffs**: an added line on `--text` at 6%, a deleted line on `--danger` at 10% with its words in `--muted`; `+` and `−` in the gutter carry the meaning.
- **Agent window**: a task is a list row; its state is a word ("working" in `--accent`, "waiting for you" in `--warning`, "done" in `--muted`). A finished step is `--muted`; the current step is `--text`.
- **Icons**: optional, an 18px 1.5px-stroke line drawing beside its word in `currentColor`, never alone except a stepping chevron.
- **Logo**: the F mark with its full stop in `--accent` (collapsed sidebar, favicon) and the Fiada wordmark (sidebar head). Letters take the text colour so both themes work; nothing else in the logo is coloured.

## Do and don't

Do:
- Take every colour, size, gap and radius from a token. A missing value gets a new token in `tokens.css`, in both themes, with a comment saying what it is for.
- Check each change in both themes (`setTheme('light')` from `tokens.ts`).
- Give every piece of state words as well as colour.

Don't:
- Write a hex, `rgb()` or `oklch()` value outside `tokens.css`, or use a layer or repo colour on words or chrome.
- Fill anything with green, or use green for anything but here, hover, selected, focus and now.
- Add shadows, gradients, blur, translucent panels, pills, uppercase labels, a second typeface, or a size under 13px.
- Let a hover look stronger than a selection.

## In code

- **CSS**: `var(--muted)`; to fade a token, `color-mix(in srgb, var(--layer-3) 12%, transparent)`.
- **Canvas**: `token('--accent')`, `withAlpha(color, a)`, `layerColor(i, a)`, `repoColor(i, a)`, `changeColor('modified', a)`, and `fonts().serif` for `ctx.font`. Values follow the theme; call `onThemeChange(redraw)` to repaint on a switch.
- **Theme**: `setTheme('light' | 'dark')` sets `data-theme` and remembers it; `index.html` restores it before first paint. Fiada stays dark unless light is chosen; once every surface is on tokens, it should follow the system preference until the person chooses.
- **Checks**: `bun run --cwd web test` runs the palette test with the rest.
