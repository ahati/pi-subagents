/**
 * window-frame.ts — the window chrome two overlays draw: the agent hub
 * (`agent-hub.ts`, roster and chat pane) and the workflow inspector
 * (`workflow-dialog.ts`, all three levels).
 *
 * Both draw the same window: a `╭───╮` / `╰───╯` box, content rows
 * `│ content │`, and a two-pane split whose three bars partition the width
 * exactly. They arrived at it independently — the hub in strings, the
 * inspector in `WorkflowCardLine` segments plus a second string copy for its
 * log level — so the arithmetic lived in four places and drifted silently.
 * This module is that arithmetic, once:
 *
 * - {@link paneRightWidth} is the bar-partition invariant
 *   (`│` + cell + `│` + cell + `│` = width).
 * - {@link frameEdge} and {@link frameRow} are the window's edges and its
 *   padded content row.
 * - {@link hintLine} is the footer rule: drop hints right-to-left until the
 *   line fits, so the escape hatch always survives and no hint is ever cut in
 *   half.
 * - {@link paneBodyHeight} is the height basis, in viewport percent.
 *
 * The two surfaces stay separate where they differ on purpose: which pane
 * policy picks the left cell's width ({@link leftPaneWidth} is the
 * inspector's, the hub gates on {@link TWO_PANE_MIN_WIDTH} and pins its list
 * column), how each styles a segment, and every key they bind.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The bars that separate the cells of a two-pane row: `│ a │ b │`. */
export const FRAME_BARS = 3;

/**
 * Below this total width a surface drops its side pane rather than squeezing
 * both cells to unreadable. The hub's chat and the inspector's panes share it.
 */
export const TWO_PANE_MIN_WIDTH = 60;

/**
 * The box-drawing glyphs of the window. Both surfaces swap the whole set for
 * ASCII together, so no cell mixes tiers.
 */
export interface PaneBox {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  topTee: string;
  bottomTee: string;
  /** The window's rule ends: `├` / `┤`. */
  leftTee: string;
  rightTee: string;
}

export const UNICODE_PANE_BOX: PaneBox = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  topTee: "┬",
  bottomTee: "┴",
  leftTee: "├",
  rightTee: "┤",
};

/** The ASCII tier, one column per glyph so the bars stay aligned either way. */
export const ASCII_PANE_BOX: PaneBox = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  topTee: "+",
  bottomTee: "+",
  leftTee: "+",
  rightTee: "+",
};

/**
 * The right cell's width, given the left cell's.
 *
 * The invariant every pane row depends on: the three bars plus the two cells
 * total exactly `width`, with `pad` padding columns inside each cell. Both
 * callers derive the right cell from the left one rather than picking two
 * widths, which is what keeps the middle bar in one column across a
 * surface's levels.
 */
export function paneRightWidth(width: number, leftWidth: number, pad = 0): number {
  return Math.max(1, width - leftWidth - FRAME_BARS - 4 * pad);
}

/**
 * Inner width of a left pane that holds short labels.
 *
 * Fixed rather than proportional at usable sizes: the left cell holds a phase
 * title or an agent label and the right holds everything that needs room, so
 * a share of a wide terminal would only pad it. It gives way on a narrow one —
 * capped at a third of the cells so the right keeps twice as much, and at
 * `available - 1` so the right never loses its last column and the frame
 * cannot tear.
 */
export function leftPaneWidth(width: number, maxLeft = 18, pad = 0): number {
  const available = Math.max(2, width - FRAME_BARS - 4 * pad);
  return Math.max(1, Math.min(maxLeft, Math.floor(available / 3), available - 1));
}

/** The window's top or bottom edge: `╭───╮` / `╰───╯` across the whole width. */
export function frameEdge(width: number, box: PaneBox, side: "top" | "bottom"): string {
  const left = side === "top" ? box.topLeft : box.bottomLeft;
  const right = side === "top" ? box.topRight : box.bottomRight;
  return `${left}${box.horizontal.repeat(Math.max(0, width - 2))}${right}`;
}

/**
 * A top or bottom edge with a tee where the two panes meet:
 * `╭ Agents ──┬────╮` / `╰──────────┴────╯`. `leftCellWidth` is the whole left
 * cell — padding included, so it matches what a pane row spends before its
 * bar — and an optional `leftCell` names the pane on the top edge; the rest of
 * both cells is rule.
 */
export function splitEdge(
  width: number,
  leftCellWidth: number,
  box: PaneBox,
  side: "top" | "bottom",
  leftCell = "",
): string {
  const [corner, tee, end] = side === "top"
    ? [box.topLeft, box.topTee, box.topRight]
    : [box.bottomLeft, box.bottomTee, box.bottomRight];
  const left = leftCellWidth - visibleWidth(leftCell);
  const right = Math.max(0, width - leftCellWidth - FRAME_BARS);
  return `${corner}${leftCell}${box.horizontal.repeat(Math.max(0, left))}${tee}${box.horizontal.repeat(right)}${end}`;
}

/**
 * One padded content row: `│ content │`, the content clamped to `width - 4`
 * so the bars stay in their columns and the row never wraps. `border` stylizes
 * the bars, which each surface does with its own theme.
 */
export function frameRow(
  width: number,
  content: string,
  box: PaneBox,
  border: (s: string) => string,
  ellipsis = "…",
): string {
  const inner = Math.max(0, width - 4);
  const clamped = truncateToWidth(content, inner, ellipsis, true);
  const gap = Math.max(0, inner - visibleWidth(clamped));
  return `${border(box.vertical)} ${clamped}${" ".repeat(gap + 1)}${border(box.vertical)}`;
}

/**
 * A footer, fitted to `width`: hints are dropped from the right until the line
 * fits, so the last hint standing is never cut in half and the essential keys
 * — the way out, above all — survive. Only when a single hint is already too
 * wide does the result get truncated.
 */
export function hintLine(keys: readonly string[], width: number, joiner = "·"): string {
  const kept = [...keys];
  let line = kept.join(joiner);
  while (kept.length > 1 && visibleWidth(line) > width) {
    kept.pop();
    line = kept.join(joiner);
  }
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/**
 * The rows a window draws around its panes — top and bottom edges, the header
 * rows, the two rules and the footer — for a window whose body falls under
 * `viewportPct` of the terminal. The inspector's `WINDOW_CHROME_ROWS`.
 */
export const WINDOW_CHROME_ROWS = 7;

/**
 * Rows a window may draw between its edges, from the share of the terminal its
 * overlay occupies.
 *
 * `chromeRows` is what the window spends on its own frame — borders, headers,
 * rules, the footer — so the whole window lands under the same viewport
 * ceiling the overlay host clips at, rather than losing its bottom edge to it.
 */
export function paneBodyHeight(options: {
  terminalRows: number | undefined;
  viewportPct: number;
  chromeRows: number;
  min: number;
  fallbackRows: number;
}): number {
  const { terminalRows } = options;
  if (terminalRows === undefined) return options.fallbackRows;
  return Math.max(
    options.min,
    Math.floor((terminalRows * options.viewportPct) / 100) - options.chromeRows,
  );
}
