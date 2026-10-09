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

export interface PauseStoreData {
  version: 1;
  entries: PausedAgentEntry[];
}

/** Resolve the storage path for a session-scoped pause manifest. */
export function resolvePauseStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-pauses", `${sessionId}.json`);
}

export class PauseStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Read the manifest from disk. Silent on parse errors — next write rewrites. */
  list(): PausedAgentEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const data: PauseStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return data.entries ?? [];
    } catch {
      return [];
    }
  }

  /** Replace the manifest with exactly these entries. Empty list clears the file. */
  replace(entries: PausedAgentEntry[]): void {
    if (entries.length === 0) {
      this.clear();
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const data: PauseStoreData = { version: 1, entries };
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
