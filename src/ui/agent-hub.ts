/**
 * agent-hub.ts — Full-screen agent hub overlay (oh-my-pi style), pi-subagents data.
 *
 * One full-terminal overlay (`ctx.ui.custom` with `width: "100%"`,
 * `maxHeight: "100%"`), three views:
 *
 * - Table view: every top-level agent of this session plus workflow runs, as a
 *   roster table — status glyph, name, task, live activity, tools/tokens/cost/
 *   elapsed stats flush right. `/` filters, `x` stops (two-press), `Enter`
 *   opens the agent's conversation or the workflow inspector, `1`/`2`/Tab
 *   switch views, `q`/Esc closes the hub.
 * - Activity view: one line per agent describing what it is doing right now.
 * - Chat view: the existing `ConversationViewer` embedded at full height. Its
 *   quit keys come "back" to the table instead of closing the overlay, so the
 *   hub is one continuous surface: roster → transcript → roster → close.
 *
 * Purely a UI layer over the same runtime the fleet list drives: AgentManager
 * records, the activity tracker, workflow runs. All behavior — steering,
 * stopping, markdown modes, cost display, linger semantics — is unchanged.
 */

import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { describeActivity, formatCost, formatFleetElapsed } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import type { FleetWorkflow } from "./fleet-list.js";
import { disableTerminalMouse, enableTerminalMouse, parseMouseInput } from "./terminal-mouse.js";
import type { ViewerKeybindings } from "./viewer-keys.js";

/** How long a settled workflow run lingers in the roster (matches the fleet list). */
const FINISHED_LINGER_MS = 4000;
/** Re-render cadence so elapsed/activity/stats tick while the hub is open. */
const TICK_MS = 200;
/** Roster never renders fewer body rows than this, even on tiny terminals. */
const MIN_BODY_ROWS = 3;
/** Cap on the padded name column so descriptions keep room on narrow terminals. */
const MAX_NAME_COL = 24;
/** A terminal shorter than this renders the empty state instead of a broken table. */
const MIN_TERMINAL_ROWS = 8;

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

type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type HubEntry = WorkflowEntry | AgentEntry;

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
  /** Open the workflow inspector for a run id. */
  openWorkflow?: (id: string) => Promise<void> | void;
  /** Surface stop confirmations. Omitted → silent. */
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
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
    // aborted / stopped
    default:
      return th.fg("dim", "·");
  }
}

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
  const entries = [...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record }))];
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
  private chatRecordId: string | undefined;
  /** Windowed popup vs full-screen hub; flipped by `f` via the reopen loop. */
  private readonly popup: boolean;
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
    return this.roster().filter(e => this.matchesFilter(e));
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

    // Chat view: the embedded viewer owns everything, exactly as it did as a
    // standalone overlay — including its quit keys, which come back here.
    if (this.view === "chat") {
      this.chatViewer?.handleInput(data);
      this.tui.requestRender();
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
      this.stopArmed = false;
      this.openSelected(items);
      return;
    }

    if (matchesKey(data, "x")) {
      this.stopSelected(items);
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

  private openSelected(items: HubEntry[]): void {
    const entry = items[this.selected];
    if (!entry) return;
    if (entry.kind === "workflow") {
      void Promise.resolve(this.deps.openWorkflow?.(entry.workflow.id));
      return;
    }
    const current = this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
    if (!current.session) {
      this.deps.notify?.(`Agent is ${current.status} — no session available.`, "info");
      return;
    }
    this.enterChat(current);
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
      {
        // Viewport tracks the mode live: popup caps at the windowed height,
        // full-screen uses the whole terminal.
        maxHeightPct: () => (this.popup ? VIEWPORT_HEIGHT_PCT : 100),
        // Popup has no roster behind it — Esc closes. Full-screen walks back.
        onBack: () => (this.popup ? this.close() : this.leaveChat()),
        backHint: () => (this.popup ? "←→ agent · Esc close · f expand" : "←→ agent · Esc back · f popup"),
        // The hub's extra keys ride through the viewer's key stream: `f`
        // flips popup/full-screen, ←/→ cycle the conversation across the
        // roster's agents (wrapping).
        onUnhandledKey: data => {
          if (matchesKey(data, "f")) {
            this.requestToggle();
            return true;
          }
          if (matchesKey(data, "left")) {
            this.cycleAgent(-1);
            return true;
          }
          if (matchesKey(data, "right")) {
            this.cycleAgent(1);
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
    this.clampSelection();
    this.requestRender();
  }

  /**
   * ←/→ in the conversation: jump to the previous/next agent in roster order
   * (earliest-launched first), wrapping around. Workflows are skipped — they
   * have no conversation — and finished agents stay in the cycle so a wrap
   * still reaches them for review. Re-entering the same agent is a no-op so
   * scroll position survives a stray keypress.
   */
  private cycleAgent(direction: 1 | -1): void {
    const agents = this.roster().filter((e): e is AgentEntry => e.kind === "agent" && !!e.record.session);
    if (agents.length < 2) return;
    const current = agents.findIndex(e => e.record.id === this.chatRecordId);
    const next = current === -1 ? 0 : (current + direction + agents.length) % agents.length;
    const record = agents[next].record;
    if (record.id === this.chatRecordId) return;
    const fresh = this.deps.manager.listAgents().find(a => a.id === record.id) ?? record;
    if (fresh.session) this.enterChat(fresh);
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

  // ---- Rendering ----

  render(width: number): string[] {
    if (width < 6) return [];
    if (this.view === "chat" && this.chatViewer) return this.chatViewer.render(width);
    const rows = this.tui.terminal.rows;
    if (rows < MIN_TERMINAL_ROWS) return [truncateToWidth(this.headerTitle(width), width)];

    const th = this.theme;
    const innerW = width - 4; // border + padding
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    lines.push(row(this.headerTitle(innerW)));
    if (this.filterInput || this.filterText) lines.push(row(this.filterLine(innerW)));
    lines.push(hrMid);

    const bodyRows = Math.max(MIN_BODY_ROWS, rows - lines.length - 3); // hrMid + footer + hrBot

    if (this.view === "activity") {
      lines.push(...this.renderActivity(bodyRows, innerW, row));
    } else {
      lines.push(...this.renderTable(bodyRows, innerW, row));
    }

    lines.push(hrMid);
    lines.push(row(this.footer(innerW)));
    lines.push(hrBot);
    return lines;
  }

  private headerTitle(width: number): string {
    const th = this.theme;
    const agents = this.agentRecords();
    const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
    const parts: string[] = [];
    const tab = (label: string, active: boolean) =>
      active ? th.fg("accent", th.bold(` ${label} `)) : th.fg("dim", ` ${label} `);
    const tabs = `[${tab("1 Agents", this.view !== "activity")}${tab("2 Activity", this.view === "activity")}]`;
    parts.push(th.bold("Agent Hub"));
    if (this.activeFilter()) parts.push(th.fg("accent", `filter: ${this.activeFilter()}`));
    parts.push(
      agents.length === 0
        ? th.fg("dim", "no agents")
        : `${agents.length} agent${agents.length === 1 ? "" : "s"} · ${running} active`,
    );
    const wfCount = this.workflows().length;
    if (wfCount > 0) parts.push(th.fg("dim", `${wfCount} workflow${wfCount === 1 ? "" : "s"}`));
    parts.push(tabs);
    return truncateToWidth(parts.join(th.fg("dim", " · ")), width);
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

  private renderTable(bodyRows: number, innerW: number, row: (content: string) => string): string[] {
    const items = this.entries();
    this.clampSelection();
    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(row(this.theme.fg("dim", this.activeFilter() ? "no matches" : "(no agents yet — spawn one to see it here)")));
      return lines;
    }

    // Pad the name column to the widest visible name so descriptions align.
    let nameCol = 0;
    for (const e of items) {
      const name = e.kind === "workflow" ? e.workflow.name : renderAgentName(e.record.type, this.theme, {});
      nameCol = Math.max(nameCol, visibleWidth(name) + (e.kind === "workflow" ? "workflow ".length : 0));
    }
    nameCol = Math.min(nameCol, MAX_NAME_COL);

    // Window the rows so the selection stays visible.
    const start = Math.max(0, Math.min(this.selected - Math.floor(bodyRows / 2), items.length - bodyRows));
    const visible = items.slice(start, start + bodyRows);

    for (let i = 0; i < bodyRows; i++) {
      const entry = visible[i];
      if (!entry) { lines.push(row("")); continue; }
      const index = start + i;
      lines.push(row(this.renderEntry(entry, index === this.selected, nameCol, innerW)));
    }
    return lines;
  }

  private renderEntry(entry: HubEntry, selected: boolean, nameCol: number, width: number): string {
    const th = this.theme;
    const marker = selected ? th.fg("accent", "▸") : " ";
    if (entry.kind === "workflow") {
      const wf = entry.workflow;
      const kind = th.fg(selected ? "text" : "muted", "workflow");
      const name = selected ? th.fg("text", wf.name) : wf.name;
      const label = `${kind} ${name}`;
      const left = `${marker} ${label}`;
      const elapsed = (wf.completedAt ?? Date.now()) - wf.startedAt;
      const agents = `${wf.doneCount}/${wf.totalCount}`;
      const stats = `${agents} agents · ${formatFleetElapsed(elapsed)} · ↓${compactCount(wf.tokens)}`;
      return finishRow(left, nameCol + 2, selected ? th.fg("text", stats) : th.fg("dim", stats), width);
    }

    const record = entry.record;
    const name = renderAgentName(record.type, th, selected
      ? { fallbackColor: "text", bold: true }
      : { fallbackColor: "muted" });
    const description = selected ? th.fg("text", record.description) : record.description;
    // Live activity segment: what the agent is doing right now, dimmed so the
    // description stays the anchor. Skipped for settled agents.
    let activity = "";
    if (record.status === "running") {
      const act = this.deps.agentActivity.get(record.id);
      if (act) activity = th.fg("dim", ` — ${describeActivity(act.activeTools, act.responseText)}`);
    }
    const left = `${marker} ${name.padEnd(nameCol)} ${description}${activity}`;

    const toolUses = this.deps.agentActivity.get(record.id)?.toolUses ?? record.toolUses;
    const stats: string[] = [];
    if (toolUses > 0) stats.push(`${toolUses}t`);
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    if (tokens > 0) stats.push(`↓${compactCount(tokens)}`);
    if (this.deps.showCost) {
      const cost = formatCost(getLifetimeCost(record.lifetimeUsage));
      if (cost) stats.push(cost);
    }
    if (record.status === "running") {
      const pct = getSessionContextPercent(this.deps.agentActivity.get(record.id)?.session);
      if (pct != null) stats.push(`${Math.round(pct)}%ctx`);
    }
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
    stats.push(formatFleetElapsed(elapsedMs));

      const stopNote = selected && this.stopArmed
        ? th.fg("error", " x to STOP")
        : "";
    return finishRow(left, nameCol + 2, (selected ? th.fg("text", stats.join(" · ")) : th.fg("dim", stats.join(" · "))) + stopNote, width);
  }

  private renderActivity(bodyRows: number, innerW: number, row: (content: string) => string): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const items = this.entries();
    if (items.length === 0) {
      lines.push(row(th.fg("dim", "(nothing running)")));
      return lines;
    }
    for (let i = 0; i < bodyRows; i++) {
      const entry = items[i];
      if (!entry) { lines.push(row("")); continue; }
      if (entry.kind === "workflow") {
        const wf = entry.workflow;
        lines.push(row(truncateToWidth(
          `${th.fg("muted", "workflow")} ${wf.name}  ${th.fg("dim", `${wf.doneCount}/${wf.totalCount} agents · ${wf.status}`)}`,
          innerW,
        )));
        continue;
      }
      const record = entry.record;
      const act = this.deps.agentActivity.get(record.id);
      const doing = act
        ? describeActivity(act.activeTools, act.responseText)
        : record.status === "running" ? "thinking…" : record.status;
      const turns = act?.maxTurns ? ` · turn ${act.turnCount}/${act.maxTurns}` : act ? ` · turn ${act.turnCount}` : "";
      const line = `${statusGlyph(record.status, th)} ${renderAgentName(record.type, th, {})}  ${th.fg(record.status === "running" ? "text" : "dim", doing)}${th.fg("dim", turns)}`;
      lines.push(row(truncateToWidth(line, innerW)));
    }
    return lines;
  }

  private footer(width: number): string {
    const th = this.theme;
    // Popup mode never renders the roster footer (it shows the conversation
    // only); "f popup" is therefore only offered where it applies.
    const keys = this.view === "activity"
      ? ["↑↓ select", "Enter open", "x stop", "1 agents", "f popup", "q close"]
      : ["↑↓ select", "Enter open", "x stop", "/ filter", "Tab activity", "f popup", "q close"];
    let footer = keys.join("·");
    // Drop hints right-to-left until the line fits, so the essential ones survive.
    while (keys.length > 1 && visibleWidth(footer) > width) {
      keys.pop();
      footer = keys.join("·");
    }
    if (this.stopArmed) footer = `${th.fg("error", "x again to STOP")} ${footer}`;
    return truncateToWidth(footer, width);
  }
}

/** `13.1k` — compact magnitude for table cells (no `tokens` suffix). */
function compactCount(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Left cell + right-aligned stats, truncated hard so lines never wrap. */
function finishRow(left: string, minWidth: number, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(minWidth, width - rightW - 2);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}
