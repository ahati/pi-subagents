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
import { frameEdge, paneGeometry, UNICODE_PANE_BOX } from "../src/ui/window-frame.js";
import type { WorkflowDialogLogDeps } from "../src/ui/workflow-dialog.js";
import { WorkflowDialog } from "../src/ui/workflow-dialog.js";

const START = 1_700_000_000_000;
/** The width the overlay host asks the component to render at — the spec's. */
const RENDER_WIDTH = 120;
/** The one older width the fits-everything case still pins. */
const NARROW_HOST = 100;

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

  it("draws the same rule lines at every level, byte for byte", () => {
    // Captured from the render, so this is the no-drift proof: the segment
    // levels and the log level's string path draw one window, and their bytes
    // cannot drift. The master pane is named in the top edge, so the rule
    // titles the detail pane alone; the band rule closes the panes, the
    // divider's `┴` in it, and the bottom edge below is plain.
    const rules = (lines: string[]) => lines.filter(line => line.startsWith("\u251c"));
    const bands = (lines: string[]) => lines.filter(line => line.startsWith("\u2502 \u2500"));
    expect(rules(frames.phases!)).toEqual([
      "├────────────────────┬ Verify · 1 agent ───────────────────────────────────────────────────────────────────────────────┤",
    ]);
    expect(rules(frames.detail!)).toEqual([
      "├────────────────────┬ row-one ────────────────────────────────────────────────────────────────────────────────────────┤",
    ]);
    expect(rules(frames.log!)).toEqual([
      "├────────────────────┬ row-one ────────────────────────────────────────────────────────────────────────────────────────┤",
    ]);
    // The band rule is the same row at every level, and it is the only line
    // that ends the divider.
    expect(bands(frames.phases!)).toEqual([
      "│ ───────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────── │",
    ]);
    expect(bands(frames.detail!)).toEqual(bands(frames.phases!));
    expect(bands(frames.log!)).toEqual(bands(frames.phases!));
  });

  it("puts the pane's right bar on the window's right border", () => {
    for (const [level, lines] of Object.entries(frames)) {
      for (const line of lines) {
        expect(line.at(-1), `${level}: last glyph`).toBeDefined();
        expect("│┤╮╯".includes(line.at(-1)!), `${level}: ${JSON.stringify(line)}`).toBe(true);
      }
    }
  });

  it("ends the panes at the band rule rather than the bottom edge", () => {
    for (const [level, lines] of Object.entries(frames)) {
      const band = lines.filter(line => line.startsWith("\u2502 \u2500"));
      expect(band, level).toHaveLength(1);
      // The divider's `┴` sits in the band rule, in the column the pane bars
      // occupy, and no row below it carries the divider any more.
      expect(band[0]!.indexOf("┴"), level).toBe(paneGeometry(RENDER_WIDTH).leftCellWidth + 1);
      expect(lines.at(-1), level).toBe(frameEdge(RENDER_WIDTH, UNICODE_PANE_BOX, "bottom"));
    }
  });

  it("fills the host's width at each level, leaving no strip on the right", () => {
    // The frame is the overlay's whole box: its top and bottom rules run to
    // the last column the host offered, and every row's right border is that
    // column. A width basis that reserves the dialog's own chrome here would
    // end every row short and pad the rest of the overlay with blanks.
    const { instance } = boot();
    const widths = [RENDER_WIDTH, NARROW_HOST];
    for (const host of widths) {
      const levels: string[][] = [instance.render(host)];
      instance.handleInput("\r");
      levels.push(instance.render(host));
      for (const lines of levels) {
        expect(lines.length, `w=${host}`).toBeGreaterThan(0);
        const panes = paneGeometry(host);
        // The top edge splits where the pane bars are, whichever level is up:
        // the corner, then the master cell, then the tee.
        expect(lines[0]!.indexOf("\u252c"), `w=${host}`).toBe(panes.leftCellWidth + 1);
        // The divider ends at the band rule's `┴`; the bottom edge below it is
        // plain — a split bottom edge would hang a second tee under it.
        expect(lines.at(-1), `w=${host}`).toBe(frameEdge(host, UNICODE_PANE_BOX, "bottom"));
        for (const line of lines) {
          expect(visibleWidth(line), `w=${host}: ${JSON.stringify(line)}`).toBe(host);
        }
      }
      instance.handleInput("\x1b"); // back to the overview for the next width
    }
    instance.dispose();
  });
});
