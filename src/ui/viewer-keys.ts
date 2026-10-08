/**
 * viewer-keys.ts — Key matchers for the conversation viewer.
 *
 * Resolves ids through the user's keybindings when pi provides a manager,
 * falling back to the previous hardcoded keys otherwise. The viewer's k/j and
 * shift+arrow aliases always work alongside whatever is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/**
 * Keybinding ids the viewer resolves. The `tui.select.*` ids drive scrolling;
 * `app.tools.expand` toggles expanded rich tool output — pi's ctrl+o, the key
 * the built-in renderers' own collapsed previews advertise. Pi's production
 * manager always defines the id (its defaults live in the coding-agent's map,
 * not pi-tui's `TUI_KEYBINDINGS`); a manager without it simply never matches,
 * and the no-manager fallback below keeps ctrl+o working in tests and
 * embedded sessions.
 */
export type ViewerKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybindingId): boolean;
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  expand(data: string): boolean;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybindingId, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    expand: (data) => matches(data, "app.tools.expand", "ctrl+o"),
  };
}
