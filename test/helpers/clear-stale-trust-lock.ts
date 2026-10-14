/**
 * Removes a stale pi trust lock before any worker spawns.
 *
 * pi-coding-agent's `acquireTrustLockSync` retries an ELOCKED trust lock in a
 * `Date.now()` busy-wait. Under vitest fake timers the clock is frozen, so one
 * retry iteration never returns and the worker spins at 100% CPU forever
 * instead of giving up after ~200ms. The lock is only left stale when a
 * previous run is killed mid-trust-read, which is exactly the situation a
 * heavy suite invites. `globalSetup` runs once in the main process before any
 * worker exists, so removing the file here cannot race a live holder.
 *
 * The real fix belongs upstream (a clock-mock-immune `Atomics.wait` sleep, or
 * no sleep at all); this only removes the trigger in this repo's runs.
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export default function clearStaleTrustLock(): void {
  try {
    unlinkSync(join(getAgentDir(), "trust.json.lock"));
  } catch {
    // No lock (the normal case) or an unreadable agent dir — nothing to do.
  }
}
