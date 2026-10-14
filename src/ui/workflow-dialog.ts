/**
 * workflow-dialog.ts — the `/agents → Workflows` inspector.
 *
 * Three levels inside one agent-hub-style window:
 *
 * ```
 * ╭ review-changes ───────────────────── 3/7 agents · 1m12s ─╮
 * │ Review changed files across dimensions                  │
 * ├ ─ Phases ──────┬─ Verify · 1 agent ───────────────────── ┤
 * │ ❯ ✔ Review 3/3 │ ❯ ◌ verify:auth.ts · attempt 2 · wait 8s│
 * │   2 Verify 1/2 │                                         │
 * ├ ───────────────┴───────────────────────────────────────── ┤
 * │ ↑↓ select · ⏎ open · f filter · x stop · esc close       │
 * ╰──────────────────────────────────────────────────────────╯
 * ```
 *
 * Enter on a phase swaps the panes — that phase's agents move left and the
 * right becomes the agent's Prompt / Activity / Outcome detail. Enter on an
 * agent with a conversation descends to the third level: the agent's live
 * `ConversationViewer` embedded frameless in the right pane, the same surface
 * the agent hub's chat view shows. Esc walks back one level at a time.
 *
 * The window is the hub's popup chrome — title inside the frame, hints in a
 * bordered footer, `border`-coloured rules — and sized like it too: the shell
 * spans the overlay's whole width and fills the same 70%-of-terminal ceiling
 * the hub's overlay caps at, rather than shrink-wrapping the content.
 *
 * A phase with no agents yet shows its number and nothing else. The single-pane
 * layout this replaced spelled that out as "Not started yet"; the left pane is
 * too narrow to hold the words, and a numbered row with no count says it.
 *
 * **The glyphs are not the card's glyphs.** `workflow-card.ts` keys off the raw
 * entry `state`; this file keys off the *derived* `displayState(entry, active)`
 * and splits cases the card cannot see — skipped, blocked, queued and
 * interrupted all render as a plain ✘ or ⟳ inline but are distinct here. `◌`
 * (U+25CC) appears only in this file, and a running row animates a spinner where
 * the card draws a static `⟳`.
 *
 * **The phases pane is stranger still**: a phase that has not finished shows
 * *its number*, not a glyph. That is deliberate, recovered behaviour.
 *
 * **The layout is pure.** `layoutWorkflowDialog` returns coloured segments and
 * `handleWorkflowDialogKey` maps a keypress to the next state plus an optional
 * action; neither touches a theme, a terminal, or the workflow runtime. The
 * `WorkflowDialog` component is the shell that wires those to `ctx.ui`, and
 * the runtime side arrives as injected `WorkflowDialogActions` plus the
 * optional {@link WorkflowDialogLogDeps} the third level needs. The log level
 * renders as themed strings (the viewer's output), so it bypasses the segment
 * layout — the same split `agent-hub.ts` makes between its table and chat
 * renderers.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import {
  type Component,
  matchesKey,
  type ScrollViewScrollbar,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  buildPhaseGroups,
  displayState,
  formatDuration,
  header,
  isLive,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
} from "../workflow/progress.js";
import { type AgentActivity, SPINNER, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { copyRecordResult } from "./copy-result.js";
import { disableTerminalMouse, enableTerminalMouse, parseMouseInput } from "./terminal-mouse.js";
import {
  ASCII_GLYPHS,
  clampLine,
  formatCompactTokens,
  formatModel,
  formatThinking,
  REPLAYED_ANNOTATION,
  styleWorkflowCardLines,
  UNICODE_GLYPHS,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;


/** Inner width of the left pane at any comfortable terminal size. */
const LEFT_PANE_WIDTH = 18;

/**
 * Most rows the frame will ever draw between its top and bottom edges.
 *
 * A cap, not a height: the box sizes itself to what it holds, and this is where
 * it stops growing so a 200-agent fan-out scrolls inside the pane instead of
 * pasting 200 rows into the conversation. The live shell overrides it with the
 * hub-derived height below.
 */
export const DEFAULT_PANE_BODY_ROWS = 22;
/**
 * Fewest rows the frame will draw.
 *
 * Below this a pane stops reading as a pane, and the box would resize on
 * nearly every keypress — most phases hold a handful of agents, so a floor here
 * absorbs the ordinary movement and leaves the height alone.
 */
export const MIN_PANE_BODY_ROWS = 6;
/**
 * Non-body rows the window draws around its panes: top and bottom borders, the
 * two header rows, the titled rule above the panes, the plain rule below them
 * and the footer. The shell subtracts this from the hub's 70%-of-terminal
 * ceiling to get its body height, so the whole window lands under the same cap
 * the hub's overlay clips at.
 */
export const WINDOW_CHROME_ROWS = 7;
/** Prompt lines shown before `expand` is offered. */
export const PROMPT_COLLAPSED_LINES = 4;
/** Spinner cadence. Unlike the card's 1s header tick, this row really animates. */
export const WORKFLOW_DIALOG_SPINNER_MS = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowDialogGlyphs {
  tick: string;
  cross: string;
  /** `◌` — queued or interrupted. The card has no row that draws this. */
  queued: string;
  /** `figures.pointer` — the selected row in either pane. */
  pointer: string;
  /** Marks whichever pane currently owns j/k. */
  focus: string;
  /** Running rows cycle these. */
  spinner: readonly string[];
  /** The pane frame: corners, edges and the tees where the two panes meet. */
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    topTee: string;
    bottomTee: string;
    /** The window's rule ends: `├` / `┤`. */
    leftTee: string;
    rightTee: string;
  };
  /** Trailing marker on a title the pane was too narrow to hold. */
  ellipsis: string;
  /** How the footer names the arrow keys and Enter. */
  upDown: string;
  enter: string;
}

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: UNICODE_GLYPHS.tick,
  cross: UNICODE_GLYPHS.cross,
  queued: "◌",
  pointer: "❯",
  focus: UNICODE_GLYPHS.pointer,
  spinner: SPINNER,
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    topTee: "┬",
    bottomTee: "┴",
    leftTee: "├",
    rightTee: "┤",
  },
  ellipsis: "…",
  upDown: "↑↓",
  enter: "⏎",
};

/** The ASCII tier, one column per glyph so the panes stay aligned either way. */
export const ASCII_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: ASCII_GLYPHS.tick,
  cross: ASCII_GLYPHS.cross,
  queued: "o",
  pointer: ">",
  focus: ASCII_GLYPHS.pointer,
  spinner: ["-", "\\", "|", "/"],
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topTee: "+",
    bottomTee: "+",
    leftTee: "+",
    rightTee: "+",
  },
  ellipsis: "~",
  upDown: "up/down",
  enter: "enter",
};

/**
 * The recovered dialog mapping — keyed on the *display* state.
 *
 * Claude Code's `permission` colour has no pi equivalent; a blocked agent is
 * waiting on the user, so it maps to `warning` (selection maps to `accent`).
 */
export function dialogRowGlyph(
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
  switch (state) {
    case "done":
      return { text: glyphs.tick, color: "success" };
    case "failed":
      return { text: glyphs.cross, color: "error" };
    case "skipped":
      return { text: glyphs.cross, color: "dim" };
    case "blocked":
      return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted":
      return { text: glyphs.queued, color: "dim" };
    case "running":
      return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Verbatim copy
 * ------------------------------------------------------------------------- */

/**
 * Claude Code's own strings. Kept together and named so a reader can see at a
 * glance which surface each belongs to, and so none drifts under an edit.
 */
export const WORKFLOW_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  availableOnceStarted: "Available once the agent starts.",
  notAvailableYet: "Not available yet (agent still running).",
  noTranscript: "Transcript not available.",
  stoppedEarly: "The workflow stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noToolCallsYet: "No tool calls yet.",
  noToolCalls: "No tool calls.",
  noAgents: "No agents",
} as const;

/* ------------------------------------------------------------------------- *
 * State
 * ------------------------------------------------------------------------- */

/**
 * Which of the three drill-down levels is showing.
 *
 * `phases` is the overview — phases on the left, the selected phase's agents on
 * the right. `agent` is the subview reached by opening one: the same phase's
 * agents move to the left pane and the right pane becomes that agent's detail.
 * `log` is the third level, reached from `agent` when the selected agent has a
 * conversation: the same list stays left and the right pane becomes the agent's
 * live `ConversationViewer`. The panes never change count, only what they hold,
 * which is what makes the frame stay put as you drill in and back out.
 */
export type WorkflowDialogLevel = "phases" | "agent" | "log";

/** `all`, or exactly one display state. */
export type WorkflowDialogFilter = "all" | WorkflowDisplayState;

/** The order `f` cycles through. */
export const WORKFLOW_DIALOG_FILTERS: readonly WorkflowDialogFilter[] = [
  "all",
  "running",
  "queued",
  "done",
  "failed",
  "blocked",
  "skipped",
  "interrupted",
];

export interface WorkflowDialogState {
  /** Raw selection; `clampedPhase` is what actually renders. */
  selectedPhase: number;
  selectedAgent: number;
  level: WorkflowDialogLevel;
  filter: WorkflowDialogFilter;
  promptExpanded: boolean;
}

export function initialWorkflowDialogState(initialPhaseIndex = 0): WorkflowDialogState {
  return {
    selectedPhase: initialPhaseIndex,
    selectedAgent: 0,
    level: "phases",
    filter: "all",
    promptExpanded: false,
  };
}

/** State carried across the popup ↔ full-screen reopen cycle. */
export interface WorkflowDialogResumeState {
  /** The previous instance's drill-down state, written back at toggle time. */
  state?: WorkflowDialogState;
}

/** Optional constructor state: which window size to start in, and what to restore. */
export interface WorkflowDialogInitial {
  /** Start windowed (the default) or full-screen. */
  popup?: boolean;
  /** Shared object a toggle writes the live state into, for the reopen to restore. */
  resume?: WorkflowDialogResumeState;
}

/** Everything the dialog reads about a run, so it can be driven from a stub. */
export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that reported. */
  agentCount?: number;
}

export interface WorkflowDialogInput extends WorkflowDialogSource {
  state: WorkflowDialogState;
  /**
   * Which actions the caller actually wired. Absent keys default to available,
   * so layout tests and read-only callers keep the full footer; a caller that
   * wires only some actions passes the map so the hints stay truthful.
   * `onOpenLog` is not a {@link WorkflowDialogActions} key — it exists only
   * when the constructor got {@link WorkflowDialogLogDeps} — so it is named
   * here separately.
   */
  available?: Partial<Record<keyof WorkflowDialogActions | "onOpenLog", boolean>>;
  /** Whether the dialog is showing full-screen — names the `f` hint accordingly. */
  fullscreen?: boolean;
  now?: number;
  /**
   * The width the overlay host asks the component to render at — the overlay's
   * box, not the terminal's. The frame spans all of it; the content width is
   * derived from it by {@link workflowDialogContentWidth}.
   */
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
  /**
   * Most rows the frame may use, overriding {@link DEFAULT_PANE_BODY_ROWS}.
   *
   * The frame still sizes to its content and still respects
   * {@link MIN_PANE_BODY_ROWS}; this only moves the ceiling.
   */
  bodyRows?: number;
}

/** The actions the dialog needs from the workflow runtime, injected. */
export interface WorkflowDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  /** `index` is the entry's stable `index`, not its row position. */
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
  /**
   * Open the selected agent's conversation.
   *
   * `recordId` is the manager's id for the child, which the entry carries once
   * the host has reported one — the dialog knows nothing about sessions, so
   * what happens to an id whose record has since been swept is the caller's to
   * say. The only key here that shows something rather than changing the run.
   */
  onOpenAgent?(recordId: string): void;
}

/**
 * What the third level needs to embed one agent's live conversation.
 *
 * The same knobs the agent hub hands its chat viewer, resolved against the
 * session the dialog runs in. Absent from the constructor — a bare layout test,
 * or a caller that does not want the level — the level does not exist: Enter at
 * the detail level falls through, and the footer never advertises it.
 */
export interface WorkflowDialogLogDeps {
  /** The record behind an entry's `recordId`, or undefined once swept. */
  getRecord(recordId: string): AgentRecord | undefined;
  /** Abort and steering for the viewer's stop and compose affordances. */
  manager: Pick<AgentManager, "abort" | "steer">;
  /** In-flight activity the viewer renders under tool calls. */
  agentActivity: Map<string, AgentActivity>;
  /** Whether the viewer's header shows an estimated cost. Read at each open. */
  showCost: () => boolean;
  /** The user's `viewerMarkdown` setting, read live by the viewer. */
  viewerMarkdown?: () => ViewerMarkdownMode;
  /** Persist a mode chosen with `m` in the viewer. */
  onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
  /** Pi's fullscreen scrollbar preference. */
  scrollbarMode?: () => ScrollViewScrollbar;
  /** Surface a swept record. Omitted → silent. */
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  /**
   * Pause/resume for the log level's `p` key, wired by the extension to the
   * same funnel the `/agents` commands use — the hub's `AgentHubDeps` pair.
   * `pauseAgent` returns why the pause was refused, so the toast never claims
   * a pause that did not land. Omitted → `p` does nothing.
   */
  pauseAgent?: (id: string) => string | undefined;
  resumeAgent?: (id: string) => boolean;
}

export type WorkflowDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number }
  | { kind: "open"; recordId: string }
  | { kind: "open-log" }
  | { kind: "toggle-fullscreen" };

export interface ResolvedWorkflowDialog {
  groups: PhaseGroup[];
  clampedPhase: number;
  clampedAgent: number;
  /** The selected phase's agents, after the state filter. */
  visibleAgents: WorkflowAgentEntry[];
  selectedEntry: WorkflowAgentEntry | undefined;
  /** False once the run stops — which is what turns live agents "interrupted". */
  workflowActive: boolean;
  paused: boolean;
}

/**
 * The window's width, for the width the overlay host hands the component.
 *
 * All of it: the override is built at the hub's geometry — the popup's 90% of
 * the terminal, or the full-screen 100% — and the frame's own border and
 * padding are drawn *inside* that box (`windowRow` and `paneBodyRow` spend
 * four of its columns), so none of it belongs to them. Reserving them here
 * counts them twice: the frame stops six columns short of the overlay's right
 * edge, in the popup and in the full-screen window alike, and the host pads
 * the rest of the box with blanks. Only the narrow-terminal floor remains.
 */
export function workflowDialogContentWidth(overlayWidth: number): number {
  return Math.max(12, overlayWidth);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

/**
 * Settle the selection against the data actually present.
 *
 * Selection is stored raw and clamped on read, so a phase finishing (and its
 * agents dropping out of a filtered view) never leaves the cursor pointing past
 * the end — the same trick `fleet-list.ts` plays, minus the mutation.
 */
export function resolveWorkflowDialog(input: WorkflowDialogInput): ResolvedWorkflowDialog {
  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const workflowActive = input.task.status === "running" || input.task.status === "paused";
  const clampedPhase = clampIndex(input.state.selectedPhase, groups.length);
  const all = groups[clampedPhase]?.agents ?? [];
  const visibleAgents =
    input.state.filter === "all"
      ? [...all]
      : all.filter(entry => displayState(entry, workflowActive) === input.state.filter);
  const clampedAgent = clampIndex(input.state.selectedAgent, visibleAgents.length);

  return {
    groups,
    clampedPhase,
    clampedAgent,
    visibleAgents,
    selectedEntry: visibleAgents[clampedAgent],
    workflowActive,
    paused: input.task.status === "paused",
  };
}

/* ------------------------------------------------------------------------- *
 * Row pieces
 * ------------------------------------------------------------------------- */

/**
 * The `·`-separated annotations between an agent's label and its stats.
 *
 * These say *why* a row looks the way it does — a retry and its cause, a cache
 * hit replayed from the resume journal, how long a queued agent has been
 * waiting. The stat tail (agentType, model, tokens, tool calls, duration) is the
 * card's and is appended after.
 */
export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.isolation) parts.push(entry.isolation);
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if (entry.lastAttemptReason) {
    parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  }
  if (entry.attempt != null && entry.attempt > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/** Place `right` flush to `width`, cutting `left` first so the stats survive. */
function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

/**
 * Window a list around its selection, so a 200-agent fan-out still shows the
 * row you are on. Mirrors `fleet-list.ts`'s arithmetic.
 */
function windowRange(selected: number, total: number, max: number): { start: number; end: number } {
  const visible = Math.min(max, total);
  const start = selected < visible ? 0 : selected - visible + 1;
  return { start, end: start + visible };
}

/* ------------------------------------------------------------------------- *
 * The pane frame
 * ------------------------------------------------------------------------- */

/**
 * Inner width of the left pane.
 *
 * Fixed rather than proportional at usable terminal sizes: the left pane holds
 * short labels (a phase title, an agent label) and the right pane holds
 * everything that actually needs room, so giving the left a share of a wide
 * terminal would only pad it. It gives way on a narrow one.
 */
export function leftPaneWidth(width: number): number {
  // The two cells share everything except the three border columns, and the
  // right one must keep at least a column — so the left is capped by what it
  // can take without squeezing the right out and tearing the frame.
  const available = Math.max(2, width - 3);
  return Math.max(1, Math.min(LEFT_PANE_WIDTH, Math.floor(available / 3), available - 1));
}

/**
 * The agents pane's title: the phase it lists, and how many rows survive the
 * filter — with a filter on, the count is of what survived it, so the title
 * never reads as the whole phase.
 */
export function agentPaneTitleFor(filter: WorkflowDialogFilter, phaseTitle: string, shown: number): string {
  return filter === "all"
    ? `${phaseTitle} · ${shown} agent${shown === 1 ? "" : "s"}`
    : `${phaseTitle} · ${shown} ${filter}`;
}

/** Fill a title out to the cell width with rule, so the corners stay put. */
function padTitle(line: WorkflowCardLine, width: number, horizontal: string): WorkflowCardLine {
  const gap = Math.max(0, width - lineWidth(line));
  return gap > 0 ? [...line, { text: horizontal.repeat(gap), color: "dim" }] : line;
}

/** One pane row, padded to exactly `width` so the frame stays vertical. */
function padCell(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped = clampLine(line, width);
  const gap = Math.max(0, width - lineWidth(clamped));
  return gap > 0 ? [...clamped, { text: " ".repeat(gap) }] : clamped;
}

/**
 * A window row: content between the outer borders, one padding column each
 * side — the hub's row shape (`│ content │`).
 */
function windowRow(content: WorkflowCardLine, width: number, glyphs: WorkflowDialogGlyphs): WorkflowCardLine {
  const inner = clampLine(content, width - 4);
  const gap = Math.max(0, width - 4 - lineWidth(inner));
  return [
    { text: glyphs.box.vertical, color: "border" },
    { text: " " },
    ...inner,
    { text: " ".repeat(gap + 1) },
    { text: glyphs.box.vertical, color: "border" },
  ];
}

/** A title as it sits in a rule: ` Title ` then rule to `width`. */
function frameTitle(title: string, width: number, glyphs: WorkflowDialogGlyphs): WorkflowCardSegment[] {
  const room = Math.max(0, width - 2);
  // Truncated with the marker rather than simply cut: `Discover · 1 ag…` has to
  // read as "there was more", not as a title that happens to end oddly. Pi's
  // own truncation does the width arithmetic, including wide characters; its
  // ellipsis arrives wrapped in resets, which are stripped for the same reason
  // `clampLine` strips them — the layout stays plain text until it is themed.
  const shown = stripTerminalSequences(truncateToWidth(title, room, glyphs.ellipsis));
  const rule = Math.max(0, width - visibleWidth(shown) - 2);
  // Clamped as well as computed: at a terminal narrow enough that `room` hits
  // zero the marker alone is already wider than the cell, and a title that
  // overflows tears the frame open on every row below it.
  return clampLine(
    [
      { text: " ", color: "dim" },
      { text: shown, color: "muted", bold: true },
      { text: ` ${glyphs.box.horizontal.repeat(rule)}`, color: "border" },
    ],
    width,
  );
}

/** One body row: the two cells zipped between the shared vertical borders. */
function paneBodyRow(
  left: WorkflowCardLine | undefined,
  right: WorkflowCardLine | undefined,
  leftWidth: number,
  rightWidth: number,
  glyphs: WorkflowDialogGlyphs,
): WorkflowCardLine {
  return [
    { text: glyphs.box.vertical, color: "border" },
    ...padCell(left ?? [], leftWidth),
    { text: glyphs.box.vertical, color: "border" },
    ...padCell(right ?? [], rightWidth),
    { text: glyphs.box.vertical, color: "border" },
  ];
}

/**
 * The rule under the header (or under the panes): `├` + cells + `┤`, with the
 * pane titles carried in the upper one and a `┬` where the panes meet.
 */
function paneRule(options: {
  leftTitle?: string;
  rightTitle?: string;
  leftWidth: number;
  rightWidth: number;
  glyphs: WorkflowDialogGlyphs;
}): WorkflowCardLine[] {
  const { glyphs } = options;
  const rule = (width: number): WorkflowCardSegment => ({ text: glyphs.box.horizontal.repeat(width), color: "border" });
  const line: WorkflowCardLine = [{ text: glyphs.box.leftTee, color: "border" }];
  if (options.leftTitle !== undefined) {
    line.push(...padTitle(frameTitle(options.leftTitle, options.leftWidth, glyphs), options.leftWidth, glyphs.box.horizontal));
    line.push({ text: glyphs.box.topTee, color: "border" });
    line.push(
      ...padTitle(frameTitle(options.rightTitle ?? "", options.rightWidth, glyphs), options.rightWidth, glyphs.box.horizontal),
    );
  } else {
    line.push(rule(options.leftWidth));
    line.push({ text: glyphs.box.vertical, color: "border" });
    line.push(rule(options.rightWidth));
  }
  line.push({ text: glyphs.box.rightTee, color: "border" });
  return [line];
}

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/** Split a preview into lines, treating an empty preview as absent. */
const previewLines = (preview: string | undefined) => (preview ? preview.split("\n") : []);

/** What the Activity body says. There is a count of tool calls, never a list. */
function activityBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  if (state === "queued") return WORKFLOW_DIALOG_COPY.availableOnceStarted;
  if ((entry.toolCalls ?? 0) > 0) return WORKFLOW_DIALOG_COPY.noTranscript;
  return isLive(entry) ? WORKFLOW_DIALOG_COPY.noToolCallsYet : WORKFLOW_DIALOG_COPY.noToolCalls;
}

/** What the Outcome body says, which is a different sentence for every state. */
function outcomeBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "skipped":
      return WORKFLOW_DIALOG_COPY.skippedByUser;
    case "interrupted":
      return WORKFLOW_DIALOG_COPY.stoppedEarly;
    case "queued":
      return WORKFLOW_DIALOG_COPY.waitingForSlot;
    case "running":
      return WORKFLOW_DIALOG_COPY.notAvailableYet;
    case "failed":
    case "blocked":
      return entry.error ?? WORKFLOW_DIALOG_COPY.noTranscript;
    case "done":
      return entry.resultPreview ?? WORKFLOW_DIALOG_COPY.noTranscript;
  }
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/**
 * Which of the per-agent actions the selected row can currently take.
 *
 * The window for both is the one in which the agent's `agent()` call is still
 * unanswered. Skip covers that whole window; retry needs a child to stop and
 * start again, so it begins only once one exists. Once the call has settled its
 * value is already the script's, and there is nothing either key could change.
 */
export function agentActions(
  entry: WorkflowAgentEntry | undefined,
  workflowActive: boolean,
): { skip: boolean; retry: boolean } {
  if (entry === undefined || !workflowActive) return { skip: false, retry: false };
  const state = displayState(entry, workflowActive);
  return { skip: state === "queued" || state === "running", retry: state === "running" };
}

/** Status word the detail pane leads with, one per display state. */
function statusWord(state: WorkflowDisplayState): string {
  switch (state) {
    case "done": return "Completed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    case "blocked": return "Blocked";
    case "queued": return "Queued";
    case "interrupted": return "Stopped";
    case "running": return "Running";
  }
}

/** `Prompt · 5 lines · ⏎ expand` — a detail heading and its dim suffixes. */
function detailHeading(title: string, suffixes: readonly string[], width: number): WorkflowCardLine {
  const line: WorkflowCardLine = [{ text: " " }, { text: title, color: "muted", bold: true }];
  for (const suffix of suffixes) {
    line.push({ text: " · ", color: "dim" }, { text: suffix, color: "dim" });
  }
  return clampLine(line, width);
}

/** A detail body line, indented under its heading. */
const detailBody = (text: string, width: number): WorkflowCardLine =>
  clampLine([{ text: `   ${text}`, color: "dim" }], width);

/** The row for one agent, as it appears in whichever pane is listing agents. */
function agentRow(options: {
  entry: WorkflowAgentEntry;
  selected: boolean;
  compact: boolean;
  width: number;
  glyphs: WorkflowDialogGlyphs;
  workflowActive: boolean;
  spinnerFrame: number;
  now: number;
}): WorkflowCardLine {
  const { entry, selected, glyphs, width } = options;
  const display = displayState(entry, options.workflowActive);
  const head: WorkflowCardLine = [
    { text: " " },
    { text: selected ? glyphs.pointer : " ", color: "accent" },
    { text: " " },
    dialogRowGlyph(display, glyphs, options.spinnerFrame),
    { text: " " },
    { text: entry.label, color: selected ? "accent" : undefined },
  ];
  // The narrow pane holds the label and nothing else; there is no room for a
  // stat tail, and clamping one would just spend columns on a truncated word.
  if (options.compact) return clampLine(head, width);

  const model = formatModel(entry);
  if (model) head.push({ text: ` ${model}`, color: "dim" });
  for (const part of [...subStatusAnnotations(entry, display, options.now), ...rowStatSegments(entry)]) {
    head.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
  }
  // The duration sits flush right, so a column of rows reads as a column of
  // durations rather than as ragged text.
  const duration = entry.durationMs ? [{ text: `${formatDuration(entry.durationMs)} `, color: "dim" as const }] : [];
  return duration.length > 0 ? rightAlign(head, duration, width) : clampLine(head, width);
}

/** The agent row's dot-separated tail. The model is not in it — it leads. */
function rowStatSegments(entry: WorkflowAgentEntry): string[] {
  return entry.tokens ? [`${formatCompactTokens(entry.tokens)} tok`] : [];
}

/**
 * Build the dialog.
 *
 * Two panes side by side inside one frame, and two levels of depth: phases with
 * the selected phase's agents beside them, then — on opening one — those agents
 * with the selected agent's detail beside them. The frame is a fixed height so
 * the dialog does not jump as the selection moves through runs of very
 * different sizes.
 */
export function layoutWorkflowDialog(input: WorkflowDialogInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = workflowDialogContentWidth(input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();
  const view = resolveWorkflowDialog(input);
  const { state } = input;
  // What the panes may *hold*. Given a height — the live shell derives it from
  // the hub's 70%-of-terminal ceiling — the window fills exactly that, the way
  // the hub's popup does; without one, it shrink-wraps to the content, which is
  // what the layout tests render against.
  const provided = input.bodyRows !== undefined;
  const capacity = Math.max(MIN_PANE_BODY_ROWS, input.bodyRows ?? DEFAULT_PANE_BODY_ROWS);
  const spinnerFrame = input.spinnerFrame ?? 0;

  const lines: WorkflowCardLine[] = [];

  // ---- The window's top edge, then the header rows it wraps: the run's name
  // with the counters flush right (the hub puts its counts on the title line),
  // and the description under it.
  const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, now);
  lines.push([{ text: glyphs.box.topLeft, color: "border" }, { text: glyphs.box.horizontal.repeat(width - 2), color: "border" }, { text: glyphs.box.topRight, color: "border" }]);
  lines.push(
    windowRow(
      rightAlign(
        [{ text: head.name, color: "toolTitle", bold: true }],
        head.stats ? [{ text: `${head.stats} `, color: "dim" }] : [],
        width - 6,
      ),
      width,
      glyphs,
    ),
  );
  if (head.subtext) {
    lines.push(windowRow([{ text: head.subtext, color: "dim" }], width, glyphs));
  }

  // The panes span the window's full inner width, so their right bar sits ON
  // the window's right border and the divider stays in one column across the
  // levels: left + right + the three bars = width, exactly.
  const frameWidth = width;
  const leftWidth = leftPaneWidth(frameWidth);
  const rightWidth = Math.max(1, frameWidth - leftWidth - 3);
  const inPhases = state.level === "phases";
  const entry = view.selectedEntry;

  // ---- The pane listing phases, shown only at the overview level.
  const phaseRows: WorkflowCardLine[] = [];
  const digits = String(view.groups.length).length;
  const phases = windowRange(view.clampedPhase, view.groups.length, capacity);
  for (let i = phases.start; i < Math.min(phases.end, view.groups.length); i++) {
    const group = view.groups[i];
    const selected = i === view.clampedPhase;
    const color: WorkflowCardColor =
      selected ? "accent"
      : group.status === "done" ? "success"
      : group.status === "failed" ? "error"
      : "dim";
    // An unfinished phase shows its number where a finished one shows a glyph —
    // so the list doubles as a numbered plan of the run.
    const glyph =
      group.status === "done" ? glyphs.tick
      : group.status === "failed" ? glyphs.cross
      : String(i + 1);
    phaseRows.push(
      rightAlign(
        [
          { text: " " },
          { text: selected ? glyphs.pointer : " ", color: "accent" },
          { text: " " },
          { text: glyph.padStart(digits), color },
          { text: " " },
          { text: group.title, color },
        ],
        group.totalCount === 0 ? [] : [{ text: `${group.doneCount}/${group.totalCount} `, color }],
        leftWidth,
      ),
    );
  }

  // ---- The pane listing this phase's agents. It is the right pane at the
  // overview level and the left pane in the subview, so it is built once.
  const agentPaneWidth = inPhases ? rightWidth : leftWidth;
  const agentRows: WorkflowCardLine[] = [];
  if (view.visibleAgents.length === 0) {
    agentRows.push(clampLine([{ text: `   ${WORKFLOW_DIALOG_COPY.noAgents}`, color: "dim" }], agentPaneWidth));
  } else {
    const agents = windowRange(view.clampedAgent, view.visibleAgents.length, capacity);
    for (let i = agents.start; i < Math.min(agents.end, view.visibleAgents.length); i++) {
      agentRows.push(
        agentRow({
          entry: view.visibleAgents[i],
          selected: i === view.clampedAgent,
          compact: !inPhases,
          width: agentPaneWidth,
          glyphs,
          workflowActive: view.workflowActive,
          spinnerFrame,
          now,
        }),
      );
    }
  }

  // ---- The detail pane, in the subview only.
  const detailRows: WorkflowCardLine[] = [];
  if (!inPhases && entry) {
    const display = displayState(entry, view.workflowActive);
    // Prefers the canonical `provider/model-id` here — two providers can serve
    // models whose short names read alike, and this pane has the width for it.
    const model = formatModel(entry, { canonical: true });
    detailRows.push(
      clampLine(
        [
          { text: " " },
          dialogRowGlyph(display, glyphs, spinnerFrame),
          { text: ` ${statusWord(display)}`, color: "muted" },
          ...(model ? [{ text: " · ", color: "dim" as const }, { text: model, color: "dim" as const }] : []),
        ],
        rightWidth,
      ),
    );
    // Rebuilt rather than filtered out of `agentStatSegments`: the model and the
    // agent type are already on the line above, and the token count wants its
    // unit here exactly as it has one in the row.
    const stats: string[] = [];
    // The thinking level lives here rather than on the tight card row: it is
    // per-agent configuration, which is what someone opening this pane came to
    // see, and `thinking: medium` on every row of a fan-out would be noise.
    const thinking = formatThinking(entry);
    if (thinking) stats.push(thinking);
    if (entry.tokens) stats.push(`${formatCompactTokens(entry.tokens)} tok`);
    if (entry.toolCalls) stats.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
    if (entry.durationMs) stats.push(formatDuration(entry.durationMs));
    if (stats.length > 0) {
      detailRows.push(clampLine([{ text: ` ${stats.join(" · ")}`, color: "dim" }], rightWidth));
    }

    const prompt = previewLines(entry.promptPreview);
    const collapsed = !state.promptExpanded && prompt.length > PROMPT_COLLAPSED_LINES;
    const promptSuffix: string[] = [];
    if (prompt.length > 0) promptSuffix.push(`${prompt.length} ${prompt.length === 1 ? "line" : "lines"}`);
    if (prompt.length > PROMPT_COLLAPSED_LINES) {
      promptSuffix.push(`${glyphs.enter} ${state.promptExpanded ? "collapse" : "expand"}`);
    }
    detailRows.push([]);
    detailRows.push(detailHeading("Prompt", promptSuffix, rightWidth));
    if (prompt.length === 0) {
      detailRows.push(detailBody(WORKFLOW_DIALOG_COPY.availableOnceStarted, rightWidth));
    } else {
      const shown = collapsed ? prompt.slice(0, PROMPT_COLLAPSED_LINES) : prompt;
      for (const text of shown) detailRows.push(detailBody(text, rightWidth));
      // Named rather than silently cut: the reader has to know the prompt goes on.
      if (collapsed) {
        const hidden = prompt.length - PROMPT_COLLAPSED_LINES;
        detailRows.push(detailBody(`${glyphs.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}`, rightWidth));
      }
    }

    const toolCalls = entry.toolCalls ?? 0;
    detailRows.push([]);
    detailRows.push(
      detailHeading(
        "Activity",
        toolCalls > 0 ? [`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : [],
        rightWidth,
      ),
    );
    detailRows.push(detailBody(activityBody(entry, display), rightWidth));

    detailRows.push([]);
    detailRows.push(detailHeading("Outcome", [], rightWidth));
    // Wrapped, not clamped: the outcome is the thing the reader came for, and
    // cutting it at the pane edge would hide the half that matters.
    for (const text of wrapTextWithAnsi(outcomeBody(entry, display), Math.max(1, rightWidth - 4))) {
      detailRows.push(detailBody(text, rightWidth));
    }
  }

  const phaseTitle = view.groups[view.clampedPhase]?.title ?? "Phases";
  const agentPaneTitle = agentPaneTitleFor(state.filter, phaseTitle, view.visibleAgents.length);
  const leftRows = inPhases ? phaseRows : agentRows;
  const rightRows = inPhases ? agentRows : detailRows;
  // Tall enough for whichever pane holds more, and no taller — unless the
  // caller named a height, in which case the window fills it and the panes
  // pad out below their last row, so the dialog does not resize as the
  // selection moves.
  const bodyRows = provided ? capacity : Math.min(capacity, Math.max(MIN_PANE_BODY_ROWS, leftRows.length, rightRows.length));
  // The titled rule under the header; the panes' cells between shared borders;
  // the plain rule; the hints; the bottom edge.
  lines.push(
    ...paneRule({
      leftTitle: inPhases ? "Phases" : agentPaneTitle,
      rightTitle: inPhases ? agentPaneTitle : (entry?.label ?? WORKFLOW_DIALOG_COPY.noAgents),
      leftWidth,
      rightWidth,
      glyphs,
    }),
  );
  for (let row = 0; row < bodyRows; row++) {
    lines.push(paneBodyRow(leftRows[row], rightRows[row], leftWidth, rightWidth, glyphs));
  }
  lines.push(...paneRule({ leftWidth, rightWidth, glyphs }));

  // ---- Key hints ----
  // Only the actions the run can currently take, so the footer never advertises
  // a key that does nothing. Gated on `available` as well as run state: a caller
  // that wires only some of the actions must not get a footer advertising keys
  // that do nothing. Omitting `available` entirely keeps every hint, which is
  // what the layout tests want.
  const can = (action: keyof WorkflowDialogActions | "onOpenLog") => input.available?.[action] ?? true;
  const hints: string[] = [];
  if (inPhases) {
    hints.push(`${glyphs.upDown} select`);
    if (view.visibleAgents.length > 0) hints.push(`${glyphs.enter} open`);
    hints.push("f filter");
  } else {
    hints.push(`${glyphs.upDown} agent`);
    if (previewLines(entry?.promptPreview).length > PROMPT_COLLAPSED_LINES) {
      hints.push("e prompt");
    }
    const actions = agentActions(entry, view.workflowActive);
    if (actions.skip && can("onSkipAgent")) hints.push("s skip");
    if (actions.retry && can("onRetryAgent")) hints.push("r retry");
  }
  if (view.paused && can("onResume")) hints.push("p resume");
  else if (view.workflowActive && can("onPause")) hints.push("p pause");
  if (view.workflowActive && can("onKill")) hints.push("x stop");
  hints.push(inPhases ? "esc close" : "esc back");
  // The hub popup's expand key — offered at the detail level, where `f` is
  // free. Full-screen names the way back instead. It sits after the way out
  // (a narrow terminal drops it before `esc`) and before the two display-only
  // handoffs below, which exist to be dropped first.
  if (!inPhases) hints.push(input.fullscreen ? "f popup" : "f expand");
  // The two display-only hints sit AFTER the way out, because the footer is
  // clamped rather than wrapped: an 80-column terminal drops them — first
  // `c convo`, then `⏎ log` — before it drops the escape hatch. Both are gated
  // on the entry having a record id, so a row whose child has not been issued
  // one — a queued agent, a replayed one — does not promise a conversation
  // that does not exist.
  if (view.selectedEntry?.recordId !== undefined && can("onOpenLog")) {
    hints.push(`${glyphs.enter} log`);
  }
  if (view.selectedEntry?.recordId !== undefined && can("onOpenAgent")) {
    hints.push("c convo");
  }
  lines.push(windowRow([{ text: hints.join(" · "), color: "dim" }], width, glyphs));
  lines.push([
    { text: glyphs.box.bottomLeft, color: "border" },
    { text: glyphs.box.horizontal.repeat(width - 2), color: "border" },
    { text: glyphs.box.bottomRight, color: "border" },
  ]);

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

const nextFilter = (filter: WorkflowDialogFilter): WorkflowDialogFilter =>
  WORKFLOW_DIALOG_FILTERS[(WORKFLOW_DIALOG_FILTERS.indexOf(filter) + 1) % WORKFLOW_DIALOG_FILTERS.length];

/**
 * Map a keypress to the next state and, where the key is an action, what the
 * caller should do about it. Pure: `undefined` means "not ours".
 *
 * Movement clamps at both ends rather than wrapping — a long agent list should
 * not jump back to the top under a held `j`.
 */
export function handleWorkflowDialogKey(
  data: string,
  state: WorkflowDialogState,
  view: ResolvedWorkflowDialog,
): { state: WorkflowDialogState; action?: WorkflowDialogAction } | undefined {
  // Ctrl+C is the reflex for backing out of a full-screen overlay, so it closes
  // outright from EITHER level — the conversation viewer's #255 fix, which this
  // dialog is reached the same way as. Deliberately not folded into the `esc`
  // branch below: stepping back a level on the reflex key still leaves the
  // overlay on screen, which is the stuck feeling the key exists to avoid.
  if (matchesKey(data, "ctrl+c")) return { state, action: { kind: "cancel" } };

  // Back one level before out of the dialog: `esc` walks the drill-down back —
  // log → agent detail → overview — and only closes from the overview. Anything
  // else would make a wrong turn cost the whole dialog. (At the log level the
  // embedded viewer normally takes Esc first, via its `onBack`; this branch is
  // the handler-level walk-back the component falls back to.)
  if (matchesKey(data, "escape") || matchesKey(data, "q")) {
    if (state.level === "log") return { state: { ...state, level: "agent", promptExpanded: false } };
    if (state.level === "agent") return { state: { ...state, level: "phases", promptExpanded: false } };
    return { state, action: { kind: "cancel" } };
  }
  if (matchesKey(data, "left") && state.level !== "phases") {
    return { state: { ...state, level: state.level === "log" ? "agent" : "phases", promptExpanded: false } };
  }

  const down = matchesKey(data, "j") || matchesKey(data, "down");
  const up = matchesKey(data, "k") || matchesKey(data, "up");
  if (down || up) {
    const delta = down ? 1 : -1;
    if (state.level === "phases") {
      const next = clampIndex(view.clampedPhase + delta, view.groups.length);
      // Changing phase re-points the agent list at a different set of rows, so
      // the old row index would be meaningless.
      return { state: next === view.clampedPhase ? state : { ...state, selectedPhase: next, selectedAgent: 0 } };
    }
    return { state: { ...state, selectedAgent: clampIndex(view.clampedAgent + delta, view.visibleAgents.length) } };
  }

  // One key, three jobs, because the levels are what it means at each: open
  // the selected phase's agents, then open the selected agent's live log. The
  // prompt expand/collapse moved to `e` — Enter is the descend key at every
  // level but the last.
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    if (state.level === "phases") {
      // Nothing to open, so nothing happens — entering an empty pane would
      // strand the reader in a subview with no rows and no detail.
      if (view.visibleAgents.length === 0) return { state };
      return { state: { ...state, level: "agent", promptExpanded: false } };
    }
    if (state.level === "agent") {
      // A row with no record id has no conversation to descend into; it falls
      // through as a no-op rather than pretending.
      if (view.selectedEntry?.recordId === undefined) return { state };
      return { state, action: { kind: "open-log" } };
    }
    return { state };
  }
  if (matchesKey(data, "e") && state.level !== "log") {
    return { state: { ...state, promptExpanded: !state.promptExpanded } };
  }

  // The hub popup's expand key, at the one level below the overview where `f`
  // is free (there it is the filter cycle). The component resolves the overlay
  // with "toggle" and its opener reopens it full-screen — or windowed again.
  if (matchesKey(data, "f") && state.level === "agent") {
    return { state, action: { kind: "toggle-fullscreen" } };
  }

  // The one key that opens something instead of changing the run, so unlike
  // skip/retry it works at both levels and on a settled agent: reading what a
  // finished child did is most of why anyone opens this dialog. A row with no
  // record id has no conversation to open, and falls through as unbound.
  if (matchesKey(data, "c")) {
    const recordId = view.selectedEntry?.recordId;
    return recordId === undefined ? undefined : { state, action: { kind: "open", recordId } };
  }

  // The filter re-points the agent list, so it belongs to the level that shows
  // the whole list rather than the one showing a single agent's detail.
  if (matchesKey(data, "f") && state.level === "phases") {
    return { state: { ...state, filter: nextFilter(state.filter), selectedAgent: 0 } };
  }

  // Gated on the run being live, exactly as the footer's hints are. A settled
  // run has nothing left to stop, and firing `kill` at one aborts a controller
  // that is already done and reports a stop that never happened.
  if (matchesKey(data, "x")) return view.workflowActive ? { state, action: { kind: "kill" } } : undefined;
  if (matchesKey(data, "p")) {
    if (!view.workflowActive) return undefined;
    return { state, action: { kind: view.paused ? "resume" : "pause" } };
  }
  const actions = agentActions(view.selectedEntry, view.workflowActive);
  if (matchesKey(data, "s") && actions.skip && view.selectedEntry) {
    return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  }
  if (matchesKey(data, "r") && actions.retry && view.selectedEntry) {
    return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  }

  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The dialog as plain text — what the layout tests assert against. */
export function plainWorkflowDialogLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/** The TUI/terminal surface mouse capture needs — structural, version-safe. */
interface MouseTerminalHost {
  mode?: string;
  terminal?: { write?(data: string): void };
}

/**
 * The `/agents → Workflows` overlay.
 *
 * Deliberately thin: it owns the spinner timer, the theme and the third
 * level's embedded viewer, and delegates everything else to the two pure
 * functions above. `source` is re-read every render so a live run updates in
 * place without any subscription plumbing.
 */
export class WorkflowDialog implements Component {
  private state: WorkflowDialogState;
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** The third level's viewer, alive only while the level is open. */
  private logViewer: ConversationViewer | undefined;
  /** The record id the viewer was built for, so switching agents rebuilds it. */
  private logRecordId: string | undefined;
  /** Windowed popup vs full-screen window; flipped by `f` via the reopen loop. */
  private readonly popup: boolean;
  /** Shared object written back at toggle time so the reopen resumes here. */
  private readonly resume: WorkflowDialogResumeState | undefined;
  /** Whether this dialog enabled regular-mode mouse reporting (and must restore it). */
  private mouseCaptured = false;

  constructor(
    private tui: TUI,
    private source: () => WorkflowDialogSource,
    private theme: Theme,
    private done: (result: "toggle" | undefined) => void,
    private actions: WorkflowDialogActions = {},
    initialPhaseIndex = 0,
    private log?: WorkflowDialogLogDeps,
    initial?: WorkflowDialogInitial,
  ) {
    this.state = initial?.resume?.state ?? initialWorkflowDialogState(initialPhaseIndex);
    this.popup = initial?.popup ?? true;
    this.resume = initial?.resume;
    this.timer = setInterval(() => {
      this.spinnerFrame++;
      if (!this.closed) this.tui.requestRender();
    }, WORKFLOW_DIALOG_SPINNER_MS);
    this.timer.unref?.();
    // Regular TUI mode leaves the wheel to the terminal's own scrollback;
    // capture it for the dialog's lifetime. No-op in fullscreen, where pi
    // already parses mouse input and calls handleMouse instead.
    this.mouseCaptured = enableTerminalMouse(this.tui as unknown as MouseTerminalHost);
  }

  handleInput(data: string): void {
    // Mouse reports first. In regular mode the dialog captured mouse
    // reporting, so wheel bytes arrive as input; the chunk is consumed either
    // way so no escape sequence can leak into the editor.
    const mouse = parseMouseInput(data);
    if (mouse.sawMouse) {
      if (mouse.wheelDelta !== 0) this.applyWheel(mouse.wheelDelta);
      return;
    }
    // Ctrl+C is the reflex for backing out of a full-screen overlay, and it
    // closes from EVERY level — including the log, where the embedded viewer
    // would otherwise turn it into a one-level step-back.
    if (this.state.level === "log" && this.logViewer && !matchesKey(data, "ctrl+c")) {
      // The viewer owns the keys while its level is open: scroll, compose,
      // copy, quit — its quit keys come back through `onBack`, and the
      // selection keys come back through `onUnhandledKey`.
      this.logViewer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const input: WorkflowDialogInput = { ...this.source(), state: this.state };
    const result = handleWorkflowDialogKey(data, this.state, resolveWorkflowDialog(input));
    if (!result) return;
    const wasLevel = this.state.level;
    this.state = result.state;
    // Leaving the log level — by any route — tears its viewer down.
    if (wasLevel === "log" && this.state.level !== "log") this.closeLogViewer();
    if (result.action) this.dispatch(result.action);
    this.tui.requestRender();
  }

  /**
   * Mouse wheel support, fullscreen route. pi's alt-screen renderer parses
   * mouse input and dispatches wheel events to an overlay's top-level
   * component — this dialog. In regular mode nothing arrives here;
   * `handleInput` parses the reports instead (see `terminal-mouse.ts`).
   *
   * The shape is declared locally rather than imported: mouse dispatch landed
   * in pi-tui 0.99 while this extension's peer floor is 0.84, so the method is
   * duck-typed — hosts that support mouse call it, older hosts never do.
   */
  handleMouse(event: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;
    this.applyWheel(delta);
    return { handled: true };
  }

  /**
   * One wheel movement, from whichever route delivered it. The log level
   * scrolls the conversation — so follow-the-tail behaves exactly as with the
   * scroll keys — and the two levels above move the visible selection a row
   * per logical line, the hub roster's same rule. Consumed by the caller
   * either way: an unhandled wheel would scroll the transcript underneath the
   * overlay.
   */
  private applyWheel(delta: number): void {
    if (this.state.level === "log" && this.logViewer) {
      this.logViewer.scrollBy(delta);
      this.tui.requestRender();
      return;
    }
    const steps = Math.max(1, Math.round(Math.abs(delta)));
    const view = resolveWorkflowDialog({ ...this.source(), state: this.state });
    if (this.state.level === "phases") {
      const next = clampIndex(view.clampedPhase + Math.sign(delta) * steps, view.groups.length);
      // Changing phase re-points the agent list at a different set of rows, so
      // the old row index would be meaningless — `j`/`k`'s same rule.
      if (next !== view.clampedPhase) this.state = { ...this.state, selectedPhase: next, selectedAgent: 0 };
    } else {
      const next = clampIndex(view.clampedAgent + Math.sign(delta) * steps, view.visibleAgents.length);
      if (next !== view.clampedAgent) this.state = { ...this.state, selectedAgent: next };
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.state.level === "log") {
      const log = this.ensureLogViewer();
      if (log) return this.renderLog(width, log);
      // The record vanished between the Enter and this render (swept mid-drill):
      // fall back to the detail level rather than drawing a broken pane.
      this.state = { ...this.state, level: "agent" };
    }
    const lines = layoutWorkflowDialog({
      ...this.source(),
      state: this.state,
      // Derived from what was actually injected, so the footer advertises only
      // the keys this dialog can service.
      available: {
        onKill: this.actions.onKill !== undefined,
        onPause: this.actions.onPause !== undefined,
        onResume: this.actions.onResume !== undefined,
        onSkipAgent: this.actions.onSkipAgent !== undefined,
        onRetryAgent: this.actions.onRetryAgent !== undefined,
        onOpenAgent: this.actions.onOpenAgent !== undefined,
        onOpenLog: this.log !== undefined,
      },
      width,
      spinnerFrame: this.spinnerFrame,
      fullscreen: !this.popup,
      // The hub's popup size: fill the same 70%-of-terminal ceiling the
      // overlay clips at, minus the rows the window itself draws around the
      // panes. A host with no terminal reported (bare tests) falls back to the
      // default ceiling, sizing the window as the content-sized box it was
      // before the hub restyle.
      bodyRows: this.paneHeight(),
    });
    return styleWorkflowCardLines(lines, this.theme);
  }

  /** Terminal share the window fills: the popup's 70%, full-screen's 100%. */
  private viewportPct(): number {
    return this.popup ? VIEWPORT_HEIGHT_PCT : 100;
  }

  /** Body height for the pane window, from the hub's popup arithmetic. */
  private paneHeight(): number {
    const rows = this.tui.terminal?.rows;
    if (rows === undefined) return DEFAULT_PANE_BODY_ROWS;
    return Math.max(MIN_PANE_BODY_ROWS, Math.floor((rows * this.viewportPct()) / 100) - WINDOW_CHROME_ROWS);
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    this.closeLogViewer();
    // Hand the wheel back to the terminal (native scrollback, text selection).
    if (this.mouseCaptured) {
      disableTerminalMouse(this.tui as unknown as MouseTerminalHost);
      this.mouseCaptured = false;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Build the third level's viewer for the selected agent, if it can. */
  private ensureLogViewer(): ConversationViewer | undefined {
    const recordId = this.resolveLogState()?.recordId;
    if (recordId === undefined || !this.log) return undefined;
    if (this.logViewer && this.logRecordId === recordId) return this.logViewer;
    const record = this.log.getRecord(recordId);
    if (!record?.session) {
      // Swept between the Enter and now — say so, as the `c` handoff does.
      this.log.notify?.("No conversation left — agent records are dropped ten minutes after they finish.", "info");
      return undefined;
    }
    this.closeLogViewer();
    this.logRecordId = recordId;
    this.logViewer = new ConversationViewer(
      this.tui,
      record.session,
      record,
      this.log.agentActivity.get(record.id),
      this.theme,
      _result => this.closeFromLog(),
      () => {
        if (this.log!.manager.abort(record.id)) {
          this.log!.notify?.(`Stopped "${record.description}".`, "info");
        }
      },
      undefined,
      message => this.log!.manager.steer(record.id, message),
      this.log.showCost(),
      this.log.viewerMarkdown,
      this.log.onViewerMarkdown,
      this.log.scrollbarMode?.() ?? "auto",
      undefined,
      {
        // The window around the pane spends rows too, so the viewer's ceiling
        // shrinks by their share of the terminal — the whole dialog stays
        // under the overlay's clip instead of losing its bottom border. Full
        // screen starts from the whole terminal instead of the popup's share.
        maxHeightPct: () =>
          Math.max(
            20,
            this.viewportPct() - Math.ceil((WINDOW_CHROME_ROWS * 100) / Math.max(1, this.tui.terminal.rows)),
          ),
        onBack: () => this.leaveLog(),
        // ↑/↓ are the pane list's selection keys, so the viewer must not
        // advertise them as scroll keys.
        scrollHint: () => "PgUp/PgDn · Shift+↑↓ · j/k scroll",
        frameless: () => true,
        onUnhandledKey: data => {
          // ↑/↓ move the pane list's selection and the stream follows.
          const down = matchesKey(data, "down");
          const up = matchesKey(data, "up");
          if (down || up) {
            this.moveLogSelection(down ? 1 : -1);
            return true;
          }
          // `f` flips windowed ↔ full-screen, `c` copies the shown agent's
          // settled result and `p` pauses/resumes it — the hub chat pane's
          // extra keys. The composer check inside the viewer runs first, so a
          // steering message still receives its f's, c's and p's.
          if (matchesKey(data, "f")) {
            this.requestToggle();
            return true;
          }
          if (matchesKey(data, "c")) {
            this.copyLogResult();
            return true;
          }
          if (matchesKey(data, "p")) {
            this.pauseResumeLogAgent();
            return true;
          }
          return false;
        },
      },
    );
    return this.logViewer;
  }

  /** The selected entry at the detail level — the one the log shows. */
  private resolveLogState(): { recordId: string | undefined } {
    const input: WorkflowDialogInput = { ...this.source(), state: { ...this.state, level: "agent" } };
    const view = resolveWorkflowDialog(input);
    return { recordId: view.selectedEntry?.recordId };
  }

  /** Step the agent selection while the log is up; a new agent rebuilds the viewer. */
  private moveLogSelection(delta: number): void {
    const input: WorkflowDialogInput = { ...this.source(), state: { ...this.state, level: "agent" } };
    const view = resolveWorkflowDialog(input);
    const next = clampIndex(view.clampedAgent + delta, view.visibleAgents.length);
    if (next === view.clampedAgent) return;
    this.state = { ...this.state, selectedAgent: next };
    // Re-pointed selection: the next render rebuilds the viewer for that agent.
    this.closeLogViewer();
    this.tui.requestRender();
  }

  private leaveLog(): void {
    this.closeLogViewer();
    this.state = { ...this.state, level: "agent", promptExpanded: false };
    this.tui.requestRender();
  }

  /** `f`: flip windowed ↔ full-screen. pi sizes overlays once, so this writes
   *  the live state into the shared resume object and resolves the overlay
   *  with `"toggle"`; `showWorkflowDialog` reopens us resized, resuming there. */
  private requestToggle(): void {
    if (this.resume) this.resume.state = this.state;
    this.done("toggle");
  }

  /** The record the log level is showing, fetched fresh — the hub fetches its
   *  chat record fresh for the same reason: it may have settled or been swept
   *  between renders. */
  private logRecord(): AgentRecord | undefined {
    const recordId = this.resolveLogState()?.recordId;
    return recordId === undefined ? undefined : this.log?.getRecord(recordId);
  }

  /** `c` in the log: copy the shown agent's settled result — the hub chat
   *  pane's same key, over the one implementation in `copyRecordResult`. */
  private copyLogResult(): void {
    const record = this.logRecord();
    if (record) copyRecordResult(record, this.log?.notify);
  }

  /**
   * `p` in the log: pause the agent being viewed if it is active, resume it if
   * paused — the hub chat pane's same key and strings. Settled agents stay
   * put: this pauses one child, never the run.
   */
  private pauseResumeLogAgent(): void {
    const record = this.logRecord();
    if (!record) return;
    if (record.status === "running" || record.status === "queued") {
      const why = this.log?.pauseAgent?.(record.id);
      this.log?.notify?.(
        why ? `Cannot pause "${record.description}" — ${why}.` : `Paused "${record.description}".`,
        why ? "warning" : "info",
      );
    } else if (record.status === "paused") {
      const started = this.log?.resumeAgent?.(record.id);
      this.log?.notify?.(
        started ? `Resuming "${record.description}".` : `Cannot resume "${record.description}".`,
        started ? "info" : "warning",
      );
    }
  }

  /** A viewer quit that is not `onBack` — close the dialog outright. */
  private closeFromLog(): void {
    this.closed = true;
    this.closeLogViewer();
    this.done(undefined);
  }

  private closeLogViewer(): void {
    this.logViewer?.dispose();
    this.logViewer = undefined;
    this.logRecordId = undefined;
  }

  /**
   * The log level, drawn as themed strings — the viewer renders strings, so
   * this bypasses the segment layout entirely, the way the hub's chat view
   * bypasses its table renderer. Same window, same rows:
   *
   * ```
   * ╭ review-changes ───────── 2/3 agents · 40s ─╮
   * │ Verify the auth flow                       │
   * ├ ─ Verify · 2 agents ─┬─ verify:auth.ts ─── ┤
   * │ ❯ ◌ verify:auth.ts   │ (live conversation) │
   * │   ✓ plan             │                     │
   * ├ ─────────────────────┴───────────────────── ┤
   * │ ↑↓ agent · p pause · x stop · esc back ·    │
   * │   c copy · f expand                         │
   * ╰────────────────────────────────────────────╯
   * ```
   */
  private renderLog(width: number, viewer: ConversationViewer): string[] {
    const glyphs = UNICODE_DIALOG_GLYPHS;
    const th = this.theme;
    const input: WorkflowDialogInput = { ...this.source(), state: { ...this.state, level: "agent" } };
    const view = resolveWorkflowDialog(input);
    const entry = view.selectedEntry;

    // The SAME width basis and pane arithmetic as the segment path — the
    // host's render width itself, panes spanning the full window — so
    // descending to this level moves nothing: the divider and the right bar
    // stay in the columns the other two levels drew them in.
    const contentWidth = workflowDialogContentWidth(width);
    const leftWidth = leftPaneWidth(contentWidth);
    const rightWidth = Math.max(1, contentWidth - leftWidth - 3);
    // The window's non-body rows: borders, headers, two rules, footer.
    const chrome = WINDOW_CHROME_ROWS;
    const bodyRows = Math.max(MIN_PANE_BODY_ROWS, Math.floor(((this.tui.terminal?.rows ?? 40) * this.viewportPct()) / 100) - chrome);

    const chat = viewer.render(rightWidth);
    if (chat.length === 0) return [];

    // Left cells reuse the segment pipeline at its narrowest, styled like the
    // segment path styles them — the selection's accent colour survives.
    const leftRows: WorkflowCardLine[] = [];
    if (view.visibleAgents.length === 0) {
      leftRows.push(clampLine([{ text: `   ${WORKFLOW_DIALOG_COPY.noAgents}`, color: "dim" }], leftWidth));
    } else {
      const agents = windowRange(view.clampedAgent, view.visibleAgents.length, bodyRows);
      for (let i = agents.start; i < Math.min(agents.end, view.visibleAgents.length); i++) {
        leftRows.push(
          agentRow({
            entry: view.visibleAgents[i],
            selected: i === view.clampedAgent,
            compact: true,
            width: leftWidth,
            glyphs,
            workflowActive: view.workflowActive,
            spinnerFrame: this.spinnerFrame,
            now: Date.now(),
          }),
        );
      }
    }
    const leftText = styleWorkflowCardLines(leftRows, th);

    const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, Date.now());
    const phaseTitle = view.groups[view.clampedPhase]?.title ?? "Phases";
    const agentPaneTitle = agentPaneTitleFor(this.state.filter, phaseTitle, view.visibleAgents.length);

    // ---- Window helpers, in strings. The shapes mirror the segment path's
    // windowRow/paneRule so both render paths draw the same window.
    const border = (s: string) => th.fg("border", s);
    const windowTop = () => border(`${glyphs.box.topLeft}${glyphs.box.horizontal.repeat(contentWidth - 2)}${glyphs.box.topRight}`);
    const windowBottom = () => border(`${glyphs.box.bottomLeft}${glyphs.box.horizontal.repeat(contentWidth - 2)}${glyphs.box.bottomRight}`);
    const windowLine = (content: string) => {
      const clamped = truncateToWidth(content, contentWidth - 4, glyphs.ellipsis, true);
      const gap = Math.max(0, contentWidth - 4 - visibleWidth(clamped));
      return `${border(glyphs.box.vertical)} ${clamped}${" ".repeat(gap + 1)}${border(glyphs.box.vertical)}`;
    };
    const ruleCell = (title: string | undefined, w: number) => {
      if (title === undefined) return border(glyphs.box.horizontal.repeat(w));
      // Stripped like `frameTitle` strips its ellipsis wrappers: pi's
      // truncation wraps the marker in resets, and resets inside a rule cell
      // skew every raw-column offset to the right of them.
      const shown = stripTerminalSequences(truncateToWidth(` ${title} `, w - 2, glyphs.ellipsis));
      return `${border(" ")}${th.fg("muted", th.bold(shown))}${border(glyphs.box.horizontal.repeat(Math.max(0, w - visibleWidth(shown) - 1)))}`;
    };
    const ruleRow = (leftTitle: string | undefined, rightTitle: string | undefined) =>
      border(glyphs.box.leftTee) +
      ruleCell(leftTitle, leftWidth) +
      border(leftTitle === undefined ? glyphs.box.vertical : glyphs.box.topTee) +
      ruleCell(rightTitle, rightWidth) +
      border(glyphs.box.rightTee);

    const lines: string[] = [];
    lines.push(windowTop());
    lines.push(windowLine(`${th.fg("toolTitle", th.bold(head.name))}  ${th.fg("dim", head.stats)}`));
    if (head.subtext) lines.push(windowLine(th.fg("dim", head.subtext)));
    lines.push(ruleRow(agentPaneTitle, entry?.label ?? WORKFLOW_DIALOG_COPY.noAgents));

    for (let i = 0; i < bodyRows; i++) {
      // Same row shape as `paneBodyRow`: cells padded to their pane width, no
      // extra spacing columns — the three bars plus both cells total exactly
      // the window width, keeping the bars on the window's borders.
      const leftCell = stripTerminalSequences(truncateToWidth(leftText[i] ?? "", leftWidth, glyphs.ellipsis, true));
      const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftCell)));
      const chatLine = chat[i] ?? "";
      const chatPad = " ".repeat(Math.max(0, rightWidth - visibleWidth(chatLine)));
      lines.push(
        `${border(glyphs.box.vertical)}${leftCell}${leftPad}${border(glyphs.box.vertical)}${chatLine}${chatPad}${border(glyphs.box.vertical)}`,
      );
    }

    lines.push(ruleRow(undefined, undefined));
    // The level's own keys. `p` here pauses the AGENT being viewed — not the
    // run — so it is gated on the record's lifecycle and the wiring, not on
    // the run's. `c` and `f` sit after the way out so a narrow terminal drops
    // them first, the display-only rule the segment footer follows.
    const hints: string[] = [`${glyphs.upDown} agent`];
    const record = this.logRecord();
    if (this.log?.pauseAgent !== undefined) {
      if (record?.status === "paused") hints.push("p resume");
      else if (record?.status === "running" || record?.status === "queued") hints.push("p pause");
    }
    if (view.workflowActive) hints.push("x stop");
    hints.push("esc back");
    hints.push("c copy");
    hints.push(this.popup ? "f expand" : "f popup");
    lines.push(windowLine(th.fg("dim", hints.join(" · "))));
    lines.push(windowBottom());
    return lines;
  }

  private dispatch(action: WorkflowDialogAction): void {
    switch (action.kind) {
      case "cancel":
        this.closed = true;
        this.closeLogViewer();
        this.done(undefined);
        return;
      case "kill":
        this.actions.onKill?.();
        return;
      case "pause":
        this.actions.onPause?.();
        return;
      case "resume":
        this.actions.onResume?.();
        return;
      case "skip":
        this.actions.onSkipAgent?.(action.index);
        return;
      case "retry":
        this.actions.onRetryAgent?.(action.index);
        return;
      case "open":
        this.actions.onOpenAgent?.(action.recordId);
        return;
      case "open-log":
        // The descend: flip the level and let the next render build the
        // viewer. A record with no conversation falls back in render().
        this.state = { ...this.state, level: "log", promptExpanded: false };
        return;
      case "toggle-fullscreen":
        this.requestToggle();
        return;
    }
  }
}
