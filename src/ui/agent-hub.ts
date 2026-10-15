/**
 * agent-hub.ts — Full-screen agent hub overlay (oh-my-pi style), pi-subagents-hub data.
 *
 * One full-terminal overlay (`ctx.ui.custom` with `width: "100%"`,
 * `maxHeight: "100%"`), three views:
 *
 * - Table view: every top-level agent of this session plus workflow runs, as
 *   an identity-only roster — cursor, state glyph, name — with a run row's
 *   `done/total` counter flush right. `/` filters, `x` stops (two-press), `Enter`
 *   opens the agent's conversation or the workflow inspector, `1`/`2`/Tab
 *   switch views, `q`/Esc closes the hub.
 * - Activity view: one line per agent describing what it is doing right now.
 * - Chat view: two panes, the workflow inspector's layout — the agent list on
 *   the left (↑/↓ move the selection and the stream follows), the selected
 *   agent's live `ConversationViewer` on the right. The viewer's quit keys come
 *   "back" to the table instead of closing the overlay, so the hub is one
 *   continuous surface: roster → transcript → roster → close.
 *
 * Purely a UI layer over the same runtime the fleet list drives: AgentManager
 * records, the activity tracker, workflow runs. All behavior — steering,
 * stopping, markdown modes, cost display, linger semantics — is unchanged.
 */

import { type Component, Input, matchesKey, type ScrollViewScrollbar, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentRecordName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { buildPhaseGroups, currentPhaseIndex, displayState, elapsedMs, formatDuration, type PhaseGroup, type WorkflowAgentEntry } from "../workflow/progress.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { buildInvocationTags, describeActivity, formatCost, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT, type ViewerBackgroundAction } from "./conversation-viewer.js";
import { copyRecordResult } from "./copy-result.js";
import type { FleetWorkflow } from "./fleet-list.js";
import { disableTerminalMouse, enableTerminalMouse, parseMouseInput } from "./terminal-mouse.js";
import type { ViewerKeybindings } from "./viewer-keys.js";
import {
  type FooterHint,
  footerBand,
  masterPaneGeometry,
  paneGeometry,
  renderWindow,
  TWO_PANE_MIN_WIDTH,
  UNICODE_PANE_BOX,
  type WindowRow,
  windowInnerWidth,
  windowRange,
} from "./window-frame.js";
import type { WorkflowCardLine } from "./workflow-card.js";
import { clampLine } from "./workflow-card.js";
import {
  agentRow,
  phaseListRows,
  UNICODE_DIALOG_GLYPHS,
  type WorkflowDialogSource,
} from "./workflow-dialog.js";

/** How long a settled workflow run lingers in the roster (matches the fleet list). */
const FINISHED_LINGER_MS = 4000;
/** Re-render cadence so elapsed/activity/stats tick while the hub is open. */
const TICK_MS = 200;
/** Roster never renders fewer body rows than this, even on tiny terminals. */
const MIN_BODY_ROWS = 3;

/** Lifecycle group of an agent for the chat pane's list: 0 active, 1 completed, 2 failed. */
function chatGroupRank(status: AgentRecord["status"]): number {
  switch (status) {
    case "running":
    case "queued":
    case "paused":
      return 0;
    case "completed":
    case "steered":
      return 1;
    // error / aborted / stopped — a stopped run has no result, so it groups
    // with the failures rather than implying it finished.
    default:
      return 2;
  }
}

/** Pane labels for the three lifecycle groups, in rank order. */
const CHAT_GROUP_LABELS = ["ACTIVE", "COMPLETED", "FAILED"] as const;

/**
 * The roster's top-level group headers, in display order. The subagents
 * section is one list in stable launch order — a row's identity never moves,
 * so a settling agent cannot reshuffle the roster under the cursor; workflow
 * runs follow as one section, sorted by launch time.
 */
const ROSTER_SUBAGENTS_LABEL = "SUBAGENTS";
const ROSTER_WORKFLOWS_LABEL = "WORKFLOWS";

/**
 * The run-state glyph for a roster workflow row, the same vocabulary the
 * subagent rows use: running `●`, paused `‖`, completed `✓`, failed/killed `✗`.
 */
export function workflowStatusGlyph(status: FleetWorkflow["status"], th: Theme): string {
  switch (status) {
    case "running":
      return th.fg("accent", "●");
    case "paused":
      return th.fg("dim", "‖");
    case "completed":
      return th.fg("success", "✓");
    // failed / killed
    default:
      return th.fg("error", "✗");
  }
}

/** The word a workflow row's status tail uses, one per run state. */
function workflowStatusWord(status: FleetWorkflow["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    // failed / killed
    default:
      return "failed";
  }
}

/** Result of a wheel dispatch — structural subset of pi-tui's mouse types. */
interface HubMouseEvent {
  type: string;
  /** Logical lines; negative scrolls up. */
  wheelDelta?: number;
}

/** The TUI/terminal surface mouse capture needs — structural, version-safe. */
interface MouseTerminalHost {
  mode?: string;
  terminal?: { write?(data: string): void };
}

type HubView = "table" | "activity" | "chat";

/**
 * The window's pages — the spec's one-window model. `R` is the roster; every
 * other page is a nesting level inside the same frame, reached with `⏎` and
 * left with `esc`, each with the previous view demoted into the left pane.
 *
 * `T`/`WA` show a conversation, `SL`/`SAL` an agent's event log, `W` a run's
 * phases and agents and `L` the run's event log. `TD` is deliberately absent:
 * an expanded tool-call is a view state of the page it was opened on, never a
 * page of its own.
 */
type HubPage = "R" | "T" | "SL" | "W" | "WA" | "SAL" | "L";

/** `esc`'s walk back from a page: one level up, never further. */
const PAGE_PARENT: Record<HubPage, HubPage | undefined> = {
  R: undefined,
  T: "R",
  SL: "T",
  W: "R",
  WA: "W",
  SAL: "WA",
  L: "W",
};

/**
 * A page's footer band, as data: the left slot's actions — the readout is
 * computed per render and drops first — and the right slot's hints. The right
 * slot gains the twin toggle (the twin you would get) and the pinned escape
 * anchor, so neither is repeated per page.
 */
interface PageFooterKeys {
  actions: readonly string[];
  hints: readonly string[];
  /** Where `esc` lands, as the band's `Esc <target>` anchor. */
  esc: string;
}

/** The footer's slots, per page — the spec's bottom-controls table, as data. */
const PAGE_KEYS: Record<HubPage, PageFooterKeys> = {
  R: { actions: ["⏎ transcript", "l log", "p pause", "c copy"], hints: ["↑↓ select", "⇥ activity"], esc: "close" },
  T: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j/k scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "roster",
  },
  SL: { actions: ["Enter steer", "x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  W: { actions: [], hints: ["↑↓ item", "⏎ agent", "l run log", "s stop run"], esc: "roster" },
  WA: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j/k scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "back",
  },
  SAL: { actions: ["Enter steer", "x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  L: { actions: ["s stop run"], hints: ["↑↓ scroll", "c copy tail"], esc: "back" },
};

/** **R**'s run-row slots: the selected row type decides what the band offers. */
const R_RUN_KEYS: PageFooterKeys = {
  actions: ["⏎ open run", "s stop run", "c copy"],
  hints: ["↑↓ select", "⇥ activity"],
  esc: "close",
};

/**
 * **TD**'s own actions — the expanded tool-call's pair. It replaces the page's
 * markdown hint with them and drops the `o expand` hint: the call is already
 * expanded, and `o collapse` is what undoes it.
 */
const TD_ACTIONS = ["c copy diff", "o collapse"] as const;
const TD_REPLACED_ACTION = "m md";
const TD_DROPPED_HINT = "o expand";

/** The hub window's refuse/single-pane/two-pane thresholds (spec size ladder). */
const HUB_MIN_WIDTH = 40;
const HUB_MIN_ROWS = 10;
const HUB_FULL_ROWS = 16;
/** The status strip's prefix — `describeActivity`'s output follows it. */
const STATUS_PREFIX = "❞";
/**
 * The window's title: the constant ` Agents & Workflows `, which fills the
 * 20-column master cell exactly. The header block, never the title, names the
 * item the right pane is showing.
 */
const HUB_TITLE = " Agents & Workflows ";
/** How the window refuses a terminal under the ladder. */
export const HUB_SIZE_REFUSAL = "Agent hub needs a terminal ≥ 40×10";

type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type HubEntry = WorkflowEntry | AgentEntry;

/**
 * One roster row: either a non-selectable section header or an entry. Headers
 * take a line but no cursor slot, so `selected` stays an index into the
 * selectable rows while the display list carries the headers.
 */
type HubRosterItem = { kind: "header"; label: string } | HubEntry;

/** Minimal UI surface the hub needs from `ctx.ui` (structural subset). */
export type HubUICtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/** Everything the hub renders from — the same sources the fleet list uses. */
export interface AgentHubDeps {
  manager: Pick<AgentManager, "listAgents" | "abort" | "steer">;
  agentActivity: Map<string, AgentActivity>;
  /** Whether rows show an estimated cost. Captured once at open time. */
  showCost: boolean;
  /** The user's `viewerMarkdown` setting, for the embedded conversation viewer. */
  viewerMarkdown?: () => ViewerMarkdownMode;
  /** Persist a mode chosen with `m` in the viewer. */
  onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
  /** Workflow runs, on the same terms as the fleet list. */
  workflows?: () => readonly FleetWorkflow[];
  /**
   * The run's detail for the hub's run pages (**W**, **WA**, **L**): the same
   * source the workflow inspector reads. Omitted → the run pages have no pane
   * content and say so; the roster still shows the run.
   */
  workflowRun?: (id: string) => WorkflowDialogSource | undefined;
  /** Open the workflow inspector for a run id. The legacy adapter entry point. */
  openWorkflow?: (id: string) => Promise<void> | void;
  /** `s` on a workflow row: stop the run. Omitted → `s` does nothing. */
  stopWorkflow?: (id: string) => void;
  /** Surface stop confirmations. Omitted → silent. */
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  /**
   * Pause/resume for the `p` key, wired by the extension to the same funnel
   * the `/agents` commands use. `pauseAgent` returns why the pause was
   * refused, so the toast never claims a pause that did not land. Omitted →
   * `p` does nothing.
   */
  pauseAgent?: (id: string) => string | undefined;
  resumeAgent?: (id: string) => boolean;
  /** Pi's fullscreen scrollbar preference, for the embedded conversation viewer. */
  scrollbarMode?: () => ScrollViewScrollbar;
  /**
   * The viewer's `b` for a row's run, supplied by the extension: only it knows
   * which runs have a tool call waiting to be released. Omitted → no `b`.
   */
  backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction;
}

// ---- Roster (module-level so the reopen loop can peek without an instance) ----

/** Live workflow runs, plus recently settled ones (same terms as the fleet list). */
function hubWorkflows(deps: AgentHubDeps): FleetWorkflow[] {
  if (!deps.workflows) return [];
  const now = Date.now();
  return [...deps.workflows()]
    .filter(run =>
      run.status === "running"
      || run.status === "paused"
      || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Every top-level agent with a session, earliest-launched first — the hub is
 * the session-wide roster, so finished agents stay listed until the hub
 * closes (unlike the compact fleet widget, which lingers them only briefly).
 */
function hubAgents(deps: AgentHubDeps): AgentRecord[] {
  return deps.manager.listAgents()
    .filter(a => isTopLevelAgent(a) && a.session)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function statusGlyph(status: AgentRecord["status"], th: Theme): string {
  switch (status) {
    case "running":
      return th.fg("accent", "●");
    case "completed":
      return th.fg("success", "✓");
    case "steered":
      return th.fg("accent", "✓");
    case "error":
      return th.fg("error", "✗");
    case "queued":
      return th.fg("dim", "○");
    case "paused":
      return th.fg("dim", "‖");
    // aborted / stopped
    default:
      return th.fg("dim", "·");
  }
}

/**
 * The header block's `↳` line: the run name when the page sits inside one,
 * then the canonical model, then whatever invocation tags apply. A record with
 * nothing to say still draws the line — `—` — because the block is exactly
 * three rows on every page and the rule under it never moves.
 */
function invocationSummary(record: AgentRecord, parentName?: string): string {
  const { modelName, modelId, tags } = buildInvocationTags(record.invocation);
  const model = modelId ?? modelName;
  const parts = [...(parentName ? [parentName] : []), ...(model ? [model] : []), ...tags];
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * The agent header block's two text lines (spec: *the right pane opens with a
 * header block*). Every pane that shows an agent — R's preview, T, SL, WA,
 * SAL — opens with these, then the frame's header rule, then its body.
 *
 * `parentName` is the run the agent belongs to; the run-agent pages lead their
 * `↳` line with it.
 */
export function agentHeaderLines(input: {
  record: AgentRecord;
  activity: AgentActivity | undefined;
  width: number;
  th: Theme;
  parentName?: string;
}): WorkflowCardLine[] {
  const { activity, parentName, record, th, width } = input;
  const mode = getPromptModeLabel(record.type);
  const tools = activity?.toolUses ?? record.toolUses;
  const elapsed = formatDuration(elapsedMs({ startTime: record.startedAt, endTime: record.completedAt }, Date.now()));
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  const stats: string[] = [];
  if (tools > 0) stats.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  stats.push(`${elapsed} (${record.status})`);
  if (tokens > 0) stats.push(formatSessionTokens(tokens, getSessionContextPercent(activity?.session), th, record.compactionCount));
  return [
    clampLine([
      { text: `${statusGlyph(record.status, th)} ${renderAgentRecordName(record, th, { bold: true })}${mode ? th.fg("dim", ` (${mode})`) : ""}` },
      { text: `  ${record.description}`, color: "muted" },
      { text: ` · ${stats.join(" · ")}`, color: "dim" },
    ], width),
    clampLine([{ text: th.fg("dim", `  ↳ ${invocationSummary(record, parentName)}`) }], width),
  ];
}

/**
 * The run header block's two text lines: the run's identity and counters, then
 * where the run currently is. A settled run freezes its clock and reads
 * `↳ <m> phases · <state word>`.
 */
export function runHeaderLines(input: {
  run: FleetWorkflow;
  groups: readonly PhaseGroup[];
  width: number;
  th: Theme;
  now?: number;
}): WorkflowCardLine[] {
  const { groups, run, th, width } = input;
  const active = run.status === "running" || run.status === "paused";
  const state = workflowStatusWord(run.status);
  const elapsed = formatDuration(elapsedMs({ startTime: run.startedAt, endTime: run.completedAt }, input.now ?? Date.now()));
  const flight = groups.reduce((count, group) => count + group.agents.filter(entry => displayState(entry, true) === "running").length, 0);
  const subtext = groups.length === 0 ? state
    : !active ? `${groups.length} phase${groups.length === 1 ? "" : "s"} · ${state}`
    : runPhaseSubtext(groups, flight);
  return [
    clampLine([
      { text: `${workflowStatusGlyph(run.status, th)} ${th.bold(run.name)}` },
      { text: `  workflow · ${run.doneCount}/${run.totalCount} agents · ${elapsed} (${state})`, color: "dim" },
    ], width),
    clampLine([{ text: th.fg("dim", `  ↳ ${subtext}`) }], width),
  ];
}

/** `phase 2 of 4 — migrate · 2 agents in flight`, a live run's `↳` line. */
function runPhaseSubtext(groups: readonly PhaseGroup[], flight: number): string {
  const current = currentPhaseIndex(groups);
  const parts = [`phase ${current + 1} of ${groups.length} — ${groups[current].title}`];
  if (flight > 0) parts.push(`${flight} agent${flight === 1 ? "" : "s"} in flight`);
  return parts.join(" · ");
}

/**
 * A right-pane row: content cells, or the marker for the frame's header rule.
 * The rule itself is `renderWindow`'s — a surface never spells its glyphs or
 * its role — so the composer emits a marker where the rule belongs.
 */
type PaneRow = WorkflowCardLine | { kind: "headerRule" };

/** Rows the identity block spends: the header line, the `↳` line, the header rule. */
const IDENTITY_ROWS = 3;

/** The one marker value the composer and `renderHubPage` agree on by identity. */
const HEADER_RULE: PaneRow = { kind: "headerRule" };

const isHeaderRule = (row: PaneRow | undefined): row is { kind: "headerRule" } => row !== undefined && !Array.isArray(row);

/** Overlay geometry for the popup panel — the familiar windowed viewer size. */
const POPUP_OVERLAY_OPTIONS = { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
/** Overlay geometry for the full-screen hub. */
const FULLSCREEN_OVERLAY_OPTIONS = { anchor: "center", width: "100%", maxHeight: "100%" };

/** What `openAgentHub` resolves its per-mode `ui.custom` promise with. */
type HubResult = "toggle" | undefined;

/** State carried across the popup ↔ full-screen reopen cycle. */
interface HubResumeState {
  view: HubView;
  /** Selection index into the (filtered) roster. */
  selected: number;
  filterText: string;
  chatRecordId: string | undefined;
}

export interface AgentHubInitial {
  /** Start on this agent's conversation (the fleet Enter-on-agent flow). */
  agentId?: string;
  /** Start windowed. Defaults to true when `agentId` is given, else false. */
  popup?: boolean;
}

/**
 * Open the agent hub. **The default surface is the windowed popup** — the same
 * panel the fleet list always opened, now with the detailed log and an `f` key
 * that expands to the full-screen hub (roster + activity + chat). Opening
 * without an `agentId` starts full-screen on the roster instead, since a popup
 * with no conversation to show has nothing to draw.
 *
 * pi resolves an overlay's geometry once, at creation, so the toggle closes
 * the overlay and reopens it in the other mode; this loop owns that cycle and
 * carries view/selection/filter/chat state across. Resolves when the hub
 * closes for good.
 */
export async function openAgentHub(ui: HubUICtx, deps: AgentHubDeps, initial?: AgentHubInitial): Promise<undefined> {
  const resume: HubResumeState = {
    view: initial?.agentId != null ? "chat" : "table",
    selected: 0,
    filterText: "",
    chatRecordId: initial?.agentId,
  };
  let popup = initial?.popup ?? initial?.agentId != null;
  for (;;) {
    const result = await ui.custom<HubResult>(
      (tui, theme, keybindings, done) =>
        new AgentHub(tui, theme, keybindings, done, deps, { popup, resume, onToggle: () => done("toggle") }),
      { overlay: true, overlayOptions: popup ? POPUP_OVERLAY_OPTIONS : FULLSCREEN_OVERLAY_OPTIONS },
    );
    if (result !== "toggle") return undefined;
    popup = !popup;
    if (popup && resume.view !== "chat") {
      // Popup draws a conversation, nothing else — target the roster selection.
      const agent = pickChatAgent(deps, resume);
      if (!agent) popup = false; // nothing to show; stay full-screen
      else {
        resume.view = "chat";
        resume.chatRecordId = agent.id;
      }
    }
  }
}

/** The agent a popup expansion from the roster would show: the selection, else the next openable agent below it. */
function pickChatAgent(deps: AgentHubDeps, resume: HubResumeState): AgentRecord | undefined {
  // The same order the roster draws: the subagents section first, then the
  // runs — the index is into that list, not into a workflows-first one.
  const entries: HubEntry[] = [
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record })),
    ...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  for (let i = Math.max(0, resume.selected); i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "agent" && e.record.session) return e.record;
  }
  return undefined;
}

export class AgentHub implements Component {
  private view: HubView;
  /** Selection index into the *filtered* roster. */
  private selected = 0;
  private filterText = "";
  private filterInput: Input | undefined;
  /** Two-press confirm guard for the stop key, mirroring the viewer. */
  private stopArmed = false;
  /** Chat view state — one viewer instance per opened agent. */
  private chatViewer: ConversationViewer | undefined;
  /** The embedded conversation viewer while the hub is on its chat view. */
  get chatView(): ConversationViewer | undefined { return this.chatViewer; }
  private chatRecordId: string | undefined;
  /**
   * Whether the embedded viewer renders frameless — true in the two-pane
   * layout (the shared border spans the list too), false on the narrow
   * fallback where the conversation stands alone with its own box. Read by
   * the viewer's `frameless` option at render time, so `renderChat` flips it
   * per frame before delegating.
   */
  private chatFrameless = true;
  /** Windowed popup vs full-screen hub; flipped by `f` via the reopen loop. */
  private readonly popup: boolean;
  /** The current page — the roster, or one nesting level below it. */
  private page: HubPage = "R";
  /** The run a W/WA/L page is showing; kept across the loop back. */
  private runId: string | undefined;
  /** Cursor in the run's agent list, on WA/SAL/L. */
  private runAgentSel = 0;
  /** Cursor in the run's phase list, on **L**. */
  private runPhaseSel = 0;
  /** For a log opened straight from the roster: what `esc` returns to. */
  private logBack: HubPage = "T";
  /** Log pages' scroll offset, reset when none is up. */
  private logScroll = 0;
  /**
   * The band's readout for a log page: the line count and scroll percent of
   * the log pane as it last rendered. The pane knows them; the band cannot.
   */
  private logReadout: { lines: number; percent: number } | undefined;
  /** Whether the too-small refusal has already been announced. */
  private refused = false;
  /** Shared state object written back on close/toggle so the loop can resume. */
  private readonly resume: HubResumeState;
  /** Resolve the overlay with `"toggle"`, making `openAgentHub` reopen us in the other mode. */
  private readonly onToggle: () => void;
  private readonly tick: ReturnType<typeof setInterval>;
  private disposed = false;
  /** Whether this panel enabled regular-mode mouse reporting (and must restore it). */
  private mouseCaptured = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: unknown,
    private done: (result: HubResult) => void,
    private deps: AgentHubDeps,
    initial: { popup: boolean; resume: HubResumeState; onToggle: () => void },
  ) {
    this.popup = initial.popup;
    this.resume = initial.resume;
    this.onToggle = initial.onToggle;
    this.view = this.resume.view;
    this.selected = this.resume.selected;
    this.filterText = this.resume.filterText;
    this.chatRecordId = this.resume.chatRecordId;
    // Resumed on a conversation full-screen: that is page T, the roster beside
    // the transcript. (Windowed, the conversation is the popup's whole frame.)
    if (this.view === "chat" && !this.popup) this.page = "T";
    if (this.view === "chat") {
      const record = this.chatRecordId
        ? this.deps.manager.listAgents().find(a => a.id === this.chatRecordId)
        : undefined;
      if (record?.session) this.enterChat(record);
      else this.view = "table"; // agent gone between modes — fall back to the roster
    }
    this.tick = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, TICK_MS);
    // Regular TUI mode leaves the wheel to the terminal's own scrollback;
    // capture it for the panel's lifetime. No-op in fullscreen, where pi
    // already parses mouse input and calls handleMouse instead.
    this.mouseCaptured = enableTerminalMouse(this.tui as unknown as MouseTerminalHost);
  }

  invalidate(): void { /* no cached render state */ }

  /**
   * Mouse wheel support, fullscreen route. pi's alt-screen renderer parses
   * mouse input and dispatches wheel events to an overlay's top-level component
   * — this hub. In regular mode nothing arrives here; `handleInput` parses the
   * reports instead (see `terminal-mouse.ts`).
   *
   * The shape is declared locally rather than imported: mouse dispatch landed
   * in pi-tui 0.99 while this extension's peer floor is 0.84, so the method is
   * duck-typed — hosts that support mouse call it, older hosts never do.
   */
  handleMouse(event: HubMouseEvent): { handled?: boolean } | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;
    this.applyWheel(delta);
    return { handled: true };
  }

  /**
   * One wheel movement, from whichever route delivered it (fullscreen mouse
   * dispatch, or regular-mode input parsing). Conversation views scroll the
   * embedded viewer — so follow-the-tail behaves exactly as with ↑/↓ — and
   * roster views move the selection a row per logical line. Consumed by the
   * caller either way: an unhandled wheel would scroll the transcript
   * underneath the overlay.
   */
  private applyWheel(delta: number): void {
    if (this.view === "chat" && this.chatViewer) {
      this.chatViewer.scrollBy(delta);
      this.requestRender();
      return;
    }
    const steps = Math.max(1, Math.round(Math.abs(delta)));
    const items = this.entries();
    if (items.length > 0) {
      this.selected = Math.min(items.length - 1, Math.max(0, this.selected + Math.sign(delta) * steps));
      this.stopArmed = false;
      this.requestRender();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.tick);
    this.chatViewer?.dispose();
    this.chatViewer = undefined;
    // Hand the wheel back to the terminal (native scrollback, text selection).
    if (this.mouseCaptured) {
      disableTerminalMouse(this.tui as unknown as MouseTerminalHost);
      this.mouseCaptured = false;
    }
  }

  // ---- Roster ----

  private workflows(): FleetWorkflow[] {
    return hubWorkflows(this.deps);
  }

  private agentRecords(): AgentRecord[] {
    return hubAgents(this.deps);
  }

  private roster(): HubEntry[] {
    return [
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  /** The filter in force: the live input while it's open, else the applied text. */
  private activeFilter(): string {
    return this.filterInput ? this.filterInput.getValue() : this.filterText;
  }

  private matchesFilter(entry: HubEntry): boolean {
    const q = this.activeFilter().trim().toLowerCase();
    if (!q) return true;
    const hay = entry.kind === "workflow"
      ? `${entry.workflow.name} workflow`
      : `${entry.record.type} ${entry.record.alias ?? ""} ${entry.record.description}`;
    return hay.toLowerCase().includes(q);
  }

  private entries(): HubEntry[] {
    const matching = this.roster().filter(e => this.matchesFilter(e));
    // Stable launch order inside SUBAGENTS: a row's identity never moves, so a
    // settling agent cannot reshuffle the list under the cursor.
    const agents = matching
      .filter((e): e is AgentEntry => e.kind === "agent")
      .sort((a, b) => a.record.startedAt - b.record.startedAt);
    const workflows = matching.filter((e): e is WorkflowEntry => e.kind === "workflow");
    return [...agents, ...workflows];
  }

  /**
   * The roster's display rows: the `SUBAGENTS` section first, its agents in
   * stable launch order (a settling agent never reshuffles the list under the
   * cursor), then the `WORKFLOWS` section. Headers are drawn but never
   * selected — the cursor crosses them seamlessly, which is why the selection
   * index counts entries, not rows.
   */
  private rosterItems(entries: readonly HubEntry[]): HubRosterItem[] {
    const items: HubRosterItem[] = [];
    const agents = entries.filter((e): e is AgentEntry => e.kind === "agent");
    const workflows = entries.filter((e): e is WorkflowEntry => e.kind === "workflow");
    if (agents.length > 0) {
      items.push({ kind: "header", label: ROSTER_SUBAGENTS_LABEL });
      items.push(...agents);
    }
    if (workflows.length > 0) {
      items.push({ kind: "header", label: ROSTER_WORKFLOWS_LABEL });
      items.push(...workflows);
    }
    return items;
  }

  // ---- Key handling ----

  handleInput(data: string): void {
    // Mouse reports first. In regular mode the panel captured mouse reporting,
    // so wheel bytes arrive as input; the chunk is consumed either way so no
    // escape sequence can leak into the editor.
    const mouse = parseMouseInput(data);
    if (mouse.sawMouse) {
      if (mouse.wheelDelta !== 0) this.applyWheel(mouse.wheelDelta);
      return;
    }

    // The filter input owns all keys while open (Enter applies, Esc clears).
    if (this.filterInput) {
      this.filterInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Chat view (the popup): the embedded viewer owns everything, exactly as
    // it did as a standalone overlay — including its quit keys.
    if (this.view === "chat" && this.popup) {
      this.chatViewer?.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // The transcript pages own their keys through the same viewer; `esc` walks
    // back one level via the viewer's `onBack`, and the page keys arrive
    // through its `onUnhandledKey` hook. A page with no viewer (a record whose
    // session is gone) still pops on the quit keys — a level up, never out of
    // the window.
    if (this.page === "T" || this.page === "WA") {
      if (this.page === "WA" && (matchesKey(data, "down") || matchesKey(data, "up"))) {
        this.moveRunSelection(matchesKey(data, "down") ? 1 : -1);
        return;
      }
      if (this.chatViewer) {
        this.chatViewer.handleInput(data);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        this.popPage();
        return;
      }
    }

    // The log pages (SL/SAL/L): scroll, copy, pause, stop, back.
    if ((this.page === "SL" || this.page === "SAL" || this.page === "L") && this.handleLogKey(data)) return;

    // **W**: ↑↓ moves the item cursor in the run pane, ⏎ descends to its agent.
    if (this.page === "W") {
      if (matchesKey(data, "down")) { this.moveRunSelection(1); return; }
      if (matchesKey(data, "up")) { this.moveRunSelection(-1); return; }
      if (matchesKey(data, "enter")) { this.enterPage(this.entries()); return; }
      if (matchesKey(data, "l")) { this.pushLogPage(); return; }
      if (matchesKey(data, "s")) { this.stopRun(); return; }
      if (matchesKey(data, "c")) { this.copyFocusedResult(); return; }
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.popPage(); return; }
      if (matchesKey(data, "f")) { this.requestToggle(); return; }
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "1")) { this.view = "table"; this.clampSelection(); this.requestRender(); return; }
    if (matchesKey(data, "2")) { this.view = "activity"; this.requestRender(); return; }
    if (matchesKey(data, "tab")) {
      this.view = this.view === "table" ? "activity" : "table";
      this.clampSelection();
      this.requestRender();
      return;
    }
    // `f` from the roster expands into the windowed panel on the selected
    // conversation (no-op when the selection has no openable agent). From chat
    // the same key arrives via the viewer's `onUnhandledKey` hook.
    if (matchesKey(data, "f")) {
      this.requestToggle();
      return;
    }
    if (matchesKey(data, "/")) {
      this.stopArmed = false;
      this.openFilter();
      return;
    }

    const items = this.entries();
    this.clampSelection();
    // Per-row keys: subagent rows keep the lifecycle bindings, workflow rows
    // get the run's safe set (⏎ / s / c) and nothing that a run cannot take.
    const row = items[this.selected];

    if (matchesKey(data, "down")) {
      this.selected = Math.min(items.length - 1, this.selected + 1);
      this.stopArmed = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.stopArmed = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "home")) { this.selected = 0; this.stopArmed = false; this.requestRender(); return; }
    if (matchesKey(data, "end")) { this.selected = Math.max(0, items.length - 1); this.stopArmed = false; this.requestRender(); return; }

    if (matchesKey(data, "enter")) {
      this.enterPage(items);
      return;
    }

    if (matchesKey(data, "l")) { this.pushLogPage(); return; }
    if (matchesKey(data, "c") && row?.kind === "workflow") { this.copyFocusedResult(); return; }
    if (matchesKey(data, "s") && row?.kind === "workflow") { this.stopRun(); return; }

    if (matchesKey(data, "x") || matchesKey(data, "k")) {
      this.stopSelected(items);
      return;
    }
    if (matchesKey(data, "p")) {
      this.pauseResumeSelected(items);
      return;
    }
    if (matchesKey(data, "c")) {
      const entry = items[this.selected];
      if (entry?.kind === "agent") {
        const record = this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
        copyRecordResult(record, (message, type) => this.deps.notify?.(message, type));
      }
      return;
    }

    // Any other key disarms a pending stop.
    if (this.stopArmed) this.stopArmed = false;
    this.requestRender();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  /** Write UI state back to the shared resume object for a reopen with the other mode. */
  private syncResume(): void {
    this.resume.view = this.view;
    this.resume.selected = this.selected;
    this.resume.filterText = this.filterText;
    this.resume.chatRecordId = this.chatRecordId;
  }

  private close(): void {
    this.syncResume();
    this.dispose();
    this.done(undefined);
  }

  /** `f`: flip popup ↔ full-screen. pi sizes overlays once, so this resolves
   *  the overlay with `"toggle"` and `openAgentHub` reopens us resized, with
   *  state carried through the shared resume object. */
  private requestToggle(): void {
    if (this.view !== "chat") {
      // Expanding the roster into a popup targets the selected conversation.
      const agent = pickChatAgent(this.deps, this.resume);
      if (!agent) return;
      this.view = "chat";
      this.chatRecordId = agent.id;
    }
    this.syncResume();
    this.onToggle();
  }

  private clampSelection(): void {
    const max = Math.max(0, this.entries().length - 1);
    if (this.selected > max) this.selected = max;
    if (this.selected < 0) this.selected = 0;
  }

  private openFilter(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = () => {
      this.filterText = input.getValue();
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    input.onEscape = () => {
      this.filterText = "";
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    this.filterInput = input;
    this.requestRender();
  }

  /** Switch to the chat view for `record`, embedding the detailed-log viewer. */
  private enterChat(record: AgentRecord): void {
    this.chatViewer?.dispose();
    this.view = "chat";
    this.chatRecordId = record.id;
    this.chatViewer = new ConversationViewer(
      this.tui,
      record.session!,
      record,
      this.deps.agentActivity.get(record.id),
      this.theme,
      // With `onBack` set the viewer's quit keys never reach `done`; treat it
      // as a hard close (e.g. a host-requested teardown).
      result => this.done(result),
      () => {
        if (this.deps.manager.abort(record.id)) {
          this.deps.notify?.(`Stopped "${record.description}".`, "info");
        }
      },
      this.keybindings as ViewerKeybindings | undefined,
      message => this.deps.manager.steer(record.id, message),
      this.deps.showCost,
      this.deps.viewerMarkdown,
      this.deps.onViewerMarkdown,
      this.deps.scrollbarMode?.() ?? "auto",
      this.deps.backgroundAction?.(record, message => this.deps.notify?.(message, "info")),
      {
        // Viewport tracks the mode live: popup caps at the windowed height,
        // full-screen uses the whole terminal.
        maxHeightPct: () => (this.popup ? VIEWPORT_HEIGHT_PCT : 100),
        // Popup has no roster behind it — Esc closes. Full-screen walks back.
        onBack: () => (this.popup ? this.close() : this.leaveChat()),
        backHint: () => (this.popup ? "↑↓ agent · c copy · p pause · Esc close · f expand" : "↑↓ agent · c copy · p pause · Esc back · f popup"),
        // ↑/↓ are repurposed by the pane list, so the viewer must not
        // advertise them as scroll keys.
        scrollHint: () => "PgUp/PgDn · Shift+↑↓ · j/k scroll",
        // The shared frame spans the pane list too, so the viewer contributes
        // its header/rules/content/footer — not a box of its own. Flipped off
        // per render when the terminal is too narrow for the side pane.
        frameless: () => this.chatFrameless,
        // The hub's extra keys ride through the viewer's key stream: `f`
        // flips popup/full-screen, ↑/↓ move the pane list's selection and the
        // stream follows, `c` copies the shown agent's response. The composer
        // check inside the viewer runs first, so a steering message still
        // receives its arrow keys and its "c"s.
        onUnhandledKey: data => {
          if (matchesKey(data, "f")) {
            this.requestToggle();
            return true;
          }
          if (matchesKey(data, "c")) {
            this.copyChatResult();
            return true;
          }
          if (matchesKey(data, "p")) {
            this.pauseResumeChat();
            return true;
          }
          if (matchesKey(data, "up")) {
            this.moveChatSelection(-1);
            return true;
          }
          if (matchesKey(data, "down")) {
            this.moveChatSelection(1);
            return true;
          }
          return false;
        },
      },
    );
    this.requestRender();
  }

  private leaveChat(): void {
    this.chatViewer?.dispose();
    this.chatViewer = undefined;
    this.chatRecordId = undefined;
    this.view = "table";
    // The table view is the roster: the page pops with the view, so the next
    // `esc` closes the hub rather than popping an orphaned transcript page.
    this.page = "R";
    this.stopArmed = false;
    this.clampSelection();
    this.requestRender();
  }

  /**
   * The chat pane's list, grouped by lifecycle — active, then completed, then
   * failed — earliest-launched within each group. The list is what the user
   * navigates spatially, so an agent finishing must not reshuffle it out from
   * under the pointer: the selection is re-derived from `chatRecordId` on
   * every move and render (see `chatSelIndex`), and the group move merely
   * relocates the same agent, with the pointer following it.
   */
  private chatAgents(): AgentRecord[] {
    return this.entries()
      .filter(e => e.kind === "agent" && !!e.record.session)
      .map(e => (e as AgentEntry).record)
      .sort((a, b) => chatGroupRank(a.status) - chatGroupRank(b.status) || a.startedAt - b.startedAt);
  }

  /** The pane list's cursor, derived from the agent being shown. */
  private chatSelIndex(agents: AgentRecord[]): number {
    return Math.max(0, agents.findIndex(a => a.id === this.chatRecordId));
  }

  /**
   * ↑/↓ in the conversation: move the pane list's selection and retarget the
   * stream to that agent. Clamps at the ends — the list is visible next to the
   * user, so wrapping would only break the spatial model. Re-entering the same
   * agent is a no-op so scroll position survives a stray keypress.
   */
  private moveChatSelection(direction: 1 | -1): void {
    const agents = this.chatAgents();
    if (agents.length === 0) return;
    const next = Math.min(agents.length - 1, Math.max(0, this.chatSelIndex(agents) + direction));
    if (next === this.chatSelIndex(agents)) return;
    const record = agents[next];
    if (record.id === this.chatRecordId) return;
    const fresh = this.deps.manager.listAgents().find(a => a.id === record.id) ?? record;
    if (fresh.session) this.enterChat(fresh);
  }

  /**
   * `c`: copy the shown agent's response to the system clipboard — the one
   * implementation in `copyRecordResult`, shared with the workflow inspector's
   * log level.
   */
  /** `p` in the chat pane: pause/resume the agent being viewed. */
  private pauseResumeChat(): void {
    const record = this.deps.manager.listAgents().find(a => a.id === this.chatRecordId);
    if (record) this.pauseResumeAgent(record);
  }

  private copyChatResult(): void {
    const record = this.deps.manager.listAgents().find(a => a.id === this.chatRecordId);
    if (record) copyRecordResult(record, (message, type) => this.deps.notify?.(message, type));
  }

  /** Two-press stop on the selected agent, mirroring the viewer's `x`. */
  private stopSelected(items: HubEntry[]): void {
    const entry = items[this.selected];
    if (!entry || entry.kind !== "agent") return;
    const record = entry.record;
    const active = record.status === "running" || record.status === "queued";
    if (!active) return;
    if (this.stopArmed) {
      this.stopArmed = false;
      if (this.deps.manager.abort(record.id)) {
        this.deps.notify?.(`Stopped "${record.description}".`, "info");
      }
    } else {
      this.stopArmed = true;
    }
    this.requestRender();
  }

  /**
   * `p`: pause the selected agent if it is active, resume it if paused. One
   * key because the two states are one lifecycle — a paused row is where a
   * pause landed and the only thing a resume starts from. Settled agents stay
   * put: continuing a finished run is `/agents resume`'s job, not a toggle's.
   */
  private pauseResumeSelected(items: HubEntry[]): void {
    const entry = items[this.selected];
    if (entry?.kind !== "agent") return;
    this.pauseResumeAgent(entry.record);
  }

  private pauseResumeAgent(record: AgentRecord): void {
    if (record.status === "running" || record.status === "queued") {
      const why = this.deps.pauseAgent?.(record.id);
      this.deps.notify?.(
        why ? `Cannot pause "${record.description}" — ${why}.` : `Paused "${record.description}".`,
        why ? "warning" : "info",
      );
    } else if (record.status === "paused") {
      const started = this.deps.resumeAgent?.(record.id);
      this.deps.notify?.(
        started ? `Resuming "${record.description}".` : `Cannot resume "${record.description}".`,
        started ? "info" : "warning",
      );
    }
    this.requestRender();
  }

  // ---- Rendering ----

  render(width: number): string[] {
    const terminalRows = this.tui.terminal?.rows ?? 24;
    if (width < HUB_MIN_WIDTH || terminalRows < HUB_MIN_ROWS) {
      this.refuseSize();
      return [];
    }
    if (this.view === "chat" && this.popup && this.chatViewer) return this.renderChat(width);
    if (this.view === "activity") return this.renderActivityWindow(width, terminalRows);
    return this.renderHubPage(width, terminalRows);
  }

  /**
   * The window under the ladder: below 40×10 it refuses to open at all — no
   * partial frame, one notification, then the overlay closes. Called from
   * `render`, where the terminal's size is finally known.
   */
  private refuseSize(): void {
    if (this.refused) return;
    this.refused = true;
    this.deps.notify?.(HUB_SIZE_REFUSAL, "warning");
    this.close();
  }

  /**
   * The unified window: the roster (or a run's agent list) on the left, the
   * current page's detail on the right, the constant window title, a full-width
   * status strip, and the page's own footer.
   *
   * The detail pane opens with its identity block on every page; on run-agent
   * pages the `↳` line leads with the run name.
   *
   * Two-pane down to {@link TWO_PANE_MIN_WIDTH}, stacked below it: the pane
   * policy is the size ladder's, the columns are the shared window's.
   */
  private renderHubPage(width: number, terminalRows: number): string[] {
    const twoPane = width >= TWO_PANE_MIN_WIDTH;
    const header: WindowRow[] = [];
    if (this.filterInput || this.filterText) {
      header.push({ kind: "full", cells: [{ text: this.filterLine(windowInnerWidth(width)) }] });
    }
    // The first thing height scarcity drops, then the blank row, then the
    // summaries — the spec's degradation order.
    const showStatus = terminalRows >= HUB_FULL_ROWS;
    const showBlank = terminalRows >= 12;
    const chrome = header.length + 4 + (showStatus ? 1 : 0) + (showBlank ? 1 : 0);
    const bodyRows = Math.max(MIN_BODY_ROWS, terminalRows - chrome);

    const body: WindowRow[] = [];
    // A log page's readout is captured as its pane renders; clear it so a page
    // without one never shows the last log's numbers.
    this.logReadout = undefined;

    if (!twoPane) {
      // Stacked: one full-width page. `⏎` pushes the right pane's content as
      // its own page; `esc` pops it — the page model unchanged, one column.
      body.push(...this.stackedLines(width - 4, bodyRows));
    } else {
      const panes = masterPaneGeometry(width);
      const left = this.leftPaneLines(panes.listWidth, bodyRows);
      const right = this.rightPaneLines(panes.detailWidth, bodyRows);
      for (let i = 0; i < bodyRows; i++) {
        const rightRow = right[i];
        body.push(isHeaderRule(rightRow)
          ? { kind: "headerRule", left: left[i] }
          : { kind: "split", left: left[i], right: rightRow ?? [] });
      }
    }

    const rows: WindowRow[] = [...header, ...body];
    if (showBlank) rows.push({ kind: "full", cells: [{ text: "" }] });
    if (showStatus) rows.push({ kind: "full", cells: [{ text: this.statusStrip(windowInnerWidth(width)) }] });
    rows.push({ kind: "band" }, { kind: "full", cells: [{ text: this.pageFooter(windowInnerWidth(width)) }] });

    return paintWindow(
      renderWindow({
        width,
        box: UNICODE_PANE_BOX,
        panes: twoPane ? masterPaneGeometry(width) : undefined,
        title: HUB_TITLE,
        rows,
        ellipsis: "…",
      }),
      this.theme,
    );
  }

  /**
   * The status strip: the focused item's last activity, from the SAME
   * `describeActivity` the agent widget's subtext uses, prefixed with `❞` and
   * truncated at the window edge.
   */
  private statusStrip(width: number): string {
    const th = this.theme;
    const record = this.focusedRecord();
    let doing: string | undefined;
    if (record) {
      const activity = this.deps.agentActivity.get(record.id);
      if (record.status === "running" || record.status === "queued" || record.status === "paused") {
        doing = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
      } else {
        doing = record.status;
      }
    } else {
      const run = this.currentRun();
      if (run) {
        const source = this.runSource(run.id);
        const live = source ? flattenRunAgents(source).filter(e => displayState(e, true) === "running") : [];
        doing = live.length > 0 ? `${live.length} agent${live.length === 1 ? "" : "s"} in flight` : workflowStatusWord(run.status);
      }
    }
    return truncateToWidth(`${th.fg("accent", STATUS_PREFIX)} ${th.fg("dim", doing ?? "idle")}`, width);
  }

  /**
   * The page's footer band: the readout and the page's actions in the left
   * slot, navigation, the page's keys, the twin toggle and the pinned escape
   * anchor in the right. The window's fitter drops whole hints — the readout
   * first — so the band never cuts one in half.
   */
  private pageFooter(width: number): string {
    const keys = this.page === "R" && this.entries()[this.selected]?.kind === "workflow" ? R_RUN_KEYS : PAGE_KEYS[this.page];
    const viewer = this.viewerBand();
    const expanded = (this.page === "T" || this.page === "WA") && (viewer?.expanded ?? false);
    const actions = expanded
      ? [...keys.actions.filter(action => action !== TD_REPLACED_ACTION), ...TD_ACTIONS]
      : [...keys.actions];
    const hints = expanded ? keys.hints.filter(hint => hint !== TD_DROPPED_HINT) : [...keys.hints];
    const armed = this.stopArmed || (viewer?.stopArmed ?? false);

    const left: FooterHint[] = [];
    const readout = this.pageReadout();
    if (readout) left.push({ text: readout, group: "readout" });
    // The armed stop reads on whichever slot the page advertises it in, and
    // sits leftmost among the actions so it outlives them when the band is
    // tight. A page that does not advertise `x` still arms the roster's own.
    if (armed) left.push({ text: "x again to STOP", group: "action" });
    for (const action of actions) {
      if (armed && action === "x stop") continue;
      left.push({ text: action, group: "action" });
    }
    const right: FooterHint[] = [
      ...hints.map((text): FooterHint => ({ text, group: "hint" })),
      { text: `f ${this.popup ? "full" : "popup"}`, group: "hint" },
      { text: `Esc ${keys.esc}`, group: "hint", pinned: true },
    ];
    return footerBand({ width, left, right });
  }

  /** The embedded viewer's band state, when a page is showing one. */
  private viewerBand(): { text: string; expanded: boolean; stopArmed: boolean } | undefined {
    return this.page === "T" || this.page === "WA" ? this.chatViewer?.bandReadout() : undefined;
  }

  /**
   * The band's readout — the one hint that is data, not a key. T/WA read the
   * embedded viewer's transcript; the log pages the log they just windowed;
   * **W** the run's counters; **R** has none (its left slot is actions).
   */
  private pageReadout(): string | undefined {
    if (this.page === "T" || this.page === "WA") return this.chatViewer?.bandReadout().text || undefined;
    if (this.page === "SL" || this.page === "SAL" || this.page === "L") {
      const log = this.logReadout;
      return log ? `${log.lines} lines · ${log.percent}%` : undefined;
    }
    if (this.page === "W") {
      const run = this.currentRun();
      return run ? this.runReadout(run) : undefined;
    }
    return undefined;
  }

  /** **W**'s readout: the run's counters and how far through its phases it is. */
  private runReadout(run: FleetWorkflow): string {
    const groups = this.runGroups(run.id);
    const parts = [`${run.doneCount}/${run.totalCount} agents`];
    if (groups.length > 0) parts.push(`phase ${currentPhaseIndex(groups) + 1} of ${groups.length}`);
    return parts.join(" · ");
  }

  /** The legacy activity list, still reachable with `2` — the roster's sibling view. */
  private renderActivityWindow(width: number, terminalRows: number): string[] {
    const rows = Math.max(MIN_BODY_ROWS, terminalRows - 4);
    return paintWindow(
      renderWindow({
        width,
        box: UNICODE_PANE_BOX,
        rows: [
          { kind: "full", cells: [{ text: this.activityTitle(width) }] },
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          ...this.renderActivity(rows),
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          { kind: "full", cells: [{ text: "↑↓ select · Enter open · x stop · p pause · 1 agents · f popup · q close" }] },
        ],
        ellipsis: "…",
      }),
      this.theme,
    );
  }

  private activityTitle(width: number): string {
    const th = this.theme;
    const agents = this.agentRecords();
    const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
    return truncateToWidth(`${th.bold("Agents & Workflows")} ${th.fg("dim", `· activity · ${agents.length} agents · ${running} active`)}`, width);
  }

  /**
   * The chat view's two-pane layout inside one overall frame — the workflow
   * inspector's shape, so the border spans the agent list too:
   *
   * ```
   * ╭ Agents ───────┬──────────────────────────────────╮
   * │ ACTIVE        │ ● Agent (twin)  task · 12s · 3t  │
   * │ ❯ ● Agent     │ ──────────────────────────────── │
   * │ COMPLETED     │ (live conversation)              │
   * │   ✓ explore   │                                  │
   * │ FAILED        │                                  │
   * │   ✗ plan      │                                  │
   * ╰───────────────┴──────────────────────────────────╯
   * ```
   *
   * The viewer renders frameless at the reduced width (it is
   * width-parameterized), the list pads to its pane width, and the two zip
   * line-by-line between the shared borders. Below
   * {@link TWO_PANE_MIN_WIDTH} the list pane is dropped and the conversation
   * stands alone in its own framed box rather than being squeezed to
   * unreadable.
   */
  private renderChat(width: number): string[] {
    if (width < TWO_PANE_MIN_WIDTH) {
      this.chatFrameless = false; // conversation alone → its own frame
      return this.chatViewer!.render(width);
    }
    this.chatFrameless = true;
    const th = this.theme;
    // The split is the shared window's: the list cell, the conversation cell
    // and the three bars partition the width exactly.
    const panes = paneGeometry(width);
    const chat = this.chatViewer!.render(panes.detailWidth);
    if (chat.length === 0) return chat; // viewer bailed on width; nothing to frame

    const agents = this.chatAgents();
    const sel = this.chatSelIndex(agents);

    // Display list: a dim group header whenever the lifecycle group changes,
    // then each agent row. Only non-empty groups get a header — an empty
    // "FAILED" label is noise, and the header appearing when an agent fails is
    // itself the signal.
    const items: Array<{ kind: "header"; label: string } | { kind: "agent"; record: AgentRecord; selected: boolean }> = [];
    let lastRank = -1;
    for (let i = 0; i < agents.length; i++) {
      const record = agents[i];
      const rank = chatGroupRank(record.status);
      if (rank !== lastRank) {
        items.push({ kind: "header", label: CHAT_GROUP_LABELS[rank] });
        lastRank = rank;
      }
      items.push({ kind: "agent", record, selected: i === sel });
    }

    // Window the rows to the conversation's height, centered on the selection.
    const rows = chat.length;
    const selAt = Math.max(0, items.findIndex(item => item.kind === "agent" && item.selected));
    const slice = windowRange(selAt, items.length, rows);

    const body: WindowRow[] = [];
    for (let i = 0; i < rows; i++) {
      const item = items[slice.start + i];
      const left: WorkflowCardLine = item == null
        ? []
        : item.kind === "header"
          ? [{ text: item.label, color: "dim" }]
          : [{ text: this.renderChatRow(item.record, item.selected) }];
      body.push({ kind: "split", left, right: [{ text: chat[i] ?? "" }] });
    }
    return paintWindow(
      renderWindow({ width, box: UNICODE_PANE_BOX, panes, title: " Agents ", rows: body }),
      th,
    );
  }

  /** One row of the chat pane's list: `❯ ● name`, matching the inspector's. */
  private renderChatRow(record: AgentRecord, selected: boolean): string {
    const th = this.theme;
    const marker = selected ? th.fg("accent", "❯") : " ";
    const name = renderAgentRecordName(record, th, selected
      ? { fallbackColor: "text", bold: true }
      : { fallbackColor: "muted" });
    return `${marker} ${statusGlyph(record.status, th)} ${name}`;
  }

  private filterLine(width: number): string {
    const th = this.theme;
    if (this.filterInput) {
      // The Input renders its own `> ` prompt; just add the usage hint.
      const field = this.filterInput.render(Math.max(1, width - 2))[0] ?? "";
      return truncateToWidth(field + th.fg("dim", "  (Enter apply · Esc clear)"), width);
    }
    const total = this.roster().length;
    const shown = this.entries().length;
    return truncateToWidth(th.fg("accent", `/ ${this.filterText}`) + th.fg("dim", `  — ${shown}/${total} match${shown === 1 ? "" : "es"}`), width);
  }

  /** The roster's rows for a pane: section headers, windowed on the selection. */
  private rosterLines(width: number, rows: number): WorkflowCardLine[] {
    const items = this.entries();
    this.clampSelection();
    if (items.length === 0) {
      return [clampLine([{ text: this.theme.fg("dim", this.activeFilter() ? "no matches" : "(no agents yet — spawn one to see it here)") }], width)];
    }
    // The display list carries the section headers; the selection counts only
    // the rows, so `selAt` finds the selection's row position under the headers.
    const display = this.rosterItems(items);
    const selectedEntry = items[this.selected];
    const selAt = Math.max(0, display.findIndex(item => item.kind !== "header" && item === selectedEntry));
    const slice = windowRange(selAt, display.length, rows);

    const lines: WorkflowCardLine[] = [];
    for (let i = 0; i < rows; i++) {
      const item = display[slice.start + i];
      if (!item) { lines.push([]); continue; }
      if (item.kind === "header") {
        lines.push([{ text: item.label, color: "dim", bold: true }]);
        continue;
      }
      lines.push(clampLine([{ text: this.renderEntry(item, item === selectedEntry, width) }], width));
    }
    return lines;
  }

  // ---- Pages (the one window) ----

  /** The left pane: the parent level for whichever page is up. */
  private leftPaneLines(width: number, rows: number): WorkflowCardLine[] {
    switch (this.page) {
      case "WA":
      case "SAL":
      case "L":
        return this.runLeftLines(width, rows);
      default:
        return this.rosterLines(width, rows);
    }
  }

  /** The right pane: the selected item's detail, per page. Identity is composed in front of it. */
  private rightPaneLines(width: number, rows: number): PaneRow[] {
    switch (this.page) {
      case "R":
        return this.previewLines(width, rows);
      case "T":
      case "WA":
        return this.transcriptLines(width, rows);
      case "SL":
      case "SAL":
        return this.agentLogPageLines(width, rows);
      case "W":
        return this.runPaneLines(width, rows);
      case "L":
        return this.runLogPageLines(width, rows);
    }
  }

  /** **R**'s detail: the agent-log preview for a subagent row, the run overview for a workflow row. */
  private previewLines(width: number, rows: number): PaneRow[] {
    const entry = this.entries()[this.selected];
    if (entry?.kind === "workflow") return this.runPreviewLines(entry.workflow, width, rows);
    const record = this.rosterRecordForCurrent();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    return this.identityPane(
      this.agentIdentity(record, width),
      this.agentLogLines(width, this.bodyRows(rows, true)),
      this.noteLine("(⏎ opens the full transcript)", width),
    );
  }

  /**
   * The run overview **R** shows for a selected workflow row (spec R2): the run
   * header block, the phases with the current one carrying the `❯`, and the
   * hint onto the run page.
   */
  private runPreviewLines(run: FleetWorkflow, width: number, rows: number): PaneRow[] {
    const source = this.runSource(run.id);
    const groups = source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
    const body: PaneRow[] = [];
    if (groups.length > 0) {
      body.push(clampLine([{ text: "PHASES", color: "muted", bold: true }], width));
      body.push(...phaseListRows({
        groups,
        selectedPhase: currentPhaseIndex(groups),
        capacity: Math.max(1, this.bodyRows(rows, true) - body.length),
        width,
        glyphs: UNICODE_DIALOG_GLYPHS,
      }));
    }
    return this.identityPane(
      runHeaderLines({ run, groups, width, th: this.theme }),
      body,
      this.noteLine("(⏎ opens the run page)", width),
    );
  }

  /**
   * The transcript pages' right pane: the selected agent's full conversation,
   * through the same `ConversationViewer` the popup shows — user, thinking,
   * assistant, tool-call, diff and streaming blocks, with `o`/`ctrl+o`
   * expanding a tool-call in place (a view state, never a page).
   */
  private transcriptLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    if (!record.session) {
      return [clampLine([{ text: this.theme.fg("dim", `transcript unavailable — agent is ${record.status}`) }], width)];
    }
    const viewer = this.ensureViewer(record);
    if (!viewer) return [];
    const body: PaneRow[] = viewer.render(width).map((text): PaneRow => [{ text }]);
    return this.identityPane(this.agentIdentity(record, width), padLines(body, this.bodyRows(rows, false)));
  }

  /**
   * **W**: the run's phases followed by its agents — the level the next `⏎`
   * descends into. Rows come from the inspector's own builders.
   */
  private runPaneLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    if (!run) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const identity = runHeaderLines({ run, groups: this.runGroups(run.id), width, th: this.theme });
    const source = this.runSource(run.id);
    if (!source) return this.identityPane(identity, [this.noteLine("run detail unavailable", width)]);
    const capacity = this.bodyRows(rows, false);
    const glyphs = UNICODE_DIALOG_GLYPHS;
    const groups = buildPhaseGroups(source.progress, source.meta?.phases);
    const lines: PaneRow[] = [clampLine([{ text: "PHASES", color: "muted", bold: true }], width)];
    lines.push(
      ...phaseListRows({ groups, selectedPhase: this.runPhaseSel, capacity: Math.max(1, groups.length), width, glyphs }),
    );
    lines.push([]);
    lines.push(clampLine([{ text: "RUN AGENTS", color: "muted", bold: true }], width));
    const entries = flattenRunAgents(source);
    const selection = this.clampRunAgentIndex();
    const slice = windowRange(selection, entries.length, Math.max(1, capacity - lines.length));
    if (entries.length === 0) lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
    for (let i = slice.start; i < slice.end; i++) {
      lines.push(
        agentRow({
          entry: entries[i],
          selected: i === selection,
          compact: false,
          width,
          glyphs,
          workflowActive: source.task.status === "running" || source.task.status === "paused",
          spinnerFrame: 0,
          now: Date.now(),
        }),
      );
    }
    return this.identityPane(identity, padLines(lines, capacity));
  }

  /** The phase groups of the named run, or none when its detail source is gone. */
  private runGroups(id: string): PhaseGroup[] {
    const source = this.runSource(id);
    return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
  }

  /**
   * The run's agent list, with the run's phases above it on **L** — the
   * parent level a run page demotes into its left pane.
   */
  private runLeftLines(width: number, rows: number): WorkflowCardLine[] {
    const source = this.runSource();
    if (!source) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const glyphs = UNICODE_DIALOG_GLYPHS;
    const groups = buildPhaseGroups(source.progress, source.meta?.phases);
    const selection = this.clampRunAgentIndex();
    const lines: WorkflowCardLine[] = [];
    if (this.page === "L") {
      lines.push(...phaseListRows({ groups, selectedPhase: this.runPhaseSel, capacity: rows, width, glyphs }));
      if (lines.length < rows) lines.push([]);
    }
    const entries = flattenRunAgents(source);
    if (entries.length === 0) {
      lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
      return lines;
    }
    const capacity = Math.max(1, rows - lines.length);
    const slice = windowRange(selection, entries.length, capacity);
    for (let i = slice.start; i < slice.end; i++) {
      lines.push(
        agentRow({
          entry: entries[i],
          selected: i === selection,
          compact: this.page !== "L",
          width,
          glyphs,
          workflowActive: source.task.status === "running" || source.task.status === "paused",
          spinnerFrame: 0,
          now: Date.now(),
        }),
      );
    }
    return lines;
  }

  /** The run log: the events the run's progress entries carry, timestamped. */
  private runLogLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    const source = run ? this.runSource(run.id) : undefined;
    if (!run || !source) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const active = source.task.status === "running" || source.task.status === "paused";
    const lines: WorkflowCardLine[] = [
      clampLine([{ text: `${stamp(run.startedAt)} run start: ${run.totalCount} agent${run.totalCount === 1 ? "" : "s"}`, color: "muted" }], width),
    ];
    for (const entry of flattenRunAgents(source)) {
      const state = displayState(entry, active);
      if (entry.startedAt != null) {
        lines.push(clampLine([{ text: `${stamp(entry.startedAt)} ${entry.label} spawned${entry.phaseTitle ? ` (${entry.phaseTitle})` : ""}`, color: "dim" }], width));
      }
      if (state === "running") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} still running`, color: "dim" }], width));
      if (state === "done") {
        const at = entry.startedAt != null && entry.durationMs != null ? entry.startedAt + entry.durationMs : Date.now();
        lines.push(clampLine([{ text: `${stamp(at)} ${entry.label} done${entry.resultPreview ? ` — ${entry.resultPreview}` : ""}`, color: "success" }], width));
      }
      if (state === "failed" || state === "blocked") {
        lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} failed${entry.error ? ` — ${entry.error}` : ""}`, color: "error" }], width));
      }
      if (state === "skipped") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} skipped`, color: "dim" }], width));
    }
    if (!active) lines.push(clampLine([{ text: `${stamp(run.completedAt ?? Date.now())} run ${workflowStatusWord(run.status)}`, color: "muted" }], width));
    return padLines(this.scrollTail(lines, this.logScroll, rows), rows);
  }

  /**
   * An agent's event log — the compact timestamped companion to the
   * transcript, from what the record and its live activity know: spawn, turns,
   * tool calls, completion with tokens and cost. The trailing line is the live
   * activity, which is where the removed `❞` strip's information went.
   */
  private agentLogLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    const activity = this.deps.agentActivity.get(record.id);
    const lines: WorkflowCardLine[] = [
      clampLine([{ text: `${stamp(record.startedAt)} spawn  ${record.alias ?? record.handle ?? record.type} · ${record.description}`, color: "muted" }], width),
    ];
    for (let turn = 1; turn <= (activity?.turnCount ?? 0); turn++) {
      lines.push(clampLine([{ text: `${stamp(record.startedAt)} turn ${turn} start`, color: "dim" }], width));
    }
    if (record.toolUses > 0) {
      lines.push(clampLine([{ text: `${stamp(record.startedAt)} tools  ${record.toolUses} call${record.toolUses === 1 ? "" : "s"}`, color: "dim" }], width));
    }
    if (activity?.responseText) {
      lines.push(clampLine([{ text: `${stamp(Date.now())} note   ${activity.responseText.split("\n")[0] ?? ""}`, color: "dim" }], width));
    }
    if (record.status === "running" || record.status === "queued" || record.status === "paused") {
      const doing = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
      lines.push(clampLine([{ text: `${stamp(Date.now())} still ${record.status} — ${doing}`, color: "dim" }], width));
    }
    if (record.completedAt != null) {
      const done = record.status === "completed" || record.status === "steered";
      lines.push(clampLine([{ text: `${stamp(record.completedAt)} ${done ? "done" : record.status}${record.error ? ` — ${record.error}` : ""}`, color: done ? "success" : "error" }], width));
      const tokens = getLifetimeTotal(record.lifetimeUsage);
      const cost = this.deps.showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
      lines.push(clampLine([{ text: `${stamp(record.completedAt)} usage  ${tokens} tokens${cost ? ` · ${cost}` : ""}`, color: "dim" }], width));
    }
    return padLines(this.scrollTail(lines, this.logScroll, rows), rows);
  }

  /**
   * An agent's event-log page (**SL**, **SAL**): the identity block, the
   * frame's header rule, then the log.
   */
  private agentLogPageLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    return this.identityPane(this.agentIdentity(record, width), this.agentLogLines(width, this.bodyRows(rows, false)));
  }

  /** The run log page (**L**): the run's identity block, the rule, the events. */
  private runLogPageLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    if (!run) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const identity = runHeaderLines({ run, groups: this.runGroups(run.id), width, th: this.theme });
    return this.identityPane(identity, this.runLogLines(width, this.bodyRows(rows, false)));
  }

  /** Rows a pane has left for its body, the identity block and a closing note removed. */
  private bodyRows(rows: number, note: boolean): number {
    return Math.max(1, rows - IDENTITY_ROWS - (note ? 1 : 0));
  }

  /**
   * A pane's content: the identity block, the frame's header rule, the body,
   * then an optional closing note (a preview's `⏎` hint). Identity is composed
   * here, outside the body: the body is windowed to the rows it is handed, and
   * identity must never be trimmed by that windowing.
   */
  private identityPane(identity: WorkflowCardLine[], body: readonly PaneRow[], note?: WorkflowCardLine): PaneRow[] {
    return [...identity, HEADER_RULE, ...body, ...(note ? [note] : [])];
  }

  /** The agent header block for whichever record the page is showing. */
  private agentIdentity(record: AgentRecord, width: number): WorkflowCardLine[] {
    return agentHeaderLines({
      record,
      activity: this.deps.agentActivity.get(record.id),
      width,
      th: this.theme,
      parentName: this.page === "WA" || this.page === "SAL" ? this.currentRun()?.name : undefined,
    });
  }

  /** A dim one-line note closing a pane. */
  private noteLine(text: string, width: number): WorkflowCardLine {
    return clampLine([{ text, color: "dim" }], width);
  }

  /**
   * The stacked single-pane page (40–59 cols): the current page's own content
   * at full width. `⏎` pushes the detail page, `esc` pops it — the pane model
   * with one column.
   */
  private stackedLines(width: number, rows: number): WindowRow[] {
    const lines: PaneRow[] = this.page === "R" ? this.rosterLines(width, rows) : this.rightPaneLines(width, rows);
    const content = lines.length > 0 ? lines : this.leftPaneLines(width, rows);
    return content.map(row => (isHeaderRule(row) ? { kind: "headerRule" } : { kind: "full", cells: row }));
  }

  /** The viewer for `record`, rebuilt only when the target changes. */
  private ensureViewer(record: AgentRecord): ConversationViewer | undefined {
    if (this.chatViewer && this.chatRecordId === record.id && !this.popup) return this.chatViewer;
    if (!record.session) return undefined;
    this.chatViewer?.dispose();
    this.chatRecordId = record.id;
    this.chatViewer = new ConversationViewer(
      this.tui,
      record.session,
      record,
      this.deps.agentActivity.get(record.id),
      this.theme,
      result => this.done(result),
      () => {
        if (this.deps.manager.abort(record.id)) {
          this.deps.notify?.(`Stopped "${record.description}".`, "info");
        }
      },
      this.keybindings as ViewerKeybindings | undefined,
      message => this.deps.manager.steer(record.id, message),
      this.deps.showCost,
      this.deps.viewerMarkdown,
      this.deps.onViewerMarkdown,
      this.deps.scrollbarMode?.() ?? "auto",
      this.deps.backgroundAction?.(record, message => this.deps.notify?.(message, "info")),
      {
        maxHeightPct: () => (this.popup ? VIEWPORT_HEIGHT_PCT : 100),
        onBack: () => this.popPage(),
        backHint: () => "↑↓ scroll · esc back · f full",
        scrollHint: () => "PgUp/PgDn · Shift+↑↓ · j/k scroll",
        frameless: () => true,
        onUnhandledKey: data => this.pageUnhandledKey(data),
      },
    );
    return this.chatViewer;
  }

  /** The viewer keys that belong to the PAGE, not to the viewer. */
  private pageUnhandledKey(data: string): boolean {
    // Anything but the stop key disarms a pending stop — the viewer hands
    // every key it sees through here first, so this covers its own scrolling
    // keys too, which the hub never sees again.
    if (!matchesKey(data, "k") && !matchesKey(data, "x") && this.stopArmed) this.stopArmed = false;
    if (matchesKey(data, "l")) { this.pushLogPage(); return true; }
    if (matchesKey(data, "f")) { this.requestToggle(); return true; }
    if (matchesKey(data, "c")) { this.copyFocusedResult(); return true; }
    if (matchesKey(data, "p")) { this.pauseResumeFocused(); return true; }
    if (matchesKey(data, "k") || matchesKey(data, "x")) { this.stopFocused(); return true; }
    return false;
  }

  /** One step in the run's agent list — `WA`'s left pane, and `W`'s item cursor. */
  private moveRunSelection(delta: 1 | -1): void {
    if (this.runAgents().length === 0) return;
    const next = Math.min(this.runAgents().length - 1, Math.max(0, this.clampRunAgentIndex() + delta));
    if (next === this.runAgentSel) return;
    this.runAgentSel = next;
    // A new agent is a new page subject: the viewer rebuilds on the next render.
    if (this.page === "WA") this.chatRecordId = undefined;
    this.requestRender();
  }

  /** `s`: stop the run the cursor is on (workflow rows only — refusal rules). */
  private stopRun(): void {
    const run = this.page === "W" || this.page === "L" ? this.currentRun() : this.entries()[this.selected]?.kind === "workflow" ? (this.entries()[this.selected] as { workflow: FleetWorkflow }).workflow : undefined;
    if (!run || (run.status !== "running" && run.status !== "paused")) return;
    this.runId = run.id;
    this.deps.stopWorkflow?.(run.id);
    this.requestRender();
  }

  /**
   * The log pages' keys: scroll, copy, pause, stop the focused agent, stop the
   * run, expand, back. `k` stays scroll-up here (the roster and transcript
   * pages are where it aliases `x`); any other key disarms a pending stop.
   */
  private handleLogKey(data: string): boolean {
    const down = matchesKey(data, "down") || matchesKey(data, "j");
    const up = matchesKey(data, "up") || matchesKey(data, "k");
    if (down || up) { this.stopArmed = false; this.scrollLog(down ? 1 : -1); return true; }
    if (matchesKey(data, "c")) { this.stopArmed = false; this.copyFocusedResult(); return true; }
    if (matchesKey(data, "p")) { this.stopArmed = false; this.pauseResumeFocused(); return true; }
    if (matchesKey(data, "s") && this.page === "L") { this.stopArmed = false; this.stopRun(); return true; }
    if (matchesKey(data, "x") && (this.page === "SL" || this.page === "SAL")) { this.stopFocused(); return true; }
    if (matchesKey(data, "f")) { this.stopArmed = false; this.requestToggle(); return true; }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.stopArmed = false; this.popPage(); return true; }
    return false;
  }

  /** `⏎` at the page level: `R` descends into the selected item, `W` into its agent. */
  private enterPage(items: HubEntry[]): void {
    this.stopArmed = false;
    if (this.page === "R") {
      const entry = items[this.selected];
      if (!entry) return;
      if (entry.kind === "workflow") {
        this.runId = entry.workflow.id;
        this.runAgentSel = 0;
        this.runPhaseSel = 0;
        this.page = "W";
        this.requestRender();
        return;
      }
      const record = this.rosterRecordForCurrent();
      if (!record?.session) {
        this.deps.notify?.(`Agent is ${record?.status ?? "gone"} — no session available.`, "info");
        return;
      }
      this.chatRecordId = record.id;
      this.page = "T";
      this.requestRender();
      return;
    }
    if (this.page === "W") {
      const record = this.selectedRunRecord();
      if (!record?.session) {
        this.deps.notify?.("That agent has no conversation to open.", "info");
        return;
      }
      this.page = "WA";
      this.requestRender();
    }
  }

  /** `esc`: exactly one nesting level up. */
  private popPage(): void {
    if (this.page === "R") { this.close(); return; }
    const from = this.page;
    this.page = from === "SL" && this.logBack === "R" ? "R" : PAGE_PARENT[from]!;
    this.logScroll = 0;
    this.stopArmed = false;
    // Back on the roster the pointer is what the right pane follows; deeper, the
    // pinned record stays the page's subject.
    if (this.page === "R" || this.page === "T") {
      const record = this.page === "R" ? this.rosterRecordForCurrent() : this.focusedRecord();
      this.chatRecordId = record?.id;
    }
    this.requestRender();
  }

  /** The record a page is showing — the page's focus, whatever the roster cursor does. */
  private focusedRecord(): AgentRecord | undefined {
    const fresh = (id: string | undefined) => (id === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === id));
    if (this.page === "R") return this.rosterRecordForCurrent();
    if (this.page === "T" || this.page === "SL") return fresh(this.chatRecordId);
    if (this.page === "WA" || this.page === "SAL") return this.selectedRunRecord();
    // W / L: the run's most recently active agent — the status strip's subject.
    const entries = flattenRunAgents(this.runSource() ?? EMPTY_RUN_SOURCE);
    const live = entries.filter(e => displayState(e, true) === "running");
    return fresh((live.at(-1) ?? entries.at(-1))?.recordId);
  }

  /** The roster row under the cursor, when it is an agent. */
  private rosterRecordForCurrent(): AgentRecord | undefined {
    const entry = this.entries()[this.selected];
    if (entry?.kind !== "agent") return undefined;
    return this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
  }

  /** The run the page is on, live. */
  private currentRun(): FleetWorkflow | undefined {
    return this.runId === undefined ? undefined : this.workflows().find(w => w.id === this.runId);
  }

  /** The run's detail source — the named run's, or the current page's. */
  private runSource(id?: string): WorkflowDialogSource | undefined {
    const runId = id ?? this.runId;
    return runId === undefined ? undefined : this.deps.workflowRun?.(runId);
  }

  private clampRunAgentIndex(): number {
    const max = Math.max(0, this.runAgents().length - 1);
    this.runAgentSel = Math.min(Math.max(0, this.runAgentSel), max);
    return this.runAgentSel;
  }

  /** The run's agents, flattened across phases, in run order. */
  private runAgents(): readonly WorkflowAgentEntry[] {
    return flattenRunAgents(this.runSource() ?? EMPTY_RUN_SOURCE);
  }

  /** The record behind the run's selected agent row. */
  private selectedRunRecord(): AgentRecord | undefined {
    const recordId = this.runAgents()[this.clampRunAgentIndex()]?.recordId;
    return recordId === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === recordId);
  }

  /** `l`: to the log page one level below the current one (R skips T). */
  private pushLogPage(): void {
    if (this.page === "R") {
      const record = this.rosterRecordForCurrent();
      if (!record) return;
      this.chatRecordId = record.id;
      this.logBack = "R";
      this.page = "SL";
    } else if (this.page === "T") {
      this.logBack = "T";
      this.page = "SL";
    } else if (this.page === "WA") {
      this.page = "SAL";
    } else if (this.page === "W") {
      this.page = "L";
    } else {
      return;
    }
    this.logScroll = 0;
    this.requestRender();
  }

  private copyFocusedResult(): void {
    const record = this.focusedRecord();
    if (record) copyRecordResult(record, (message, type) => this.deps.notify?.(message, type));
  }

  private pauseResumeFocused(): void {
    const record = this.focusedRecord();
    if (record) this.pauseResumeAgent(record);
  }

  /**
   * `x` on a page showing one agent — T and WA (the transcript pages), SL and
   * SAL (the logs): two-press, exactly like the roster's `stopSelected` — the
   * first press arms and the band says `x again to STOP`, the second aborts.
   * Any other key disarms (see `pageUnhandledKey` and `handleLogKey`).
   */
  private stopFocused(): void {
    const record = this.focusedRecord();
    if (!record || (record.status !== "running" && record.status !== "queued")) return;
    if (!this.stopArmed) {
      this.stopArmed = true;
      this.requestRender();
      return;
    }
    this.stopArmed = false;
    if (this.deps.manager.abort(record.id)) {
      this.deps.notify?.(`Stopped "${record.description}".`, "info");
    }
    this.requestRender();
  }

  /** One scroll step inside a log page, clamped at the ends. */
  private scrollLog(delta: number): void {
    this.logScroll = Math.max(0, this.logScroll + delta);
    this.requestRender();
  }

  /**
   * The window of log lines the pane shows, from `offset` toward the tail —
   * and the readout the band reports for it, which is exactly this window.
   */
  private scrollTail(lines: readonly WorkflowCardLine[], offset: number, rows: number): WorkflowCardLine[] {
    const max = Math.max(0, lines.length - rows);
    const start = Math.max(0, Math.min(offset, max));
    this.logReadout = {
      lines: lines.length,
      percent: lines.length <= rows ? 100 : Math.round(((start + rows) / lines.length) * 100),
    };
    return lines.slice(start, start + rows);
  }

  /**
   * One roster row: the cursor, the state glyph and the name, plus a run row's
   * `<done>/<total>` counter flush right. Identity only: the master cell is 18
   * columns, so a description, live activity or stats tail could never survive
   * here — the detail pane's header and preview carry them.
   */
  private renderEntry(entry: HubEntry, selected: boolean, width: number): string {
    const th = this.theme;
    const marker = selected ? th.fg("accent", "❯") : " ";
    if (entry.kind === "workflow") {
      const wf = entry.workflow;
      const glyph = workflowStatusGlyph(wf.status, th);
      const name = selected ? th.fg("text", wf.name) : th.fg("muted", wf.name);
      // The counter is the run row's one datum: it is measured first and the
      // name truncates into the columns left of it, so the counter is never
      // the side that gets cut.
      const counter = `${wf.doneCount}/${wf.totalCount}`;
      const prefix = `${marker} ${glyph} `;
      return finishRow(
        `${prefix}${name}`,
        visibleWidth(prefix),
        selected ? th.fg("text", counter) : th.fg("dim", counter),
        width,
      );
    }
    const record = entry.record;
    const glyph = statusGlyph(record.status, th);
    const name = renderAgentRecordName(record, th, selected
      ? { fallbackColor: "text", bold: true }
      : { fallbackColor: "muted" });
    return `${marker} ${glyph} ${name}`;
  }

  private renderActivity(bodyRows: number): WindowRow[] {
    const th = this.theme;
    const lines: WindowRow[] = [];
    // This view keeps its legacy lifecycle order (active → completed →
    // failed); the roster itself is launch-stable, so re-rank agents here only.
    const items = [...this.entries()].sort((a, b) => {
      if (a.kind !== "agent" || b.kind !== "agent") return 0;
      return chatGroupRank(a.record.status) - chatGroupRank(b.record.status)
        || a.record.startedAt - b.record.startedAt;
    });
    if (items.length === 0) {
      lines.push(fullRow(th.fg("dim", "(nothing running)")));
      return lines;
    }
    for (let i = 0; i < bodyRows; i++) {
      const entry = items[i];
      if (!entry) { lines.push(fullRow("")); continue; }
      if (entry.kind === "workflow") {
        const wf = entry.workflow;
        lines.push(fullRow(
          `${th.fg("muted", "workflow")} ${wf.name}  ${th.fg("dim", `${wf.doneCount}/${wf.totalCount} agents · ${wf.status}`)}`,
        ));
        continue;
      }
      const record = entry.record;
      const act = this.deps.agentActivity.get(record.id);
      const doing = act
        ? describeActivity(act.activeTools, act.responseText)
        : record.status === "running" ? "thinking…" : record.status;
      const turns = act?.maxTurns ? ` · turn ${act.turnCount}/${act.maxTurns}` : act ? ` · turn ${act.turnCount}` : "";
      const line = `${statusGlyph(record.status, th)} ${renderAgentRecordName(record, th, {})}  ${th.fg(record.status === "running" ? "text" : "dim", doing)}${th.fg("dim", turns)}`;
      lines.push(fullRow(line));
    }
    return lines;
  }

}

/** One full-width window row, from content this surface has already shaped. */
function fullRow(text: string): WindowRow {
  return { kind: "full", cells: [{ text }] };
}

/** `HH:MM:SS` — the log pages' event rows are timestamps first. */
function stamp(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** A run source with nothing in it, for pages whose run has been swept. */
const EMPTY_RUN_SOURCE: WorkflowDialogSource = {
  progress: [],
  task: { status: "completed", startTime: 0 },
  agentCount: 0,
};

/** The inspector's empty-agents copy, so both surfaces say it the same way. */
const WORKFLOW_NO_AGENTS = "No agents";

/** A run's agents in run order, flattened across its phase groups. */
function flattenRunAgents(source: WorkflowDialogSource): WorkflowAgentEntry[] {
  return buildPhaseGroups(source.progress, source.meta?.phases).flatMap(group => group.agents);
}

/** A pane's lines, cut or padded to the body height so both cells stay level. */
function padLines(lines: readonly PaneRow[], rows: number): PaneRow[] {
  const out = lines.slice(0, rows);
  while (out.length < rows) out.push([]);
  return out;
}

/**
 * Paint the shared window's cells with this surface's theme. Content the
 * surface styled itself arrives as a colourless cell and passes through
 * untouched; the bars, rules and labels the window contributes arrive with a
 * role colour and are painted here. Styling only — the layout is the window's.
 */
function paintWindow(lines: readonly WorkflowCardLine[], th: Theme): string[] {
  return lines.map(line =>
    line
      .map(segment => {
        const text = segment.bold ? th.bold(segment.text) : segment.text;
        return segment.color ? th.fg(segment.color, text) : text;
      })
      .join(""),
  );
}

/** Left cell + a right-aligned tail, truncated hard so lines never wrap. */
function finishRow(left: string, minWidth: number, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(minWidth, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft, "…");
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}
