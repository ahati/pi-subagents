/**
 * workflow-view.test.ts — the run/agent row vocabulary the hub's run pages read.
 *
 * What survived the inspector's retirement: the pure builders, no window. The
 * hub composes them into its **W** and **WA** panes, so their gating and row
 * grammar are the contract those pages inherit.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowCardLine } from "../src/ui/workflow-card.js";
import {
  agentActions,
  agentRow,
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
    expect(agentActions(undefined, true)).toEqual({ skip: false, retry: false });
    expect(agentActions(entry(), false)).toEqual({ skip: false, retry: false });
  });

  it("allows skip while the call is unanswered, retry only once a child is running", () => {
    expect(agentActions(entry({ startedAt: 1 }), true)).toEqual({ skip: true, retry: true });
    // Queued: accepted, no slot yet — nothing to stop and restart.
    expect(agentActions(entry({ queuedAt: 1 }), true)).toEqual({ skip: true, retry: false });
    expect(agentActions(entry({ state: "done" }), true)).toEqual({ skip: false, retry: false });
    expect(agentActions(entry({ state: "error" }), true)).toEqual({ skip: false, retry: false });
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
      workflowActive: true,
      spinnerFrame: 0,
      now: 0,
    }));
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
      workflowActive: true,
      spinnerFrame: 0,
      now: 0,
    }));
    expect(row).toContain("user retry");
    expect(row).toContain("attempt 2");
    expect(row).toContain("from resume journal");
    expect(row.trimEnd().endsWith("40s")).toBe(true);
  });
});

describe("subStatusAnnotations", () => {
  it("says why a queued row has not started", () => {
    const parts = subStatusAnnotations(entry({ queuedAt: 0 }), "queued", 5_000);
    expect(parts).toContain("waiting 5s");
  });
});
