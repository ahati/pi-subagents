/**
 * Negative TCs for the workflow inspector's log level — the hub-parity
 * defects, reproduced red against the current code.
 *
 * The agent hub's chat view (the subagents window's log view) supports the
 * mouse wheel on both TUI routes and binds `f` (popup ↔ full-screen toggle),
 * `c` (copy the shown agent's result) and `p` (pause/resume), advertising them
 * in its footer. The workflow dialog's log level embeds the very same
 * ConversationViewer but wires none of that: wheel events go unhandled (so
 * they scroll the transcript underneath the overlay, or the terminal's native
 * scrollback in regular mode), `f`/`c`/`p` are dropped before anything can
 * service them, and the log footer omits `c`/`f` while advertising the inert
 * `p`.
 *
 * Every test here FAILS until the parity fix lands; each mirrors its passing
 * counterpart in test/agent-hub.test.ts. After the fix this file is the
 * regression suite for that parity. (`k` stays the scroll-up alias and kill
 * stays on `x`, per the hub — deliberately not TC'd here.)
 */
import * as piHost from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
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

/** A session streaming enough lines to scroll: 40 single-line messages. */
function scrollableSession() {
  return {
    subscribe: () => () => {},
    messages: Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `message number ${i}` })),
  };
}

/**
 * The log deps the parity fix requires: pause/resume for the `p` key,
 * mirroring `AgentHubDeps.pauseAgent`/`resumeAgent` on the hub. Cast into
 * `WorkflowDialogLogDeps` until the fix adds the fields.
 */
interface LogDepsWithPause extends WorkflowDialogLogDeps {
  pauseAgent: Mock<(id: string) => string | undefined>;
  resumeAgent: Mock<(id: string) => boolean>;
}

function harness(records: AgentRecord[]) {
  const closed: boolean[] = [];
  const done = vi.fn((result: undefined | "toggle") => {
    if (result === "toggle") return;
    closed.push(true);
  });
  const write = vi.fn();
  const tui = { mode: "regular", requestRender: vi.fn(), terminal: { rows: 40, columns: 120, write } };
  const log: LogDepsWithPause = {
    getRecord: id => records.find(r => r.id === id),
    manager: { abort: vi.fn(() => true), steer: vi.fn(() => true) },
    agentActivity: new Map(),
    showCost: () => false,
    notify: vi.fn(),
    pauseAgent: vi.fn(() => undefined),
    resumeAgent: vi.fn(() => true),
  };
  // Two rows ALWAYS, so the drill-down works even when `getRecord` resolves
  // nothing — the rows carry the record ids, the log deps decide what is
  // behind them.
  const instance = new WorkflowDialog(
    tui as unknown as never,
    () => ({
      progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        { type: "workflow_agent", index: 0, label: "row-one", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-1" },
        { type: "workflow_agent", index: 1, label: "row-two", phaseIndex: 0, state: "progress", startedAt: START, recordId: "rec-2" },
      ],
      task: { status: "running" as const, workflowName: "wf", startTime: START },
    }),
    // Passthrough theme, so assertions run on plain text.
    { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never,
    done as (result: undefined) => void,
    {},
    0,
    log,
  );
  // Open the detail level, then descend on the first agent → the log level.
  instance.handleInput("\r");
  instance.handleInput("\r");
  return { instance, closed, log, done, write, tui };
}

/** Rendered frame, ANSI-stripped (the viewer may style without the theme). */
const frame = (instance: WorkflowDialog) =>
  instance.render(120).join("\n").replace(/\u001b\[[0-9;]*m/g, "");

describe("workflow dialog log — hub parity (negative TCs, red until the parity fix)", () => {
  describe("mouse wheel", () => {
    /** SGR report: 64 = wheel up, 65 = wheel down. */
    const wheel = (button: number) => `\x1b[<${button};10;5M`;

    it("TC1 wheel events dispatched by the host scroll the conversation (fullscreen route)", () => {
      const { instance } = harness([makeRecord({ id: "rec-1", session: scrollableSession() })]);
      // pi's alt-screen renderer dispatches wheel events to the overlay's
      // top-level component — the dialog, like the hub.
      const dialog = instance as unknown as {
        handleMouse?(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
      };
      expect(dialog.handleMouse).toBeTypeOf("function");
      const followed = frame(instance);
      expect(followed).toContain("message number 39"); // auto-following the tail
      expect(dialog.handleMouse!({ type: "wheel", wheelDelta: -5 })).toEqual({ handled: true });
      const scrolled = frame(instance);
      expect(scrolled).not.toBe(followed);
      expect(scrolled).not.toContain("message number 39");
      instance.dispose();
    });

    it("TC2 raw SGR wheel bytes scroll the conversation (regular TUI route)", () => {
      const { instance } = harness([makeRecord({ id: "rec-1", session: scrollableSession() })]);
      const followed = frame(instance);
      expect(followed).toContain("message number 39");
      instance.handleInput(wheel(64)); // wheel up — captured mouse mode delivers bytes
      const scrolled = frame(instance);
      expect(scrolled).not.toBe(followed);
      expect(scrolled).not.toContain("message number 39");
      instance.dispose();
    });

    it("TC3 captures mouse reporting while open and restores it on close", () => {
      const { instance, write } = harness([makeRecord({ id: "rec-1" })]);
      // Enable sequence written once, on construction, like the hub does.
      const writes = write.mock.calls.map(c => c[0] as string);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("\x1b[?1006h");
      instance.dispose();
      const after = write.mock.calls.map(c => c[0] as string);
      expect(after).toHaveLength(2);
      expect(after[1]).toContain("\x1b[?1006l");
    });
  });

  describe("f / c / p keys", () => {
    it("TC4 f requests the popup ↔ full-screen toggle, like the hub's chat view", () => {
      const { instance, done } = harness([makeRecord({ id: "rec-1" })]);
      instance.handleInput("f");
      // The hub's contract: resolve the overlay with "toggle" so the open
      // loop reopens it at full-screen size (pi sizes overlays once).
      expect(done).toHaveBeenCalledWith("toggle");
      instance.dispose();
    });

    it("TC5 c copies the shown agent's finished result to the clipboard", async () => {
      const copy = vi.spyOn(piHost, "copyToClipboard").mockResolvedValue(undefined);
      const { instance, log } = harness([
        makeRecord({ id: "rec-1", status: "completed", result: "the final answer" }),
      ]);
      instance.handleInput("c");
      await Promise.resolve();
      expect(copy).toHaveBeenCalledWith("the final answer");
      expect(log.notify).toHaveBeenCalledWith(expect.stringContaining("Copied"), "info");
      instance.dispose();
    });

    it("TC6 c on a running agent explains there is nothing to copy yet", () => {
      const { instance, log } = harness([makeRecord({ id: "rec-1", status: "running" })]);
      instance.handleInput("c");
      expect(log.notify).toHaveBeenCalledWith(expect.stringContaining("still running"), "info");
      instance.dispose();
    });

    it("TC7 p pauses the shown agent, as the footer already advertises", () => {
      const { instance, log } = harness([makeRecord({ id: "rec-1", status: "running" })]);
      instance.handleInput("p");
      expect(log.pauseAgent).toHaveBeenCalledWith("rec-1");
      expect(log.notify).toHaveBeenCalledWith(expect.stringContaining('Paused "verify:auth.ts"'), "info");
      instance.dispose();
    });
  });

  describe("footer hints", () => {
    it("TC8 advertises c copy and f expand beside the existing hints", () => {
      const { instance } = harness([makeRecord({ id: "rec-1", status: "completed", result: "done" })]);
      const rendered = frame(instance);
      // Already advertised today (and x stop works via the viewer):
      expect(rendered).toContain("↑↓ agent");
      expect(rendered).toContain("x stop");
      expect(rendered).toContain("esc back");
      // Missing hub-parity hints:
      expect(rendered).toContain("c copy");
      expect(rendered).toContain("f expand");
      instance.dispose();
    });
  });
});
