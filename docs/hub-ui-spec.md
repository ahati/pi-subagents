# Hub UI Spec — the unified Agents & Workflows window

This document is the design contract for the unified hub window: one popup that
shows subagents and workflow runs together, grouped, rendered entirely through
the shared window-layout module. Audience: contributors changing
`src/ui/agent-hub.ts`, `src/ui/workflow-dialog.ts`, or `src/ui/window-frame.ts`.

Status: **spec**. The visual language is the one the hub's popup chat pane
established — narrow master list, detail pane opening with a two-line header
block, transcript blocks in the shared viewer's grammar, one full-width footer
band. The implementation may land in phases (narrow master → header blocks → footer band → strip
removal → test repins); where code and this spec
disagree, either the code is behind (keep working) or a deliberate deviation
was accepted (update this file in the same change). All frames are drawn at 120
columns; `f` twins redraw the same pages at terminal size.

**Implementation status.** The page model is landed and stays: the page enum
**R · T · SL · W · WA · SAL · L** (`enterPage`/`popPage`, `PAGE_PARENT`), the
pane invariant, the shared `ConversationViewer` behind **T**/**WA**, the 40×10
refusal and the 40–59 stacked / ≥ 60 two-pane ladder, and per-row key dispatch
(`test/hub-pages.test.ts`). Landed in the previous style and restyled by this
rewrite: the half-width roster (`hubPaneGeometry`, description/stats columns)
becomes the narrow 18-column master (`masterPaneGeometry`); the window-title
breadcrumb is dropped (the title cell is 20 columns) — the header block names
the item, and on run-agent pages the run name rides the `↳` line; the roster's
transcript preview becomes the agent-log preview; the `❞` status strip is
removed (activity = header stats, the log's trailing line, the `▍` live
tail); the single-list `hintLine` footer becomes the two-slot band; `▸` becomes `❯`; the
`⋯` queued glyph becomes `○`; evicted `◌ ⇋` roster rows are dropped (revival
flows through mentions and `/agents revive`). The `●`/`├`/`└` diff chrome
tracks pi's tool renderers (`resolveRenderers`) — the text fallback must stay
readable. Expand state is viewer-wide (`o`/`ctrl+o`), not per tool-call. Still
handed off: `/agents → Workflows` rewiring onto this window (`WorkflowDialog`
remains that path's adapter), a dedicated event stream behind the log pages
(they render from run/record progress), `AgentHubInitial.runId` for opening a
run pre-focused, and the activity view's (`2`) restyle.

## The window style (the chat-pane grammar)

One window, drawn by `renderWindow` (`src/ui/window-frame.ts`): it owns every
edge, bar, rule and the footer band; a surface contributes rows — groups,
pane bodies, header blocks, key lists — and nothing else. Acceptance rule: no
layout arithmetic in a surface module.

- **The split** — the master cell holds `MASTER_LIST_WIDTH` (18) content
  columns via `masterPaneGeometry`, fixed at every two-pane size. The master is
  identity (cursor, state glyph, name); the detail pane owns the width. At 120
  columns a split row is `│ <18> │ <95> │`. `hubPaneGeometry` (the half split)
  is retired — it existed to fit the description/stats columns the narrow
  roster no longer carries; the proportional `paneGeometry` keeps its cap where
  its bytes are pinned: the inspector and the popup chat twin.
- **The frame** — the top edge is `╭ Agents & Workflows ┬──…──╮`: the title
  names both kinds and exactly fills the master cell, and the `┬` is where the
  divider lands. The bottom edge mirrors it plain; the divider's `┴` sits in
  the band rule just above the footer. The stacked twin
  (40–59 cols) has no tee to hang a title on, so its top edge carries the same
  title itself: `╭ Agents & Workflows ─…─╮`.
- **Three rules, three jobs**:
  1. the **quiet rule** `───` — exactly three dashes, dim, between transcript
     blocks; content-level, never spanning a cell;
  2. the **header rule** — a full-cell rule directly under the right pane's
     header block (the cell's pad columns are the inset), separating identity
     from body;
  3. the **band rule** — a full-width rule above the footer. The panes end at
     it; the footer row beneath spans the window. The divider column continues
     down to the band rule's `┴`, and the bottom edge below it is plain.
- **Twins** — `f` swaps the popup twin (90 % viewport) and the fullscreen twin
  (100 %); twins differ only in frame size, never in content or page. The
  footer names the twin you would get: `f full` in the popup, `f popup` in
  fullscreen. Frames in this document show the popup twin.
- **Width is a parameter, not a cap** — 120 columns is the verification width
  every frame here is drawn at; `renderWindow` stays width-parameterized, so a
  twin redraws the same pages at the terminal's size and a narrower one wraps
  its cells or drops whole hints instead of tearing.

## Pane invariant (the one rule that decides every layout)

**The left pane is always the parent level; the right pane is always the
selected item's detail.** The more detailed a view is — transcript, diff,
event log — the further right it lives. Navigating deeper never moves detail
to the left; it changes what the right pane shows and demotes the previous
view into the left pane.

| Page | Left pane (parent level) | Right pane (detail) |
|---|---|---|
| **R** — roster | grouped roster (subagents + runs) | selected item's live preview |
| **T** — subagent transcript | grouped roster, selection pinned | full conversation |
| **SL** — subagent log | grouped roster, selection pinned | the subagent's event log |
| **W** — workflow run | grouped roster, selection pinned | the run's phases + agents |
| **WA** — a run's agent | the run's agent list (+ phases) | that agent's full conversation |
| **SAL** — run-agent log | the run's agent list (+ phases) | that agent's event log |
| **L** — run log | the run's phases + agents | the run's event log |

## The window has pages, not windows

There is exactly one window. What used to be separate popups (agent roster,
workflow inspector, transcript, log) are **pages** inside it. A page = (left
pane = parent level, right pane = detail, footer band). `⏎`
descends, `esc` ascends exactly one level, `o`/`ctrl+o` expands in place —
never a page. Every page has a twin (`f`).

The footer band holds two slots (the grammar is in
[The footer band](#the-footer-band)); the tables below list each page's slots
in full — the fitter may drop hints at narrower widths.

| Page | Reached by | Footer left slot | Footer right slot |
|---|---|---|---|
| **R** — roster, subagent selected | hub open; `esc` from T | `⏎ transcript · l log · p pause · c copy` | `↑↓ select · ⇥ activity · f full · Esc close` |
| **R** — roster, run selected | `↑↓` onto a run row | `⏎ open run · s stop run · c copy` | `↑↓ select · ⇥ activity · f full · Esc close` |
| **T** — subagent transcript | `⏎` on a subagent row | `<N> lines · <P>% · Enter steer · x stop · m md` | `PgUp/PgDn · j/k scroll · o expand · l log · p pause · c copy · f full · Esc roster` |
| **TD** — expanded tool-call | `o` / `ctrl+o` in T or WA | as the page it sits in, with `m md` swapped for `c copy diff · o collapse` | as the page it sits in, without `o expand` |
| **SL** — subagent log | `l` in T — or `l` on a subagent row | `<N> lines · <P>% · Enter steer · x stop` | `↑↓ scroll · c copy tail · p pause agent · f full · Esc back` |
| **W** — workflow run | `⏎` on a run row | `<done>/<total> agents · phase <n> of <m>` | `↑↓ item · ⏎ agent · l run log · s stop run · f full · Esc roster` |
| **WA** — agent inside a run | `⏎` on an agent row in W | `<N> lines · <P>% · Enter steer · x stop · m md` | `PgUp/PgDn · j/k scroll · o expand · l log · p pause · c copy · f full · Esc back` |
| **SAL** — run-agent log | `l` in WA | `<N> lines · <P>% · Enter steer · x stop` | `↑↓ scroll · c copy tail · p pause agent · f full · Esc back` |
| **L** — run log | `l` in W | `<N> lines · <P>% · s stop run` | `↑↓ scroll · c copy tail · f full · Esc back` |

**TD** is a view state of the page it sits in, not a nesting level. The
activity view (`2`, `⇥`) stays a single-pane legacy table with its own
one-list footer (`↑↓ select · Enter open · x stop · p pause · f popup ·
q close`); restyling it to the header-block grammar is a follow-up.

## The right pane opens with a header block

Every right pane begins with identity — the same block on a page and in its
roster preview — and identity is exactly **three rows**: the header line, the
`↳` line, the header rule. The rule sits directly under the `↳` line —
never a blank row between identity and body — and everything below it is
body: the item's transcript or event log, taking every remaining row. The
left pane's rows continue beside the body; the panes flow independently, so a
tall roster never pushes the right pane's content down. The 20-column title
cell never carries a breadcrumb; the header block is the identity.

The agent header (R preview, **T**, **SL**):

```text
● <name>[(twin)]  <description> · <N> tools · <elapsed> (<state>) · <tokens> token (<ctx>%)
  ↳ <provider/model> · thinking: <level> · worktree · isolated · background · max turns: <N>
```

`(twin)` marks append prompt mode; invocation tags list only what applies. The
`↳` line is always drawn — an agent with no invocation tag renders `  ↳ —` —
so the header rule and the body below it never move by a row per record. The
run header (R preview, **W**, **L**):

```text
● <name>  workflow · <done>/<total> agents · <elapsed> (<state>)
  ↳ phase <n> of <m> — <current phase> · <k> agents in flight
```

A settled run freezes its clock and reads `↳ <m> phases · <state word>`. The
run-agent header (**WA**, **SAL**) is the agent header with the run name
leading the `↳` line: `↳ migrate-v2 · <provider/model> · worktree`.

## Transcript block grammar (right pane of T and WA)

| Block | Marker | Rendering |
|---|---|---|
| user message | `[User]` | accent label; body wrapped at the pane width, no indent |
| thinking | `✻ thinking` | muted label; body indented two, dim, capped at six preview lines; overflow `… +N lines` |
| assistant | `[Assistant]` | bold label; wrapped body indented two; a streaming assistant with nothing legible yet renders `  ✻ thinking…` |
| tool-call | `● <Tool> <subject>` | one header line — `● Bash pnpm vitest run …`, `● Edit src/db.ts` — from pi's tool renderers |
| collapse bars | `├` / `└` | `+a −b [━━━━━━━━━━] at line N` opens a rich block, `… • <H> hunk(s) at line M` closes it; the bar fills with progress |
| diff body | `│ ▌N− │` | boxed: inner rules top and bottom, gutter `▌N− │` removed / `▌N+ │` added / ` N  │` context |
| plain results | `└ <summary>` | `└ 12 passing, 3 unstable • ctrl+o to toggle`; empty output renders `✓ (no output)` |
| in-flight | `○ awaiting result` | dim; partial output streams as `… N earlier lines` plus the last four |
| streaming tail | `▍` | `▍ <describeActivity>` — the focused item's live activity, the last content row |
| content separator | `───` | the quiet rule, between blocks only |

The tool-call chrome (`●`, `├`/`└`, `[━━━]`, the `▌` gutter) is owned by pi's
tool renderers, reached through `resolveRenderers`; this extension pins where
the blocks sit (the detail pane, wrapped at its width), not their bytes, and
the text fallback (`⏺ name(args)` with `  ✓`/`  ✗` result lines) must stay
readable when no renderer exists. `o`/`ctrl+o` toggles rich-output expansion
for the whole embedded viewer — viewer-wide state, kept in the viewer's cache
key, reset when a page rebuilds its viewer. A settled agent's transcript
renders the same blocks frozen, without the `▍` tail.

## The footer band

One row, full window width, under the band rule — never a split row, never
two stacked rows:

- **left slot** — the readout and live actions: `<N> lines · <P>%` then
  `Enter steer · x stop · m md` on pages embedding a live conversation or log;
  on **R** the selected row's action keys; on **W** the run counters;
- **right slot** — navigation, then the page's keys, then the twin toggle and
  the escape anchor: `PgUp/PgDn · j/k scroll · <page keys> · f <twin> ·
  Esc <target>`.

The slots keep at least two columns between them and the right slot is flush
to the band's right edge. When the pair overflows, whole hints drop in this
order: (1) the readout; (2) left actions right-to-left — `m md` first,
`Enter steer` last; (3) right hints right-to-left — the `f` twin first — with
the `Esc …` anchor pinned. Hints are never cut mid-hint. `x` is armed on
first press (`x again to STOP`); `k` aliases `x` on roster and transcript
pages. The readout is the first thing the band gives up: at 120 columns **T**,
**WA** and **TD** have already dropped `<N> lines · <P>%` (**TD**, which
carries `c copy diff` instead of `m md`, its `o collapse` too) — the frames
show the fitter's honest output; wider terminals restore them.

## Page R — roster

### R1 — subagent selected (live agent-log preview)

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● explore  Find and fix the flaky tests · 3 tools · 12s (running) · 41.2k token (12%)           │
│ ❯ ● explore        │   ↳ opencode-go/deepseek-v4.1-flash · thinking: max · background                                │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │ 12:01:02 spawn  explore · opencode-go/deepseek-v4.1-flash · background                          │
│   ✓ docs-gen       │ 12:01:03 turn   1 start                                                                         │
│   ✗ crawl-old      │ 12:01:04 tool   read README.md → 42 lines                                                       │
│ WORKFLOWS          │ 12:01:06 tool   bash: grep -rn flaky test/ → 3 hits                                             │
│   ● migrate-v2 3/5 │ 12:01:21 note   steering: focus on test/e2e                                                     │
│   ✓ batch-d… 12/12 │ 12:01:40 tool   bash: pnpm vitest run test/x → 12 passing                                       │
│                    │ 12:01:41 still running — 3 unstable detected                                                    │
│                    │ (⏎ opens the full transcript)                                                                   │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ ⏎ transcript · l log · p pause · c copy                                  ↑↓ select · ⇥ activity · f full · Esc close │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

### R2 — run selected (run overview preview)

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● migrate-v2  workflow · 3/5 agents · 1m12s (running)                                           │
│   ● explore        │   ↳ phase 2 of 4 — migrate · 2 agents in flight                                                 │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │ PHASES                                                                                          │
│   ✓ docs-gen       │ ✓ discover                                                                                  3/3 │
│   ✗ crawl-old      │ ❯ 2 migrate                                                                                 1/2 │
│ WORKFLOWS          │ 3 verify                                                                                      — │
│ ❯ ● migrate-v2 3/5 │ 4 report                                                                                      — │
│   ✓ batch-d… 12/12 │ (⏎ opens the run page)                                                                          │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ ⏎ open run · s stop run · c copy                                         ↑↓ select · ⇥ activity · f full · Esc close │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Row grammar: the master holds group headers — `SUBAGENTS`, then `WORKFLOWS`,
dim and bold, non-selectable, omitted when the group is empty — and rows
`❯ ● name` selected, `  ○ name` not. The cursor `❯` crosses group headers
seamlessly; the list windows through `windowRange` (centered on the cursor,
clamped at both ends). Run rows append their `<done>/<total>` counter flush
right; the name truncates first, the counter survives. Glyphs: `●` running,
`○` queued, `‖` paused, `✓` completed, `✗` failed, `·` stopped; runs reuse
`● ‖ ✓ ✗`. `/` filters the roster; the wheel scrolls it. While the filter input
is open or a filter is applied, a full-width filter row sits directly under the
top edge — never a split row — and costs the body one row.

The preview pane is the item's **agent log** — the same event grammar as
**SL** — closed by the `(⏎ opens the full transcript)` hint. It is the
compact answer to "what is this agent doing": the trailing line is the live
activity (`describeActivity` in `src/ui/agent-widget.ts`), which is where the
removed `❞` strip's information went. A selected run previews its overview
instead: header block, phases (the current phase carries the `❯`), and the
`(⏎ opens the run page)` hint.

## Page T — subagent transcript (nested level 1)

Left: the roster stays, selection pinned. Right: the header block, then the
full conversation. **TD** is this page with one rich block expanded.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● explore  Find and fix the flaky tests · 3 tools · 12s (running) · 41.2k token (12%)           │
│ ❯ ● explore        │   ↳ opencode-go/deepseek-v4.1-flash · thinking: max · background                                │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │ [User]                                                                                          │
│   ✓ docs-gen       │ Find and fix the flaky tests in test/. Start from test/e2e and verify with pnpm.                │
│   ✗ crawl-old      │ ───                                                                                             │
│ WORKFLOWS          │ ✻ thinking                                                                                      │
│   ● migrate-v2 3/5 │   Three tests share one temp dir — the failures vanish in isolation. Confirm                    │
│   ✓ batch-d… 12/12 │   with a solo run, then scope the temp dir per worker.                                          │
│                    │   … +2 lines                                                                                    │
│                    │ ───                                                                                             │
│                    │ [Assistant]                                                                                     │
│                    │   The e2e helpers reuse one mkdtemp root. I'll prove it with a solo run,                        │
│                    │   then scope the temp dir per worker.                                                           │
│                    │ ───                                                                                             │
│                    │ ● Edit test/e2e/helpers/boot.ts                                                                 │
│                    │   └ +9 −4 [━━━━━━━━━━] • 1 hunk at line 12                                                      │
│                    │ ▍ running tests…                                                                                │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ Enter steer · x stop · m md       PgUp/PgDn · j/k scroll · o expand · l log · p pause · c copy · f full · Esc roster │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page TD — expanded tool-call (in-place view state)

`o`/`ctrl+o` on the `Edit` call expands its diff in place; the roster does not
move, no nesting level is added.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● explore  Find and fix the flaky tests · 3 tools · 12s (running) · 41.2k token (12%)           │
│ ❯ ● explore        │   ↳ opencode-go/deepseek-v4.1-flash · thinking: max · background                                │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │   (earlier blocks scroll up — identical)                                                        │
│   ✓ docs-gen       │ ───                                                                                             │
│   ✗ crawl-old      │ ● Edit test/e2e/helpers/boot.ts                                                                 │
│ WORKFLOWS          │   ├ +9 −4 [━━━━━━━━━━] at line 12                                                               │
│   ● migrate-v2 3/5 │   │ ─────────────────────────────────────────────────────────────────────────────────────────   │
│   ✓ batch-d… 12/12 │   │  10  │ export function boot() {                                                             │
│                    │   │ ▌12- │   const root = mkdtempSync(tmpdir())                                                 │
│                    │   │ ▌12+ │   const root = mkdtempSync(join(tmpdir(), name))                                     │
│                    │   │ ▌13+ │   process.env.VITEST_WORKER = name                                                   │
│                    │   │  15  │   return { root, cwd }                                                               │
│                    │   │ ─────────────────────────────────────────────────────────────────────────────────────────   │
│                    │   └ +9 −4 [━━━━━━━━━━] • 1 hunk at line 12                                                      │
│                    │ ▍ running tests…                                                                                │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ Enter steer · x stop · c copy diff           PgUp/PgDn · j/k scroll · l log · p pause · c copy · f full · Esc roster │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page SL — subagent log (nested level 2)

`l` from **T** — or `l` directly on a roster subagent row (skipping **T**).
The event log is the compact, timestamped companion to the transcript:
spawns, turn starts, tool results, steering notes, completion with
tokens/cost.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● explore  Find and fix the flaky tests · 3 tools · 12s (running) · 41.2k token (12%)           │
│ ❯ ● explore        │   ↳ opencode-go/deepseek-v4.1-flash · thinking: max · background                                │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │ 12:01:02 spawn  explore · opencode-go/deepseek-v4.1-flash · background                          │
│   ✓ docs-gen       │ 12:01:03 turn   1 start                                                                         │
│   ✗ crawl-old      │ 12:01:04 tool   read README.md → 42 lines                                                       │
│ WORKFLOWS          │ 12:01:06 tool   bash: grep -rn flaky test/ → 3 hits                                             │
│   ● migrate-v2 3/5 │ 12:01:21 note   steering: focus on test/e2e                                                     │
│   ✓ batch-d… 12/12 │ 12:01:40 tool   bash: pnpm vitest run test/x → 12 passing                                       │
│                    │ 12:01:41 still running — 3 unstable detected                                                    │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ 42 lines · 100% · Enter steer · x stop                   ↑↓ scroll · c copy tail · p pause agent · f full · Esc back │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page W — workflow run (nested level 1)

Left: the roster, selection pinned to the run. Right: the run header, phases
and the run's agents — the level the next `⏎` descends into.
`↑↓` moves the `❯` across phases and run agents alike; it starts on the
current phase.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ SUBAGENTS          │ ● migrate-v2  workflow · 3/5 agents · 1m12s (running)                                           │
│   ● explore        │   ↳ phase 2 of 4 — migrate · 2 agents in flight                                                 │
│   ○ audit          │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ‖ refactor       │ PHASES                                                                                          │
│   ✓ docs-gen       │ ✓ discover                                                                                  3/3 │
│   ✗ crawl-old      │ ❯ 2 migrate                                                                                 1/2 │
│ WORKFLOWS          │ 3 verify                                                                                      — │
│ ❯ ● migrate-v2 3/5 │ 4 report                                                                                      — │
│   ✓ batch-d… 12/12 │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│                    │ RUN AGENTS                                                                                      │
│                    │ ❯ ● m-1   schema tables                                                                     40s │
│                    │ ● m-2   api endpoints                                                                       32s │
│                    │ ✓ m-3   seed data                                                                          done │
│                    │ ○ m-4   verify queries                                                                   queued │
│                    │ ○ m-5   write report                                                                     queued │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ 3/5 agents · phase 2 of 4                           ↑↓ item · ⏎ agent · l run log · s stop run · f full · Esc roster │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page WA — a run's agent (nested level 2)

Left: the run's agent list — now the parent level — with the phases beneath.
Right: that agent's full conversation, same grammar as **T**. `↑↓` in the
left list switches agents in place.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ migrate-v2         │ ● m-1 (twin)  Migrate the schema in db.ts to v2 · 5 tools · 40s (running) · 88.3k token (9%)    │
│ ❯ ● m-1            │   ↳ migrate-v2 · opencode-go/deepseek-v4.1-flash · worktree                                     │
│   ● m-2            │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ✓ m-3            │ [User]                                                                                          │
│   ○ m-4            │ Migrate the schema in db.ts to the v2 format. Keep the public API stable.                       │
│   ○ m-5            │ ───                                                                                             │
│ PHASES             │ ✻ thinking                                                                                      │
│ ✓ discover         │   The v1 tables are created in init(); migrate needs a dual-write shim.                         │
│ ❯ 2 migrate        │ ───                                                                                             │
│                    │ [Assistant]                                                                                     │
│                    │   Adding a dual-write shim around init().                                                       │
│                    │ ───                                                                                             │
│                    │ ● Edit src/db.ts                                                                                │
│                    │   ├ +42 −6 [━━━━━━━━━━] at line 88                                                              │
│                    │   │ ─────────────────────────────────────────────────────────────────────────────────────────   │
│                    │   │ ▌88- │ db.createTable("v1_rows")                                                            │
│                    │   │ ▌88+ │ db.createTable("v2_rows", { ifNotExists: true })                                     │
│                    │   │ ▌89+ │ db.onWrite("v1_rows", mirrorToV2)                                                    │
│                    │   │ ─────────────────────────────────────────────────────────────────────────────────────────   │
│                    │   └ +42 −6 [━━━━━━━━━━] • 1 hunk at line 88                                                     │
│                    │ ▍ editing 2 files…                                                                              │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ Enter steer · x stop · m md         PgUp/PgDn · j/k scroll · o expand · l log · p pause · c copy · f full · Esc back │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page SAL — a run agent's log (nested level 3)

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ migrate-v2         │ ● m-1 (twin)  Migrate the schema in db.ts to v2 · 5 tools · 40s (running) · 88.3k token (9%)    │
│ ❯ ● m-1            │   ↳ migrate-v2 · opencode-go/deepseek-v4.1-flash · worktree                                     │
│   ● m-2            │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│   ✓ m-3            │ 12:02:11 spawn  m-1 (migrate) · parent run migrate-v2                                           │
│   ○ m-4            │ 12:02:12 turn   1 start                                                                         │
│   ○ m-5            │ 12:02:13 tool   read schema.sql → 88 lines                                                      │
│ PHASES             │ 12:02:30 tool   edit db.ts +42 −6                                                               │
│ ✓ discover         │ 12:02:44 turn   2 start                                                                         │
│ ❯ 2 migrate        │ 12:02:45 tool   bash: pnpm test → 12 passing                                                    │
│                    │ 12:02:46 still running                                                                          │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ 7 lines · 100% · Enter steer · x stop                    ↑↓ scroll · c copy tail · p pause agent · f full · Esc back │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Page L — run log (nested level 2 from W)

Left: the run's phases + agents. Right: the run's event log — the run's own
events interleaved with its agents' spawns, edits and completions.

```text
╭ Agents & Workflows ┬─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ migrate-v2         │ ● migrate-v2  workflow · 3/5 agents · 1m12s (running)                                           │
│ PHASES             │   ↳ phase 2 of 4 — migrate · 2 agents in flight                                                 │
│ ✓ discover         │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│ ❯ 2 migrate        │ 12:01:18 run start: 5 agents, 4 phases                                                          │
│ 3 verify           │ 12:01:19 m-1 spawned (discover)                                                                 │
│ 4 report           │ 12:01:33 m-1 done — 3 tables found                                                              │
│ RUN AGENTS         │ 12:01:34 m-2 spawned (migrate)                                                                  │
│ ❯ ● m-1            │ 12:02:02 m-2: edit api.ts +120 −14                                                              │
│   ● m-2            │ 12:02:10 m-3 done — seeds applied                                                               │
│   ✓ m-3            │ 12:02:11 phase 2 still running — 2 agents in flight                                             │
│   ○ m-4            │                                                                                                 │
│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │
│ 11 lines · 64% · s stop run                                              ↑↓ scroll · c copy tail · f full · Esc back │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Transition map

```text
 R (subagent sel) ──⏎──> T ──o──> TD (in place) ──o──> T ──l──> SL ──esc──> T ──esc──> R
 R (subagent sel) ──l──────────────> SL (skips T) ──esc──> R
 R (run sel) ──⏎──> W ──⏎ on agent──> WA ──l──> SAL ──esc──> WA ──esc──> W
                W ──l──> L ──esc──> W
 R ──⇥ / 2──> A (activity view) ──1 / ⇥──> R
 any page ──f──> twin (popup ⇄ fullscreen; frame size only)
 roster ──↑/↓──> cursor crosses group headers; right pane + footer follow
 /agents menu ── "Agent hub" ──> R
 SubagentWorkflow tool ── open ──> R, cursor on that run's row (AgentHubInitial.runId)
 legacy workflow-dialog entry points ──> same window, focused (adapter)
```

`esc` always ascends exactly one nesting level; the footer's `Esc <target>`
names where it lands. Maximum nesting depth is 3 (roster → run → agent → log).

## Live regrouping

- A subagent settles → its glyph flips in place (`●` → `✓`), nothing moves.
- A workflow parks (global `/pause`) → its row renders `‖` in `WORKFLOWS` and
  the agents it owns render `‖` in `SUBAGENTS` (and as `‖` rows inside **W**).
- A workflow completes → `✓` and its counters freeze.
- Resume moves rows back exactly as the lifecycle glyphs dictate. Nothing in
  the roster is hand-sorted; grouping is derived.

## Minimum window size

The parent terminal gates the window before it opens. `TWO_PANE_MIN_WIDTH`
(60) stays the two-pane gate; the master keeps its 18 columns at every
two-pane size and the detail pane takes the rest.

| Terminal | Behavior |
|---|---|
| ≥ 60 cols · ≥ 16 rows | Full layout: narrow master + detail, header blocks, footer band |
| 60–99 cols | Same grammar; detail wraps at its width; footer degrades by the fitter |
| 40–59 cols | **Single-pane stacked mode**: the roster takes the full width; `⏎` pushes the right pane's content as a full-width page (header block + `esc` pops) |
| < 40 cols or < 10 rows | The window refuses to open: `ctx.ui.notify("Agent hub needs a terminal ≥ 40×10")` — no partial frame is drawn |
| height 10–15 (any width) | Body floors at six rows — five while the filter row is up; diff boxes keep their shape, older hunks scroll |

Escalation back up is automatic on resize; selection, scroll, page and expand
state are preserved through every resize.

## Refusal rules (unchanged)

Foreground agents a caller blocks on, worktree-isolated runs, and agents owned
by another agent or a workflow refuse to pause; workflow rows expose only
actions safe for their run state (`s` stops a run; it does nothing on an
agent row). Labels and available actions may differ per row type — the window
may not.

## Tests that hold this together

- **Chrome parity**: the shared chrome (edges, tees, rules, band, footer row
  shape) renders identically for the hub and the workflow inspector at equal
  widths — `renderWindow` owns it; parity pins fail if a surface drifts.
- **Pane invariant**: every page's left pane shows the parent level and its
  right pane the detail — pinned per page in `test/hub-pages.test.ts`.
- **Header block**: every right pane opens with the same three identity rows —
  header line, `↳` line, rule — before any body row; run-agent pages lead the
  `↳` line with the run name.
- **Footer band**: each page renders its two slots; the fitter's drop order
  (readout → left actions → right hints, `Esc` pinned, never mid-hint) is
  pinned.
- **Transcript grammar**: T and WA render the same block set from the same
  `ConversationViewer` (`[User]` / `[Assistant]` / `✻` / `───` / `▍` pinned;
  renderer-owned chrome pinned by shape, not bytes).
- **Roster**: windowing, counter truncation, the glyph set, and live
  regrouping pins.
- **Preview**: R's right pane renders the selected subagent's log in the SL
  grammar (a run row renders its overview), closed by the `⏎` hint.
- **Size ladder**: the 40×10 refusal, 40–59 stacked and ≥ 60 two-pane
  boundaries trigger exactly at the table above; resize up restores in
  reverse order with state preserved.
- **Per-row keys**: `p`/`c`/`x`/`l`/`⏎` dispatch per row kind; `s` only on
  run rows; `x` is armed two-press.
- **All prior capability**: subagent pause/resume/copy, workflow log keys,
  filters, resize levels.
