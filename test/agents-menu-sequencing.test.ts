/**
 * agents-menu-sequencing.test.ts — /agents → Running agents → pick one.
 *
 * Regression: viewAgentConversation used to fire the panel off without
 * awaiting it, so showRunningAgents' back-navigation re-opened its select
 * dialog ON TOP of the just-opened panel — the dialog took the keyboard and
 * the panel's ←/→ cycling was dead. The panel must be awaited: the list only
 * re-opens after the panel closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Enough of a pi session for the manager to keep, and the panel to render. */
const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: () => () => {},
  messages: [],
});

interface OverlayRecord {
  kind: string;
  close(): void;
}

type Answer = (options: string[]) => string | undefined;

/**
 * ctx.ui double: `custom` keeps overlays OPEN (held like real ones, closable
 * by test); `select` answers from a finite queue of finders, then undefined.
 */
function overlayCtx(answers: Answer[]) {
  const overlays: OverlayRecord[] = [];
  const selectTitles: string[] = [];
  let index = 0;
  const context = ctx({
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (_title: string, options: string[]) => {
        selectTitles.push(_title);
        const answer = answers[index++];
        return answer ? answer(options) : undefined;
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        const tui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        return await new Promise<undefined>(resolve => {
          const instance = factory(tui, theme, undefined, resolve) as { constructor: { name: string } };
          overlays.push({
            kind: instance.constructor.name,
            close: () => resolve(undefined),
          });
        });
      }),
    },
  });
  return { context, overlays, selectTitles };
}

describe("/agents → Running agents sequencing", () => {
  let hermetic: Hermetic;
  let booted: BootedPi;

  beforeEach(() => {
    hermetic = hermeticDir({});
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      opts.onSessionCreated?.(fakeSession() as any);
      return { responseText: "done", session: fakeSession() as any, aborted: false, steered: false };
    });
    booted = makePi();
    subagentsExtension(booted.pi);
  });
  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  it("does not re-open the list while the panel is up; re-opens after it closes", async () => {
    // One background agent, settled, with a session — a list row to pick.
    await booted.tools.get("Agent").execute(
      "tc-0",
      { description: "the one", prompt: "hi", run_in_background: true },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );

    // Answer queue: menu → "Running agents", list → the agent row, then out.
    const { context, overlays, selectTitles } = overlayCtx([
      options => options.find(o => o.startsWith("Running agents")),
      options => options.find(o => o.includes("the one")),
      () => undefined,
    ]);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let menuDone = false;
    const menu = command.handler("", context).then(() => {
      menuDone = true;
    });

    // The panel opens (AgentHub popup) while the handler is still running…
    await vi.waitFor(() => expect(overlays.map(o => o.kind)).toContain("AgentHub"));
    const hubIndex = overlays.map(o => o.kind).lastIndexOf("AgentHub");
    // …and NOTHING stacks on top of it: the list must wait for the panel.
    expect(overlays.slice(hubIndex + 1)).toHaveLength(0);
    const picksBefore = selectTitles.filter(t => t === "Running agents").length;

    // Close the panel — only then may the list re-open.
    overlays[hubIndex].close();
    await vi.waitFor(() =>
      expect(selectTitles.filter(t => t === "Running agents").length).toBeGreaterThan(picksBefore),
    );
    // Answer queue exhausted (undefined) → the menus unwind and the handler
    // completes cleanly instead of parking on a hidden dialog.
    await menu;
    expect(menuDone).toBe(true);
  });
});
