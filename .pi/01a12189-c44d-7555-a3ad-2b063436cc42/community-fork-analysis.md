# Community fork (`mt-code/pi-subagents-community`) — merge analysis

**Divergence point:** both forks branch from upstream `e955e29` (`fix: stand down for lowercase workflow tools`).
Local has 16 own commits (fullscreen agent hub, two-pane panel, mouse wheel, pi tool renderers, pause/resume).
Community has 10 commits.

**Also relevant:** local `master` is **behind upstream** (`tintinweb/pi-subagents`) by 6 commits — merging upstream brings **pi 1.1.0 support** and 5 fixes, and merges cleanly except CHANGELOG/package.json/lock.

## Community commits — verdicts

| Commit | What it does | Already here? | Verdict |
|---|---|---|---|
| `8276e8e` typebox → peerDependencies | port of upstream #367 | ✅ yes — local `8d790fe` is the same fix | **Skip** |
| `f810458` release v0.20.0 | renames pkg to `pi-subagents-community`, media swap | — | **Skip** (fork-specific) |
| `af4c8bd` pi ≥1.0.0 support | −2597 lines pre-1.0 code | ❌ (local on pi 0.84) | **Skip** — superseded by upstream `25eb4fa` (pi **1.1.0** support, merges cleanly) |
| `87f05ab` inherit parent thinking level | `options.thinkingLevel ?? agentConfig?.thinking ?? ctx.thinkingLevel` in [agent-runner.ts](file:///home/hati/workspace/pi-subagents/src/agent-runner.ts#L837) + test | ❌ missing (upstream doesn't have it either) | **Cherry-pick** — applies cleanly |
| `265fe99` load `dist/index.js` not `src/index.ts` | `pi.extensions` entry + `prepare` build script | ❌ missing (local still boots via src transpile) | **Manual apply** (2-line pkg change; their pkg.json diverged) |
| `20d09cc` `subagents:usage` per assistant message + `subagents:disposed` at shutdown | live per-message usage events in [index.ts](file:///home/hati/workspace/pi-subagents/src/index.ts#L660) + tests | ❌ missing (upstream PR #377 not merged yet) | **Cherry-pick** — preconditions (`toReportedUsage`, `record.invocation`, `requestedThinking`) all exist locally |
| `09cc7b3` load pi built-in codemode/tool-search/MCP extensions in subagents | `PI_BUILTIN_EXTENSIONS` via `extensionFactories` in agent-runner + `projectTrusted` in mention-clone + tests | ❌ missing (upstream lacks it) | **Cherry-pick AFTER pi 1.1.0 merge** — needs `createCodemodeExtension`/`createMcpExtension`/`createToolSearchExtension` (absent in pi 0.84.2) |
| `e55f1ae` fullscreen TUI observer | rewrites viewer around pi's fullscreen renderer | ⚠️ local has its **own** fullscreen agent hub (`agent-hub.ts`) — different architecture | **Skip** (conflicts with local hub; ideas only) |
| `2dc1be9` live tool output in viewer | streams partial tool output while running; adds `tool-block.ts` | ◑ partially — local renders finished calls/results with pi's renderers + "○ awaiting result" placeholder | **Manual, optional** — adapt idea to local viewer |
| `05381dc` stream thinking/assistant text | renders `session.state.streamingMessage` live + viewer caching | ❌ missing — local viewer only renders completed `session.messages` | **Manual adapt** — small targeted change to local `buildContentLines()` |

## Recommended sequence

1. **Merge `upstream/master`** → pi 1.1.0 support (subsumes `af4c8bd`), plus #339 (`isolated` in workflow spawns), #374, #351, stale-isError fix. Conflicts limited to CHANGELOG/package.json/package-lock.
2. **Cherry-pick `87f05ab`** (thinking inheritance).
3. **Cherry-pick `20d09cc`** (usage/disposed events).
4. **Cherry-pick `09cc7b3`** (built-in extensions) — only after step 1.
5. **Manually apply `265fe99`** (dist entry + prepare script).
6. **Manually adapt `05381dc`** core idea: include `session.state.streamingMessage` in the local viewer's message list (+ periodic refresh). Optionally adapt `2dc1be9`'s live tool output.
7. Skip `8276e8e`, `f810458`, `e55f1ae`.

Net: 1 merge + 3 cherry-picks + 1–2 manual ports. No fork-only commits lost.
