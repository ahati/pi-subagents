/**
 * pause-continue-print-mode.e2e.test.ts — the `/pause` → quit → reload →
 * `/continue` story against the REAL pi runtime.
 *
 * The wiring tests (pause-continue-wiring.test.ts) mock `runAgent`, so their
 * "session files" are empty paths and `SessionManager.open` never runs. This
 * suite closes that gap with no pi-mono mock and only the model faux:
 *
 *   - run 1 drives a real parent turn (real command dispatch through
 *     `session.prompt("/pause")`, real `ExtensionCommandContext`) that spawns
 *     a real child session whose faux model call is held open, so the child is
 *     mid-turn when `/pause` lands; the manifest then holds a REAL session
 *     file path, and run 1's shutdown must leave it intact.
 *   - run 2 boots a fresh extension against the SAME cwd, resuming run 1's
 *     parent session file (the cross-boot step), and `/continue` revives the
 *     child through the real `SessionManager.open` → `resumeAgent` path.
 *
 * The disk is the assertion surface: the manifest, the child session file's
 * content before and after the continuation, and the parent's follow-up turn.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { agentCall, conversationText, routeBySession, runPrintMode, toolResultsNamed } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

/** Poll a condition with real timers — the runs have genuinely async tails. */
async function waitFor(what: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("/pause → quit → reload → /continue (real pi sessions, faux model)", () => {
  let cwd: string;
  let sessionDir: string;
  let prevSessionDirEnv: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pause-continue-e2e-"));
    sessionDir = join(cwd, "sessions");
    // Both runs must resolve child sessions to the SAME dir under the shared
    // cwd: each run isolates HOME, and pi's default session dir lives under
    // it, which would make run 1's child sessions unreachable from run 2.
    prevSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    if (prevSessionDirEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDirEnv;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("parks a mid-turn child, survives shutdown, and continues it after a reload", async () => {
    // --- run 1: spawn, park, quit -----------------------------------------
    let releaseChild!: () => void;
    const childHeld = new Promise<string>(resolve => {
      releaseChild = () => resolve("late answer, dropped after the pause");
    });

    const run1 = await runPrintMode({
      live: false,
      cwd,
      prompt: "delegate work",
      hold: false, // the child never finishes — the parent must not wait for it
      sessionManager: SessionManager.create(cwd, sessionDir),
      respond: routeBySession({
        parentInitial: [agentCall({ prompt: "long child task", description: "long task", run_in_background: true })],
        parentFinal: "Spawned.",
        subagent: () => childHeld,
      }),
    });
    try {
      const childId = /Agent ID: (\S+)/.exec(toolResultsNamed(run1.parentSession, "Agent")[0])![1];
      const record = run1.manager!.getRecord(childId);
      expect(record).toBeDefined();

      // The child is mid-turn: its session exists on disk and its faux model
      // call is still held. /pause parks it through REAL command dispatch.
      await waitFor(() => record!.status === "running" && !!record!.sessionFile && existsSync(record!.sessionFile!));
      await run1.parentSession.prompt("/pause");

      expect(record!.status).toBe("paused");

      const sessionId1 = run1.parentSession.sessionManager.getSessionId();
      const parentSessionFile = run1.parentSession.sessionManager.getSessionFile();
      const manifestPath = resolvePauseStorePath(cwd, sessionId1);
      const entries = new PauseStore(manifestPath).list();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(childId);
      expect(entries[0].handle).toBe("general-purpose");
      expect(existsSync(entries[0].sessionFile)).toBe(true);
      const childSessionFile = entries[0].sessionFile;

      // The held stream settles so nothing dangles into dispose.
      releaseChild();
      await run1.dispose();

      // Quit must not have scrubbed the manifest — the cross-restart premise.
      expect(new PauseStore(manifestPath).list()).toHaveLength(1);

      // --- run 2: fresh boot, resumed session, /continue --------------------
      const run2 = await runPrintMode({
        live: false,
        cwd,
        prompt: "/continue",
        hold: false,
        sessionManager: SessionManager.open(parentSessionFile, sessionDir),
        respond: routeBySession({
          parentInitial: "unexpected parent turn",
          parentFinal: "Noted.",
          subagent: "continued work",
        }),
      });
      try {
        // /continue clears the manifest: the parked entry is now a live run.
        await waitFor(() => new PauseStore(manifestPath).list().length === 0);

        // The child's REAL session file was reopened and continued: the
        // synthetic continuation prompt and the new exchange are on disk
        // alongside the first run's conversation.
        await waitFor(() => readFileSync(childSessionFile, "utf-8").includes("continued work"));
        const childTranscript = readFileSync(childSessionFile, "utf-8");
        expect(childTranscript).toContain("long child task");
        expect(childTranscript).toContain("Continue from where you left off.");
        expect(childTranscript).toContain("continued work");

        // The completion nudge reached the resumed parent and was processed
        // (the follow-up turn answered). The nudge itself is a user-role
        // message, so conversationText — assistant text only — shows the reply.
        await waitFor(() => conversationText(run2.parentSession).includes("Noted."));
        expect(conversationText(run2.parentSession)).toContain("Noted.");
      } finally {
        await run2.dispose();
      }
    } finally {
      releaseChild();
      await run1.dispose().catch(() => {});
    }
  });
});
