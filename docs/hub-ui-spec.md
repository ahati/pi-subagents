# Hub UI Spec — the unified Agents & Workflows window

This document is the design contract for the unified hub window: one popup that
shows subagents and workflow runs together, grouped, rendered entirely through
the shared window-layout module. Audience: contributors changing
`src/ui/agent-hub.ts`, `src/ui/workflow-dialog.ts`, or `src/ui/window-frame.ts`.

Status: **spec**. The implementation may land in phases (common layout → grouped
roster → unified window); where code and this spec disagree, either the code is
behind (keep working) or a deliberate deviation was accepted (update this file
in the same change). All frames are drawn at 120 columns; `f` maximized twins
redraw the same pages at terminal size.

**Implementation status.** Landed: the shared window component
(`src/ui/window-frame.ts`) and the grouped-page **R** roster
(`src/ui/agent-hub.ts` — `SUBAGENTS` by lifecycle, then `WORKFLOWS` with
run-state glyphs and `done/total agents`, headers non-selectable). Handed off:
right-pane routing for a workflow selection (**W**, **WA**, **SAL**, **L**),
entry-point consolidation onto this window, per-row key dispatch, the status
strip, the minimum-size ladder, and the transcript block grammar in T/WA.

## Pane invariant (the one rule that decides every layout)

**The left pane is always the parent level; the right pane is always the
selected item's detail.** The more detailed a view is — transcript, diff,
event log — the further right it lives. Navigating deeper never moves detail
to the left; it changes what the right pane shows and demotes the previous
view into the left pane (it becomes the parent context). Concretely:

| Page | Left pane (parent level) | Right pane (detail) |
|---|---|---|
| **R** — roster | grouped roster (subagents + workflows) | selected item's live preview |
| **T** — subagent transcript | grouped roster, selection pinned | full conversation (user / thinking / assistant / tool-calls / diffs) |
| **SL** — subagent log | grouped roster, selection pinned | the subagent's event log |
| **W** — workflow run | grouped roster, selection pinned | the run's phases + agents |
| **WA** — a workflow's agent | the run's agent list (+ phases) | that agent's full conversation |
| **SAL** — workflow-agent log | the run's agent list | that agent's event log |
| **L** — run log | the run's phases + agents | the run's event log |

`window-frame.ts` owns every layout mechanic (box glyphs, edges and tees, pane
split arithmetic, row/column formatting, list centering and clamping,
selection drawing, the status strip, footer assembly). Surfaces contribute
only groups, rows, pane bodies, key tables, and callbacks. Acceptance rule: no
layout arithmetic in a surface module — a surface needing new layout behavior
extends the shared module.

## The window has pages, not windows

There is exactly one window. What used to be separate popups (agent roster,
workflow inspector, transcript, log) are **pages** inside it. A page =
(left pane = parent level, right pane = detail, breadcrumb title, status
strip, bottom controls). `⏎` descends, `esc` ascends exactly one level. Every
page has a maximized twin (`f`) that differs only in frame size.

| Page | Reached by | Bottom controls |
|---|---|---|
| **R** — roster, subagent selected | hub open; `esc` from T | `↑↓ select · ⇥ pane · ⏎ transcript · l log · p pause · c copy · f full · esc close` |
| **R** — roster, workflow selected | `↑↓` onto a workflow row | `↑↓ select · ⇥ pane · ⏎ open run · s stop run · c copy · f full · esc close` |
| **T** — subagent transcript | `⏎` on a subagent row | `↑↓ scroll · o expand · l log · p pause · r resume · c copy · k stop · f full · esc roster` |
| **TD** — expanded tool-call | `o` / `ctrl+o` on a tool-call in T or WA | as T, with `o collapse` and `c copy diff` |
| **SL** — subagent log | `l` in T — or `l` straight on a subagent row in R | `↑↓ scroll · c copy tail · p pause agent · f full · esc back` |
| **W** — workflow run | `⏎` on a workflow row | `↑↓ item · ⏎ agent · l run log · s stop run · f full · esc roster` |
| **WA** — agent inside a workflow | `⏎` on an agent row in W (nested) | `p pause · r resume · o expand · c copy · l log · k stop · f full · esc back` |
| **SAL** — workflow-agent log | `l` in WA (nested, level 3) | `↑↓ scroll · c copy tail · p pause agent · f full · esc back` |
| **L** — run log | `l` in W | `↑↓ scroll · c copy tail · s stop run · f full · esc back` |

## Transcript block grammar (right pane of T and WA; collapsed preview in R)

| Block | Marker | Rendering |
|---|---|---|
| user message | `user` | the prompt / steering text, wrapped at the pane width |
| thinking | `▝` | dim; collapsed to 2 lines with `…` unless focused |
| assistant | `●` | normal text; wrapped |
| tool-call | `⚙` | one collapsed line: tool, subject, result summary (`→ 42 lines`, `+9 −4`, `12 passing`); `⊕` marks rich output available |
| diff view | `┌── diff` | expanded edit/write: `@@` hunk header plus `−`/`+` lines, boxed; opened by `o`/`ctrl+o` (the existing `app.tools.expand`) |
| streaming | `▍` | the in-flight call's live tail |

Expand state is per tool-call and persists while the page is open; a settled
agent's transcript renders the same blocks frozen.

## Page R — roster (both selection types, all row types)

### R1 — subagent selected (live transcript preview, collapsed grammar)

```
╭─ Agents & Workflows ────────────────────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │ @explore                                                   │
│  ❯ ● explore    Find flaky tests              12s       │ ● running · 12s · turn 2                                   │
│    ● audit      Audit the auth flow           48s       │────────────────────────────────────────────────            │
│    ⋯ web-crawl  Crawl the release notes         —       │ user  Find and fix the flaky tests in test/.               │
│    ‖ refactor   Refactor the parser        parked       │ ▝ thinking  Failures vanish in isolation…                  │
│    ✓ docs-gen   Draft the README           done 2m      │ ● assistant  The e2e helpers reuse one temp root.          │
│    ✗ crawl-old  Crawl legacy notes          failed      │ ⚙ bash  pnpm vitest run test/e2e -t flaky                  │
│  ◌ old-explorer (evicted — ⇋ revive)            —       │   ▍12 passing, 3 unstable                                  │
│ WORKFLOWS                                               │ ⚙ read  test/e2e/helpers/boot.ts → 88 lines                │
│    ● migrate-v2  3/5 agents · phase 2           1m      │ ⚙ edit  test/e2e/helpers/boot.ts  +9 −4     ⊕              │
│    ‖ nightly     paused at phase 1          parked      │ ▍bash  pnpm vitest run test/e2e (verifying…)               │
│    ✓ batch-docs  completed · 12 agents          14m     │ (live tail — ⏎ opens the full transcript)                  │
│    ✗ old-migrate failed at phase 3            failed    │                                                            │
│❞ bash: pnpm vitest run test/x — 12 passing, 3 unstable  │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ select · ⇥ pane · ⏎ transcript · l log · p pause · c copy│
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

Row types: running (`●`), queued (`⋯`), paused (`‖`), completed (`✓`),
failed (`✗`), evicted (`◌`, `⇋` revive). Workflow rows reuse the same glyph set
for the run state. The cursor `❯` crosses group headers seamlessly; the roster
window centers on the cursor and clamps at both ends.

### R2 — workflow selected (run overview in the right pane)

```
╭─ Agents & Workflows ────────────────────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │ migrate-v2                                                 │
│  ❯ ● explore    Find flaky tests              12s       │ ● running · 1m · phase 2 of 4                              │
│    ● audit      Audit the auth flow           48s       │ ▰▰▰▰▰▰▱▱▱▱ 3/5 agents                                      │
│    ⋯ web-crawl  Crawl the release notes         —       │────────────────────────────────────────────────            │
│    ‖ refactor   Refactor the parser        parked       │ PHASES                                                     │
│    ✓ docs-gen   Draft the README           done 2m      │ ✓ discover   3 agents · done                               │
│    ✗ crawl-old  Crawl legacy notes          failed      │ ❯ migrate    2 agents · running                            │
│  ◌ old-explorer (evicted — ⇋ revive)            —       │   verify     —  · waiting                                  │
│ WORKFLOWS                                               │   report     —  · waiting                                  │
│    ● migrate-v2  3/5 agents · phase 2           1m      │ (⏎ opens the run page)                                     │
│    ‖ nightly     paused at phase 1          parked      │                                                            │
│    ✓ batch-docs  completed · 12 agents          14m     │                                                            │
│    ✗ old-migrate failed at phase 3            failed    │                                                            │
│❞ m-2: editing api.ts, reading schema.sql…               │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ select · ⇥ pane · ⏎ open run · s stop run · c copy · f fu│
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page T — subagent transcript (nested level 1)

Left: the roster stays, selection pinned. Right: the full conversation in the
block grammar above.

```
╭─ Agents & Workflows › explore ──────────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │ user  Find and fix the flaky tests in test/. Start         │
│  ❯ ● explore    Find flaky tests              12s       │       from test/e2e and verify with pnpm.                  │
│    ● audit      Audit the auth flow           48s       │ ▝ thinking  Three tests share one temp dir — the           │
│    ⋯ web-crawl  Crawl the release notes         —       │ ▝           failures vanish in isolation. Confirm          │
│    ‖ refactor   Refactor the parser        parked       │ ▝           with a solo run, then fix the fixture.         │
│    ✓ docs-gen   Draft the README           done 2m      │ ● assistant  The e2e helpers reuse one mkdtemp root.       │
│    ✗ crawl-old  Crawl legacy notes          failed      │   I'll prove it with a solo run, then scope the            │
│  ◌ old-explorer (evicted — ⇋ revive)            —       │   temp dir per worker.                                     │
│ WORKFLOWS                                               │ ⚙ bash  pnpm vitest run test/e2e -t flaky                  │
│    ● migrate-v2  3/5 agents · phase 2           1m      │   ▍12 passing, 3 unstable — reruns confirm                 │
│    ‖ nightly     paused at phase 1          parked      │ ⚙ read  test/e2e/helpers/boot.ts → 88 lines                │
│    ✓ batch-docs  completed · 12 agents          14m     │ ⚙ edit  test/e2e/helpers/boot.ts  +9 −4        ⊕           │
│    ✗ old-migrate failed at phase 3            failed    │       − const dir = mkdtempSync(tmpdir())                  │
│                                                         │       + const dir = mkdtempSync(join(tmp, name))           │
│                                                         │       + process.env.VITEST_WORKER = name                   │
│                                                         │ ▍bash  pnpm vitest run test/e2e  (verifying…)              │
│❞ bash: pnpm vitest run test/x — 12 passing, 3 unstable  │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ scroll · o expand · l log · p pause · r resume · c copy ·│
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page TD — expanded tool-call (diff view)

`o`/`ctrl+o` on the `edit` tool-call opens its full diff in the right pane; the
left roster does not move.

```
╭─ Agents & Workflows › explore ──────────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │   (earlier blocks scroll up — identical)                   │
│  ❯ ● explore    Find flaky tests              12s       │ ⚙ edit  test/e2e/helpers/boot.ts  +9 −4   expanded         │
│    ● audit      Audit the auth flow           48s       │ ┌── diff ─────────────────────────────────                 │
│    ⋯ web-crawl  Crawl the release notes         —       │ │ @@ -12,7 +12,10 @@ export function boot()                │
│    ‖ refactor   Refactor the parser        parked       │ │− const root = mkdtempSync(tmpdir())                      │
│    ✓ docs-gen   Draft the README           done 2m      │ │− const cwd  = join(root, "proj")                         │
│    ✗ crawl-old  Crawl legacy notes          failed      │ │+ const root = mkdtempSync(join(tmpdir(), name))          │
│  ◌ old-explorer (evicted — ⇋ revive)            —       │ │+ process.env.VITEST_WORKER = name                        │
│ WORKFLOWS                                               │ │+ return { root, cwd }                                    │
│    ● migrate-v2  3/5 agents · phase 2           1m      │ └─────────────────────────────────────────                 │
│    ‖ nightly     paused at phase 1          parked      │ ▍bash  pnpm vitest run test/e2e  (verifying…)              │
│    ✓ batch-docs  completed · 12 agents          14m     │                                                            │
│    ✗ old-migrate failed at phase 3            failed    │                                                            │
│❞ bash: pnpm vitest run test/x — 12 passing, 3 unstable  │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ scroll · o collapse · l log · p pause · r resume · c copy│
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page SL — subagent log (nested level 2)

`l` from T — or `l` directly on a roster subagent row (skipping T). The event
log is the compact, timestamped companion to the transcript: spawns, turn
starts, tool results, steering notes, completion with tokens/cost.

```
╭─ Agents & Workflows › explore › log ────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │ 12:01:02 spawn  explore · model haiku · background         │
│  ❯ ● explore    Find flaky tests              12s       │ 12:01:03 turn 1 start                                      │
│    ● audit      Audit the auth flow           48s       │ 12:01:04 tool   read README.md → 42 lines                  │
│    ⋯ web-crawl  Crawl the release notes         —       │ 12:01:06 tool   bash: grep -rn flaky test/ → 3 hits        │
│    ‖ refactor   Refactor the parser        parked       │ 12:01:20 turn 2 start                                      │
│    ✓ docs-gen   Draft the README           done 2m      │ 12:01:21 note   steering: focus on test/e2e                │
│    ✗ crawl-old  Crawl legacy notes          failed      │ 12:01:40 tool   bash: pnpm vitest run test/x → 12 pass     │
│  ◌ old-explorer (evicted — ⇋ revive)            —       │ 12:01:41 still running — 3 unstable detected               │
│ WORKFLOWS                                               │ (filter: all · wheel scrolls · /text filters)              │
│    ● migrate-v2  3/5 agents · phase 2           1m      │                                                            │
│    ‖ nightly     paused at phase 1          parked      │                                                            │
│    ✓ batch-docs  completed · 12 agents          14m     │                                                            │
│    ✗ old-migrate failed at phase 3            failed    │                                                            │
│❞ bash: pnpm vitest run test/x — 12 passing, 3 unstable  │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ scroll · c copy tail · p pause agent · f full · esc back │
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page W — workflow run (nested level 1)

Left: the roster, selection pinned to the run. Right: phases and the run's
agents — the level the next `⏎` descends into.

```
╭─ Agents & Workflows › migrate-v2 ───────────────────────┬────────────────────────────────────────────────────────────╮
│ SUBAGENTS                                               │ PHASES                                                     │
│  ● explore    Find flaky tests              12s         │ ✓ discover   3 agents · done                               │
│  ● audit      Audit the auth flow           48s         │ ❯ migrate    2 agents · running                            │
│  ⋯ web-crawl  Crawl the release notes         —         │   verify     —  · waiting                                  │
│  ‖ refactor   Refactor the parser        parked         │   report     —  · waiting                                  │
│  ✓ docs-gen   Draft the README           done 2m        │────────────────────────────────────────────────            │
│ WORKFLOWS                                               │ RUN AGENTS                                                 │
│  ❯ ● migrate-v2  3/5 agents · phase 2         1m        │ ❯ ● m-1   schema tables             40s                    │
│    ‖ nightly     paused at phase 1        parked        │   ● m-2   api endpoints             32s                    │
│    ✓ batch-docs  completed · 12 agents       14m        │   ✓ m-3   seed data                done                    │
│                                                         │   ⋯ m-4   verify queries           queued                  │
│ (roster stays — the run opens at the right)             │   ⋯ m-5   write report             queued                  │
│                                                         │ (⏎ on an agent opens its transcript at the right)          │
│❞ m-2: editing api.ts, reading schema.sql…               │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ item · ⏎ agent · l run log · s stop run · f full · esc ro│
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page WA — a workflow's agent (nested level 2)

Left: the run's agent list (now the parent level). Right: that agent's full
conversation. `↑↓` in the left list switches agents in place.

```
╭─ Agents & Workflows › migrate-v2 › m-1 ─────────────────┬────────────────────────────────────────────────────────────╮
│ migrate-v2 · run agents                                 │ user  Migrate the schema in db.ts to the v2                │
│ ❯ ● m-1   schema tables             40s                 │       format. Keep the public API stable.                  │
│   ● m-2   api endpoints             32s                 │ ▝ thinking  The v1 tables are created in init();           │
│   ✓ m-3   seed data                done                 │ ▝           migrate needs a dual-write shim.               │
│   ⋯ m-4   verify queries           queued               │ ● assistant  Adding a dual-write shim around init().       │
│   ⋯ m-5   write report             queued               │ ⚙ edit  src/db.ts  +42 −6                      ⊕           │
│                                                         │       − db.createTable("v1_rows")                          │
│ PHASES                                                  │       + db.createTable("v2_rows", { ifNotExists: true })   │
│ ✓ discover   done                                       │       + db.onWrite("v1_rows", mirrorToV2)                  │
│ ❯ migrate    running                                    │ ⚙ bash  pnpm test db                                       │
│                                                         │   ▍12 passing                                              │
│ (parent level — esc returns to the run page;            │                                                            │
│  ↑↓ switches agents in place)                           │                                                            │
│❞ bash: pnpm test — 12 passing                           │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │p pause · r resume · o expand · c copy · l log · k stop · f │
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page SAL — a workflow agent's log (nested level 3)

```
╭─ Agents & Workflows › migrate-v2 › m-1 › log ───────────┬────────────────────────────────────────────────────────────╮
│ migrate-v2 · run agents                                 │ 12:02:11 spawn  m-1 (migrate) · parent run migrate-v2      │
│ ❯ ● m-1   schema tables             40s                 │ 12:02:12 turn 1 start                                      │
│   ● m-2   api endpoints             32s                 │ 12:02:13 tool   read schema.sql → 88 lines                 │
│   ✓ m-3   seed data                done                 │ 12:02:30 tool   edit db.ts +42 −6                          │
│   ⋯ m-4   verify queries           queued               │ 12:02:44 turn 2 start                                      │
│   ⋯ m-5   write report             queued               │ 12:02:45 tool   bash: pnpm test → 12 passing               │
│                                                         │ 12:02:46 still running                                     │
│ PHASES                                                  │ (filter: all)                                              │
│ ✓ discover   done                                       │                                                            │
│ ❯ migrate    running                                    │                                                            │
│                                                         │                                                            │
│ (parent level — esc returns to the run page;            │                                                            │
│  ↑↓ switches agents in place)                           │                                                            │
│❞ bash: pnpm test — 12 passing                           │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ scroll · c copy tail · p pause agent · f full · esc back │
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Page L — run log (nested level 2 from W)

Left: the run's phases + agents. Right: the run's event log.

```
╭─ Agents & Workflows › migrate-v2 › log ─────────────────┬────────────────────────────────────────────────────────────╮
│ migrate-v2 · phases & agents                            │ 12:01:18 run start: 5 agents, 4 phases                     │
│ ✓ discover   3 agents · done                            │ 12:01:19 m-1 spawned (discover)                            │
│ ❯ migrate    2 agents · running                         │ 12:01:33 m-1 done — 3 tables found                         │
│   verify     —  · waiting                               │ 12:01:34 m-2 spawned (migrate)                             │
│   report     —  · waiting                               │ 12:02:02 m-2: edit api.ts +120 −14                         │
│                                                         │ 12:02:10 m-3 done — seeds applied                          │
│ ❯ ● m-1   schema tables       40s                       │ 12:02:11 phase 2 still running — 2 agents in flight        │
│   ● m-2   api endpoints       32s                       │ (filter: all)                                              │
│   ✓ m-3   seed data          done                       │                                                            │
│   ⋯ m-4   verify queries   queued                       │                                                            │
│   ⋯ m-5   write report     queued                       │                                                            │
│                                                         │                                                            │
│ (parent level — esc returns to the run page)            │                                                            │
│❞ m-2: editing api.ts, reading schema.sql…               │                                                            │
│                                                         │                                                            │
├─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┤
│                                                         │↑↓ scroll · c copy tail · s stop run · f full · esc back    │
╰─────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────╯
```

## Transition map

```
 R (subagent sel) ──⏎──> T ──o──> TD (in place) ──o──> T ──l──> SL ──esc──> T ──esc──> R
 R (subagent sel) ──l──────────────> SL (skips T) ──esc──> R
 R (workflow sel) ──⏎──> W ──⏎ on agent──> WA ──l──> SAL ──esc──> WA ──esc──> W
                W ──l──> L ──esc──> W
 any page ──f──> maximized twin ──f──> back        (frame size only)
 any page ──⇥──> roster ⇄ right-pane focus
 roster ──↑/↓──> cursor crosses group headers; right pane + status strip follow
 /agents menu ── "Agent hub" ──> R
 SubagentWorkflow tool ── open ──> R, cursor on that run's row
 legacy workflow-dialog entry points ──> same window, focused (adapter)
```

`esc` always ascends exactly one nesting level; the breadcrumb title shows the
trail (`Agents & Workflows › migrate-v2 › m-1 › log`). Maximum nesting depth is
3 (roster → run → agent → log). `o`/`ctrl+o` expands in place — it never
creates a page.

## The status strip (last agent output)

The full-width row directly above the footer separator shows — for the focused
item — the SAME string the extension already renders as the agent widget's
activity subtext (`describeActivity` in `src/ui/agent-widget.ts`):

1. active tools, grouped — `editing 2 files, searching…`
2. else the latest streamed response line, truncated
3. else `thinking…`

prefixed with `❞`, truncated with `…` at the window edge, refreshed on the same
tick as the roster. On workflow pages it follows the run's most recently active
agent. It exists on every page and is the first thing dropped when height is
scarce.

## Minimum parent window size

The parent terminal gates the window before it opens. The existing
`TWO_PANE_MIN_WIDTH` (60) stays the two-pane gate.

| Terminal | Behavior |
|---|---|
| ≥ 100 cols · ≥ 16 rows | Full spec layout: two panes, status strip, full footer |
| 60–99 cols | Two panes survive; roster summaries, transcript wraps, and the status strip truncate with `…` first, then age columns drop; footer fitter drops whole hints from the right |
| 40–59 cols | **Single-pane stacked mode**: the roster takes the full width; `⏎` pushes the right pane's content as a full-width page (breadcrumb + `esc` pops). Status strip hidden; diffs wrap at the pane edge |
| < 40 cols or < 10 rows | The window refuses to open: `ctx.ui.notify("Agent hub needs a terminal ≥ 40×10")` — no partial frame is drawn |
| height 10–15 (any width) | Status strip hidden first, then the blank separator row; group headers collapse to inline rules; expanded diffs keep their box, older hunks scroll |
| height ≥ 16 | Status strip always rendered |

Degradation is by section, in this order: status strip → blank row → roster
summary column → age column → two-pane (→ stacked). Escalation back up is
automatic on resize; selection, scroll, page, and per-tool-call expand state
are preserved through every resize.

## Bottom controls per page and popup size

Bottom controls belong to the PAGE, not to the popup size: restored and
maximized (`f`) twins show the identical footer at their respective widths.
The per-page footers are the ones in the page table and frames above; the
shared fitter drops whole hints from the right when the width cannot fit them
(never clamping mid-hint), so the `f`/`c`/`esc` anchors survive first.

## Live regrouping

- A subagent settles → its row regroups in place (`● running` → `✓ done`).
- A workflow parks (global `/pause`) → its row renders `‖` in `WORKFLOWS`; the
  agents it owns render `‖` in `SUBAGENTS` (and as `‖` rows inside W).
- A workflow completes → `✓ name · completed · N agents`.
- Revive/resume moves rows back exactly as the lifecycle grouping dictates.
  Nothing in the roster is hand-sorted; grouping is derived.

## Refusal rules (unchanged)

Foreground agents a caller blocks on, worktree-isolated runs, and agents owned
by another agent or a workflow refuse to pause; workflow rows expose only
actions safe for their run state. Labels and available actions may differ per
row type — the window may not.

## Tests that hold this together

- Byte pins: the shared chrome (top/bottom bars, pane-split columns, status
  strip, footer row shape) renders identically for the hub and the dialog at
  equal widths — parity tests fail if a surface drifts.
- Pane invariant: every page's left pane shows the parent level and its right
  pane shows the detail — pinned per page; a detail view on the left fails.
- Page invariants: every page renders its stated footer and status strip; `esc`
  pops exactly one nesting level; the breadcrumb title matches the page trail.
- Transcript grammar: T and WA render the same block set (user / thinking /
  assistant / tool-call / diff / streaming) from the same renderer; collapsed
  vs expanded (`o`) states are pinned per tool-call.
- Size ladder: two-pane/stacked/refuse boundaries trigger exactly at the table
  above; resize up restores the hidden sections in reverse order.
- Surface purity: no layout arithmetic in surface modules (enforced by review;
  the pins make silent duplication visible).
- All prior capability: subagent pause/resume/revive/copy, workflow log keys
  (wheel, f, c, p), filters, resize levels.
