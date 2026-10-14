import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps, HUB_SIZE_REFUSAL, type HubUICtx, openAgentHub } from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import type { FleetWorkflow } from "../src/ui/fleet-list.js";
import type { WorkflowDialogSource } from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/** Visible text: ANSI and the fake theme's markers stripped (their width is zero in a terminal). */
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

/** The cells either side of the pane bars, measured from the line itself. */
const leftCell = (line: string) => line.slice(1, line.indexOf("│", 1));
const rightCell = (line: string) => line.slice(line.indexOf("│", 1) + 1);

describe("hub pane invariant — detail is always on the right", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

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

describe("page footers, breadcrumbs and esc", () => {
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

  it("breadcrumb shows the trail and grows one level per page", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    expect(h.frame().join("\n")).toContain("Agents & Workflows");
    h.press(DOWN);
    h.press("\r");
    expect(h.frame().join("\n")).toContain("Agents & Workflows › migrate-v2");
    h.press("\r");
    expect(h.frame().join("\n")).toContain("Agents & Workflows › migrate-v2 › m-1");
    h.press("l");
    expect(h.frame().join("\n")).toContain("Agents & Workflows › migrate-v2 › m-1 › log");
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
    expect(h.frame().join("\n")).toContain("› m-1 › log");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("› migrate-v2 › m-1");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("› migrate-v2");
    expect(h.frame().join("\n")).not.toContain("› migrate-v2 › m-1");
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
    expect(frame).toContain("› general-purpose › log");
    expect(frame).toContain("spawn");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
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
    // one column. (The breadcrumb, not the footer, is the stable witness: the
    // test theme's fake markers push hints out of a 50-column line.)
    h.press("\r");
    expect(h.frame(50).join("\n")).toContain("general-purp");
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
