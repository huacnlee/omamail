// The window's responsive rules, as plain functions so they can be tested
// without a window. From App.qml: the mail area is the window less the
// assistant dock; wide from 1000 points, compact below 760. Lengths are
// base-14 points: `scale` (uiScale()) grows them with Omarchy's base size.

export type Mode = "wide" | "medium" | "compact";

export const WIDE_FROM = 1000;
export const COMPACT_BELOW = 760;

// v2 rows are roomier than Qt's (32 tall, 12 inset, a count lane): the
// default and least widths grow from Qt's 148 / 110 so "Unread" and a
// label with its count are not cut at base 14.
export const SIDEBAR = { min: 140, max: 360, default: 184, rail: 44 } as const;
export const LIST = { min: 100, max: 460, share: 0.34, readerMin: 200 } as const;

export function modeFor(windowWidth: number, assistantWidth = 0, scale = 1): Mode {
  const mail = Math.max(0, windowWidth - Math.max(0, assistantWidth));
  // Qt's Style.space(1000) / Style.space(760): they grow with the base size.
  if (mail >= WIDE_FROM * scale) return "wide";
  if (mail < COMPACT_BELOW * scale) return "compact";
  return "medium";
}

/** The sidebar's width: the rail when folded, else the stored width clamped,
 * else the default. */
export function sidebarWidthFor(stored: number, collapsed: boolean, scale = 1): number {
  if (collapsed) return SIDEBAR.rail * scale;
  if (stored > 0) return Math.max(SIDEBAR.min * scale, Math.min(SIDEBAR.max * scale, stored));
  return SIDEBAR.default * scale;
}

/** The list's width beside the reader: proportional until dragged, then the
 * dragged width, always leaving the reader its minimum. */
export function listWidthFor(stored: number, available: number, scale = 1): number {
  const wanted = stored > 0 ? stored : Math.min(LIST.max * scale, Math.round(available * LIST.share));
  return Math.max(LIST.min * scale, Math.min(available - LIST.readerMin * scale, wanted));
}

/** Which body the window shows. */
export type Body = "page" | "compose" | "calendar" | "list" | "reader" | "split";

export interface BodyState {
  mode: Mode;
  showPage: boolean;
  composing: boolean;
  calendarVisible: boolean;
  readerOpen: boolean;
}

export function bodyFor(state: BodyState): Body {
  if (state.showPage) return "page";
  if (state.composing) return "compose";
  if (state.calendarVisible) return "calendar";
  if (state.mode !== "compact") return "split";
  return state.readerOpen ? "reader" : "list";
}

/** The sidebar shows beside the list, the split and the calendar, never in
 * compact mode, on a page or over a draft. */
export function sidebarVisible(state: BodyState): boolean {
  return state.mode !== "compact" && !state.showPage && !state.composing;
}

/** The status bar's sidebar switch follows the sidebar. */
export const railToggleVisible = sidebarVisible;

/** Columns of the shortcut sheet for its width: as many 330-point columns as
 * fit after the margins, one to three. Both lengths grow with the interface
 * scale (Omarchy's base size), as Qt's `Style.space(330)` did. */
export function helpColumnCount(width: number, scale = 1): number {
  return Math.max(1, Math.min(3, Math.floor((width - 60 * scale) / (330 * scale))));
}
