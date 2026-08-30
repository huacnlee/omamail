// @ts-check

import { style } from "../lib/omarchy-ui/style.js";

// The window's shape, ported from `App.qml`.
//
// Two breakpoints, not a continuum: three columns, list-plus-reader with the
// sidebar collapsed to a strip, and a single column that swaps list for
// reader.
//
// Every number below is the pixel value the QML names, and every one of them
// goes through `Style.space()` at the moment it is asked for rather than being
// frozen into a constant at import time: the spacing scale follows the
// desktop's font size, and a breakpoint measured before the theme loaded is a
// breakpoint measured in the wrong unit.

/** Three columns: the sidebar stands open beside the list and the reader. */
export const MAIL_WIDE_WIDTH = 1000;
/** Also the window's minimum size, so nothing narrower is a resize accident. */
export const MAIL_COMPACT_WIDTH = 760;
/**
 * The open sidebar. Narrow on purpose: the longest mailbox name is "All mail",
 * which at 11px monospace needs about 116px including the icon, the gaps and a
 * count, so the rail costs little enough to leave standing.
 */
export const MAIL_RAIL_WIDTH = 148;
/** The same rail as a strip of icons, with the names in the tooltips. */
export const MAIL_RAIL_COLLAPSED_WIDTH = 44;
/** The cap on the list's proportional default. */
export const MAIL_LIST_WIDTH = 460;
/** ...and the proportion itself, which is what the cap caps. */
export const MAIL_LIST_PROPORTION = 0.34;
/**
 * The floor is low on purpose: at a hundred pixels the column is a strip of
 * times and initials, which is a legitimate way to work when the message is
 * what you are reading. Refusing to go there was the app deciding how somebody
 * else should use their screen.
 */
export const MAIL_LIST_MIN_WIDTH = 100;
/** What the list may never take from the message. */
export const MAIL_READER_MIN_WIDTH = 360;
/**
 * A hairline is the right thing to look at and the wrong thing to aim at, so
 * the splitter's grab area is wider than the rule it draws.
 */
export const MAIL_SPLITTER_WIDTH = 5;

/**
 * The window as it is now, not as it was when the process started.
 *
 * `Window::viewport_size` is the only measurement a view can take, and it is
 * legal from `render` precisely so a layout can ask during the pass that draws
 * it. A screen that kept the width it was constructed with lays itself out for
 * a window that is no longer there the moment one is resized — which is what the
 * shortcut sheet was doing.
 * @param {number} [fallbackWidth] what to use where there is no window: a node
 *   test, or a host that predates the call
 * @param {number} [fallbackHeight]
 */
export function viewportSize(fallbackWidth = 1024, fallbackHeight = 768) {
  const host = /** @type {any} */ (
    typeof window !== "undefined" ? window : undefined
  );
  if (typeof host?.viewport_size !== "function")
    return { width: Number(fallbackWidth) || 0, height: Number(fallbackHeight) || 0 };
  const size = host.viewport_size();
  return {
    width: Number(size.width) || Number(fallbackWidth) || 0,
    height: Number(size.height) || Number(fallbackHeight) || 0,
  };
}

/**
 * Proportional until somebody drags the divider, then whatever they dragged it
 * to — clamped so neither column can squeeze the other out.
 * @param {number} available the width the body has to divide
 * @param {number} dragged 0 for "proportional"; anything else is a width
 *   somebody dragged to
 */
function listWidthFor(available, dragged) {
  const { space } = style();
  const preferred =
    dragged > 0
      ? dragged
      : Math.min(
          space(MAIL_LIST_WIDTH),
          Math.round(available * MAIL_LIST_PROPORTION),
        );
  return Math.max(
    space(MAIL_LIST_MIN_WIDTH),
    Math.min(available - space(MAIL_READER_MIN_WIDTH), preferred),
  );
}

/**
 * What the window puts on screen at this width.
 *
 * @param {number} width the window's width, in the units `Style.space` returns
 * @param {boolean} [readerOpen] whether a message is being read, which is the
 *   only thing that decides the single column's contents
 * @param {{sidebarCollapsed?: boolean, listWidth?: number}} [preferences] what the
 *   person using the window has said they want: the service holds both, because
 *   the service is what outlives the window
 */
export function mailLayout(width, readerOpen = false, preferences = {}) {
  const { space } = style();
  const available = Math.max(0, Number(width) || 0);
  const compact = available < space(MAIL_COMPACT_WIDTH);
  const wide = available >= space(MAIL_WIDE_WIDTH);
  // Collapsed because somebody asked for it, or because between the two
  // breakpoints there is no room for a name beside every icon. Asking is a
  // preference and survives the window growing back; the breakpoint is not
  // written anywhere and stops applying the moment there is room again.
  const sidebarCollapsed = preferences.sidebarCollapsed === true || !wide;
  const dragged = Math.max(0, Number(preferences.listWidth) || 0);
  return {
    /** @type {"wide" | "split" | "single"} */
    mode: compact ? "single" : wide ? "wide" : "split",
    // The two breakpoints themselves, for the chrome that answers to them
    // rather than to a column: the search field, the sidebar's own toggle.
    compact,
    wide,
    // The rail goes entirely at the compact breakpoint rather than shrinking
    // again: below it the window has one column, and a strip of icons beside a
    // single column is a second column.
    showRail: !compact,
    sidebarCollapsed,
    sidebarWidth: space(
      sidebarCollapsed ? MAIL_RAIL_COLLAPSED_WIDTH : MAIL_RAIL_WIDTH,
    ),
    // Narrow windows lose the sidebar; the same mailboxes come back as a
    // scrolling strip above the list.
    showTabs: compact && !readerOpen,
    showList: !compact || !readerOpen,
    listWidth: compact ? available : listWidthFor(available, dragged),
    showSplitter: !compact,
    // A window with room for both keeps the reader standing even with nothing
    // in it: the blank pane is where the next message will appear, and a column
    // that comes and goes under the pointer is worse than an empty one.
    showReader: !compact || readerOpen,
  };
}
