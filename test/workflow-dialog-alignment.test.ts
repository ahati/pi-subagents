/**
 * Window alignment across the inspector's three levels.
 *
 * Every row of the dialog — borders, header, rules, pane cells, footer — must
 * be exactly the same width, and the vertical bars must sit in the same
 * columns, whichever level is on screen. Otherwise pressing Enter (phases →
 * detail → log) makes the dividers and the right edge jump into a misaligned
 * state.
 *
 * That width is the whole of the width the overlay host hands the component:
 * the frame's border and padding are drawn inside it, so anything the dialog
 * reserved here would show up as an empty strip along the overlay's right
 * edge — in the popup and in the full-screen window alike.
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
        expect(visibleWidth(line), `${level}: ${JSON.stringify(line)}`).toBe(RENDER_WIDTH);
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
      for (const line of lines) {
        expect(line.at(-1), `${level}: last glyph`).toBeDefined();
        expect("│┤╮╯".includes(line.at(-1)!), `${level}: ${JSON.stringify(line)}`).toBe(true);
      }
    }
  });

  it("fills the host's width at each level, leaving no strip on the right", () => {
    // The frame is the overlay's whole box: its top and bottom rules run to
    // the last column the host offered, and every row's right border is that
    // column. A width basis that reserves the dialog's own chrome here would
    // end every row short and pad the rest of the overlay with blanks.
    const { instance } = boot();
    const widths = [RENDER_WIDTH, 87];
    for (const host of widths) {
      const levels: string[][] = [instance.render(host)];
      instance.handleInput("\r");
      levels.push(instance.render(host));
      for (const lines of levels) {
        expect(lines.length, `w=${host}`).toBeGreaterThan(0);
        expect(lines[0], `w=${host}`).toBe(`╭${"─".repeat(host - 2)}╮`);
        for (const line of lines) {
          expect(visibleWidth(line), `w=${host}: ${JSON.stringify(line)}`).toBe(host);
        }
      }
      instance.handleInput("\x1b"); // back to the overview for the next width
    }
    instance.dispose();
  });
});
