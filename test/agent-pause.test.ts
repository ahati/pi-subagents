import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const runResult = (overrides: Record<string, unknown> = {}) =>
  ({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
    ...overrides,
  }) as any;

describe("AgentManager — pause / unpause", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  /**
   * Spawn with a runAgent the test releases by hand, and wait out the
   * startup — spawn() returns synchronously but the startups entry (which
   * pause() refuses on) clears a microtask later, so a reachable pause point
   * is always past awaitStartup.
   */
  async function spawnHeld(options: { isBackground?: boolean } = {}, prompt = "task") {
    let release!: (value: ReturnType<typeof runResult>) => void;
    vi.mocked(runAgent).mockImplementation(
      () => new Promise<ReturnType<typeof runResult>>(resolve => { release = resolve; }),
    );
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, {
      description: prompt,
      ...options,
    });
    await manager.awaitStartup(id);
    return { id, release };
  }

  it("pauses a running agent, and the settle keeps 'paused'", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    expect(manager.pause(id)).toBe(true);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("paused");
    // The run settles as an abort would — but externallyHalted must keep the
    // status pause() chose, or a later resume could not be told apart from a
    // run that died mid-turn.
    release(runResult({ aborted: true, responseText: "partial" }));
    await record.promise;
    expect(record.status).toBe("paused");
    expect(record.result).toBe("partial");
    expect(record.completedAt).toBeDefined();
  });

  it("fires onComplete once, with the paused status", async () => {
    const seen: string[] = [];
    manager = new AgentManager(r => { seen.push(r.status); });
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;
    expect(seen).toEqual(["paused"]);
  });

  it("pauses a queued agent: it never self-starts, unpause re-queues it", async () => {
    manager = new AgentManager(undefined, 1);
    const a = await spawnHeld({ isBackground: true }, "a");
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(b)!.status).toBe("queued");

    expect(manager.pause(b)).toBe(true);
    expect(manager.getRecord(b)!.status).toBe("paused");

    // A settles and frees the slot — but B's entry is parked, so the drain
    // that starts everything else must not start it.
    a.release(runResult({ responseText: "a-done" }));
    await manager.getRecord(a.id)!.promise;
    expect(manager.getRecord(b)!.status).toBe("paused");

    vi.mocked(runAgent).mockResolvedValue(runResult({ responseText: "b-done" }));
    expect(manager.unpause(b)).toBe(true);
    expect(manager.getRecord(b)!.status).toBe("running");
    await manager.getRecord(b)!.promise;
    expect(manager.getRecord(b)!.status).toBe("completed");
  });

  it("refuses to pause a foreground agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: false });
    expect(manager.pause(id)).toBe(false);
    expect(manager.getRecord(id)!.status).toBe("running");
    release(runResult());
    await manager.getRecord(id)!.promise;
  });

  it("refuses to pause a worktree-isolated agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    const record = manager.getRecord(id)!;
    // Settled worktree agents keep the field; the settle path commits and
    // removes the tree, and a resumed session would hold tools bound to a
    // deleted directory.
    record.worktree = { path: "/tmp/wt" } as any;
    expect(manager.pause(id)).toBe(false);
    expect(record.status).toBe("running");
    release(runResult({ aborted: true }));
    await record.promise;
  });

  it("refuses to pause while startup is in flight (worktree copy)", async () => {
    // A never-resolving copy: the agent is "running" with no session and no
    // queue entry, so "paused" could never be lifted.
    vi.mocked(createWorktree).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "task", {
      description: "task",
      isBackground: true,
      isolation: "worktree",
    });
    expect(manager.pause(id)).toBe(false);
  });

  it("refuses to pause a settled agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    release(runResult());
    await manager.getRecord(id)!.promise;
    expect(manager.pause(id)).toBe(false);
    expect(manager.getRecord(id)!.status).toBe("completed");
  });

  it("leaves session-bearing paused records to resume(): unpause returns false", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.session).toBeDefined();
    expect(manager.unpause(id)).toBe(false);
  });

  it("resume after pause completes the same record", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;

    vi.mocked(resumeAgent).mockResolvedValue({ text: "ok" } as any);
    const record = await manager.resume(id, "Continue from where you left off.");
    expect(record?.status).toBe("completed");
    expect(record?.result).toBe("ok");
  });

  it("abortAll leaves paused agents alone", async () => {
    manager = new AgentManager();
    const p = await spawnHeld({ isBackground: true }, "p");
    const r = await spawnHeld({ isBackground: true }, "r");
    expect(manager.pause(p.id)).toBe(true);

    expect(manager.abortAll()).toBe(1);
    expect(manager.getRecord(r.id)!.status).toBe("stopped");
    expect(manager.getRecord(p.id)!.status).toBe("paused");
    p.release(runResult());
    r.release(runResult());
    await Promise.allSettled([
      manager.getRecord(p.id)!.promise,
      manager.getRecord(r.id)!.promise,
    ]);
  });

  it("the 10-minute cleanup skips paused records", async () => {
    manager = new AgentManager();
    const p = await spawnHeld({ isBackground: true }, "p");
    manager.pause(p.id);
    const d = await spawnHeld({ isBackground: true }, "d");
    d.release(runResult());
    await manager.getRecord(d.id)!.promise;

    const stale = Date.now() - 11 * 60_000;
    manager.getRecord(p.id)!.completedAt = stale;
    manager.getRecord(d.id)!.completedAt = stale;
    (manager as any).cleanup();

    // Paused is exempt — evicting it would tombstone a conversation the user
    // explicitly parked. A completed record the same age goes.
    expect(manager.getRecord(p.id)).toBeDefined();
    expect(manager.getRecord(d.id)).toBeUndefined();
  });
});
