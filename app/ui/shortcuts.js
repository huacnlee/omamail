// @ts-check

// The reference sheet behind Ctrl+K.
//
// A plain list over a dimmed window rather than a dialog, because it never
// needs an answer — Esc, Ctrl+K again, or a click puts it away.
//
// **Wide and short, in as many columns as the window has room for.** One narrow
// column is taller than a short window, which makes a reference sheet something
// you have to scroll to read. The split into columns is `Keymap.helpColumns`'s,
// not this file's: balancing it here would put a layout decision in a view, and
// the rule — in order, a heading costs a line as surely as a row does — is
// worth a test.
//
// Every row comes from `keys/keymap.js` and nothing else. Three hand-written
// copies of this list used to exist and had already drifted: the sheet listed
// Esc twice, was missing `u` and `?`, and carried a mouse gesture among the
// keyboard shortcuts.

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { helpColumns } from "../keys/keymap.js";
import { alpha, muted, style } from "../lib/omarchy-ui/index.js";

// How wide one column of keys and their labels wants to be, and how many of
// them a window can hold. Three is the ceiling, as it is in `ShortcutHelp.qml`:
// past that the sheet is wider than it is readable, and the eye has to travel
// further to cross it than to scroll it.
const COLUMN_WIDTH = 330;
const COLUMN_GAP = 28;
const MAX_COLUMNS = 3;
// The keys keep their share of the column rather than a fixed measure: at three
// columns a fixed one left the label no room at all.
const KEY_SHARE = 0.54;
// What separates a key from what it does, on top of that share.
const KEY_GAP = 5;
// One row of the sheet, which is also one step of `j`.
const ROW_HEIGHT = 20;
// What the sheet keeps clear of the window's edges.
const SHEET_PADDING = 20;

/** @param {number} width @param {ReturnType<typeof style>} tokens */
export function columnCount(width, tokens) {
  const usable = Number(width) - tokens.space(60);
  return Math.max(
    1,
    Math.min(MAX_COLUMNS, Math.floor(usable / tokens.space(COLUMN_WIDTH)) || 1),
  );
}

/**
 * How far the sheet can be moved before its last row is on screen.
 *
 * The QML asks its `Flickable` — `contentHeight - height` — and this host has
 * no equivalent: a script can neither scroll a plain scroll container nor
 * measure one. So the height is computed from the table the sheet is drawn
 * from, which is the same arithmetic the layout does: a heading costs a line as
 * surely as a row does, which is `Keymap.helpWeight`, and the tallest column is
 * the sheet.
 * @param {{width?:number,height?:number,available?:ReadonlySet<string>}} model
 */
export function shortcutScrollLimit(model) {
  const tokens = style();
  const count = columnCount(model.width ?? 1024, tokens);
  const columns = helpColumns(count, model.available);
  const tallest = columns.reduce(
    (/** @type {number} */ high, /** @type {any[]} */ groups) =>
      Math.max(
        high,
        groups.reduce(
          (/** @type {number} */ lines, /** @type {any} */ group) =>
            lines + group.rows.length + 1,
          0,
        ) *
          (tokens.space(ROW_HEIGHT) + tokens.spacing.md) +
          // Each group opens with a spacer and the column's own gap on the
          // near side of it, which is what separates one group from the last.
          groups.length * (tokens.spacing.lg + tokens.spacing.md),
      ),
    0,
  );
  // The title band above the columns — its own spacer and the two gaps around
  // it — and the padding below them.
  const content =
    tallest +
    tokens.space(48) +
    tokens.spacing.md * 2 +
    tokens.space(SHEET_PADDING) * 2;
  return Math.max(0, Math.round(content - (Number(model.height) || 0)));
}

/**
 * Where `j` and `k` leave the sheet. One row per step, clamped at both ends —
 * the QML's `scrollBy`, in the units this host can work in.
 * @param {number} offset @param {number} steps
 * @param {{width?:number,height?:number,available?:ReadonlySet<string>}} model
 */
export function shortcutScrollAfter(offset, steps, model) {
  const tokens = style();
  const moved =
    (Number(offset) || 0) + (Number(steps) || 0) * tokens.space(ROW_HEIGHT);
  return Math.max(0, Math.min(shortcutScrollLimit(model), moved));
}

/**
 * `available` is what the window actually answers to. The sheet is a promise
 * about the keyboard, so a row for a key nothing here answers breaks it.
 * @param {{width?:number,height?:number,scrollOffset?:number,
 *   available?:ReadonlySet<string>,focus?:any,
 *   onDismiss?:(event:any,cx:any)=>void,
 *   onScroll?:(steps:number,cx:any)=>void}} model
 * @param {import("gpui").Context} cx
 */
export function renderShortcutSheet(model, cx) {
  const tokens = style();
  const count = columnCount(model.width ?? 1024, tokens);
  const columns = helpColumns(count, model.available);
  const dismiss = model.onDismiss;
  const sheet = v_flex()
    .id("shortcut-sheet")
    .role("dialog")
    .accessibility_label("Keyboard shortcuts")
    .w_full()
    .max_w(
      count * tokens.space(COLUMN_WIDTH) + (count - 1) * tokens.space(COLUMN_GAP),
    )
    .gap(tokens.spacing.md)
    .child(
      div()
        .role("heading")
        .text_size(tokens.font.subtitle)
        .font_bold()
        .text_color(cx.theme().colors.foreground)
        .child("Keyboard shortcuts"),
    )
    // The QML puts a `Style.space(6)` spacer between the title and the columns
    // on top of the column's own spacing, so the heading stands clear of the
    // first group rather than reading as part of it.
    .child(div().flex_none().h(tokens.spacing.md))
    .child(
      h_flex()
        .id("shortcut-columns")
        .w_full()
        .min_w_0()
        .items_start()
        .gap(tokens.space(COLUMN_GAP))
        .children(
          columns.map((/** @type {any[]} */ groups, /** @type {number} */ index) =>
            v_flex()
              .id(`shortcut-column-${index}`)
              .flex_1()
              .min_w_0()
              .gap(tokens.spacing.md)
              .children(
                groups.map((/** @type {any} */ group) =>
                  v_flex()
                    .id(`shortcut-group-${group.name.toLowerCase()}`)
                    .role("group")
                    .accessibility_label(group.name)
                    .w_full()
                    .min_w_0()
                    .gap(tokens.spacing.md)
                    // A heading costs a line as surely as a row does, and the
                    // gap above it is what makes the groups read as groups.
                    // A spacer rather than padding, because that is what the
                    // QML has: the column's own `space(6)` falls on both sides
                    // of it, and padding would swallow one of them.
                    .child(div().flex_none().h(tokens.spacing.lg))
                    .child(
                      muted(group.name, cx)
                        .text_size(tokens.font.caption)
                        .font_bold(),
                    )
                    .children(
                      group.rows.map((/** @type {any} */ row) =>
                        h_flex()
                          .w_full()
                          .min_w_0()
                          .items_center()
                          .h(tokens.space(ROW_HEIGHT))
                          // The QML starts the action at `keys * 0.54 +
                          // space(5)`, so the two never touch when a key
                          // string runs the width of its share.
                          .gap(tokens.space(KEY_GAP))
                          .child(
                            // Plain text rather than key caps: forty filled
                            // caps is a wall, and this sheet is read down the
                            // left edge rather than glanced at the way the
                            // status line's hints are.
                            div()
                              .flex_none()
                              .w(`${KEY_SHARE * 100}%`)
                              .truncate()
                              .text_size(tokens.font.caption)
                              .text_color(cx.theme().colors.foreground)
                              .child(row.keys),
                          )
                          .child(
                            muted(row.action, cx)
                              .flex_1()
                              .min_w_0()
                              .truncate()
                              .text_size(tokens.font.caption),
                          ),
                      ),
                    ),
                ),
              ),
          ),
        ),
    );

  const offset = Math.max(0, Number(model.scrollOffset) || 0);
  const scroll = model.onScroll;
  return v_flex()
    .id("shortcut-help")
    .absolute()
    .inset_0()
    .items_center()
    // Centred while it fits and pinned to the top when it does not, because
    // half of a centred sheet taller than the window is above the top edge and
    // can never be scrolled back down to.
    .when(offset === 0 && shortcutScrollLimit(model) === 0, (overlay) =>
      overlay.justify_center(),
    )
    .p(tokens.space(SHEET_PADDING))
    // The sheet moves rather than the container scrolling. `j` and `k` are
    // handed to the sheet while it is up, and this host gives a script no way
    // to drive a scroll container — so wheel and keyboard drive the one offset
    // instead of one of them working and the other looking as though it does.
    .overflow_hidden()
    // Nearly opaque rather than opaque: the window stays faintly visible, so
    // the sheet reads as something laid over where you were rather than as
    // another screen you have been sent to.
    .bg(alpha(cx.theme().colors.background, 0.96))
    // The sheet is what holds the keyboard while it is up, and that is the whole
    // of `survivesOverlay` here: the screen behind it is off the focus path, so
    // `e`, `d` and `r` cannot fire behind the sheet that documents them.
    .when(Boolean(model.focus), (overlay) => overlay.track_focus(model.focus))
    .when(typeof scroll === "function", (overlay) =>
      overlay.on_scroll_wheel((event, eventCx) =>
        scroll?.(-Math.sign(Number(event.delta?.y) || 0), eventCx),
      ),
    )
    .when(typeof dismiss === "function", (overlay) =>
      overlay.on_click((event, eventCx) => dismiss?.(event, eventCx)),
    )
    .child(sheet.mt(-offset));
}
