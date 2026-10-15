/**
 * workflow-view.test.ts — the run/agent row vocabulary the hub's run pages read.
 *
 * What survived the inspector's retirement: the pure builders, no window. The
 * hub composes them into its **W** and **WA** panes, so their gating and row
 * grammar are the contract those pages inherit.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SPINNER } from "../src/ui/agent-widget.js";
import type { WorkflowCardLine } from "../src/ui/workflow-card.js";
import {
  agentActions,
  agentRow,
  dialogRowGlyph,
  phaseListRows,
  subStatusAnnotations,
  UNICODE_DIALOG_GLYPHS,
} from "../src/ui/workflow-view.js";
import type { PhaseGroup, WorkflowAgentEntry } from "../src/workflow/progress.js";

const entry = (over: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry => ({
  type: "workflow_agent",
  index: 0,
  label: "m-1",
  state: "progress",
  ...over,
});

const group = (over: Partial<PhaseGroup> = {}): PhaseGroup => ({
  title: "migrate",
  status: "running",
  agents: [],
  doneCount: 1,
  totalCount: 2,
  tokens: 0,
  durationMs: 0,
  ...over,
});

const text = (line: WorkflowCardLine) => line.map(segment => segment.text).join("");

describe("agentActions — the skip/retry gate the inspector owned", () => {
  it("refuses both when there is no agent or the run has settled", () => {
    expect(agentActions(undefined, "running")).toEqual({ skip: false, retry: false });
    expect(agentActions(entry(), "completed")).toEqual({ skip: false, retry: false });
    expect(agentActions(entry(), "killed")).toEqual({ skip: false, retry: false });
  });

  it("allows skip while the call is unanswered, retry only once a child is running", () => {
    expect(agentActions(entry({ startedAt: 1 }), "running")).toEqual({ skip: true, retry: true });
    // Queued: accepted, no slot yet — nothing to stop and restart.
    expect(agentActions(entry({ queuedAt: 1 }), "running")).toEqual({ skip: true, retry: false });
    expect(agentActions(entry({ state: "done" }), "running")).toEqual({ skip: false, retry: false });
    expect(agentActions(entry({ state: "error" }), "running")).toEqual({ skip: false, retry: false });
  });

  it("keeps both live through a park — the children stay alive", () => {
    expect(agentActions(entry({ startedAt: 1 }), "paused")).toEqual({ skip: true, retry: true });
    expect(agentActions(entry({ queuedAt: 1 }), "paused")).toEqual({ skip: true, retry: false });
    expect(agentActions(entry({ state: "done" }), "paused")).toEqual({ skip: false, retry: false });
  });
});

describe("phaseListRows — the run's plan", () => {
  const groups = [
    group({ title: "discover", status: "done", doneCount: 2, totalCount: 2 }),
    group({ title: "migrate", doneCount: 1, totalCount: 2 }),
    group({ title: "verify", status: "not-started", doneCount: 0, totalCount: 0 }),
  ];

  it("ticks a finished phase and numbers an unfinished one", () => {
    const rows = phaseListRows({ groups, selectedPhase: 1, capacity: 3, width: 40, glyphs: UNICODE_DIALOG_GLYPHS }).map(text);
    expect(rows[0]).toContain("✓ discover");
    expect(rows[1]).toContain("❯ 2 migrate");
    expect(rows[2]).toContain("3 verify");
    // An empty phase's count is a dash, never a zero the reader has to parse.
    expect(rows[2]).toContain("—");
  });

  it("draws the cursor row even when it is not the state mark", () => {
    const rows = phaseListRows({ groups, selectedPhase: 1, cursor: 2, capacity: 3, width: 40, glyphs: UNICODE_DIALOG_GLYPHS }).map(text);
    expect(rows[1]).toContain("❯ 2 migrate");
    expect(rows[2]).toContain("❯ 3 verify");
  });

  it("windows on the cursor and keeps the rows clamped to the width", () => {
    const rows = phaseListRows({ groups, selectedPhase: 1, cursor: 2, capacity: 1, width: 40, glyphs: UNICODE_DIALOG_GLYPHS });
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toContain("verify");
    expect(text(rows[0]).length).toBeLessThanOrEqual(40);
  });
});

describe("agentRow — one run agent, compact or detailed", () => {
  it("keeps the label and glyph in the compact row", () => {
    const row = text(agentRow({
      entry: entry({ startedAt: 1, durationMs: 40_000 }),
      selected: true,
      compact: true,
      width: 18,
      glyphs: UNICODE_DIALOG_GLYPHS,
      runStatus: "running",
      spinnerFrame: 0,
      now: 0,
    })[0]);
    expect(row).toContain("m-1");
    expect(row).toContain("❯");
    expect(row).not.toContain("40s");
  });

  it("appends the annotations and a flush-right duration in the wide row", () => {
    const row = text(agentRow({
      entry: entry({ startedAt: 1, durationMs: 40_000, attempt: 2, lastAttemptReason: "user-retry", cached: true }),
      selected: false,
      compact: false,
      width: 60,
      glyphs: UNICODE_DIALOG_GLYPHS,
      runStatus: "running",
      spinnerFrame: 0,
      now: 0,
    })[0]);
    expect(row).toContain("user retry");
    expect(row).toContain("attempt 2");
    expect(row).toContain("from resume journal");
    expect(row.trimEnd().endsWith("40s")).toBe(true);
  });

  it("reads a parked run's live row with the pause mark and the reason", () => {
    const row = text(agentRow({
      entry: entry({ queuedAt: 1, startedAt: 2 }),
      selected: false,
      compact: false,
      width: 60,
      glyphs: UNICODE_DIALOG_GLYPHS,
      runStatus: "paused",
      spinnerFrame: 0,
      now: 0,
    })[0]);
    expect(row).toContain("‖");
    expect(row).toContain("run paused");
  });
});

describe("subStatusAnnotations", () => {
  it("says why a queued row has not started", () => {
    const parts = subStatusAnnotations(entry({ queuedAt: 0 }), "queued", 5_000);
    expect(parts).toContain("waiting 5s");
  });

  it("says why a parked row looks alive, and keeps its waiting clock", () => {
    expect(subStatusAnnotations(entry({ startedAt: 1 }), "paused", 5_000)).toEqual(["run paused"]);
    expect(subStatusAnnotations(entry({ queuedAt: 0 }), "paused", 5_000)).toEqual(["run paused", "waiting 5s"]);
  });
});

describe("dialogRowGlyph (the row glyph mapping the run pages inherit)", () => {
  it("maps every one of the eight display states to its glyph and colour", () => {
    expect(dialogRowGlyph("done", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✓", color: "success" });
    expect(dialogRowGlyph("failed", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✗", color: "error" });
    // The three ✗ states are told apart by colour alone — dim for skipped,
    // warning for blocked (waiting on the user).
    expect(dialogRowGlyph("skipped", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✗", color: "dim" });
    expect(dialogRowGlyph("blocked", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✗", color: "warning" });
    expect(dialogRowGlyph("queued", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("interrupted", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("paused", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "‖", color: "dim" });
    expect(dialogRowGlyph("running", UNICODE_DIALOG_GLYPHS, 3)).toEqual({ text: SPINNER[3], color: "dim" });
    // Every glyph is one column wide — the rows' right-aligned counters and
    // the panes' column math depend on it.
    for (const state of ["done", "failed", "skipped", "blocked", "queued", "interrupted", "paused"] as const) {
      expect(visibleWidth(dialogRowGlyph(state, UNICODE_DIALOG_GLYPHS).text)).toBe(1);
    }
  });

  it("keys off the derived display state, not the raw entry state", () => {
    // `state: "error"` inline splits three ways — failed, skipped (dim ✗),
    // blocked (warning ✗) — and only the derived key draws ◌ for queued.
    const rows = [
      agentRow({ entry: entry({ label: "done", state: "done" }), selected: false, compact: true, width: 30, glyphs: UNICODE_DIALOG_GLYPHS, runStatus: "running", spinnerFrame: 0, now: 0 }),
      agentRow({ entry: entry({ label: "skipped", state: "error", skipped: true }), selected: false, compact: true, width: 30, glyphs: UNICODE_DIALOG_GLYPHS, runStatus: "running", spinnerFrame: 0, now: 0 }),
      agentRow({ entry: entry({ label: "blocked", state: "error", blocked: true }), selected: false, compact: true, width: 30, glyphs: UNICODE_DIALOG_GLYPHS, runStatus: "running", spinnerFrame: 0, now: 0 }),
      agentRow({ entry: entry({ label: "queued", state: "start", queuedAt: 1 }), selected: false, compact: true, width: 30, glyphs: UNICODE_DIALOG_GLYPHS, runStatus: "running", spinnerFrame: 0, now: 0 }),
      agentRow({ entry: entry({ label: "parked" }), selected: false, compact: true, width: 30, glyphs: UNICODE_DIALOG_GLYPHS, runStatus: "paused", spinnerFrame: 0, now: 0 }),
    ].map(r => r.flat().map(s => s.text).join(""));
    expect(rows[0]).toContain("✓ done");
    expect(rows[1]).toContain("✗ skipped");
    expect(rows[2]).toContain("✗ blocked");
    expect(rows[3]).toContain("◌ queued");
    expect(rows[4]).toContain("‖ parked");
  });
});

describe("agentRow — a live row's clock", () => {
  it("derives the duration from the start while the agent runs", () => {
    const row = agentRow({
      entry: entry({ label: "m-2", state: "progress", startedAt: 1_000 }),
      selected: false,
      compact: false,
      width: 60,
      glyphs: UNICODE_DIALOG_GLYPHS,
      workflowActive: true,
      spinnerFrame: 0,
      now: 33_000,
      live: { turns: 2, tokens: 63_400, tail: "editing" },
    });
    expect(row[0].map(s => s.text).join("")).toContain("turn 2 · 63.4k tok · 32s");
    // The live tail rides the second line as a ↳ continuation.
    expect(row[1].map(s => s.text).join("")).toContain("↳ editing");
  });
});
