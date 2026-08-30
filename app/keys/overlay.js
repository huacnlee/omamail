// @ts-check

// The shortcut sheet, from the window's side.
//
// The sheet is the one screen that stands over the window rather than replacing
// it: it is a reference for the keys of the screen behind it, and taking that
// screen away to show it would defeat the point. What it costs is a guard, and
// `survivesOverlay` in `keys/keymap.js` is that guard — without it a row goes
// dead while the sheet is up, which is why `e` cannot be left able to archive
// behind it.
//
// `KeyRouter` implements the guard by disabling every Shortcut the table does
// not mark. gpui has no such switch, so the sheet takes the keyboard instead:
// with the focus inside it the mailbox's own context element is off the dispatch
// path and none of its bindings can fire, and the four rows that do survive are
// bound in `Overlay` as well. Two spellings of one rule, and this is the one
// this host can say.

import { HANDLED_ACTIONS } from "./actions.js";
import { focusOverlay, parkKeyboard } from "./focus.js";
import { viewportSize } from "../ui/layout.js";
import { shortcutScrollAfter } from "../ui/shortcuts.js";

/** @param {any} app @param {import("gpui").Context} cx */
export function openShortcuts(app, cx) {
  app.shortcutHelpOpen = true;
  app.shortcutScroll = 0;
  focusOverlay(app);
  cx.notify();
}

/** @param {any} app @param {import("gpui").Context} cx */
export function closeShortcuts(app, cx) {
  app.shortcutHelpOpen = false;
  app.shortcutScroll = 0;
  parkKeyboard(app);
  cx.notify();
}

/**
 * Move the sheet under the keyboard. `cursorDown` and `cursorUp` are handed to
 * it while it is up: a reference sheet taller than the window that could only be
 * read with a mouse would be the one screen here that contradicts the rest.
 * @param {any} app @param {number} steps @param {import("gpui").Context} cx
 */
export function scrollShortcuts(app, steps, cx) {
  app.shortcutScroll = shortcutScrollAfter(
    app.shortcutScroll,
    steps,
    shortcutSheetModel(app),
  );
  cx.notify();
}

/**
 * What the sheet is drawn from: the live window, rather than the width the
 * process started at. A sheet that kept its first measurement laid itself out
 * for a window that is no longer there the moment one is resized.
 * @param {any} app
 */
export function shortcutSheetModel(app) {
  const viewport = viewportSize(app.width);
  return {
    width: viewport.width,
    height: viewport.height,
    // The same set the bindings are installed from, so the sheet says what this
    // window answers to rather than what the table describes.
    available: HANDLED_ACTIONS,
    scrollOffset: app.shortcutScroll,
  };
}
