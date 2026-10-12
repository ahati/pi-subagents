/**
 * Window alignment across the inspector's three levels.
 *
 * Every row of the dialog — borders, header, rules, pane cells, footer — must
 * be exactly the same width, and the vertical bars must sit in the same
 * columns, whichever level is on screen. Otherwise pressing Enter (phases →
 * detail → log) makes the dividers and the right edge jump into a misaligned
 * state.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { WorkflowDialogLogDeps } from "../src/ui/workflow-dialog.js";
import { WorkflowDialog } from "../src/ui/workflow-dialog.js";

const START = 1_700_000_000_000;
/** The width the overlay host asks the component to render at. */
const RENDER_WIDTH = 100;

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

/** A passthrough theme, so `visibleWidth` sees the layout's true geometry. */
const theme = { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never;

function boot() {
  const closed: boolean[] = [];
  const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as never;
  const log: WorkflowDialogLogDeps = {
    getRecord: id => (id === "rec-1" ? makeRecord() : undefined),
    manager: { abort: vi.fn(() => true), steer: vi.fn(() => true) },
    agentActivity: new Map(),
    showCost: () => false,
  };
  const instance = new WorkflowDialog(
    tui,
    () => ({
      progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        { type: "workflow_agent", index: 0, label: "row-one", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-1" },
      ],
      task: { status: "running" as const, workflowName: "wf", startTime: START },
    }),
    theme,
    () => closed.push(true),
    {},
    0,
    log,
  );
  return { instance, closed };
}

/** The columns every vertical-bar glyph occupies in a frame. */
function barColumns(lines: string[]): Set<number> {
  const columns = new Set<number>();
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if ("│├┤┬┴╭╮╰╯".includes(line[i]!)) columns.add(i);
    }
  }
  return columns;
}

describe("workflow dialog window alignment across levels", () => {
  const { instance } = boot();

  const frames: Record<string, string[]> = {
    phases: instance.render(RENDER_WIDTH),
  };
  instance.handleInput("\r"); // open the selected phase → detail level
  frames.detail = instance.render(RENDER_WIDTH);
  instance.handleInput("\r"); // descend to the log on the record-carrying row
  frames.log = instance.render(RENDER_WIDTH);

  it("renders every row of every level at exactly one width", () => {
    for (const [level, lines] of Object.entries(frames)) {
      expect(lines.length, level).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line), `${level}: ${JSON.stringify(line)}`).toBe(RENDER_WIDTH - 6);
      }
    }
  });

  it("keeps the vertical bars in the same columns at every level", () => {
    const phases = barColumns(frames.phases!);
    for (const [level, lines] of Object.entries(frames)) {
      expect([...barColumns(lines)].sort((a, b) => a - b), `${level} bar columns`).toEqual(
        [...phases].sort((a, b) => a - b),
      );
    }
  });

  it("puts the pane's right bar on the window's right border", () => {
    for (const [level, lines] of Object.entries(frames)) {
      const width = RENDER_WIDTH - 6;
      for (const line of lines) {
        expect(line.at(-1), `${level}: last glyph`).toBeDefined();
        expect("│┤╮╯".includes(line.at(-1)!), `${level}: ${JSON.stringify(line)}`).toBe(true);
      }
      void width;
    }
  });
});
