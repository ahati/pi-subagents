/**
 * pause-store.ts — File-backed manifest of agents paused for a cross-restart /continue.
 *
 * `/pause` parks every active top-level agent and writes the ones with a
 * persisted session to `<cwd>/.pi/subagent-pauses/<sessionId>.json`. The
 * in-memory records die with the process, but this manifest survives it:
 * after the session is loaded again, `/continue` reads the entries back and
 * revives each conversation from its session file — the same
 * `resumeSessionFile` path `/agents revive` and `@handle` use.
 *
 * Only disk-resumable agents are listed. A paused agent without a session
 * file (`persist_session: false`, or paused out of the queue) has nothing to
 * reopen, so quitting loses it regardless; `/pause` reports that split
 * instead of pretending otherwise.
 *
 * Concurrency: writes are whole-file snapshots via temp+rename (POSIX
 * atomic), and every access re-reads from disk, so there is no cache to go
 * stale. There is deliberately no PID lock (unlike ScheduleStore): the store
 * has no timers, so the only cross-process scenario is two live pi instances
 * on the same session both running `/continue` — a double-revive hazard pi
 * itself has (`--resume` in two windows), not a corruption one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubagentType } from "./types.js";

/** One manifest row: enough to reopen the conversation and reclaim its names. */
export interface PausedAgentEntry {
  /** The original record id — lets `/continue` prefer a still-live record. */
  id: string;
  type: SubagentType;
  handle?: string;
  alias?: string;
  description: string;
  /** The agent's persisted pi session — the whole point of the entry. */
  sessionFile: string;
  /** ISO timestamp of when the pause landed (kept across re-syncs). */
  pausedAt: string;
}

/**
 * The parked main-agent turn. The pending calls themselves live in the
 * transcript; `pendingTools` is only their count.
 */
export interface PausedMainTurn {
  parked: boolean;
  pendingTools: number;
  /** Set when a gate closure marked the pending calls (not used by the default flow). */
  cancelled?: boolean;
  /** Multi-window guard for the non-idempotent shadow continuation. */
  claim: { pid: number; at: string };
  pausedAt: string;
}

/**
 * One parked workflow run. `/pause` stops a run at its next settle boundary
 * and records this row; `/continue` re-runs the script through the
 * journal-resume path, so the longest unchanged prefix replays cheaply.
 */
export interface PausedWorkflowEntry {
  /** The parked run id; becomes `resumedFrom` on the restart. */
  id: string;
  /** The settled-call journal to replay. */
  journalPath: string;
  /** The exact source the run was started from — temp dirs get swept. */
  script: string;
  /** Verbatim `args`: prompts are derived from them, so replay keys need them. */
  args?: unknown;
  /** So the restarted run's notification correlates with the original call. */
  toolCallId?: string;
  pausedAt: string;
}

/** Manifest v3: the paused-agent rows, a parked main turn, and parked runs. */
export interface PauseStoreData {
  version: 3;
  entries: PausedAgentEntry[];
  mainTurn?: PausedMainTurn;
  workflows?: PausedWorkflowEntry[];
}

/** Resolve the canonical storage path for a session-scoped pause manifest. */
export function resolvePauseStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-pauses", `${sessionId}.json`);
}

/** How many parent directories the fallback lookup walks before giving up. */
const MAX_PARENT_LEVELS = 6;

/**
 * Resolve the manifest for a session the way `/continue` needs it: the
 * canonical `<cwd>/.pi/subagent-pauses/<sessionId>.json` when it is there,
 * otherwise the same relative path under a parent directory — the restart
 * flow hits this when the session header recorded the workspace root as cwd
 * but the live `ctx.cwd` is a subdirectory. Falls back to the canonical path
 * when no manifest exists anywhere (callers check existence).
 */
export function resolvePauseManifestPath(cwd: string, sessionId: string): string {
  const canonical = resolvePauseStorePath(cwd, sessionId);
  if (existsSync(canonical)) return canonical;

  let dir = cwd;
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = resolvePauseStorePath(dir, sessionId);
    if (existsSync(candidate)) return candidate;
  }
  return canonical;
}

export class PauseStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Read the manifest from disk. Silent on parse errors — next write rewrites. */
  list(): PausedAgentEntry[] {
    return this.read().entries;
  }

  /** The parked main turn, if one was recorded. */
  getMainTurn(): PausedMainTurn | undefined {
    return this.read().mainTurn;
  }

  /** The parked workflow runs, in parking order. */
  listWorkflows(): PausedWorkflowEntry[] {
    return this.read().workflows;
  }

  /**
   * Record (or clear, with `undefined`) the parked main turn without touching
   * the entry or workflow rows. Clearing with nothing else left removes the
   * file.
   */
  setMainTurn(turn: PausedMainTurn | undefined): void {
    const current = this.read();
    if (!turn) {
      if (!current.entries.length && !current.workflows.length) {
        this.clear();
        return;
      }
      this.write(current.entries, undefined, current.workflows);
      return;
    }
    this.write(current.entries, turn, current.workflows);
  }

  /**
   * Replace the entry rows. A main turn and any parked workflow runs already on
   * disk survive (the settle/quit funnel rewrites the entries while the parked
   * turn waits for `/continue`); an empty list with nothing else left clears the
   * file.
   */
  replace(entries: PausedAgentEntry[]): void {
    const { mainTurn, workflows } = this.read();
    if (entries.length === 0 && workflows.length === 0 && !mainTurn) {
      this.clear();
      return;
    }
    this.write(entries, mainTurn, workflows);
  }

  /**
   * Replace the parked workflow rows, preserving the entry rows and the parked
   * main turn — the mirror of {@link replace} for the workflow collection.
   */
  replaceWorkflows(workflows: PausedWorkflowEntry[]): void {
    const { entries, mainTurn } = this.read();
    if (entries.length === 0 && workflows.length === 0 && !mainTurn) {
      this.clear();
      return;
    }
    this.write(entries, mainTurn, workflows);
  }

  /** Read rows and main turn tolerantly: v1/v2 files, garbage and all. */
  private read(): {
    entries: PausedAgentEntry[];
    mainTurn?: PausedMainTurn;
    workflows: PausedWorkflowEntry[];
  } {
    if (!existsSync(this.filePath)) return { entries: [], workflows: [] };
    try {
      const data: Partial<PauseStoreData> = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return {
        entries: data.entries ?? [],
        mainTurn: data.mainTurn,
        workflows: Array.isArray(data.workflows) ? data.workflows : [],
      };
    } catch {
      return { entries: [], workflows: [] };
    }
  }

  /** Whole-file snapshot via temp+rename. */
  private write(
    entries: PausedAgentEntry[],
    mainTurn: PausedMainTurn | undefined,
    workflows: PausedWorkflowEntry[],
  ): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const data: PauseStoreData = {
      version: 3,
      entries,
      ...(mainTurn ? { mainTurn } : {}),
      ...(workflows.length > 0 ? { workflows } : {}),
    };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Delete the backing file. */
  clear(): void {
    try {
      unlinkSync(this.filePath);
    } catch {
      /* already gone */
    }
  }
}
