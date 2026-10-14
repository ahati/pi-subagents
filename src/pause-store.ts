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
 * A row carries either the agent's session file — `/continue` reopens that
 * conversation — or a `respawn` recipe (the prompt and the invocation fields
 * the live record held when it was parked), for an agent paused with nothing
 * on disk (`persist_session: false`, or paused out of the queue). A respawn is
 * a fresh run of the original task: the earlier transcript, tool state and
 * usage history are gone. `/pause` reports that split.
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
import type { EffectiveThinkingLevel, SubagentType } from "./types.js";

/**
 * Minimal recipe for re-running an agent parked without a persisted session.
 * Best-effort by construction: only what the live record held at pause time.
 */
export interface PausedRespawnSpec {
  /** The prompt the original run was started with, verbatim. */
  prompt: string;
  /** Canonical `provider/modelId` as the run's session reported it. */
  model?: string;
  /** The level in effect, `"off"` included — it is a level, not an absence. */
  thinking?: EffectiveThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
}

/** One manifest row: enough to reopen the conversation and reclaim its names. */
export interface PausedAgentEntry {
  /** The original record id — lets `/continue` prefer a still-live record. */
  id: string;
  type: SubagentType;
  handle?: string;
  alias?: string;
  description: string;
  /** Present when the run has a persisted session: `/continue` revives it. */
  sessionFile?: string;
  /** Present when it has none: `/continue` re-runs it from scratch. Never both. */
  respawn?: PausedRespawnSpec;
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
 * Manifest v3: the paused-agent rows plus an optional parked main turn. `read()`
 * is version-agnostic, so a v2 file loads unchanged (its rows always carry a
 * session file). The bump is documentary — and a downgrade signal: an older
 * build's `reviveTombstone` calls `existsSync` on the row's missing
 * `sessionFile`, so mixing versions is not safe.
 */
export interface PauseStoreData {
  version: 3;
  entries: PausedAgentEntry[];
  mainTurn?: PausedMainTurn;
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

  /**
   * Record (or clear, with `undefined`) the parked main turn without touching
   * the entry rows. Clearing with no entries left removes the file.
   */
  setMainTurn(turn: PausedMainTurn | undefined): void {
    const current = this.read();
    if (!turn) {
      if (current.entries.length === 0) {
        this.clear();
        return;
      }
      this.write(current.entries, undefined);
      return;
    }
    this.write(current.entries, turn);
  }

  /**
   * Replace the entry rows. A main turn already on disk survives (the
   * settle/quit funnel rewrites the entries while the parked turn waits for
   * `/continue`); an empty list with no main turn clears the file.
   */
  replace(entries: PausedAgentEntry[]): void {
    const { mainTurn } = this.read();
    if (entries.length === 0 && !mainTurn) {
      this.clear();
      return;
    }
    this.write(entries, mainTurn);
  }

  /** Read entries and main turn tolerantly: v1 files, garbage and all. */
  private read(): { entries: PausedAgentEntry[]; mainTurn?: PausedMainTurn } {
    if (!existsSync(this.filePath)) return { entries: [] };
    try {
      const data: Partial<PauseStoreData> = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return { entries: data.entries ?? [], mainTurn: data.mainTurn };
    } catch {
      return { entries: [] };
    }
  }

  /** Whole-file snapshot via temp+rename. */
  private write(entries: PausedAgentEntry[], mainTurn: PausedMainTurn | undefined): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const data: PauseStoreData = { version: 3, entries, ...(mainTurn ? { mainTurn } : {}) };
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
