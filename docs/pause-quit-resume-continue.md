# Pause, quit, resume, continue

Status: implemented. This document specifies the behaviour of the
global `/pause` and `/continue` pair after the redesign, the mechanics that make it
possible inside the extension (no upstream pi changes), the per-file change plan, and
the test plan. File:line citations refer to `@earendil-works/pi-coding-agent@1.1.0`
and `@earendil-works/pi-agent-core@1.1.0` as installed in this repo.

Audience: maintainers of this extension. Read together with `README.md`
("Pause and resume") which documents today's behaviour.

---

## 1. The contract

- `/pause` parks the agentic execution: the main agent's current turn **and** every
  active top-level subagent. Nothing in flight is killed; the turn is suspended at a
  resumable boundary.
- A turn is suspended **before the first not-yet-executed tool call**, or — if tools
  of the current message are already executing — after they finish and **before the
  next model request**. A tool that was already running when `/pause` landed runs to
  completion and its output is persisted in the session ("cached"); it is never
  re-executed.
- `/continue` is purely mechanical: it reopens the gates. Pending tool calls execute,
  their results are appended, and the next model request goes out as a **bare
  continuation** — the transcript as it stands, with **no new prompt of any kind**.
  No synthetic "Continue…", no held-input replay, no subagent continuation prompt.
- The pair works across a process restart: `/pause`, quit, pi's native `/resume`,
  then `/continue` restores the subagents and continues the parked main turn
  (executing its pending tool calls first). Provider prompt-cache misses after long
  inactivity are accepted.

Out of scope / unchanged: per-agent refusals (foreground, worktree-isolated), the
`/agents` menu, fleet/hub keys' *targets* (they change mechanism, not surface), and
`/agents revive` semantics beyond the prompt it sends.

## 2. States

| State | Who | Meaning |
|---|---|---|
| streaming | main | normal run |
| armed | main | `/pause` typed while streaming; gates armed; nothing parked yet; a second `/pause` disarms |
| parked | main + subagents | gates closed; runs suspended (alive, in-memory); manifest written |
| resumed | main + subagents | `/continue` opened the gates; runs continue bare; manifest cleared |

Subagents have the same armed/parked lifecycle per record. A **queued** (never
started) subagent does not gate: it is spliced out of the queue and re-enters with
its original prompt — unchanged from today (`src/agent-manager.ts:1485-1522`).

## 3. Behaviour

### 3.1 `/pause` while the main agent is idle

Parks every active top-level subagent by closing its gate (today: aborts — this
changes, see §5.2) and writes the manifest. No main-turn state: the main agent has
nothing in flight.

### 3.2 `/pause` while the main agent streams

1. Arm. Toast: pausing when the turn reaches its next boundary. Subagents keep
   running until the boundary — one consistent landing point.
2. The park lands at the **first** of:
   - a `tool_call` extension event with the gate closed — the batch is suspended
     before any call executes. Verified: sequential mode awaits `beforeToolCall` per
     call (`pi-agent-core/dist/agent-loop.js:494`); parallel mode prepares all calls
     up front and suspends the whole batch (`agent-loop.js:413-453`). Siblings never
     start.
   - `turn_end` — fires after the assistant message *and its tool results* are
     persisted; suspends before the loop's continue decision, steering drain,
     compaction, and next request (`agent-loop.js:179-186`,
     `pi-coding-agent/dist/core/agent-session.js:522-534`).
   A tool already executing when `/pause` landed finishes; its `toolResult` is
   persisted by the normal path before the gate closes. Pending (unstarted) calls
   stay unanswered — no synthetic results are written.
3. Landing does, in order: disarm → close subagent gates → write the manifest
   (`mainTurn.parked = true`, `pendingTools = n`) → toast.
4. If the turn had no pending calls and the run was ending anyway, the park is
   subagents-only; the main run settles naturally and `/continue` later reports that
   there is nothing to continue on the main side.
5. Esc while armed: the boundary fires for the aborted response; the park still
   lands (subagents + manifest). The main turn is over.
6. Esc while parked: the gates **must** race the run's `AbortSignal` (`ctx.signal`;
   wired at `agent-session.js:2756`, `getSignal: () => this.agent.signal`).
   Releasing on abort produces an honest "Operation aborted" result for the gated
   call (`agent-loop.js:500-507`) and the loop unwinds. The race is mandatory: a
   gate that ignores the signal leaks `session.abort()`'s `waitForIdle()` forever and
   deadlocks `/new`, `/fork`, `/resume`, `switchSession` and `compact()`
   (`agent-session.js:1909-1926`, `agent-session-runtime.js:102-111`).
7. `/quit` while parked: `dispose()` aborts without waiting and exits — no flush, no
   healing (`agent-session.js:992-1005`, `interactive-mode.js:3506-3511`). The
   transcript keeps the parked shape on disk (`assistant(tool_use…)` with only the
   executed calls answered), which is exactly the input the restart flow needs. The
   manifest survives (already on disk; the quit-time `abortAll()` settle rewrites
   entries but must preserve `mainTurn`, see §7).

### 3.3 `/continue` in-session

Opens the gates. The suspended run resumes inside pi's normal loop: the pending tool
calls execute, results persist, the next request is built by pi's own projection
(`agent-session.js:434-449`) — a bare continuation. Subagent gates open the same
way; queued agents re-enter. The manifest is cleared. `/continue` itself sends
nothing: no `sendUserMessage`, no `sendMessage`, no prompt argument anywhere.

Input typed while armed or parked follows pi's native steer/follow-up queueing; the
queues drain only after the gates resolve (`agent-loop.js:186,194`), so ordering is
automatically correct. Such input does not survive quit (pi-native behaviour for any
queued input).

### 3.4 Quit, `/resume`, `/continue` — the restart flow

1. After `/resume`, pi holds a live idle session whose transcript ends with the
   parked shape. The manifest is found: the session id comes from the file header,
   so `/resume` and `--resume` land on the same id
   (`session-manager.js:721-726`); `/fork` and `/new` mint new ids and correctly
   find nothing. `session_start` shows the extended hint ("main turn parked with N
   pending tool calls — /continue").
2. `/continue` revives the subagents (§3.5) **after** the main-turn continuation
   (ordering matters, §6.4), then continues the main turn with the **M1 shadow
   continuation** (§6): the extension opens the same session file in its own
   `SessionManager`, executes the pending calls through the real tool pipeline,
   appends their results, runs a bare `agent.continue()` to let the turn finish, and
   finally calls `ctx.switchSession(<same file>)` so the live UI re-reads the file
   and displays the continued turn.
3. `/continue` post-restart never sends a prompt either. Pending calls that cannot
   execute (unknown tool, extension tool whose session resources were never started,
   permission gate without UI) resolve to honest `isError` results and the model
   re-plans — that is the degradation path, not a prompt.

### 3.5 Subagents — same mechanism, all surfaces

- Pause closes the record's gate instead of aborting (`src/agent-manager.ts:1496-1498`
  is replaced). The run suspends at its own `beforeToolCall`/`finishTurn` boundary;
  a tool in flight finishes and is persisted. The record stays exempt from the
  10-minute GC; held time is subtracted from the elapsed clock as today.
- Resume opens the gate — bare, through every existing surface: `/agents resume`,
  `/continue`, `/agents` menu, fleet/hub `p`, RPC `subagents:rpc:resume`. For a
  record with a session that must be reopened in-process, and for `/agents revive`
  after eviction, the runner heals + bare-continues instead of prompting (§6.3).
- `CONTINUATION_PROMPT` is deleted. `@handle <text>` mentions keep sending the
  user-typed text (that is the user's own prompt, not a continuation prompt).
- Foreground and worktree-isolated refusals unchanged.

## 4. Verified mechanics this design stands on

| Fact | Evidence |
|---|---|
| Suspending a `tool_call` handler suspends the whole batch before execution (both modes) | `pi-agent-core/dist/agent-loop.js:374-453, 491-500` |
| Suspending `turn_end` defers the loop decision, steering drain, compaction, next request | `agent-loop.js:179-186`; `agent-session.js:522-534` |
| `ctx.signal` is the live run signal in event handlers | `agent-session.js:2756`; `pi-agent-core/dist/agent.js:214-216` |
| Quit does not heal or flush; parked shape survives on disk | `agent-session.js:992-1005`; persistence is synchronous `appendFileSync` (`session-manager.js:794-817`) |
| Session id survives `/resume`/`--resume` (header id); fork/new mint new ids | `session-manager.js:721-726`, `:1238-1262` |
| `SessionManager.open` on an existing file: `flushed = true`, ids collision-checked, appends chain off the file's last entry | `session-manager.js:665-690, 732-753, 815-838` |
| `appendMessage` → memory + leaf + disk in one call; `generateId` from `randomUUID` | `session-manager.js:827-838, 21-29` |
| Requests are projected from `buildSessionProjection()` at request time | `agent-session.js:434-449`; `refreshContext()` mirrors into agent state (`:571-577, 1016-1018`) |
| `createAgentSession` restores model/thinking/tools from the branch; transcript's leading system message wins; unprompted tool deltas are declared as diff system messages | `core/sdk.js:84-160, 253-260`; `agent-session.js:1267-1310, 1368-1376` |
| Extension runner + `tool_call`/`tool_result` hooks exist on a reopened session without `bindExtensions`; `session_start` (MCP, credentials, UI ctx) does not; `ui.confirm` auto-denies | `agent-session.js:2899-2924`; `extensions/runner.js:132-168, 200-207` |
| `runToolCall(tooCall, { tools, assistantMessage, context, beforeToolCall, afterToolCall, signal })` executes through validation + hooks, emits no events, adds no messages | `pi-agent-core/dist/agent-loop.js:44-56, 559`; exported from the `@earendil-works/pi-agent-core` root |
| `agent.continue()` bare-continues when the last message is user/toolResult; needs `refreshContext()` after appends | `pi-agent-core/dist/agent.js:251-272`; `agent-session.d.ts:387-388` |
| `switchSession(<same file>)` is allowed, re-reads the file, leaf = last physical line, full UI re-render | `agent-session-runtime.js:128-146`; `session-manager.js:736-741`; `interactive-mode.js:369-372, 1688-1697` |
| No built-in approval system; approvals are extension `tool_call` handlers | `docs/security.md:3`; `examples/extensions/permission-gate.ts` |
| No live `AgentSession`/`Agent` handle is exposed to extensions (closures only, no globals) | `core/extensions/loader.js:189-431`; `core/extensions/runner.js:199-206` |

## 5. Change design

### 5.1 `src/pause-store.ts` — manifest v2

```ts
interface PauseStoreData {
  version: 2;
  entries: PausedAgentEntry[];            // unchanged rows
  mainTurn?: {
    parked: boolean;
    pendingTools: number;                 // count; the calls live in the transcript
    cancelled?: boolean;                  // set if closure marked them (not used by default flow)
    claim: { pid: number; at: string };   // multi-window guard for non-idempotent execution
    pausedAt: string;
  };
}
```

- Explicit `getMainTurn()/setMainTurn()` alongside `replace()` — today `replace([])`
  deletes the file (`pause-store.ts:71-75`) and the settle funnel rewrites on every
  settle including quit-time `abortAll()` (`src/index.ts:577-581, 1148`), which would
  silently erase `mainTurn`.
- Manifest lookup falls back to scanning `.pi/subagent-pauses/` for
  `<sessionId>.json` when `ctx.cwd` differs from the session's header cwd.

### 5.2 `src/agent-manager.ts` — gate-based pause

- `pause(id)` stops aborting: it closes a per-record gate `{ promise, release }` and
  marks the record `paused`. The run no longer settles while parked; the concurrency
  slot stays held (a parked run is alive). Settle, GC-exemption, elapsed-clock hold
  and the `subagents:paused` event (`src/index.ts:3003-3022`) are preserved.
- `unpause(id)` (queued agents) unchanged.
- New: `resume(id)` opens the gate. The settle path is untouched — it fires when the
  run eventually completes or is aborted, exactly as today.

### 5.3 `src/agent-runner.ts` — gates on child sessions, bare resume

- Next to the existing `beforeToolCall` wrapper (`agent-runner.ts:340-343`), install
  the record's gate on `session.agent.beforeToolCall` and `session.agent.finishTurn`;
  both race `record.abortController.signal` (mandatory, §3.2.6).
- `resumeAgent` splits: transcript ends user/toolResult → open gate, the original
  run continues; transcript ends `assistant(tool_use)` → same heal-and-continue path
  as §6.3 (in-process variant).
- Revive (`SessionManager.open` + `createAgentSession`) heals unanswered calls
  before continuing (§6.3) and passes no prompt.

### 5.4 `src/index.ts` — arming, main gates, `/continue`, nudges, hint

- `armedPause` state; `/pause` arms/disarms instead of refusing (`pauseAllCommand`).
- `pi.on("tool_call")` + `pi.on("turn_end")`: the main-agent gates. On the first
  boundary after arming: `landPark()` — disarm, close subagent gates, write
  `mainTurn`, toast — then keep the gate closed until `/continue`. Gates race
  `ctx.signal`.
- `continuePausedCommand`: open subagent gates / re-queue / revive; post-restart,
  run §6 in the order main-continuation → `switchSession` → subagent revival inside
  the `withSession` callback (fresh context); clear `mainTurn`.
- Nudge guard: while `mainTurn.parked`, hold `pi.sendMessage(..., triggerTurn)`
  sends (`src/index.ts:475-487, 498-527, 2443-2466`) and flush after `/continue`.
  While the main run is merely parked mid-tool the nudges queue harmlessly (run
  active); the guard covers the settled no-tool park.
- `session_start` hint: main-turn clause.
- New peer dependency: `@earendil-works/pi-agent-core` (`runToolCall` is not
  exported by `pi-coding-agent`; deep imports are blocked by the exports map).

### 5.5 Re-baselined tests

`test/agents-commands.test.ts:186`, `test/pause-continue-wiring.test.ts:297`,
`test/pause-continue-print-mode.e2e.test.ts:132`, `test/agent-pause.test.ts:170` pin
`"Continue from where you left off."` — all four assert the new bare-resume calls.

## 6. The M1 shadow continuation (post-restart main turn)

Why a shadow session: the live `AgentSession` is unreachable (§4, last row), a run
cannot be started without a message, and results cannot be persisted into the live
session from a command handler — but the extension can own a **second**
`SessionManager` + `AgentSession` on the same file, do the work there, and let pi
adopt the file.

Algorithm, in strict order:

1. **Guard.** Manifest `mainTurn.parked`, claim fresh (pid liveness), live session
   idle (`ctx.isIdle()`), no second window. Refusals are toasts, never silent.
2. **Open.** `SessionManager.open(<session file>)`; `createAgentSession` with the
   parent's `agentDir` and a settings manager carrying the live trust state,
   `model` omitted (branch restore; do not pass the live model — restore must
   follow the transcript for cache and correctness), `cwd` from the manager, no
   `tools` allowlist (prefix preservation), and a `DefaultResourceLoader` built
   with `noExtensions`/`noSkills`/`noPromptTemplates`/`noThemes`/`noContextFiles`
   — no `bindExtensions` (see §6.4 hazard 3; skipping discovery outright also
   keeps the shadow cheap and never loads this extension twice).
3. **Heal.** Scan `getBranch()` backwards for the last assistant entry; collect its
   `toolCall` blocks whose ids have no later `toolResult`. For each, execute via
   `runToolCall(toolCall, { tools: session.agent.state.tools, assistantMessage,
   context: { messages: session.agent.state.messages, tools:
   session.agent.state.tools }, beforeToolCall: session.agent.beforeToolCall,
   afterToolCall: session.agent.afterToolCall, signal })` — real validation, real
   hooks, `tool_call`/`tool_result` extension events fire; a permission-gate
   extension auto-denies (fail-closed, honest blocked result). Persist each outcome
   with `manager.appendMessage(createToolResultShape(outcome))` — `role`,
   `toolCallId`, `toolName`, `content`, `usage`, `isError`, `timestamp` — so usage
   accounting and the transcript stay exact. Skip + honest-error any call whose tool
   is not resolvable (extension/MCP tools that need `session_start` resources).
4. **Continue.** `session.refreshContext()` (project the appends into agent state),
   then `await session.agent.continue()` — bare request, turn runs to completion;
   every message it produces is persisted by the shadow session's own
   `message_end` handler (`agent-session.js:754-772`). Await via
   `session.agent.waitForIdle()`. Post-run bookkeeping (auto-compaction, retry,
   `agent_settled`) does not run for this turn — accepted and documented.
5. **Adopt.** `await ctx.switchSession(sessionManager.getSessionFile())`. pi
   re-reads the file (leaf = last physical line = our continued turn), tears the old
   runtime down, re-renders the full transcript including the healed calls and the
   continuation. `session_before_switch`/`session_shutdown` fire; our handlers must
   be switch-aware (hazard 2 below).
6. **Revive.** Inside `switchSession`'s `withSession` callback (fresh context),
   revive the manifest's subagent entries — the ordinary post-restart revive path.
   Clear `mainTurn`, toast the summary.

### 6.4 Hazards and mitigations (all verified)

1. **Two writers on one JSONL.** `_persist` is a bare append; the live session never
   sees foreign lines. Mitigation: the sequence above requires the live session idle;
   the claim field catches a second window; user input during the continuation lands
   as a tree sibling after `switchSession` re-read (fork, not corruption) —
   documented as a user-error case, toasted if detected (file size changed mid-run).
2. **`switchSession` tears the extension down.** `teardownCurrent` emits
   `session_shutdown`, and our handler aborts all agents and clears state
   (`src/index.ts:1124-1150`). Mitigation: subagent revival happens *after* the
   switch (step 6), and the shutdown handler becomes switch-aware (an internal flag
   set for the duration of step 5 makes it skip `abortAll()`/teardown; the flag is
   cleared in `session_start`).
3. **Second extension runner.** Not applicable as built: the shadow loader runs
   with `noExtensions`, so no extension (this one included) is loaded twice.
   Cost: MCP-backed and session-scoped extension tools resolve "not found" → honest
   errors; `ui.confirm` auto-denies → fail-closed blocked results. The model
   re-plans around them; the degraded case is reported in the continuation toast.
4. **`agent.continue()` bypasses `_runAgentPrompt`.** No auto-compaction, no retry,
   no `agent_settled` for the healed turn; `session.isIdle` stays false. Mitigation:
   await via `agent.waitForIdle()`; the turn is bounded (it continues the parked
   turn, it does not start new work); a provider error surfaces as an error result
   in the transcript, visible after adoption.
5. **Model/auth restore.** Omit `model`; pass the parent's `modelRuntime` +
   `agentDir` so `hasConfiguredAuth` sees live credentials (`sdk.js:87-101`).
6. **Stale `_entryIdsByMessage`.** Direct `appendMessage` skips the map filled by
   `_handleAgentEvent` (`agent-session.js:766-767`); boundary lookups fall back to
   branch scans (`:810`) — no action needed, noted for debugging.

## 7. Data and accounting notes

- `pendingTools` is a count only — the calls themselves live in the transcript, and
  `getBranch()` is the source of truth (never `getLeafEntry()`, which is the last
  *appended* entry of any kind; `session-manager.js:1005-1007`).
- Tool `usage` from `runToolCall` outcomes is written onto the persisted
  `toolResult` messages so session stats stay complete (`agent-session.js:3383-3419`
  computes from entries).
- Elapsed-clock hold for parked runs reuses the existing "held time subtracted"
  bookkeeping keyed on gate close/open instead of abort/unpause.

## 8. Test plan (all failing before implementation)

Harness prep: `ctx()` defaults for `isIdle`/`signal`/`abort`/`hasPendingMessages`;
`makePi` gains nothing else — gates are driven via `b.lifecycle.get("tool_call" |
"turn_end")(event, ctx)`; the unresolved-promise gate pattern works as-is
(`runner.js:957-969` awaits handlers).

1. **Arming** — arm instead of refuse (toast, nothing parked, no gate closed);
   second `/pause` disarms; subagents untouched while armed; arm is per-session and
   cleared on `session_before_switch`.
2. **Landing** — `tool_call` gate: batch suspended pre-execution (no
   `tool_execution_start`), `pendingTools` counted; running-tool case: its result
   persisted before the gate; `turn_end` landing with the loop decision deferred;
   aborted-boundary landing; zero-active-subagent park still writes `mainTurn`;
   refusal list preserved.
3. **Gate mechanics** — Esc-while-parked releases via `signal`, writes the aborted
   result, unwinds, subagents stay parked; a gate that ignores the signal is caught
   by an assertion that fake `session.abort()` resolves.
4. **Continue (in-session)** — gates open, pending call executes, **no**
   `session.prompt`/`sendUserMessage` call anywhere, manifest cleared; nothing-to-
   continue reporting; nudge held during park and flushed after.
5. **Subagents** — `/agents pause` closes the gate without `abortController.abort`;
   `p` key, menu, RPC ride the same funnel; every resume surface sends no prompt
   argument; queued agent re-enters with its original prompt; revive path heals
   unanswered calls before `SessionManager.open` and continues bare.
6. **Restart** — manifest v2 round-trip; `replace([])` and the quit-time settle
   rewrite preserve `mainTurn`; session-id fallback finds the manifest under a
   different cwd; M1: claim blocks a live second window; heal executes only
   unanswered calls, persists results with usage, bare-continues (assert the model
   request payload contains no new user message); `switchSession` adoption re-renders
   the healed turn; subagent revival happens post-switch (order assertion);
   unresolvable tools produce honest errors, not prompts.
7. **e2e (print mode)** — park across a real child session; quit; reopen; the
   dangling shape survives on disk verbatim; the four re-baselined bare-resume
   assertions.

## 9. Known limitations (documented in README alongside the feature)

- Post-restart, the main turn continues in a shadow session and is adopted via a
  session switch — the UI shows a "Resumed session" re-render, and any keystrokes
  during the continuation land as a sibling branch after adoption.
- Pending calls to MCP/session-scoped extension tools cannot execute post-restart
  (no `session_start` in the shadow session); they resolve as errors and the model
  re-plans.
- The healed turn skips auto-compaction and retry; a provider error during it
  appears as an error turn in the adopted transcript.
- Input typed while parked is queued pi-natively and does not survive quit.
- Post-abort dangling tool calls (today's behaviour, unchanged for Esc) rely on
  pi's request-time healing if never continued; `/continue` on such a transcript
  uses the same M1 heal path.
