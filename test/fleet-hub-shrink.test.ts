/**
 * fleet-hub-shrink.test.ts — REPRO harness for: "when the fleet closes on hub
 * open, the bottom of the window does not go back to the actual bottom".
 *
 * Unlike the rest of the UI suite (which doubles `ctx.ui`), this drives the
 * REAL TuiMainScreen — the renderer class pi's interactive mode uses — through
 * a host that mirrors interactive-mode's extension surface:
 *
 *   - setWidget: per-placement maps, removal clears BOTH placements (pi's
 *     setExtensionWidget removes from both before re-adding)
 *   - custom: showExtensionCustom semantics — overlay mounts via showOverlay,
 *     close hides the overlay and calls the component's dispose
 *
 * On top of that host run the REAL FleetList and the REAL openAgentHub /
 * AgentHub, replaying the user sequence: bar visible → hub opens (the bar's
 * widget is cleared while the overlay masks the layout shrink) → Esc → the
 * fleet's deferred restore deliberately issues no further render. Assertions
 * decode the emitted ANSI into a virtual screen — what a user actually sees.
 */
import { type Component, Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentManager, AgentRecord } from "../src/types.js";
import { openAgentHub } from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { FleetList } from "../src/ui/fleet-list.js";

/** Capturing terminal stub — just enough surface for TuiBase. */
class FakeTerminal {
  columns = 80;
  rows = 24;
  written = "";
  write(data: string): void {
    this.written += data;
  }
  start(): void {}
  stop(): void {}
  hideCursor(): void {}
  showCursor(): void {}
}

function staticLines(rows: string[]): Component {
  return {
    render: (width: number) => rows.map(r => r.slice(0, width)),
    invalidate: () => {},
  };
}

/** Let the renderer's nextTick + throttle (MIN_RENDER_INTERVAL_MS = 16) fire. */
const flushRender = () => new Promise(resolve => setTimeout(resolve, 40));

/** Decode the emitted ANSI stream into the visible screen. */
function decodeScreen(stream: string, rows: number): string[] {
  const screen: string[] = Array.from({ length: rows }, () => "");
  let row = 0;
  let i = 0;
  while (i < stream.length) {
    const ch = stream[i];
    if (ch === "\x1b") {
      if (stream[i + 1] === "]" || stream[i + 1] === "_") {
        const end = stream.indexOf("\x07", i);
        i = (end === -1 ? stream.length : end) + 1;
        continue;
      }
      if (stream[i + 1] !== "[") {
        i += 2;
        continue;
      }
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(stream.slice(i));
      if (!m) {
        i += 2;
        continue;
      }
      const n = parseInt(m[1] || "1", 10) || 1;
      switch (m[2]) {
        case "A": row = Math.max(0, row - n); break;
        case "B": row = Math.min(rows - 1, row + n); break;
        case "H": row = 0; break;
        case "J": screen.fill(""); break;
        case "K": screen[row] = ""; break;
        default: break;
      }
      i += m[0].length;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      if (row === rows - 1) {
        // Physical terminals scroll: drop the top row, open a blank bottom row.
        screen.shift();
        screen.push("");
      } else {
        row += 1;
      }
      i += 1;
      continue;
    }
    screen[row] += ch;
    i += 1;
  }
  return screen;
}

/** Last row that shows any visible content. */
function lastContentRow(screen: string[]): string {
  for (let i = screen.length - 1; i >= 0; i--) {
    if (screen[i].trim() !== "") return screen[i];
  }
  return "";
}

const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  dim: (s: string) => s,
} as any;

function makeRunningAgent(): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    handle: "general-purpose",
    description: "long task",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } as unknown as AgentRecord;
}

/**
 * A host mirroring interactive-mode's extension surface, mounted on the real
 * TuiMainScreen. Layout order follows pi: chat … widgetsAbove … editor …
 * widgetsBelow … footer.
 */
class Host {
  tui: TuiMainScreen;
  chatRows: string[] = ["transcript line 1", "transcript line 2"];
  private widgetsAbove = new Map<string, Component>();
  private widgetsBelow = new Map<string, Component>();
  private aboveContainer: Container = new Container();
  private belowContainer: Container = new Container();
  private term: FakeTerminal;

  constructor(term: FakeTerminal, chatRows?: string[]) {
    this.term = term;
    if (chatRows) this.chatRows = chatRows;
    this.tui = new TuiMainScreen(term as any);
    this.tui.addChild(staticLines(this.chatRows));
    this.tui.addChild(this.aboveContainer);
    this.tui.addChild(staticLines(["❯ editor"]));
    this.tui.addChild(this.belowContainer);
    this.tui.addChild(staticLines(["? for shortcuts"]));
  }

  get written(): string {
    return this.term.written;
  }

  setWidget(
    key: string,
    factory: ((tui: any, theme: any) => Component) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    // Mirrors pi's setExtensionWidget: a removal clears BOTH placements.
    this.widgetsAbove.delete(key);
    this.widgetsBelow.delete(key);
    if (factory !== undefined) {
      const map = (options?.placement ?? "aboveEditor") === "belowEditor" ? this.widgetsBelow : this.widgetsAbove;
      map.set(key, factory(this.tui, theme));
    }
    this.renderWidgets();
  }

  /** Mirrors renderWidgetContainer: empty above-container keeps its spacer, empty below-container vanishes. */
  private renderWidgets(): void {
    this.aboveContainer.clear();
    if (this.widgetsAbove.size === 0) this.aboveContainer.addChild(staticLines([""]));
    for (const w of this.widgetsAbove.values()) this.aboveContainer.addChild(w);
    this.belowContainer.clear();
    for (const w of this.widgetsBelow.values()) this.belowContainer.addChild(w);
    this.tui.requestRender();
  }

  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => Component & { handleInput?(data: string): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T> {
    return new Promise<T>(resolve => {
      let component: ReturnType<typeof factory> | undefined;
      let closed = false;
      const close = (result: T) => {
        if (closed) return;
        closed = true;
        if (options?.overlay) this.tui.hideOverlay();
        resolve(result);
        component?.dispose?.();
      };
      Promise.resolve(factory(this.tui, theme, {}, close)).then(c => {
        if (closed) return;
        component = c;
        if (options?.overlay) this.tui.showOverlay(c, options.overlayOptions as any);
      });
    });
  }

  onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void {
    this.tui.addInputListener(() => handler(""));
    return () => {};
  }

  getEditorText(): string {
    return "";
  }

  notify(): void {}
}

/** Boot the host + fleet over a manager with one running agent. */
function boot(chatRows?: string[]): { term: FakeTerminal; host: Host; fleet: FleetList } {
  const term = new FakeTerminal();
  const host = new Host(term, chatRows);
  const manager = { listAgents: () => [makeRunningAgent()], abort: () => true, steer: () => true } as unknown as AgentManager;
  const activity = new Map<string, AgentActivity>();
  const fleet = new FleetList(manager as never, activity);
  fleet.setUICtx(host as never);
  fleet.update();
  return { term, host, fleet };
}

/** Open the hub, toggle popup ↔ full-screen with `f`, then close with Esc. */
async function openToggleCloseHub(host: Host, fleet: FleetList): Promise<void> {
  const hubPromise = fleet.openHub();
  await flushRender();
  let overlayEntry = ((host.tui as any).overlayStack ?? []).at(-1);
  expect(overlayEntry).toBeDefined();
  overlayEntry.component.handleInput("f"); // toggle → close + reopen in the other mode
  await flushRender();
  overlayEntry = ((host.tui as any).overlayStack ?? []).at(-1);
  expect(overlayEntry).toBeDefined(); // reopened
  overlayEntry.component.handleInput("\x1b");
  await hubPromise;
  await flushRender();
  await flushRender();
}

/** Open the hub over the fleet, close it with Esc, flush every deferred render.
 *  Returns the bytes the close phase emitted — the full-redraw assertion reads them. */
async function openAndCloseHub(host: Host, fleet: FleetList, initial?: { agentId?: string }): Promise<string> {
  const hubPromise = fleet.openHub(initial?.agentId);
  await flushRender();
  const overlayEntry = ((host.tui as any).overlayStack ?? []).at(-1);
  expect(overlayEntry).toBeDefined(); // the hub is up (roster or popup chat)
  const beforeClose = host.written.length;
  overlayEntry.component.handleInput("\x1b");
  await hubPromise;
  // The Esc keystroke pays for hideOverlay's render; the fleet's deferred
  // restore (setTimeout 0) registers nothing. Flush both.
  await flushRender();
  await flushRender();
  return host.written.slice(beforeClose);
}

/** The clean post-close layout for a given chat height. */
function expectedTail(): string[] {
  return ["❯ editor", "? for shortcuts"];
}

describe("fleet bar hold-down across the hub overlay (real renderer, real components)", () => {
  it("short transcript: restores the bottom edge after the hub closes", async () => {
    const { term, host, fleet } = boot();
    await flushRender();

    // Sanity: the bar sits between the editor and the footer, and registering
    // it turned on the renderer's clear-on-shrink redraw (the upstream-gap
    // bridge: shrink-averse renderers must full-redraw the band on close).
    {
      const scr = decodeScreen(term.written, term.rows).filter(r => r.trim() !== "");
      expect(lastContentRow(scr)).toBe("? for shortcuts");
      expect(scr.some(r => r.includes("long task"))).toBe(true);
      expect(host.tui.getClearOnShrink()).toBe(true);
    }

    const closeBytes = await openAndCloseHub(host, fleet);
    // The close render took the clear-on-shrink branch: a full clear+redraw
    // reclaims the bar's row band on ANY renderer that supports the flag.
    expect(closeBytes).toContain("\x1b[2J\x1b[H\x1b[3J");

    const screen = decodeScreen(term.written, term.rows);
    expect(screen.filter(r => r.trim() !== "")).toEqual([
      "transcript line 1", "transcript line 2", ...expectedTail(),
    ]);
  });

  it("scrolled transcript (content taller than the screen): restores the bottom edge", async () => {
    const chat = Array.from({ length: 60 }, (_, i) => `chat line ${i}`);
    const { term, host, fleet } = boot(chat);
    await flushRender();

    // Sanity: the bar is on screen and the viewport shows the transcript tail.
    {
      const scr = decodeScreen(term.written, term.rows);
      expect(lastContentRow(scr)).toBe("? for shortcuts");
      expect(scr.some(r => r.includes("long task"))).toBe(true);
      expect(scr.some(r => r.includes("chat line 59"))).toBe(true);
    }

    await openAndCloseHub(host, fleet);

    // The viewport shows the tail of the 63-row layout: chat 39-59, spacer,
    // editor, footer.
    const screen = decodeScreen(term.written, term.rows);
    const chatTail = Array.from({ length: 21 }, (_, i) => `chat line ${39 + i}`);
    expect(screen.filter(r => r.trim() !== "")).toEqual([...chatTail, "❯ editor", "? for shortcuts"]);
  });

  it("popup ↔ full-screen toggle then Esc: restores the bottom edge", async () => {
    const { term, host, fleet } = boot();
    await flushRender();

    await openToggleCloseHub(host, fleet);

    const screen = decodeScreen(term.written, term.rows);
    expect(screen.filter(r => r.trim() !== "")).toEqual([
      "transcript line 1", "transcript line 2", "❯ editor", "? for shortcuts",
    ]);
  });

  it("popup chat (fleet Enter-on-agent flow): restores the bottom edge", async () => {
    const { term, host, fleet } = boot();
    await flushRender();

    await openAndCloseHub(host, fleet, { agentId: "a1" });

    const screen = decodeScreen(term.written, term.rows);
    expect(screen.filter(r => r.trim() !== "")).toEqual([
      "transcript line 1", "transcript line 2", "❯ editor", "? for shortcuts",
    ]);
  });
});
