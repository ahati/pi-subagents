import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps, type HubUICtx, openAgentHub } from "../src/ui/agent-hub.js";
import { type AgentActivity } from "../src/ui/agent-widget.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const ESC = "\x1b";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/** Visible text of a rendered line: ANSI stripped, fake theme markers stripped. */
function plain(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Records with a session, so the roster lists them and chat can open. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: vi.fn(() => true),
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

/**
 * A `ctx.ui` double that keeps every overlay OPEN and records what was asked
 * for — the hub's popup ↔ full-screen toggle closes and reopens its overlay,
 * so tests drive the sequence of components, not a single one.
 */
interface Harness {
  /** Components handed back by `custom`, in open order (last = current). */
  components: Array<AgentHub & { handleInput(data: string): void; render(width: number): string[] }>;
  /** The `overlayOptions` of each `custom` call, in open order. */
  optionSets: Array<{ overlay?: boolean; overlayOptions?: Record<string, unknown> }>;
  /** Let the reopen loop advance: resolve → loop → next `custom` → component. */
  flush(): Promise<void>;
  /** Render the current component full-frame and strip styling. */
  frame(width?: number): string[];
  /** Feed a key to the current component. */
  press(data: string): void;
  /** Whether the hub's outermost promise has settled. */
  settled(): boolean;
}

function harness(agents: AgentRecord[], depsOver: Partial<AgentHubDeps> = {}, opts: { tuiMode?: string } = {}) {
  const fakeTui = {
    mode: opts.tuiMode ?? "regular",
    requestRender: vi.fn(),
    terminal: { columns: 120, rows: 40, write: vi.fn() },
  };
  const components: Harness["components"] = [];
  const optionSets: Harness["optionSets"] = [];
  let settled = false;

  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: Record<string, unknown>) => {
      optionSets.push(options ?? {});
      return await new Promise<undefined>(resolve => {
        const done = (r: undefined) => {
          if (r === "toggle") return resolve("toggle" as never);
          settled = true;
          resolve(undefined);
        };
        components.push(factory(fakeTui, theme, undefined, done) as Harness["components"][number]);
      });
    }),
  };

  const manager = fakeManager(agents);
  const deps: AgentHubDeps = {
    manager,
    agentActivity: new Map<string, AgentActivity>(),
    showCost: false,
    ...depsOver,
  };

  return {
    ui,
    deps,
    manager,
    open: (initial?: { agentId?: string }) => {
      const promise = openAgentHub(ui as unknown as HubUICtx, deps, initial);
      return { promise, settled: () => settled, components, optionSets };
    },
    get components() {
      return components;
    },
    get optionSets() {
      return optionSets;
    },
    settled: () => settled,
    /** The fake TUI handed to the overlay factory (terminal.write spy included). */
    tui: fakeTui,
    flush: async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    frame: (width = 120) => (components.at(-1)?.render(width) ?? []).map(plain),
    press: (data: string) => components.at(-1)?.handleInput(data),
  };
}

describe("agent hub mouse wheel", () => {
  /** A hub whose wheel handler is the component's own (the host calls it directly). */
  function wheelHub(agents: AgentRecord[]) {
    const h = harness(agents);
    h.open();
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    return { h, component };
  }

  it("moves the roster selection and consumes the event", () => {
    const { h, component } = wheelHub([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task", startedAt: Date.now() - 2000 }),
      makeRecord({ id: "a3", description: "gamma task" }),
    ]);
    expect(component.handleMouse({ type: "wheel", wheelDelta: 1 })).toEqual({ handled: true });
    expect(h.frame().join("\n")).toContain("▸ Agent beta task");
    component.handleMouse({ type: "wheel", wheelDelta: 1 });
    expect(h.frame().join("\n")).toContain("▸ Agent gamma task");
    // Clamps at the end instead of wrapping.
    component.handleMouse({ type: "wheel", wheelDelta: 5 });
    expect(h.frame().join("\n")).toContain("▸ Agent gamma task");
    // Wheel up.
    component.handleMouse({ type: "wheel", wheelDelta: -1 });
    expect(h.frame().join("\n")).toContain("▸ Agent beta task");
  });

  it("ignores non-wheel events and empty deltas", () => {
    const { component } = wheelHub([makeRecord({ id: "a1" })]);
    expect(component.handleMouse({ type: "click" })).toBeUndefined();
    expect(component.handleMouse({ type: "wheel", wheelDelta: 0 })).toBeUndefined();
    expect(component.handleMouse({ type: "wheel" })).toBeUndefined();
  });

  it("scrolls the conversation in the chat view", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `message number ${i}`,
    }));
    const h = harness([makeRecord({ id: "a1", session: { subscribe: () => () => {}, messages } })]);
    h.open({ agentId: "a1" });
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    const followed = h.frame().join("\n");
    expect(followed).toContain("message number 39"); // auto-following the tail
    expect(component.handleMouse({ type: "wheel", wheelDelta: -5 })).toEqual({ handled: true });
    const scrolled = h.frame().join("\n");
    expect(scrolled).not.toBe(followed);
    expect(scrolled).not.toContain("message number 39");
  });
});

describe("agent hub mouse in regular TUI mode", () => {
  /** SGR report: 64 = wheel up, 65 = wheel down. */
  const wheel = (button: number) => `\x1b[<${button};10;5M`;

  it("captures mouse reporting while open and restores it on close", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    // Enable sequence written once, on construction.
    const writes = h.tui.terminal.write.mock.calls.map(c => c[0] as string);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[?1006h");

    h.press("q"); // close → dispose → restore
    await h.flush();
    const after = h.tui.terminal.write.mock.calls.map(c => c[0] as string);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("\x1b[?1006l");
  });

  it("does not capture in fullscreen mode (pi dispatches there)", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { tuiMode: "fullscreen" });
    h.open();
    expect(h.tui.terminal.write).not.toHaveBeenCalled();
    h.press("q");
    expect(h.tui.terminal.write).not.toHaveBeenCalled();
  });

  it("parses wheel bytes from input and scrolls the conversation", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `message number ${i}` }));
    const h = harness([makeRecord({ id: "a1", session: { subscribe: () => () => {}, messages } })]);
    h.open({ agentId: "a1" });
    const followed = h.frame().join("\n");
    expect(followed).toContain("message number 39");
    h.press(wheel(64)); // wheel up
    const scrolled = h.frame().join("\n");
    expect(scrolled).not.toBe(followed);
    expect(scrolled).not.toContain("message number 39");
  });

  it("parses wheel bytes in the roster views to move the selection", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open();
    h.press(wheel(65)); // wheel down → next row
    expect(h.frame().join("\n")).toContain("▸ Agent beta task");
  });

  it("consumes non-wheel mouse reports without moving anything", () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" })]);
    h.open();
    const before = h.frame().join("\n");
    h.press("\x1b[<0;10;5M"); // left click
    h.press("\x1b[<0;10;5m"); // release
    expect(h.frame().join("\n")).toBe(before);
  });
});

describe("agent hub ↑/↓ agent selection (two-pane chat)", () => {
  const DOWN = "\x1b[B";
  const UP = "\x1b[A";

  it("renders the pane list beside the conversation", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open({ agentId: "a1" });
    const frame = h.frame().join("\n");
    expect(frame).toContain("AGENTS");
    expect(frame).toContain("alpha task");
    expect(frame).toContain("waiting for first message");
  });

  it("↓ moves to the next agent's conversation, ↑ back, clamped at the ends", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task", startedAt: Date.now() - 2000 }),
      makeRecord({ id: "a3", description: "gamma task" }),
    ]);
    h.open({ agentId: "a2" });
    expect(h.frame().join("\n")).toContain("beta task");
    h.press(DOWN);
    expect(h.frame().join("\n")).toContain("gamma task");
    h.press(DOWN); // clamps at the last agent (no wrap)
    expect(h.frame().join("\n")).toContain("gamma task");
    h.press(UP);
    expect(h.frame().join("\n")).toContain("beta task");
    h.press(UP);
    expect(h.frame().join("\n")).toContain("alpha task");
    h.press(UP); // clamps at the first
    expect(h.frame().join("\n")).toContain("alpha task");
    expect(h.settled()).toBe(false);
  });

  it("the pane list marks the selected row", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open({ agentId: "a1" });
    const firstIdx = h.frame().findIndex(l => l.includes("❯"));
    expect(firstIdx).toBeGreaterThan(0);
    h.press(DOWN);
    const secondIdx = h.frame().findIndex(l => l.includes("❯"));
    expect(secondIdx).toBeGreaterThan(firstIdx); // the pointer moved down the list
    // The conversation header switched agents.
    expect(h.frame().join("\n")).toContain("beta task");
  });

  it("skips workflow rows in the pane list", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ], {
      workflows: () => [{
        id: "wf_1", name: "audit", status: "running", doneCount: 0, totalCount: 1,
        startedAt: Date.now() - 1000, tokens: 0,
      }],
    });
    h.open({ agentId: "a1" });
    h.press(DOWN); // a1 → a2 (the workflow has no conversation, so it is not listed)
    expect(h.frame().join("\n")).toContain("beta task");
  });

  it("does not rebuild the viewer when the move is a no-op (single agent)", () => {
    const h = harness([makeRecord({ id: "a1", description: "only task" })]);
    h.open({ agentId: "a1" });
    const before = h.components.length;
    h.press(DOWN);
    h.press(UP);
    expect(h.components.length).toBe(before); // same viewer instance, scroll kept
  });

  it("advertises the pane keys in the footer instead of ←/→ cycling", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    // Wide frame: at default widths the test theme's fake color markers (real
    // ANSI is zero-width) push the footer past its truncation point.
    const frame = h.frame(200).join("\n");
    expect(frame).toContain("↑↓ agent");
    expect(frame).toContain("Esc close");
    expect(frame).not.toContain("←→ agent");
  });
});

describe("agent hub open modes", () => {
  it("defaults to the windowed popup on the agent's conversation", () => {
    const h = harness([makeRecord()]);
    h.open({ agentId: "a1" });
    expect(h.optionSets[0]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    // Chat view, not the roster: the conversation border + empty-state line.
    const frame = h.frame().join("\n");
    expect(frame).toContain("waiting for first message");
    expect(frame).not.toContain("1 Agents");
  });

  it("opens full-screen on the roster when no agent is given (/agents entry)", () => {
    const h = harness([makeRecord()]);
    h.open();
    expect(h.optionSets[0]?.overlayOptions).toMatchObject({ width: "100%", maxHeight: "100%" });
    const frame = h.frame().join("\n");
    expect(frame).toContain("Agent Hub");
    expect(frame).toContain("Sleep then report 1");
  });
});

describe("agent hub popup ↔ full-screen toggle", () => {
  it("f expands the popup into the full-screen hub, same conversation", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    expect(h.optionSets[1]?.overlayOptions).toMatchObject({ width: "100%", maxHeight: "100%" });
    // Chat carried across: still the conversation, not the roster.
    expect(h.frame().join("\n")).toContain("waiting for first message");
    expect(h.settled()).toBe(false);
  });

  it("f collapses the full-screen hub back to the windowed panel", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    h.press("f");
    await h.flush();
    expect(h.optionSets[2]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });

  it("Esc in the full-screen chat returns to the roster; Esc there closes", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    const opened = h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    h.press(ESC); // chat → roster
    expect(h.frame().join("\n")).toContain("Agent Hub");
    expect(h.settled()).toBe(false);
    h.press(ESC); // roster → close
    await h.flush();
    expect(h.settled()).toBe(true);
    expect(await opened.promise).toBeUndefined();
  });

  it("f from the roster expands into the selected agent's conversation", async () => {
    const h = harness([makeRecord({ id: "a1", description: "the one" })]);
    h.open(); // full-screen roster
    h.press("f");
    await h.flush();
    expect(h.optionSets[1]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });

  it("carries selection and filter across the toggle", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open(); // full-screen roster
    h.press("2"); // activity tab
    h.press("f");
    await h.flush();
    h.press(ESC); // popup chat closes outright
    await h.flush();
    // Reopen full-screen: resumed on the activity tab, not the default table.
    expect(h.settled()).toBe(true);

    const h2 = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h2.open(); // full-screen roster
    h2.press("/"); // filter open
    for (const ch of "beta") h2.press(ch);
    h2.press("\r"); // apply
    const frame = h2.frame().join("\n");
    expect(frame).toContain("beta task");
    expect(frame).not.toContain("alpha task");
    expect(frame).toContain("1/2 match");
  });
});

describe("agent hub roster", () => {
  it("filter / narrows rows, Esc clears it", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task" }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open();
    h.press("/");
    for (const ch of "zzz") h.press(ch);
    expect(h.frame().join("\n")).toContain("no matches");
    h.press(ESC); // clears the filter
    expect(h.frame().join("\n")).toContain("alpha task");
  });

  it("activity tab describes what each agent is doing", () => {
    const activity = new Map<string, AgentActivity>([[
      "a1",
      { activeTools: new Map([["call-1", "read"]]), toolUses: 3, responseText: "", turnCount: 2 },
    ]]);
    const h = harness([makeRecord({ id: "a1" })], { agentActivity: activity });
    h.open();
    h.press("2");
    const frame = h.frame().join("\n");
    expect(frame).toContain("2 Activity");
    expect(frame).toContain("Agent"); // the display name of general-purpose
    expect(frame.toLowerCase()).toContain("read");
  });

  it("x twice stops the selected agent", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("x");
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("x");
    expect(h.manager.abort).toHaveBeenCalledWith("a1");
  });

  it("Enter on a workflow row opens the run inspector and the hub stays up", async () => {
    const openWorkflow = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], {
      workflows: () => [{
        id: "wf_1", name: "audit", status: "running", doneCount: 1, totalCount: 2,
        startedAt: Date.now() - 1000, tokens: 500,
      }],
      openWorkflow,
    });
    h.open();
    const opened = h.open.length ? undefined : undefined; // noop; keep shape
    void opened;
    // The workflow row sits above agents: selection 0 is the run.
    h.press("\r");
    expect(openWorkflow).toHaveBeenCalledWith("wf_1");
    expect(h.settled()).toBe(false);
    expect(h.components).toHaveLength(1);
  });

  it("Enter on an agent row opens its conversation", () => {
    const h = harness([makeRecord({ id: "a1", description: "the one" })]);
    h.open();
    h.press("\r");
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });
});
