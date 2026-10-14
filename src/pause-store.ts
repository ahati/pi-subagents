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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Manifest v2: the paused-agent rows plus an optional parked main turn. */
export interface PauseStoreData {
  version: 2;
  entries: PausedAgentEntry[];
  mainTurn?: PausedMainTurn;
}

/** The canonical manifest directory for a cwd: `<cwd>/.pi/subagent-pauses`. */
export function pauseStoreDir(cwd: string): string {
  return join(cwd, ".pi", "subagent-pauses");
}

/** Resolve the canonical storage path for a session-scoped pause manifest. */
export function resolvePauseStorePath(cwd: string, sessionId: string): string {
  return join(pauseStoreDir(cwd), `${sessionId}.json`);
}

/**
 * Delete manifests in `dir` whose owning pi session no longer exists.
 *
 * A manifest is keyed by session id (`<sessionId>.json`); once that session
 * is deleted the park can never be continued, and nothing else ever removes
 * the file. `sessionExists` is the caller's proof of life and must be total
 * (a throw would abort the sweep) — the wiring passes a closure over
 * `SessionManager.findById` plus the current session id.
 *
 * Only whole manifest files are considered: `.json.tmp` snapshots and every
 * other name are left alone, and a manifest's contents are never parsed — a
 * corrupt file for a gone session is still garbage. Best effort throughout:
 * an unreadable directory yields [], and a file that cannot be unlinked is
 * simply left behind. Only the canonical `pauseStoreDir(cwd)` is swept;
 * manifests that exist solely under a parent cwd (the
 * `resolvePauseManifestPath` fallback) are out of scope.
 *
 * Returns the removed session ids.
 */
export function sweepOrphanPauseManifests(
  dir: string,
  sessionExists: (sessionId: string) => boolean,
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (id === "") continue;
    if (sessionExists(id)) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(id);
    } catch {
      /* a directory named `<id>.json`, or an unwritable entry — leave it */
    }
  }
  return removed;
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
    const data: PauseStoreData = { version: 2, entries, ...(mainTurn ? { mainTurn } : {}) };
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
