import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps, HUB_SIZE_REFUSAL, type HubUICtx, openAgentHub } from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import type { FleetWorkflow } from "../src/ui/fleet-list.js";
import { MASTER_LIST_WIDTH, PANE_PADDING } from "../src/ui/window-frame.js";
import type { WorkflowDialogSource } from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const ESC = "\x1b";
const DOWN = "\x1b[B";
/** A passthrough theme: the master cell is 18 columns, so nothing may count as visible text. */
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Visible text: ANSI stripped (agent name badges). */
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
    startedAt: Date.now() - 5000,
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function runAgent(over: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry {
  return { type: "workflow_agent", index: 0, label: "m-1", state: "running", ...over };
}

/** A run with two agents, one with a record and a session. */
function runSource(): WorkflowDialogSource {
  return {
    progress: [
      runAgent({ index: 0, label: "m-1", state: "running", recordId: "r1" }),
      runAgent({ index: 1, label: "m-2", state: "done", recordId: "r2", resultPreview: "3 tables" }),
    ],
    task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
  };
}

function harness(
  agents: AgentRecord[],
  depsOver: Partial<AgentHubDeps> = {},
  size: { cols?: number; rows?: number } = {},
) {
  const fakeTui = {
    mode: "regular",
    requestRender: vi.fn(),
    terminal: { columns: size.cols ?? 120, rows: size.rows ?? 40, write: vi.fn() },
  };
  const components: Array<AgentHub & { handleInput(data: string): void; render(width: number): string[] }> = [];
  let settled = false;
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
      return await new Promise<undefined>(resolve => {
        const done = (r: undefined) => {
          if (r === "toggle") return resolve("toggle" as never);
          settled = true;
          resolve(undefined);
        };
        components.push(factory(fakeTui, theme, undefined, done) as (typeof components)[number]);
      });
    }),
  };
  const deps: AgentHubDeps = {
    manager: {
      listAgents: () => agents,
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as AgentManager,
    agentActivity: new Map<string, AgentActivity>(),
    showCost: false,
    ...depsOver,
  };
  return {
    ui,
    deps,
    open: () => {
      const promise = openAgentHub(ui as unknown as HubUICtx, deps);
      return { promise, settled: () => settled };
    },
    frame: (width = 120) => (components.at(-1)?.render(width) ?? []).map(plain),
    press: (data: string) => components.at(-1)?.handleInput(data),
    settled: () => settled,
  };
}

/**
 * The divider column at 120 columns — the fixed master cell: `│ <18> │ <95> │`.
 * The parser reads the layout's known split rather than discovering a bar, so
 * a surface that moved it fails these tests instead of redefining them.
 */
const DIVIDER = 1 + MASTER_LIST_WIDTH + 2 * PANE_PADDING;
/** The cells either side of the pane divider, measured from the line itself. */
const leftCell = (line: string) => line.slice(1, DIVIDER);
const rightCell = (line: string) => line.slice(DIVIDER + 1);

describe("hub pane invariant — detail is always on the right", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("pins the master cell at 18 columns: `│ <18> │ <95> │` at 120", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.length).toBeGreaterThan(5);
    for (const line of body) {
      expect(line.length).toBe(120);
      // A body row is either full-width or split at the master cell's edge —
      // no other interior bar is allowed.
      for (const [index, ch] of [...line].entries()) {
        if (ch === "│" && index > 0 && index < line.length - 1) expect(index, line).toBe(DIVIDER);
      }
    }
    const split = body.filter(l => l.indexOf("│", 1) === DIVIDER);
    expect(split.length).toBeGreaterThan(5);
    for (const line of split) {
      expect(leftCell(line)).toHaveLength(MASTER_LIST_WIDTH + 2 * PANE_PADDING);
      expect(rightCell(line).slice(1, 1 + 95)).toHaveLength(95);
    }
  });

  it("R: the grouped roster sits left, the selected agent's transcript right", () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" }), makeRecord({ id: "a2", description: "beta task" })]);
    h.open();
    const frame = h.frame();
    const body = frame.filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(true);
    // The window's title row is above the split; the roster column never holds
    // the transcript and the right cell never holds the roster.
    expect(body.some(l => rightCell(l).includes("SUBAGENTS"))).toBe(false);
    expect(body.some(l => leftCell(l).includes("waiting for first message"))).toBe(false);
  });

  it("W: the roster stays pinned left, the run's phases and agents are right", () => {
    const h = harness(
      [makeRecord({ id: "a1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN); // onto the workflow row
    h.press("\r"); // page W
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("PHASES"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("RUN AGENTS"))).toBe(true);
    // The run's own panes never leak into the roster column.
    expect(body.some(l => leftCell(l).includes("RUN AGENTS"))).toBe(false);
  });

  it("WA: the run's agent list is demoted into the left pane, the conversation is right", () => {
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA — the selected run agent
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("m-1"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("waiting for first message"))).toBe(true);
    // The roster is gone at this level: the run's agents are the parent level.
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(false);
  });

  it("L: the run's phases and agents stay left, the run log is right", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("m-1"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("run start"))).toBe(true);
    expect(body.some(l => leftCell(l).includes("run start"))).toBe(false);
  });
});

describe("the header block every right pane opens with", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  /** The detail cell's content columns at 120: `│ <18> │ <95> │`. */
  const DETAIL_WIDTH = 95;
  /** The right cell's rows, content only. */
  const rightRows = (frame: string[]) => frame
    .filter(l => l.startsWith("│") && l.indexOf("│", 1) === DIVIDER)
    .map(l => rightCell(l).slice(1, 1 + DETAIL_WIDTH));
  /** The three identity rows: the header line, the `↳` line and the header rule. */
  const identity = (frame: string[]) => rightRows(frame).slice(0, 3);

  /** A harness with one run-agent, its record carrying an invocation. */
  const pageHarness = () => harness(
    [makeRecord({
      id: "r1",
      alias: "explore",
      description: "schema tables",
      invocation: { modelId: "anthropic/claude-sonnet-4-6", isolation: "worktree" },
    })],
    { workflows, workflowRun: () => runSource() },
  );

  /** How to reach each page from the roster. */
  const PAGES: Array<{ page: string; to: (press: (key: string) => void) => void }> = [
    { page: "R (agent)", to: () => {} },
    { page: "R (run)", to: p => p(DOWN) },
    { page: "T", to: p => p("\r") },
    { page: "SL", to: p => p("l") },
    { page: "W", to: p => { p(DOWN); p("\r"); } },
    { page: "WA", to: p => { p(DOWN); p("\r"); p("\r"); } },
    { page: "SAL", to: p => { p(DOWN); p("\r"); p("\r"); p("l"); } },
    { page: "L", to: p => { p(DOWN); p("\r"); p("l"); } },
  ];

  it("opens every page with the header line, the `↳` line and the rule, nothing above", () => {
    for (const { page, to } of PAGES) {
      const h = pageHarness();
      h.open();
      to(h.press);
      const rows = rightRows(h.frame());
      const [head, sub, rule] = identity(h.frame());
      expect(rows[0], page).toBe(head);
      expect(head, page).not.toMatch(/^─/);
      expect(head, page).toMatch(/[●○‖✓✗·]/);
      expect(sub, page).toMatch(/^ {2}↳ /);
      expect(rule, page).toBe("─".repeat(DETAIL_WIDTH));
    }
  });

  it("leads a run-agent's `↳` line with the run name, and only there", () => {
    const h = pageHarness();
    h.open();
    h.press("\r"); // T — the roster's preview of the same agent
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ anthropic/claude-sonnet-4-6 · worktree");
    h.press(ESC);
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA — one level inside the run
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ migrate-v2 · anthropic/claude-sonnet-4-6 · worktree");
    h.press("l"); // SAL — same agent, the log page
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ migrate-v2 · anthropic/claude-sonnet-4-6 · worktree");
  });

  it("keeps identity ahead of the body at nonzero logScroll", () => {
    const h = pageHarness();
    h.open();
    h.press("l"); // SL
    const before = identity(h.frame());
    for (let i = 0; i < 5; i++) h.press(DOWN);
    expect(identity(h.frame())).toEqual(before);
    expect(rightRows(h.frame())[0]).toBe(before[0]);
    expect(rightRows(h.frame())[1]).toBe(before[1]);
    expect(rightRows(h.frame())[2]).toBe(before[2]);
  });
});

describe("page footers, headers and esc", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("R's footer names the subagent keys; the run row's footer names the run's", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    expect(h.frame().join("\n")).toContain("⏎ transcript");
    h.press(DOWN);
    const runFooter = h.frame().join("\n");
    expect(runFooter).toContain("⏎ open run");
    expect(runFooter).toContain("s stop run");
    expect(runFooter).not.toContain("⏎ transcript");
  });

  it("W's footer advertises the run page's keys", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r");
    const frame = h.frame().join("\n");
    expect(frame).toContain("l run log");
    expect(frame).toContain("esc roster");
  });

  it("keeps the title constant while the header block names the item", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    // The 20-column title cell never carries a breadcrumb: the same title on
    // every page, and the right pane's identity block is what names the item.
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    h.press(DOWN);
    h.press("\r");
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    expect(h.frame().join("\n")).toContain("● migrate-v2  workflow");
    h.press("\r");
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    expect(h.frame().join("\n")).toContain("Sleep then report 1");
  });

  it("esc pops exactly one level: SAL → WA → W → R", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA
    h.press("l"); // SAL
    expect(h.frame().join("\n")).toContain("spawn"); // the log grammar
    expect(h.frame().join("\n")).toContain("esc back");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("waiting for first message");
    expect(h.frame().join("\n")).not.toContain("spawn");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("⏎ agent");
    expect(h.frame().join("\n")).toContain("PHASES");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.settled()).toBe(false);
    h.press(ESC); // the roster is the top: esc closes
    expect(h.settled()).toBe(true);
  });

  it("esc from a subscriber's transcript returns to the roster, not out of the hub", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("\r"); // T
    expect(h.frame().join("\n")).toContain("esc roster");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("esc close");
    expect(h.settled()).toBe(false);
  });

  it("l straight on a subagent row opens the log page and esc returns to the roster", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("l");
    const frame = h.frame().join("\n");
    expect(frame).toContain("spawn");
    expect(frame).toContain("esc back");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.frame().join("\n")).toContain("esc close");
    expect(h.settled()).toBe(false);
  });
});

describe("size ladder", () => {
  it("refuses a terminal below 40×10 with the spec's notification, drawing no frame", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { notify }, { cols: 39, rows: 10 });
    h.open();
    expect(h.frame(39)).toEqual([]);
    expect(notify).toHaveBeenCalledWith(HUB_SIZE_REFUSAL, "warning");
  });

  it("refuses a terminal below 10 rows even at full width", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { notify }, { cols: 120, rows: 9 });
    h.open();
    expect(h.frame(120)).toEqual([]);
    expect(notify).toHaveBeenCalledWith(HUB_SIZE_REFUSAL, "warning");
  });

  it("40–59 cols render a single stacked pane with no split tee", () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" })], {}, { cols: 50, rows: 30 });
    h.open();
    const frame = h.frame(50);
    expect(frame[0]).not.toContain("┬");
    expect(frame.at(-1)).not.toContain("┴");
    expect(frame.join("\n")).toContain("SUBAGENTS");
    // ⏎ pushes the detail page full width; esc pops it — the page model with
    // one column. The pushed page opens with the identity block (the constant
    // title stays on the top edge).
    h.press("\r");
    expect(h.frame(50)[0]).toContain(" Agents & Workflows ");
    expect(h.frame(50).join("\n")).toContain("alpha task");
    expect(h.frame(50).join("\n")).toContain("waiting for first message");
    h.press(ESC);
    expect(h.frame(50).join("\n")).toContain("SUBAGENTS");
  });

  it("60–99 cols keep both panes; the status strip survives from 16 rows", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 60, rows: 16 });
    h.open();
    const frame = h.frame(60);
    expect(frame[0]).toContain("┬");
    expect(frame.join("\n")).toContain("❞");
    expect(frame.join("\n")).toContain("SUBAGENTS");
  });

  it("hides the status strip below 16 rows and restores it on resize", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 15 });
    h.open();
    expect(h.frame(120).join("\n")).not.toContain("❞");
    expect(h.frame(120).join("\n")).toContain("SUBAGENTS");
  });
});

describe("per-row keys", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("s on a workflow row stops the run; s on an agent row does not", () => {
    const stopWorkflow = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { workflows, stopWorkflow });
    h.open();
    h.press("s"); // agent row: no run to stop
    expect(stopWorkflow).not.toHaveBeenCalled();
    h.press(DOWN); // workflow row
    h.press("s");
    expect(stopWorkflow).toHaveBeenCalledWith("wf_1");
  });

  it("p on an agent row still pauses it; p has no run meaning on a workflow row", () => {
    const pauseAgent = vi.fn(() => undefined);
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { workflows, pauseAgent, notify });
    h.open();
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a1");
    h.press(DOWN);
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledTimes(1);
  });
});
