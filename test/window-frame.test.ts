/**
 * The window frame the agent hub and the workflow inspector share.
 *
 * Both surfaces draw one window — `╭───╮` edges, padded `│ content │` rows, a
 * two-pane split whose three bars partition the width exactly, a footer that
 * drops its least useful hints rather than cutting one in half, and a body
 * height derived from the overlay's share of the terminal. `window-frame.ts`
 * is that geometry once; these tests pin the primitives and pin that the two
 * components actually render through them, so a third hand-rolled copy cannot
 * grow back unnoticed.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  ASCII_PANE_BOX,
  FRAME_BARS,
  frameEdge,
  frameRow,
  hintLine,
  leftPaneWidth,
  paneBodyHeight,
  paneRightWidth,
  splitEdge,
  UNICODE_PANE_BOX,
  WINDOW_CHROME_ROWS,
} from "../src/ui/window-frame.js";
import type { WorkflowDialogLogDeps } from "../src/ui/workflow-dialog.js";
import { WorkflowDialog } from "../src/ui/workflow-dialog.js";

const START = 1_700_000_000_000;
/** A passthrough theme, so `visibleWidth` sees the layout's true geometry. */
const theme = { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never;

describe("pane geometry", () => {
  it("partitions the width between the three bars and both cells", () => {
    for (const width of [30, 60, 100, 137]) {
      for (const pad of [0, 1]) {
        const left = leftPaneWidth(width, 18, pad);
        const right = paneRightWidth(width, left, pad);
        // `│` pad cell pad `│` pad cell pad `│`
        expect(left + right + FRAME_BARS + 4 * pad, `w=${width} pad=${pad}`).toBe(width);
      }
    }
  });

  it("gives the left cell a third at most, and the right its last column", () => {
    for (const width of [8, 12, 20, 55]) {
      const left = leftPaneWidth(width, 18);
      const available = Math.max(2, width - FRAME_BARS);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(left).toBeLessThanOrEqual(Math.floor(available / 3));
      expect(paneRightWidth(width, left)).toBeGreaterThanOrEqual(1);
    }
    // Comfortable widths take the cap, not a share of the terminal.
    expect(leftPaneWidth(100, 18)).toBe(18);
    expect(leftPaneWidth(200, 18)).toBe(18);
  });
});

describe("window chrome", () => {
  it("draws edges corner to corner in either glyph tier", () => {
    expect(frameEdge(12, UNICODE_PANE_BOX, "top")).toBe(`╭${"─".repeat(10)}╮`);
    expect(frameEdge(12, UNICODE_PANE_BOX, "bottom")).toBe(`╰${"─".repeat(10)}╯`);
    expect(frameEdge(6, ASCII_PANE_BOX, "top")).toBe("+----+");
    expect(frameEdge(1, UNICODE_PANE_BOX, "top")).toBe("╭╮");
  });

  it("pads a content row to exactly the width, bars in their columns", () => {
    const plain = (s: string) => s;
    const row = frameRow(20, "hello", UNICODE_PANE_BOX, plain);
    expect(row).toBe(`│ hello${" ".repeat(11)} │`);
    expect(row.length).toBe(20);
    // Overlong content is clamped inside the bars; the row never wraps.
    const long = frameRow(20, "x".repeat(50), UNICODE_PANE_BOX, plain, "~");
    expect(visibleWidth(long)).toBe(20);
    expect(stripTerminalSequences(long).endsWith(" │")).toBe(true);
    expect(stripTerminalSequences(long)).toContain("~");
  });

  it("puts a tee where the two panes meet, title included", () => {
    const top = splitEdge(24, 8, UNICODE_PANE_BOX, "top", " Agents ");
    expect(top).toBe(`╭ Agents ┬${"─".repeat(13)}╮`);
    expect(top.length).toBe(24);
    const bottom = splitEdge(24, 8, UNICODE_PANE_BOX, "bottom");
    expect(bottom).toBe(`╰${"─".repeat(8)}┴${"─".repeat(13)}╯`);
    expect(bottom.length).toBe(24);
  });
});

describe("footer hints", () => {
  const keys = ["↑↓ select", "Enter open", "x stop", "p pause", "/ filter", "f expand", "q close"];

  it("drops hints from the right, never cutting one in half", () => {
    const line = hintLine(keys, 30);
    expect(line).toBe("↑↓ select·Enter open·x stop");
    for (const key of ["↑↓ select", "Enter open", "x stop"]) expect(line).toContain(key);
    // The old clamp left a trailing separator where the cut landed.
    expect(line.endsWith("·")).toBe(false);
  });

  it("keeps every hint when they fit, and one hint when only one does", () => {
    expect(hintLine(keys, 200, " · ")).toBe(keys.join(" · "));
    expect(hintLine(keys, 10)).toBe("↑↓ select");
    // A single hint wider than the line is the one case left to truncation.
    const only = hintLine(["a very long hint"], 6);
    expect(stripTerminalSequences(only).startsWith("a v")).toBe(true);
    expect(visibleWidth(only)).toBeLessThanOrEqual(6);
  });
});

describe("body height basis", () => {
  it("subtracts the window's own chrome from the overlay's share", () => {
    expect(paneBodyHeight({ terminalRows: 40, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 }))
      .toBe(Math.floor((40 * 70) / 100) - WINDOW_CHROME_ROWS);
    expect(paneBodyHeight({ terminalRows: 40, viewportPct: 100, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 }))
      .toBe(33);
  });

  it("floors at the minimum and falls back when the host reports no rows", () => {
    expect(paneBodyHeight({ terminalRows: 8, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 })).toBe(6);
    expect(paneBodyHeight({ terminalRows: undefined, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 })).toBe(22);
  });
});

/** The hints each level can advertise, for the whole-fragment check below. */
const DETAIL_HINTS = new Set([
  "↑↓ agent", "e prompt", "⏎ log", "s skip", "r retry", "p pause", "p resume", "x stop", "esc back", "f expand", "c convo",
]);
const LOG_HINTS = new Set(["↑↓ agent", "p pause", "p resume", "x stop", "esc back", "c copy", "f expand"]);

/** The hint fragments a rendered footer holds, bars and padding stripped. */
function footerFragments(line: string): string[] {
  const inner = line.replace(/^\S\s/, "").replace(/\s\S$/, "").trim();
  return inner === "" ? [] : inner.split(" · ");
}

/** A dialog whose footer has every hint live: all actions, a long prompt, a record. */
function bootEveryHint(rows: number) {
  const log: WorkflowDialogLogDeps = {
    getRecord: id => (id === "rec-1" ? makeRecord() : undefined),
    manager: { abort: vi.fn(() => true), steer: vi.fn(() => true) },
    agentActivity: new Map(),
    showCost: () => false,
    pauseAgent: () => undefined,
    resumeAgent: () => true,
  };
  return new WorkflowDialog(
    { requestRender: vi.fn(), terminal: { rows } } as unknown as never,
    () => ({
      progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        {
          type: "workflow_agent", index: 0, label: "row-one", phaseIndex: 0, state: "progress", startedAt: START,
          recordId: "rec-1",
          promptPreview: Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n"),
        },
      ],
      task: { status: "running" as const, workflowName: "wf", startTime: START },
    }),
    theme,
    () => {},
    {
      onKill: () => {}, onPause: () => {}, onResume: () => {},
      onSkipAgent: () => {}, onRetryAgent: () => {}, onOpenAgent: () => {},
    },
    0,
    log,
  );
}

describe("footers stay whole when the window is too narrow for every hint", () => {
  it("drops hints rather than clamping one in half, at every level", () => {
    // The clamp cut wherever the line ran out, leaving a fragment like `es` and
    // a dead separator where the escape hatch should have been: at some width in
    // this range the truncation lands mid-hint.
    for (const width of [66, 67, 68, 70, 72, 76, 90]) {
      const detail = bootEveryHint(40);
      detail.handleInput("\r");
      const detailFooter = footerFragments(detail.render(width).at(-2) ?? "");
      expect(detailFooter.length, `detail w=${width}`).toBeGreaterThan(0);
      for (const part of detailFooter) expect(DETAIL_HINTS.has(part), `detail w=${width}: ${JSON.stringify(part)}`).toBe(true);
      detail.dispose();

      const log = bootEveryHint(40);
      log.handleInput("\r");
      log.handleInput("\r"); // descend to the log level
      const logFooter = footerFragments(log.render(width).at(-2) ?? "");
      expect(logFooter.length, `log w=${width}`).toBeGreaterThan(0);
      for (const part of logFooter) expect(LOG_HINTS.has(part), `log w=${width}: ${JSON.stringify(part)}`).toBe(true);
      log.dispose();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The dialog renders through those primitives
 * ------------------------------------------------------------------------- */

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

function boot(rows: number | undefined) {
  const tui = { requestRender: vi.fn(), terminal: rows === undefined ? undefined : { rows } } as unknown as never;
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
    () => {},
    {},
    0,
    log,
  );
  return instance;
}

const visibleLength = (s: string) => [...s].length;

describe("the inspector draws through the shared frame", () => {
  it("uses the shared edges and row shape at the overview level", () => {
    const instance = boot(40);
    const lines = instance.render(100);
    expect(lines[0]).toBe(frameEdge(100, UNICODE_PANE_BOX, "top"));
    expect(lines.at(-1)).toBe(frameEdge(100, UNICODE_PANE_BOX, "bottom"));
    for (const line of lines) expect(visibleLength(line)).toBe(100);
    instance.dispose();
  });

  it("keeps the level's own footer whole instead of clamping a hint in half", () => {
    const instance = boot(40);
    instance.handleInput("\r"); // detail level: the footer carries the most hints
    const footer = instance.render(70).at(-2) ?? "";
    expect(footer).not.toContain("· │");
    expect(footer.endsWith("·")).toBe(false);
    instance.dispose();
  });

  it("sizes the log level and the levels above it on one basis", () => {
    // Same terminal on both paths, so the body — and with it the whole window —
    // cannot change height when Enter descends to the log.
    const instance = boot(20);
    instance.handleInput("\r");
    const detail = instance.render(100).length;
    instance.handleInput("\r"); // descend to the log
    const log = instance.render(100);
    expect(log.length).toBeGreaterThan(0);
    expect(log.length).toBe(detail);
    instance.dispose();
  });
});
