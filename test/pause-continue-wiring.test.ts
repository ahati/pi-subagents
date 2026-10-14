/**
 * pause-continue-wiring.test.ts — the global `/pause` and `/continue`
 * commands, driven through the REAL extension's registered command handlers.
 *
 * One layer above agents-commands.test.ts: the cross-restart manifest.
 * `/pause` parks every active agent and writes the disk-resumable ones to
 * `<cwd>/.pi/subagent-pauses/<sessionId>.json`; `/continue` resumes live
 * paused records in place and revives manifest-only entries from their
 * session files after a simulated restart (a fresh boot with the manifest
 * still on disk). The session_start hint is pinned here too.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { finalReportFromSessionFile } from "../src/session-continue.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** A fake session that reports a session file, so its record is resumable from disk. */
function resumableSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    sessionManager: { getSessionFile: () => join(hermetic!.dir, "agent-session.jsonl") },
  } as any;
}

/** A runAgent that never settles, so the agent stays "running". */
function heldRun(session: () => any) {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(session());
      }) as any,
  );
}

/** A runAgent that finishes immediately, leaving a settled record behind. */
function finishedRun(session: () => any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session: session(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** A resumeAgent whose settling the test controls, so a resumed run can be
 * driven to a terminal state (and its settle callback observed). */
function controllableResume(session: () => any) {
  let resolve!: (v: unknown) => void;
  vi.mocked(resumeAgent).mockImplementation(
    () =>
      new Promise(r => {
        resolve = r;
      }) as any,
  );
  return () =>
    resolve({
      responseText: "resumed answer",
      session: session(),
      aborted: false,
      steered: false,
      failure: undefined,
    });
}

function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  return bootOnly();
}

/** Boot into the hermetic dir already created — for tests that seed state (a
 * pause manifest) before the extension exists, as a restart does. */
function bootOnly() {
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** A command ctx whose main model is idle, as /pause requires. */
function idleCtx() {
  return ctx({ isIdle: () => true });
}

function runCommand(b: BootedPi, name: "pause" | "continue", args = "", overrides: Record<string, unknown> = {}) {
  const cmdCtx = ctx({ isIdle: () => true, ...overrides });
  const result = b.commands.get(name).handler(args, cmdCtx);
  return { cmdCtx, result: result as Promise<void> };
}

const manifest = () => new PauseStore(resolvePauseStorePath(process.cwd(), "s1"));
const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

/** Spawn one running background agent through the real Agent tool. */
async function spawnRunning(
  b: BootedPi,
  session: () => any,
  description = "find flaky tests",
  mode: "held" | "finished" = "held",
): Promise<string> {
  if (mode === "finished") finishedRun(session);
  else heldRun(session);
  const r = await b.tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

describe("/pause", () => {
  it("pauses every active agent and writes the disk-resumable ones to the manifest", async () => {
    const b = boot();
    const one = await spawnRunning(b, resumableSession, "one");
    const two = await spawnRunning(b, resumableSession, "two");

    const { cmdCtx } = runCommand(b, "pause");
    await flush();

    expect(manager().getRecord(one).status).toBe("paused");
    expect(manager().getRecord(two).status).toBe("paused");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Paused 2 agents.", "info");

    const entries = manifest().list();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.handle).sort()).toEqual(["explore", "explore-2"]);
    expect(entries.every(e => e.type === "Explore")).toBe(true);
    expect(entries.every(e => e.sessionFile.endsWith("agent-session.jsonl"))).toBe(true);
    expect(entries[0].pausedAt).toBeTruthy();
  });

  it("reports agents without a persisted session as lost on quit, and manifests none of them", async () => {
    const b = boot();
    // A plain fake session: no sessionManager, so the record gets no sessionFile.
    await spawnRunning(b, () => ({
      steer: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
    }));

    const { cmdCtx } = runCommand(b, "pause");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Paused 1 agent; 1 without a persisted session — quitting loses it.",
      "info",
    );
    expect(manifest().list()).toEqual([]);
  });

  it("arms while the main model is streaming instead of refusing", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);

    const { cmdCtx } = runCommand(b, "pause", "", { isIdle: () => false });
    await flush();

    // The park lands at the main turn's next boundary, which never arrives in
    // this test — so nothing is parked yet: the subagent keeps running and the
    // manifest stays untouched.
    expect(manager().getRecord(id).status).toBe("running");
    expect(manifest().list()).toEqual([]);
    // A pause that only arms acknowledges, it does not refuse.
    const notifies = vi.mocked(cmdCtx.ui.notify).mock.calls.map(c => String(c[0]));
    expect(notifies.length).toBeGreaterThan(0);
    expect(notifies.some(t => t.includes("press Esc") || t.includes("before /pause"))).toBe(false);
    expect(vi.mocked(b.pi.events.emit).mock.calls.filter(c => c[0] === "subagents:paused")).toEqual([]);
  });

  it("reports when there is nothing active", async () => {
    const b = boot();
    const { cmdCtx } = runCommand(b, "pause");
    await flush();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("No active agents to pause.", "info");
  });

  it("rejects an argument in favor of /agents pause", async () => {
    const b = boot();
    const { cmdCtx } = runCommand(b, "pause", "@explore");
    await flush();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "/pause takes no argument — for one agent use /agents pause [handle].",
      "warning",
    );
  });

  it("names refusals in the bulk form and keeps them out of the manifest", async () => {
    const b = boot();
    const ok = await spawnRunning(b, resumableSession, "pausable");
    const blocked = await spawnRunning(b, resumableSession, "worktree");
    manager().getRecord(blocked).worktree = { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/w" };

    const { cmdCtx } = runCommand(b, "pause");
    await flush();

    expect(manager().getRecord(ok).status).toBe("paused");
    expect(manager().getRecord(blocked).status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Paused 1 agent; skipped @explore-2 (worktree-isolated runs cannot pause).",
      "info",
    );
    const entries = manifest().list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(ok);
  });

  it("the manifest survives the quit-time shutdown that aborts running agents", async () => {
    const b = boot();
    // Bind currentCtx, so the settle hook's re-syncs are live for this session.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    const id = await spawnRunning(b, resumableSession, "parked");
    await runCommand(b, "pause").result;
    await flush();
    expect(manifest().list()).toHaveLength(1);

    // A different agent finishing after the pause proves the hook is live and
    // does not scrub the parked entry on its own.
    await spawnRunning(b, resumableSession, "completes before quit", "finished");
    await flush();
    expect(manifest().list()).toHaveLength(1);
    expect(manifest().list()[0].id).toBe(id);

    // Quit: the shutdown handler aborts and disposes everything. Nothing may
    // scrub the parked entry. This is the invariant the whole feature rests on.
    await b.lifecycle.get("session_shutdown")({ type: "session_shutdown" }, ctx());

    const entries = manifest().list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
  });

  it("a later re-sync keeps each entry's original pausedAt", async () => {
    const b = boot();
    // Bind currentCtx: the completing agent's settle must actually re-sync.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    const id = await spawnRunning(b, resumableSession);
    await runCommand(b, "pause").result;
    await flush();
    const pausedAt = manifest().list()[0].pausedAt;

    // A different agent completing later fires the settle hook's re-sync.
    await new Promise(r => setTimeout(r, 8));
    await spawnRunning(b, resumableSession, "completes", "finished");
    await flush();

    const entry = manifest().list().find(e => e.id === id);
    expect(entry?.pausedAt).toBe(pausedAt);
  });
});

describe("/continue", () => {
  it("resumes live paused records in place and clears the manifest", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await runCommand(b, "pause").result;
    await flush();
    expect(manifest().list()).toHaveLength(1);

    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    // The record's run is alive behind its gate: resume reopens the gate and the
    // original run continues — no resumeAgent, and no prompt of any kind.
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(b.pi.sendMessage).mock.calls)).not.toContain(
      "Continue from where you left off.",
    );
    expect(manager().getRecord(id).status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Continued 1 agent.", "info");
    expect(manifest().list()).toEqual([]);
  });

  it("revives a manifest-only entry from its session file after a simulated restart", async () => {
    // The previous process wrote the manifest, then quit. Nothing of it
    // survives but the file — and the session file it points at.
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const sessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        alias: "auth-audit",
        description: "find flaky tests",
        sessionFile,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    heldRun(resumableSession);
    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    const spawnOpts = vi.mocked(runAgent).mock.calls.at(-1)![3] as any;
    expect(spawnOpts.resumeSessionFile).toBe(sessionFile);
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Continuing @auth-audit", "info");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Continued 1 agent.", "info");
    expect(manifest().list()).toEqual([]);
    // The revived record answers to the manifest's names again.
    const started = vi.mocked(b.pi.events.emit).mock.calls.filter(c => c[0] === "subagents:started").at(-1)!;
    const revived = manager().getRecord(started[1].id);
    expect(revived?.handle).toBe("explore");
    expect(revived?.alias).toBe("auth-audit");
  });

  it("classifies a tool-boundary transcript without a drift warning", async () => {
    // The shape probe treats "no final report" as "needs a run". A parked
    // transcript legitimately ends on an unanswered call, so the probe must
    // stay quiet — warn-always would log once per parked entry on every
    // /continue.
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const sessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "grep", arguments: {} }],
        timestamp: Date.now(),
      },
    }));
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "parked at a tool boundary",
        sessionFile,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    heldRun(resumableSession);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { cmdCtx } = runCommand(b, "continue");
      await flush();
      expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Continued 1 agent.", "info");
      expect(warn.mock.calls.filter(c => String(c[0]).includes("[pi-subagents-hub]"))).toEqual([]);
      // Control: the same file read for delivery (not the probe) DOES warn and
      // says why. Asserting only the silence above would pass on the code
      // before the probe existed, since nothing warned there at all.
      expect(finalReportFromSessionFile(sessionFile)).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes("[pi-subagents-hub]") && m.includes("unanswered tool call"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps entries it could not revive (session file gone) and reports the failure", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const sessionFile = join(hermetic.dir, "deleted-session.jsonl"); // never created
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "find flaky tests",
        sessionFile,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Could not resume @explore — its session is gone.",
      "warning",
    );
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "1 could not be revived (kept in the manifest).",
      "warning",
    );
    expect(manifest().list()).toHaveLength(1);
  });

  it("drops a stale entry whose record already moved on after the pause", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await runCommand(b, "pause").result;
    await flush();
    expect(manifest().list()).toHaveLength(1);

    // Resumed out-of-band after the pause: the record is running again, but
    // no settle has fired, so the manifest still lists it. /continue must
    // recognize the record outranks the entry and drop it, not double-resume.
    controllableResume(resumableSession); // held — stays running
    await b.commands.get("agents").handler("resume @explore", idleCtx());
    await flush();
    expect(manager().getRecord(id).status).toBe("running");

    // The resume's own resumeAgent call is expected; only a SECOND one during
    // /continue would be the double-resume bug.
    vi.mocked(resumeAgent).mockClear();
    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("1 already handled.", "info");
    expect(manifest().list()).toEqual([]);
  });

  it("reports when nothing was paused", async () => {
    const b = boot();
    const { cmdCtx } = runCommand(b, "continue");
    await flush();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Nothing paused in this session.", "info");
  });

  it("is scoped to the session that wrote the manifest", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const sessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "find flaky tests",
        sessionFile,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    // The extension loaded, but a DIFFERENT session is active (pi switched to
    // or started another session in the same directory).
    const otherSession = ctx({
      isIdle: () => true,
      sessionManager: { getSessionId: () => "s2", getBranch: vi.fn(() => []) },
    });
    const result = b.commands.get("continue").handler("", otherSession) as Promise<void>;
    await flush();
    await result;

    expect(otherSession.ui.notify).toHaveBeenCalledWith("Nothing paused in this session.", "info");
    // s1's manifest is untouched — returning to that session still finds it.
    expect(new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).list()).toHaveLength(1);
  });

  it("splits the toast and the manifest when only some entries can revive", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const good = join(hermetic.dir, "good-session.jsonl");
    writeFileSync(good, "");
    const bad = join(hermetic.dir, "deleted-session.jsonl"); // gone
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "revivable",
        sessionFile: good,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "agent-old2",
        type: "Explore",
        handle: "explore-2",
        description: "lost session",
        sessionFile: bad,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    heldRun(resumableSession);
    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Continued 1 agent; 1 could not be revived (kept in the manifest).",
      "info",
    );
    const left = manifest().list();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe("agent-old2");
  });

  it("keeps an entry whose agent type is no longer available", async () => {
    hermetic = hermeticDir({
      settings: { outputTranscript: false },
      // Overriding the default Explore with enabled: false makes the type
      // unresolvable — the Agent tool would fall back, a revive must not.
      agentFiles: { Explore: "---\nenabled: false\n---\ndisabled override" },
    });
    const sessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "find flaky tests",
        sessionFile,
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    const { cmdCtx } = runCommand(b, "continue");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Could not resume @explore — the Explore agent is no longer available.",
      "warning",
    );
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "1 could not be revived (kept in the manifest).",
      "warning",
    );
    expect(manifest().list()).toHaveLength(1);
  });

  it("removes an entry on its own when a resumed run later settles", async () => {
    const b = boot();
    // Bind currentCtx: the settle hook (not the commands) owns this removal.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    // Gate resume continues the ORIGINAL held run, so settling that run is what
    // settles the record — capture its resolve instead of mocking resumeAgent.
    let settleRun: (result?: unknown) => void = () => {};
    vi.mocked(runAgent).mockImplementation(
      (_ctx: any, _type: any, _prompt: any, opts: any) =>
        new Promise(resolve => {
          settleRun = () =>
            resolve({
              responseText: "resumed answer",
              session: resumableSession(),
              aborted: false,
              steered: false,
              failure: undefined,
            });
          opts.onSessionCreated?.(resumableSession());
        }) as any,
    );
    const spawned = await b.tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "find flaky tests", subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];

    await runCommand(b, "pause").result;
    await flush();
    expect(manifest().list()).toHaveLength(1);

    // /agents resume does NOT touch the manifest (the settle hook owns it),
    // so the entry is still there while the resumed run is live...
    await b.commands.get("agents").handler("resume @explore", idleCtx());
    await flush();
    expect(manager().getRecord(id).status).toBe("running");
    expect(manifest().list()).toHaveLength(1);

    // ...and is gone once the run reaches a terminal state.
    settleRun();
    await flush();
    await flush();
    expect(manager().getRecord(id).status).toBe("completed");
    expect(manifest().list()).toEqual([]);
  });

  it("rejects an argument in favor of /agents resume", async () => {
    const b = boot();
    const { cmdCtx } = runCommand(b, "continue", "@explore");
    await flush();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "/continue takes no argument — for one agent use /agents resume [handle].",
      "warning",
    );
  });
});

describe("pause manifest hint", () => {
  it("session_start announces parked agents when the session is loaded again", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    new PauseStore(resolvePauseStorePath(process.cwd(), "s1")).replace([
      {
        id: "agent-old1",
        type: "Explore",
        handle: "explore",
        description: "find flaky tests",
        sessionFile: join(hermetic.dir, "agent-session.jsonl"),
        pausedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const b = bootOnly();
    const startCtx = ctx();
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, startCtx);

    expect(startCtx.ui.notify).toHaveBeenCalledWith(
      "1 subagent paused here — /continue to resume.",
      "info",
    );
  });

  it("a fresh session with no manifest stays silent", async () => {
    const b = boot();
    const startCtx = ctx();
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, startCtx);

    const notifies = vi.mocked(startCtx.ui.notify).mock.calls.filter(c =>
      String(c[0]).includes("paused"),
    );
    expect(notifies).toEqual([]);
  });
});

describe("orphan pause manifest sweep", () => {
  /** Seed a manifest under the hermetic cwd and return its directory. */
  function seedManifests(ids: string[]): string {
    const dir = join(process.cwd(), ".pi", "subagent-pauses");
    mkdirSync(dir, { recursive: true });
    for (const id of ids) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 2, entries: [] }));
    return dir;
  }

  it("session_start deletes manifests whose owning session is gone", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const sessionDir = join(hermetic.dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    // A real session file with the header of the CURRENT session, so the sweep
    // has to prove s1 alive through SessionManager.findById rather than by id.
    const real = SessionManager.create(hermetic.dir, sessionDir, { id: "s1" });
    real.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

    const dir = seedManifests(["s1", "gone"]);
    const b = bootOnly();
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx({
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
        getSessionDir: () => sessionDir,
      },
    }));

    expect(existsSync(join(dir, "s1.json"))).toBe(true);
    expect(existsSync(join(dir, "gone.json"))).toBe(false);
  });

  it("does not sweep when the session directory is unknown", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const dir = seedManifests(["s1", "gone"]);
    const b = bootOnly();
    // No getSessionDir on this session manager: an id that cannot be found is
    // not proof the session is gone, so nothing may be deleted.
    await b.lifecycle.get("session_start")(
      { type: "session_start", reason: "resume" },
      ctx({ sessionManager: { getSessionId: () => "s1", getBranch: () => [] } }),
    );

    expect(existsSync(join(dir, "s1.json"))).toBe(true);
    expect(existsSync(join(dir, "gone.json"))).toBe(true);
  });
});

/** The store never leaves temp droppings behind: the .tmp sidecar is gone after a write. */
describe("pause manifest hygiene", () => {
  it("writes atomically — no .tmp file survives a replace", async () => {
    const b = boot();
    await spawnRunning(b, resumableSession);
    await runCommand(b, "pause").result;

    const path = resolvePauseStorePath(process.cwd(), "s1");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});
