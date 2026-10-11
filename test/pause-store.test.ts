/**
 * pause-store.test.ts — manifest v2: the paused-agent rows PLUS the parked
 * main-turn record (`mainTurn`), and the cwd-independent manifest lookup.
 *
 * Pure fs: every test gets its own temp dir, no extension, no process.cwd
 * games. The v2 surface does not exist yet, so the tests fail on the missing
 * exports/behaviour, not on syntax.
 *
 * Pinned contract (from docs/pause-quit-resume-continue.md §5.2):
 *   - PauseStoreData { version: 2, entries, mainTurn? }
 *   - store.getMainTurn() / store.setMainTurn(turn | undefined)
 *   - replace(entries) never deletes a present mainTurn; replace([]) still
 *     clears a file that has only entries.
 *   - resolvePauseManifestPath(cwd, sessionId) — the fallback lookup helper
 *     (adapt the name if the implementation lands on `findPauseStore`; the
 *     test binds whichever exists, in that order).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pauseStoreModule from "../src/pause-store.js";
import { type PausedAgentEntry, PauseStore } from "../src/pause-store.js";

/**
 * Namespace access, not named imports: a missing v2 export must fail the test
 * that needs it with a readable message instead of failing the whole file at
 * module-load time.
 */
const storeModule = pauseStoreModule as any;

/** A v2 main-turn row. */
function mainTurn(overrides: Record<string, unknown> = {}) {
  return {
    parked: true,
    pendingTools: 1,
    claim: { pid: process.pid, at: "2026-01-01T00:00:00.000Z" },
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** An entry row; `sessionFile` need not exist for store-level tests. */
function entry(overrides: Partial<PausedAgentEntry> = {}): PausedAgentEntry {
  return {
    id: "agent-1",
    type: "Explore",
    handle: "explore",
    description: "find flaky tests",
    sessionFile: "/tmp/agent-session.jsonl",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string | undefined;

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pi-pause-store-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The v2 lookup helper: preferred export first, the originally proposed
 * `findPauseStore` name as a fallback. */
function resolveManifestPath(cwd: string, sessionId: string): string {
  const fn = storeModule.resolvePauseManifestPath ?? storeModule.findPauseStore;
  expect(
    fn,
    "the cwd-independent manifest lookup (resolvePauseManifestPath) is not exported",
  ).toBeTypeOf("function");
  return fn(cwd, sessionId);
}

describe("PauseStore mainTurn (v2)", () => {
  it("reports no main turn for a manifest that was never written", () => {
    const file = join(tempDir(), "missing.json");
    expect(new PauseStore(file).getMainTurn()).toBeUndefined();
  });

  it("round-trips a main turn and writes version 2", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const turn = mainTurn({ pendingTools: 3 });

    store.setMainTurn(turn);

    expect(store.getMainTurn()).toEqual(turn);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.mainTurn).toEqual(turn);
    expect(onDisk.entries).toEqual([]);
  });

  it("preserves the cancelled flag and the claim when set", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const turn = mainTurn({ cancelled: true, pendingTools: 0 });

    store.setMainTurn(turn);

    expect(store.getMainTurn()).toEqual(turn);
    expect(store.getMainTurn()!.cancelled).toBe(true);
  });

  it("setMainTurn keeps the entry rows written by replace()", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const rows = [entry(), entry({ id: "agent-2", handle: "explore-2" })];

    store.replace(rows);
    store.setMainTurn(mainTurn());

    expect(store.list()).toEqual(rows);
    expect(store.getMainTurn()).toEqual(mainTurn());
  });

  it("replace(entries) preserves a main turn that is already on disk", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn({ pendingTools: 2 }));
    store.replace([entry({ id: "agent-9" })]);

    expect(store.list()).toEqual([entry({ id: "agent-9" })]);
    expect(store.getMainTurn()).toEqual(mainTurn({ pendingTools: 2 }));
  });

  it("replace([]) keeps the file and the main turn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn());
    store.replace([]);

    expect(existsSync(file)).toBe(true);
    expect(store.getMainTurn()).toEqual(mainTurn());
    expect(store.list()).toEqual([]);
  });

  it("replace([]) still clears a file that has no main turn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([entry()]);
    store.replace([]);

    expect(existsSync(file)).toBe(false);
    // Merging with the mainTurn path must not change the v1 clearing rule.
    expect(store.getMainTurn()).toBeUndefined();
  });

  it("setMainTurn(undefined) clears the main turn and removes an entry-less file", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn());
    store.setMainTurn(undefined);

    expect(store.getMainTurn()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("setMainTurn(undefined) leaves the entry rows in place", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([entry()]);
    store.setMainTurn(mainTurn());
    store.setMainTurn(undefined);

    expect(store.getMainTurn()).toBeUndefined();
    expect(store.list()).toEqual([entry()]);
  });

  it("ignores a corrupt manifest instead of throwing", () => {
    const file = join(tempDir(), "manifest.json");
    writeFileSync(file, "{ not json");

    const store = new PauseStore(file);
    expect(store.list()).toEqual([]);
    expect(store.getMainTurn()).toBeUndefined();
  });
});

describe("resolvePauseManifestPath fallback", () => {
  it("returns the canonical path for a session with no manifest yet", () => {
    const dir = tempDir();
    const resolved = resolveManifestPath(dir, "s1");
    expect(resolved).toBe(join(dir, ".pi", "subagent-pauses", "s1.json"));
  });

  it("finds a manifest written under a different (parent) cwd", () => {
    // What the restart flow hits: the session header recorded the workspace
    // root as cwd, but the live ctx.cwd is a subdirectory.
    const root = tempDir();
    const file = join(root, ".pi", "subagent-pauses", "s1.json");
    mkdirSync(join(root, ".pi", "subagent-pauses"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, entries: [] }));

    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const resolved = resolveManifestPath(nested, "s1");
    expect(resolved).toBe(file);
    expect(existsSync(resolved)).toBe(true);
  });

  it("falls back to the canonical path when nothing is found anywhere", () => {
    const dir = tempDir();
    const resolved = resolveManifestPath(dir, "nope");
    expect(typeof resolved).toBe("string");
    expect(existsSync(resolved)).toBe(false);
  });
});
