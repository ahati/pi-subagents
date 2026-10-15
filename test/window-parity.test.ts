/**
 * One window, two surfaces.
 *
 * The agent hub's chat pane and the workflow inspector draw the same window:
 * the same split bars, the same tee columns, the same row shape. These are the
 * invariants that make that true — and the ones that failed while the two
 * surfaces still did their own column math (the inspector's divider sat two
 * columns left of the hub's, and its top edge had no tee at all).
 *
 * The window's layout policy lives in `window-frame.ts`; both surfaces call
 * into it. Nothing here re-derives a width: every expectation is the shared
 * function's output, so a surface that starts doing its own arithmetic fails
 * these tests rather than silently drifting.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps } from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import {
  MASTER_LIST_WIDTH,
  masterPaneGeometry,
  PANE_PADDING,
  paneGeometry,
  renderWindow,
  UNICODE_PANE_BOX,
  type WindowRow,
  windowRange,
} from "../src/ui/window-frame.js";
import { WorkflowDialog, type WorkflowDialogLogDeps } from "../src/ui/workflow-dialog.js";

const START = 1_700_000_000_000;
/** A passthrough theme, so the assertions read the layout, not the styling. */
const theme = { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never;
const WIDTHS = [100, 87] as const;

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "rec-1",
    type: "general-purpose",
    description: "verify:auth.ts",
    status: "running",
    toolUses: 0,
    startedAt: START,
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/**
 * The hub at `width`, rendered once and disposed: the popup chat twin by
 * default (the roster list beside the stream), or — with `popup` false — the
 * roster page's own split (`renderHubPage`).
 */
function hubFrames(width: number, popup = true): string[] {
  vi.useFakeTimers();
  const agents = [
    makeRecord({ id: "rec-1", description: "verify:auth.ts", status: "running" }),
    makeRecord({ id: "rec-2", type: "explore", description: "scan the tree", status: "completed" }),
  ];
  const deps: AgentHubDeps = {
    manager: { listAgents: () => agents, abort: vi.fn(() => true), steer: vi.fn(() => true) } as unknown as AgentManager,
    agentActivity: new Map<string, AgentActivity>(),
    showCost: false,
  };
  const hub = new AgentHub(
    { requestRender: vi.fn(), terminal: { columns: 120, rows: 40, write: vi.fn() } } as never,
    theme,
    undefined,
    () => undefined,
    deps,
    popup
      ? { popup: true, resume: { view: "chat", selected: 0, filterText: "", chatRecordId: "rec-1" }, onToggle: () => undefined }
      : { popup: false, resume: { view: "table", selected: 0, filterText: "", chatRecordId: undefined }, onToggle: () => undefined },
  );
  const lines = hub.render(width);
  hub.dispose();
  vi.useRealTimers();
  return lines;
}

/** The inspector's three levels at `width`, driven through its own keys. */
function dialogFrames(width: number): Record<string, string[]> {
  const log: WorkflowDialogLogDeps = {
    getRecord: id => (id === "rec-1" ? makeRecord() : undefined),
    manager: { abort: vi.fn(() => true), steer: vi.fn(() => true) },
    agentActivity: new Map(),
    showCost: () => false,
  };
  const instance = new WorkflowDialog(
    { requestRender: vi.fn(), terminal: { rows: 40 } } as never,
    () => ({
      progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        { type: "workflow_agent", index: 0, label: "row-one", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-1" },
      ],
      task: { status: "running" as const, workflowName: "wf", startTime: START },
    }),
    theme,
    () => undefined,
    {},
    0,
    log,
  );
  const phases = instance.render(width);
  instance.handleInput("\r");
  const detail = instance.render(width);
  instance.handleInput("\r");
  const logLevel = instance.render(width);
  instance.dispose();
  return { phases, detail, log: logLevel };
}

/** The columns the frame's vertical bars and tees occupy. */
function barColumns(lines: readonly string[]): number[] {
  const columns = new Set<number>();
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if ("│├┤┬┴".includes(line[i]!)) columns.add(visibleWidth(line.slice(0, i)));
    }
  }
  return [...columns].sort((a, b) => a - b);
}

describe("one window for both surfaces", () => {
  it("splits the master pane at the shared cell width", () => {
    // The window's one geometry: 18 content columns, one padding column either
    // side, which is the hub's ` Agents ` cell and now the inspector's too.
    const panes = paneGeometry(100);
    expect(MASTER_LIST_WIDTH).toBe(18);
    expect(PANE_PADDING).toBe(1);
    expect(panes.leftCellWidth).toBe(20);
    // 1 + leftCell + 1 + rightCell + 1 = width, exactly.
    expect(1 + panes.leftCellWidth + 1 + panes.rightCellWidth + 1).toBe(100);
  });

  it("gives the master cell way rather than tearing a narrow window", () => {
    const panes = paneGeometry(12);
    expect(panes.listWidth).toBeLessThan(MASTER_LIST_WIDTH);
    expect(1 + panes.leftCellWidth + 1 + panes.rightCellWidth + 1).toBe(12);
  });

  for (const width of WIDTHS) {
    it(`puts the hub's bars in the inspector's columns at ${width} columns`, () => {
      const hub = barColumns(hubFrames(width));
      const panes = paneGeometry(width);
      // Window borders, the pane split, and the right border.
      const expected = [0, panes.leftCellWidth + 1, width - 1];
      expect(hub).toEqual(expected);

      for (const [level, lines] of Object.entries({ hub: hubFrames(width), ...dialogFrames(width) })) {
        expect(barColumns(lines), `${level} at ${width}`).toEqual(expected);
      }
    });

    it(`splits the top and bottom edges where the panes do at ${width} columns`, () => {
      const panes = paneGeometry(width);
      const tee = panes.leftCellWidth + 1;
      for (const [level, lines] of Object.entries({ hub: hubFrames(width), ...dialogFrames(width) })) {
        expect(lines[0]!.indexOf("┬"), `${level} top edge`).toBe(tee);
        expect(lines.at(-1)!.indexOf("┴"), `${level} bottom edge`).toBe(tee);
        for (const line of lines) {
          expect(visibleWidth(line), `${level} at ${width}: ${JSON.stringify(line)}`).toBe(width);
        }
      }
    });
  }

  it("keeps the 18-column master at the 60-column two-pane floor", () => {
    // The one width where the hub's fixed master and the inspector's
    // proportional `paneGeometry` disagree: 21 vs 20. A regression that swaps
    // `renderHubPage` back to `paneGeometry` fails here and nowhere else.
    expect(barColumns(hubFrames(60, false))).toEqual([0, 21, 59]);
  });

  it("names the master pane in the top edge on both surfaces", () => {
    // The hub names its agent list, the inspector names whichever list it is
    // showing; both sit in the top edge, before the first column of rule.
    expect(hubFrames(100)[0]).toContain(" Agents ");
    expect(dialogFrames(100).phases![0]).toContain(" Phases ");
    expect(dialogFrames(100).detail![0]).toContain(" Verify · 1 agent ");
  });

  it("pins the hub page's 120-column split at 18 + 95, tees in one column", () => {
    // The roster page, where the master was a half split: the fixed 18-column
    // master now owns the divider column, and the detail takes the rest.
    const panes = masterPaneGeometry(120);
    expect(panes.listWidth).toBe(18);
    expect(panes.detailWidth).toBe(95);
    const lines = hubFrames(120, false);
    const tee = panes.leftCellWidth + 1;
    expect(barColumns(lines)).toEqual([0, tee, 119]);
    expect(lines[0]!.indexOf("┬"), "top edge").toBe(tee);
    expect(lines.at(-1)!.indexOf("┴"), "bottom edge").toBe(tee);
    for (const line of lines) expect(visibleWidth(line), JSON.stringify(line)).toBe(120);
  });

  it("draws the frame from one row vocabulary", () => {
    // The component itself: the same rows a surface hands over come back as a
    // window. A surface contributes content; it never assembles a bar.
    const rows: WindowRow[] = [
      { kind: "full", cells: [{ text: "header" }] },
      { kind: "titles", right: "detail" },
      { kind: "split", left: [{ text: "master" }], right: [{ text: "content" }] },
      { kind: "seam" },
    ];
    const panes = paneGeometry(40);
    expect(renderWindow({ width: 40, box: UNICODE_PANE_BOX, panes, title: " Master ", rows }).map(line => line.map(c => c.text).join(""))).toEqual([
      "╭ Master ─────┬────────────────────────╮",
      "│ header                               │",
      "├─────────────┬ detail ────────────────┤",
      "│ master      │ content                │",
      "├─────────────┴────────────────────────┤",
      "╰─────────────┴────────────────────────╯",
    ]);
  });

  it("windows a list centered on the selection, clamped at both ends", () => {
    // The one list rule, both surfaces' rosters included.
    expect(windowRange(0, 30, 6)).toEqual({ start: 0, end: 6 });
    expect(windowRange(20, 30, 6)).toEqual({ start: 17, end: 23 });
    expect(windowRange(29, 30, 6)).toEqual({ start: 24, end: 30 });
    expect(windowRange(3, 2, 6)).toEqual({ start: 0, end: 2 });
    expect(windowRange(0, 0, 6)).toEqual({ start: 0, end: 0 });
  });

  it("keeps the inspector's selection centered in a short pane", () => {
    // Twenty phases in a six-row pane, the eleventh selected: the shared rule
    // centers it — three rows above and rows below stay visible. The pane's own
    // arithmetic pinned the selection to the bottom row of the pane instead, so
    // this is the rule change, not just the frame's.
    const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const instance = new WorkflowDialog(
      { requestRender: vi.fn(), terminal: { rows: 19 } } as never,
      () => ({
        progress: [
          ...rows.map(index => ({ type: "workflow_phase", index, title: `P${index}` })),
          ...rows.map(index => ({ type: "workflow_agent", index, label: `row-${index}`, phaseIndex: index, state: "done" })),
        ],
        task: { status: "running" as const, workflowName: "wf", startTime: START },
      }),
      theme,
      () => undefined,
    );
    for (let i = 0; i < 10; i++) instance.handleInput("j");
    const frame = instance.render(100);
    // The pane rows: the header row and the footer row are full-width and would
    // otherwise bracket them.
    const body = frame.filter(line => line.startsWith("\u2502")).slice(1, -1);
    // The pointer is the phase pane's — read the master cell, not the agent
    // row beside it, which carries a `\u276f` of its own.
    const master = body.map(line => line.split("\u2502")[1] ?? "");
    expect(master.findIndex(cell => cell.includes("\u276f"))).toBe(3); // three rows above, two below
    expect(master.at(-1)).toContain("P12");
    expect(master.some(cell => cell.includes("P8"))).toBe(true);
    instance.dispose();
  });
});
