/**
 * The workflow inspector's third level: an agent's live conversation embedded
 * in the dialog, reached with Enter from the detail pane and left with Esc —
 * the hub's chat view, one drill-down deeper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { WorkflowDialogLogDeps } from "../src/ui/workflow-dialog.js";
import { WorkflowDialog } from "../src/ui/workflow-dialog.js";

const START = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A record whose session the embedded viewer can attach to. */
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

function harness(records: AgentRecord[], logOver: Partial<WorkflowDialogLogDeps> = {}) {
  const closed: boolean[] = [];
  const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as never;
  const log: WorkflowDialogLogDeps = {
    getRecord: id => records.find(r => r.id === id),
    manager: { abort: vi.fn(() => true), steer: vi.fn(() => true) },
    agentActivity: new Map(),
    showCost: () => false,
    notify: vi.fn(),
    ...logOver,
  };
  // Two rows ALWAYS, so the drill-down works even when `getRecord` resolves
  // nothing — the rows carry the record ids, the log deps decide what is
  // behind them.
  const instance = new WorkflowDialog(
    tui,
    () => ({
      progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        { type: "workflow_agent", index: 0, label: "row-one", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-1" },
        { type: "workflow_agent", index: 1, label: "row-two", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-2" },
      ],
      task: { status: "running" as const, workflowName: "wf", startTime: START },
    }),
    // The real tests' theme double lives in workflow-dialog.test.ts; a minimal
    // one here keeps this file's assertions on plain text.
    {
      bold: (s: string) => `*${s}*`,
      fg: (_c: string, s: string) => s,
    } as never,
    () => closed.push(true),
    {},
    0,
    log,
  );
  // Open the detail level, then descend on the first agent.
  instance.handleInput("\r");
  instance.handleInput("\r");
  return { instance, closed, log, tui };
}

const frame = (instance: WorkflowDialog) => instance.render(120).join("\n");

describe("the workflow dialog's log level", () => {
  it("embeds the selected agent's live conversation", () => {
    const { instance } = harness([makeRecord({ id: "rec-1", description: "verify:auth.ts" })]);
    const rendered = frame(instance);
    // The viewer's header names the agent; the window's rules name the phase
    // pane (truncated to the narrow cell) and the entry — the log level's
    // shape, not the detail pane's.
    expect(rendered).toContain("verify:auth.ts");
    expect(rendered).toContain("Verify · 2 age");
    expect(rendered).not.toContain("Prompt");
    instance.dispose();
  });

  it("says so and stays on the detail pane when the record is gone", () => {
    const { instance, log } = harness([], { getRecord: () => undefined });
    // The viewer builds at render time, which is when the missing record is
    // discovered — render first, then assert the fallback.
    expect(frame(instance)).toContain("Prompt");
    expect(log.notify).toHaveBeenCalledWith(expect.stringContaining("No conversation left"), "info");
    instance.dispose();
  });

  it("falls back when the record has no session to show", () => {
    const { instance, log } = harness([makeRecord({ session: undefined })]);
    expect(frame(instance)).toContain("Prompt");
    expect(log.notify).toHaveBeenCalled();
    instance.dispose();
  });

  it("Esc walks back to the detail pane and tears the viewer down", () => {
    const { instance } = harness([makeRecord()]);
    // Esc reaches the embedded viewer, whose onBack returns here.
    instance.handleInput("\x1b");
    const rendered = frame(instance);
    expect(rendered).toContain("Prompt");
    // The viewer's own header is gone with it.
    expect(rendered).not.toContain("agent · started");
    instance.dispose();
  });

  it("switches agents with the arrow keys, rebuilding the viewer", () => {
    const { instance } = harness([
      makeRecord({ id: "rec-1", description: "verify:auth.ts" }),
      makeRecord({ id: "rec-2", description: "plan:scope.md" }),
    ]);
    expect(frame(instance)).toContain("verify:auth.ts · ");
    expect(frame(instance)).not.toContain("plan:scope.md · ");
    // ↑/↓ come back through the viewer's onUnhandledKey as selection moves.
    instance.handleInput("\x1b[B");
    expect(frame(instance)).toContain("plan:scope.md");
    instance.handleInput("\x1b[A");
    expect(frame(instance)).toContain("verify:auth.ts");
    instance.dispose();
  });

  it("closes the dialog on ctrl+c, the reflex key, from the log", () => {
    const { instance, closed } = harness([makeRecord()]);
    instance.handleInput("\x03");
    expect(closed).toEqual([true]);
  });

  it("does not exist without log deps: Enter stops at the detail pane", () => {
    const closed: boolean[] = [];
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as never;
    const instance = new WorkflowDialog(
      tui,
      () => ({
        progress: [
          { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "done", recordId: "rec-1" },
        ],
        task: { status: "running" as const, workflowName: "wf", startTime: START },
      }),
      { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never,
      () => closed.push(true),
    );
    instance.handleInput("\r");
    // No log deps → no descend: Enter is a no-op and the footer never
    // advertises the level.
    instance.handleInput("\r");
    expect(frame(instance)).toContain("Prompt");
    expect(frame(instance)).not.toContain("⏎ log");
    instance.dispose();
  });
});

describe("the log level's pane rule", () => {
  // This level draws the frame in strings rather than segments, and its rule is
  // the shared one in that form: ` title ` is what it measures and cuts, which
  // is how it has always read a rule cell. Pinned byte-for-byte from the render
  // before the rule moved into the shared module.
  it("is the shared rule, in strings, at every width", () => {
    const { instance } = harness([makeRecord({ id: "rec-1", description: "verify:auth.ts" })]);
    const rules = (width: number) => instance.render(width).filter(line => line.startsWith("\u251c"));
    expect(rules(120)).toEqual([
      "├ * Verify · 2 age…*─┬ * row-one *─────────────────────────────────────────────────────────────────────────────────────────┤",
      "├──────────────────│───────────────────────────────────────────────────────────────────────────────────────────────────┤",
    ]);
    expect(rules(80)).toEqual([
      "├ * Verify · 2 age…*─┬ * row-one *─────────────────────────────────────────────────┤",
      "├──────────────────│───────────────────────────────────────────────────────────┤",
    ]);
    expect(rules(60)).toEqual([
      "├ * Verify · 2 age…*─┬ * row-one *─────────────────────────────┤",
      "├──────────────────│───────────────────────────────────────┤",
    ]);
    expect(rules(40)).toEqual([
      "├ * Verify ·…*─┬ * row-one *───────────────┤",
      "├────────────│─────────────────────────┤",
    ]);
    instance.dispose();
  });
});
