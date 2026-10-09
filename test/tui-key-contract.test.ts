/**
 * Contract pins for the key layer the whole UI stands on (pi-tui 1.1.0).
 *
 * Every surface in this fork — the FleetView bar's input listener, the agent
 * hub's two-pane chat, the conversation viewer's bindings — matches raw byte
 * sequences by name via `matchesKey`, and filters kitty key-release events via
 * `isKeyRelease`. The unit tests for those surfaces feed `handleInput`
 * directly, so a pi-tui upgrade that changes delivery semantics (a renamed
 * sequence, a different kitty encoding, release filtering) breaks the UI at
 * runtime while the suite stays green. These few assertions fail loudly there
 * first — the encodings below are the exact ones pi-tui 1.1.0 delivers, as
 * verified empirically against the installed package.
 */
import { describe, expect, it } from "vitest";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

describe("pi-tui key contract", () => {
  it("legacy escape sequences match their key names", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true);
    expect(matchesKey("\x1b[B", "down")).toBe(true);
    expect(matchesKey("\x1b[D", "left")).toBe(true);
    expect(matchesKey("\x1b", "escape")).toBe(true);
    expect(matchesKey("\x0f", "ctrl+o")).toBe(true);
    // Letters must keep matching too — the surfaces that survived the
    // input-eating regression did so because plain letters were never
    // consumed as activators.
    expect(matchesKey("x", "x")).toBe(true);
  });

  it("kitty-protocol encodings match the same names", () => {
    expect(matchesKey("\x1b[1;1A", "up")).toBe(true);
    expect(matchesKey("\x1b[1;1B", "down")).toBe(true);
    expect(matchesKey("\x1b[27u", "escape")).toBe(true);
    expect(matchesKey("\x1b[111;5u", "ctrl+o")).toBe(true);
  });

  it("key releases are distinguishable from presses", () => {
    // The fleet bar acts on press only; a release double-fires every tap.
    expect(isKeyRelease("\x1b[1;1:3B")).toBe(true);
    expect(isKeyRelease("\x1b[111;1:3u")).toBe(true);
    expect(isKeyRelease("\x1b[B")).toBe(false);
  });
});
