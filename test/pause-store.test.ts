/**
 * pause-store.test.ts — Persistence for the cross-restart pause manifest.
 *
 * Mirrors schedule-store.test.ts: path shape, round-trip, clear, and
 * parse-error self-heal. No lock to test — writes are whole-file atomic
 * snapshots (see pause-store.ts header for why there is deliberately none).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PausedAgentEntry, PauseStore, resolvePauseStorePath } from "../src/pause-store.js";

function makeEntry(overrides: Partial<PausedAgentEntry> = {}): PausedAgentEntry {
  return {
    id: "agent-abc123",
    type: "Explore",
    handle: "explore",
    description: "find flaky tests",
    sessionFile: "/tmp/some-session.jsonl",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("PauseStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pause-store-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolvePauseStorePath produces session-scoped path under .pi/subagent-pauses/", () => {
    expect(resolvePauseStorePath("/repo", "abc123")).toBe("/repo/.pi/subagent-pauses/abc123.json");
  });

  it("starts empty, round-trips entries, and persists across instances", () => {
    const path = join(tmp, "p.json");
    const store = new PauseStore(path);
    expect(store.list()).toEqual([]);

    const entry = makeEntry();
    store.replace([entry]);
    expect(new PauseStore(path).list()).toEqual([entry]);
  });

  it("replace([]) deletes the backing file", () => {
    const path = join(tmp, "p.json");
    const store = new PauseStore(path);
    store.replace([makeEntry()]);
    expect(existsSync(path)).toBe(true);

    store.replace([]);
    expect(existsSync(path)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("clear() is a no-op on a missing file", () => {
    const store = new PauseStore(join(tmp, "never-written.json"));
    expect(() => store.clear()).not.toThrow();
  });

  it("self-heals from a corrupt file by reading empty", () => {
    const path = join(tmp, "p.json");
    writeFileSync(path, "{not json");
    expect(new PauseStore(path).list()).toEqual([]);
  });

  it("creates the backing directory lazily on first write", () => {
    const path = join(tmp, "nested", "dirs", "p.json");
    new PauseStore(path).replace([makeEntry()]);
    expect(new PauseStore(path).list()).toHaveLength(1);
  });
});
