import * as piHost from "@earendil-works/pi-coding-agent";
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
    // Teeth: the master cell's content is exactly the section header — a torn
    // or mis-measured frame fails this, not just the width checks above.
    expect(split.some(l => leftCell(l).trimEnd() === " SUBAGENTS")).toBe(true);
    expect(split.every(l => leftCell(l).length === MASTER_LIST_WIDTH + 2 * PANE_PADDING)).toBe(true);
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
      const [head, sub, rule] = identity(h.frame());
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

  it("identity occupies the first three rows; the body starts directly under the rule", () => {
    const h = pageHarness();
    h.open();
    h.press("l"); // SL
    const before = identity(h.frame());
    for (let i = 0; i < 5; i++) h.press(DOWN);
    // Scrolling moves the body only: the identity triple is byte-identical
    // and still the pane's first three rows.
    expect(identity(h.frame())).toEqual(before);
    const rows = rightRows(h.frame());
    expect(rows.slice(0, 3), "identity is the first three rows").toEqual(before);
    expect(rows.length, "a body exists under the rule").toBeGreaterThan(3);
    expect(rows[3], "the row under the rule is body, not another rule or blank").not.toBe(before[2]);
    expect(rows[3].trim()).not.toBe("");
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
    expect(frame).toContain("Esc roster");
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
    expect(h.frame().join("\n")).toContain("Esc back");
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
    expect(h.frame().join("\n")).toContain("Esc roster");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("Esc close");
    expect(h.settled()).toBe(false);
  });

  it("l straight on a subagent row opens the log page and esc returns to the roster", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("l");
    const frame = h.frame().join("\n");
    expect(frame).toContain("spawn");
    expect(frame).toContain("Esc back");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.frame().join("\n")).toContain("Esc close");
    expect(h.settled()).toBe(false);
  });
});

describe("the footer band", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  /** The footer row's content columns at 120: `│ <116> │`. */
  const bandOf = (frame: string[]) => (frame.at(-2) ?? "").slice(2, -2);
  /**
   * The band's two slots, split at the gap between them. The left slot's own
   * separators are single spaces, so the first run of two or more is the gap.
   */
  const slots = (content: string) => {
    const at = content.search(/ {2,}/);
    let end = at;
    while (content[end] === " ") end++;
    return { left: content.slice(0, at), gap: end - at, right: content.slice(end) };
  };

  it("R: the roster's actions left, navigation and the twin right, flush to the edge", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    const frame = h.frame();
    // The band rule carries the divider's `┴`; the bottom edge below is plain.
    expect(frame.at(-1)).not.toContain("┴");
    expect(frame.at(-3)!.indexOf("┴")).toBe(DIVIDER);
    expect(frame.at(-1)!.endsWith("╯")).toBe(true);
    const { left, gap, right } = slots(bandOf(frame));
    expect(left).toBe("⏎ transcript · l log · p pause · c copy");
    expect(gap).toBeGreaterThanOrEqual(2);
    // The full-screen twin would give the popup, so that is the twin it names.
    expect(right).toBe("↑↓ select · ⇥ activity · f popup · Esc close");
    expect(bandOf(frame).length).toBe(116);
  });

  it("R: the run row's band offers the run's keys", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press(DOWN);
    expect(slots(bandOf(h.frame())).left).toBe("⏎ open run · s stop run · c copy");
  });

  it("T: the readout drops first and the page's hints and escape anchor survive", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press("\r"); // T
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toBe("Enter steer · x stop · m md");
    expect(right).toBe("PgUp/PgDn · j scroll · o expand · l log · p pause · c copy · f popup · Esc roster");
  });

  it("TD: the expanded call swaps `m md` for `c copy diff` and drops `o expand`", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press("\r"); // T
    h.frame(); // the viewer builds on the first render
    expect(slots(bandOf(h.frame())).right).toContain("o expand");
    h.press("\x0f"); // ctrl+o — expand in place, no new page
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toContain("c copy diff");
    expect(left).not.toContain("m md");
    expect(right).not.toContain("o expand");
    // TD is a view state: the roster page is still the one beneath it.
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
  });

  it("SL: the log's readout rides the left slot, the page's keys the right", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press("l"); // SL straight from the roster
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toBe("2 lines · 100% · x stop");
    expect(right).toBe("↑↓ scroll · c copy tail · p pause agent · f popup · Esc back");
  });

  it("W: the band reads the run's counters and phase position", () => {
    const h = harness([makeRecord({ id: "r1" })], { workflows, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toBe("1/2 agents · phase 1 of 1");
    expect(right).toBe("↑↓ item · ⏎ agent · l run log · s stop run · f popup · Esc roster");
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

  it("60–99 cols keep both panes", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 60, rows: 16 });
    h.open();
    const frame = h.frame(60);
    expect(frame[0]).toContain("┬");
    expect(frame.join("\n")).toContain("SUBAGENTS");
    expect(frame.join("\n")).toContain("● Agent");
  });

  it("fills the terminal exactly: chrome is the two edges, the band rule and the footer", () => {
    for (const rows of [10, 12, 15, 16, 24, 40]) {
      for (const cols of [60, 120]) {
        const h = harness([makeRecord({ id: "a1" })], {}, { cols, rows });
        h.open();
        const frame = h.frame(cols);
        expect(frame.length, `${cols}x${rows}`).toBe(rows);
        // The `❞` strip is gone: nothing sits between the body and the band rule.
        expect(frame.join("\n"), `${cols}x${rows}`).not.toContain("❞");
      }
    }
  });

  it("floors the body at six rows at ten rows — the floor is the arithmetic, not a clamp", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 10 });
    h.open();
    const frame = h.frame(120);
    // Top edge, six split body rows, band rule, footer, bottom edge.
    const body = frame.slice(1, -3);
    expect(body).toHaveLength(6);
    expect(body.every(l => l.indexOf("│", 1) === DIVIDER)).toBe(true);
    expect(frame.at(-3)).toContain("┴");
    expect(frame.at(-1)!.endsWith("╯")).toBe(true);
  });

  it("the filter row is full width directly under the top edge and costs the body a row", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 10 });
    h.open();
    h.press("/");
    h.press("a");
    const frame = h.frame(120);
    expect(frame.length).toBe(10);
    // Row 1 is the filter input: full width — the two edge bars and no pane
    // divider — above the body.
    expect(frame[1]).toContain("> a");
    expect([...frame[1]].filter(ch => ch === "│")).toHaveLength(2);
    expect(frame[1][DIVIDER]).not.toBe("│");
    // The body gives up the row the filter takes: five, not six.
    const body = frame.slice(2, -3);
    expect(body).toHaveLength(5);
    expect(body.every(l => l.indexOf("│", 1) === DIVIDER)).toBe(true);
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

  it("k on the run log page scrolls rather than reaching the run's stop", () => {
    const stopWorkflow = vi.fn();
    const h = harness([makeRecord({ id: "r1" })], { workflows, stopWorkflow, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    h.press("k"); // scroll-up on the log pages (D7), never a stop
    expect(stopWorkflow).not.toHaveBeenCalled();
    // The guarded failure mode: `k` falling through to the roster's
    // per-row stop for the focused record.
    expect(h.deps.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).not.toContain("x again to STOP");
  });

  it("log pages open at the newest events, not the spawn line", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      {
        agentActivity: new Map([["r1", { turnCount: 9, activeTools: [], responseText: "" } as never]]),
      },
      { rows: 10 },
    );
    h.open();
    h.press("l"); // SL — the body is three rows, the log is eleven lines
    const body = h.frame().filter(l => l.startsWith("│")).map(l => l.slice(23, 118).trimEnd());
    expect(body.join("\n")).not.toContain("spawn");
    expect(body.join("\n")).toContain("still running");
  });

  it("c on the run log page still has a subject: the run's most recently active agent", async () => {
    // The reason the W/L branch of `focusedRecord()` survives the status
    // strip: the log page's advertised `c copy tail` copies that agent's
    // result, and `p` pauses it.
    const copy = vi.spyOn(piHost, "copyToClipboard").mockResolvedValue(undefined);
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables", status: "completed", result: "the final answer" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    h.press("c");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(copy).toHaveBeenCalledWith("the final answer");
    copy.mockRestore();
  });
});
