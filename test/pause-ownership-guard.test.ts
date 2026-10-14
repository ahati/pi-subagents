/**
 * pause-ownership-guard.test.ts — the ownership refusal inside the pause
 * funnel (`pauseAgentRecord` in src/index.ts), driven through the callbacks
 * and commands each surface reaches it by. The surfaces' own key handling is
 * not exercised: the fleet-list and workflow-menu callbacks are captured as
 * the extension registers them and invoked directly.
 *
 * The rule: an agent another agent or a workflow owns is not the session's to
 * park. The RPC layer always said so (`assertOwned`, "Agent is owned by
 * another agent or workflow"); the in-process funnel only refused foreground
 * and worktree-isolated runs, so a nested background child — startable today
 * through the nested Agent tool's `run_in_background` — could be parked by a
 * keypress while its owner waited on `get_nested_subagent_result`.
 *
 * The fleet list and the workflow menu are module-mocked because their
 * callbacks are the handoff the extension makes in `subagentsExtension`; the
 * mocks capture the exact callbacks the extension registered and the test
 * invokes them. The RPC channel is driven through the dispatching
 * `pi.events.on` map `rpc-lifecycle-gating.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

interface CapturedFleetActions {
  pause: (id: string) => string | undefined;
  resume: (id: string) => boolean;
}

interface CapturedEmbeddedLog {
  pauseAgent?: (id: string) => string | undefined;
}

interface CapturedWorkflowDeps {
  embeddedLog?: CapturedEmbeddedLog;
}

/** The `p` key's pause/resume pair, captured from `setLifecycleActions`. */
let fleetActions: CapturedFleetActions | undefined;
/** The fleet list's "open a workflow" callback, captured from `setWorkflowSource`. */
let workflowOpen: ((id: string) => void) | undefined;
/** The deps object `openWorkflowFromFleet` receives — the inspector's log deps. */
let workflowDeps: CapturedWorkflowDeps | undefined;

vi.mock("../src/ui/fleet-list.js", () => ({
  FleetList: class {
    setUICtx = vi.fn();
    setLifecycleActions = vi.fn((actions: CapturedFleetActions) => {
      fleetActions = actions;
    });
    setWorkflowSource = vi.fn((_source: unknown, open: (id: string) => void) => {
      workflowOpen = open;
    });
    setEnabled = vi.fn();
    update = vi.fn();
    ensureTimer = vi.fn();
    onAgentFinished = vi.fn();
    dispose = vi.fn();
    editorHasFocus = vi.fn(() => true);
    openHub = vi.fn();
  },
}));

vi.mock("../src/ui/workflow-menu.js", () => ({
  openWorkflowFromFleet: vi.fn((_id: string, deps: CapturedWorkflowDeps) => {
    workflowDeps = deps;
  }),
  showWorkflowsMenu: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import type { AgentRecord } from "../src/types.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
/** The narrow cross-extension facade the extension publishes. */
const registry = (): { getRecord(id: string): AgentRecord | undefined } =>
  (globalThis as any)[MANAGER_KEY];

const OWNERSHIP_REFUSAL = "it is owned by another agent or workflow";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  fleetActions = undefined;
  workflowOpen = undefined;
  workflowDeps = undefined;
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** A fake session that reports a session file, so its record is resumable. */
function resumableSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    sessionManager: { getSessionFile: () => `${hermetic!.dir}/agent-session.jsonl` },
  } as any;
}

/** A runAgent that never settles, so the agent stays "running". */
function heldRun() {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(resumableSession());
      }) as any,
  );
}

function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  const b = makePi();
  // Replace the host bus with a dispatching map BEFORE the extension loads, so
  // the RPC channels it registers on session_start are invocable from a test.
  const busHandlers = new Map<string, (raw: any) => unknown>();
  b.pi.events.on = vi.fn((event: string, handler: (raw: any) => unknown) => {
    busHandlers.set(event, handler);
    return vi.fn();
  });
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return { b, busHandlers };
}

/** The bound session the RPC handlers are gated on. */
const startSession = async (b: BootedPi) =>
  b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());

/** Spawn one running background agent through the real Agent tool. */
async function spawnRunning(b: BootedPi, description: string): Promise<AgentRecord> {
  heldRun();
  const r = await b.tools.get("Agent").execute(
    `tc-${description}`,
    { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return registry().getRecord(id)!;
}

/**
 * Mark a spawned record as owned, the way its real spawn would have: the
 * manager strips handle and alias from anything a workflow or another agent
 * owns, so only a raw id can reach it — which is exactly what the guard has
 * to refuse.
 */
function own(record: AgentRecord, kind: "workflow" | "nested"): AgentRecord {
  record.handle = undefined;
  record.alias = undefined;
  if (kind === "workflow") {
    // What `spawnAndWait` makes: a workflow's child is a foreground record
    // with no handle, so ownership — not "blocking" — is the reason to refuse.
    record.workflowId = "wf-1";
    record.isBackground = false;
    record.blocking = true;
  } else {
    record.parentAgentId = "parent-1";
  }
  return record;
}

/**
 * The same record after the spawn, for a run whose tool call has not returned:
 * the id comes off the options the manager handed `runAgent`.
 */
function lastRunRecord(): AgentRecord {
  const id = vi.mocked(runAgent).mock.calls.at(-1)![3].agentId as string;
  return registry().getRecord(id)!;
}

/** The `subagents:paused` announcements, filtered out of the bus traffic. */
const pausedEmits = (b: BootedPi): unknown[] =>
  vi.mocked(b.pi.events.emit).mock.calls.filter(c => c[0] === "subagents:paused");

const notifies = (cmdCtx: any): string[] =>
  vi.mocked(cmdCtx.ui.notify).mock.calls.map(c => String(c[0]));

describe("pause funnel — ownership refusal", () => {
  it("the fleet/hub lifecycle pause callback refuses a workflow-owned record with the ownership reason", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "workflow child");
    // The registry filters owned records out — capture the reference first.
    own(record, "workflow");
    expect(registry().getRecord(record.id)).toBeUndefined();
    // Blocking, as a workflow child really is: the ownership still wins.
    expect(record.isBackground).toBe(false);
    expect(record.blocking).toBe(true);

    expect(fleetActions!.pause(record.id)).toBe(OWNERSHIP_REFUSAL);
    expect(record.status).toBe("running");
    expect(pausedEmits(b)).toEqual([]);
  });

  it("the fleet/hub lifecycle pause callback refuses a nested-child background record", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "nested child");
    own(record, "nested");
    expect(registry().getRecord(record.id)).toBeUndefined();

    // Background and not worktree-isolated: before the guard this parked the
    // run its owner is blocked on.
    expect(record.isBackground).toBe(true);
    expect(record.worktree).toBeUndefined();
    expect(fleetActions!.pause(record.id)).toBe(OWNERSHIP_REFUSAL);
    expect(record.status).toBe("running");
    expect(pausedEmits(b)).toEqual([]);
  });

  it("the workflow inspector's log pause callback refuses a workflow-owned record", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "workflow child");
    own(record, "workflow");

    workflowOpen!(record.id);
    expect(workflowDeps?.embeddedLog).toBeDefined();
    expect(workflowDeps!.embeddedLog!.pauseAgent!(record.id)).toBe(OWNERSHIP_REFUSAL);
    expect(record.status).toBe("running");
    expect(pausedEmits(b)).toEqual([]);
  });

  it("ownership outranks the blocking and worktree refusals", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "owned foreground");
    own(record, "workflow");
    record.worktree = { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/w" };
    record.isBackground = false;

    expect(fleetActions!.pause(record.id)).toBe(OWNERSHIP_REFUSAL);
    expect(record.status).toBe("running");
  });
});

describe("pause funnel — command surfaces", () => {
  it("`/agents pause <workflow-child-id>` refuses by raw id", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "workflow child");
    own(record, "workflow");
    expect(record.handle).toBeUndefined();

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler(`pause ${record.id}`, cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      `Could not pause @${record.id} — ${OWNERSHIP_REFUSAL}.`,
      "warning",
    );
    expect(record.status).toBe("running");
    expect(pausedEmits(b)).toEqual([]);
  });

  it("`/agents pause <nested-child-id>` never resolves the id", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "nested child");
    own(record, "nested");

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler(`pause ${record.id}`, cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(`No active agent named @${record.id}.`, "warning");
    expect(record.status).toBe("running");
  });

  it("`/agents pause @<handle>` still refuses a foreground record as blocking", async () => {
    const { b } = boot();
    heldRun();
    const execution = b.tools.get("Agent").execute(
      "tc-foreground",
      { prompt: "go", description: "foreground", subagent_type: "Explore", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );
    await flush();
    const record = lastRunRecord();
    expect(record.isBackground).toBe(false);

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler(`pause @${record.handle}`, cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      `Could not pause @${record.handle} — it is blocking its caller.`,
      "warning",
    );
    expect(record.status).toBe("running");
    void execution;
  });

  it("`/agents pause @<handle>` still refuses a worktree-isolated record", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "worktree");
    record.worktree = { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/w" };

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler(`pause @${record.handle}`, cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      `Could not pause @${record.handle} — worktree-isolated runs cannot pause.`,
      "warning",
    );
    expect(record.status).toBe("running");
  });
});

describe("pause funnel — bulk surfaces stay scoped to top-level agents", () => {
  const manifest = () => new PauseStore(resolvePauseStorePath(process.cwd(), "s1"));

  it("`/pause` parks only the top-level agent and never names the owned one", async () => {
    const { b } = boot();
    await startSession(b);
    const ok = await spawnRunning(b, "pausable");
    const owned = own(await spawnRunning(b, "owned"), "workflow");

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("pause").handler("", cmdCtx);
    await flush();

    expect(ok.status).toBe("paused");
    expect(owned.status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Paused 1 agent.", "info");
    expect(notifies(cmdCtx).some(t => t.includes("skipped") || t.includes(owned.id))).toBe(false);
    expect(manifest().list().map(e => e.id)).toEqual([ok.id]);
  });

  it("bare `/agents pause` parks only the top-level agent", async () => {
    const { b } = boot();
    const ok = await spawnRunning(b, "pausable");
    const owned = own(await spawnRunning(b, "owned"), "nested");

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler("pause", cmdCtx);
    await flush();

    expect(ok.status).toBe("paused");
    expect(owned.status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Paused 1 agent.", "info");
    expect(notifies(cmdCtx).some(t => t.includes("skipped") || t.includes(owned.id))).toBe(false);
  });
});

describe("pause funnel — RPC surface", () => {
  const rpcReply = (b: BootedPi, requestId: string): unknown =>
    vi.mocked(b.pi.events.emit).mock.calls
      .filter(c => c[0] === `subagents:rpc:pause:reply:${requestId}`)
      .at(-1)![1];

  it("refuses both owned shapes with the bus-side ownership error", async () => {
    const { b, busHandlers } = boot();
    await startSession(b);
    const workflow = own(await spawnRunning(b, "workflow child"), "workflow");
    const nested = own(await spawnRunning(b, "nested child"), "nested");

    await busHandlers.get("subagents:rpc:pause")!({ requestId: "req-wf", agentId: workflow.id });
    await busHandlers.get("subagents:rpc:pause")!({ requestId: "req-nested", agentId: nested.id });

    expect(rpcReply(b, "req-wf")).toEqual({
      success: false,
      error: "Agent is owned by another agent or workflow",
    });
    expect(rpcReply(b, "req-nested")).toEqual({
      success: false,
      error: "Agent is owned by another agent or workflow",
    });
    expect(workflow.status).toBe("running");
    expect(nested.status).toBe("running");
    expect(pausedEmits(b)).toEqual([]);
  });
});

describe("pause funnel — top-level agents still pause", () => {
  it("the fleet action pauses a top-level background agent and announces it once", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "pausable");

    expect(fleetActions!.pause(record.id)).toBeUndefined();
    expect(record.status).toBe("paused");
    expect(pausedEmits(b)).toEqual([
      ["subagents:paused", { id: record.id, type: record.type, description: record.description }],
    ]);
  });

  it("`/agents pause @<handle>` pauses a top-level background agent", async () => {
    const { b } = boot();
    const record = await spawnRunning(b, "pausable");

    const cmdCtx = ctx({ isIdle: () => true });
    await b.commands.get("agents").handler(`pause @${record.handle}`, cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(`Paused @${record.handle}.`, "info");
    expect(record.status).toBe("paused");
  });
});
