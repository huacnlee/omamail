// @ts-check

// Everything the reader draws that is not the message: the two tones it needs
// beyond the theme's own roles, the line above a message saying why it does not
// look the way its sender meant it to, and the two panes that stand in for a
// message — one before any is picked, one while one is on its way.

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { Button, alpha, mix, role, style } from "omarchy-ui";
import { icon } from "./icons.js";

/**
 * Secondary text. The theme already derives it — `muted_foreground` is the
 * foreground mixed a third of the way toward the ground — so this is a name for
 * the role rather than a second derivation of it.
 * @param {import("gpui").Context} cx
 */
export const dimColor = (cx) => cx.theme().colors.muted_foreground;

/**
 * A third tone under that one, for the facts beside a fact: an attachment's
 * size beside its name, a guest's answer beside their name. Mixed toward the
 * *background* rather than darkened, which is the rule that keeps "dimmer" from
 * coming out heavier than body text on a light theme.
 * @param {import("gpui").Context} cx
 */
export const dimmerColor = (cx) =>
  mix(cx.theme().colors.foreground, cx.theme().colors.background, 0.55);

/**
 * The kit's idle surface: the control's own colour at the theme's normal fill
 * alpha, never a literal gray. `Style.normalFillFor` in the shell.
 * @param {import("gpui").Context} cx
 */
export const normalFill = (cx) =>
  alpha(cx.theme().colors.foreground, style().state.normalFillAlpha);

/**
 * A line above the message saying why it does not look the way the sender meant
 * it to, and offering the one thing that would change that.
 *
 * There are five of these and they stack, which is the reason this is one
 * function rather than five near-identical rows: they have to be the same
 * height, the same fill and the same distance apart, or a message that trips
 * two of them looks like a bug rather than like two answers to two questions.
 *
 * @param {string} id
 * @param {{text:string, actionLabel?:string, busy?:boolean, busyLabel?:string, onActivate?:(event:any,cx:import("gpui").Context)=>void}} notice
 * @param {import("gpui").Context} cx
 */
export function readerNotice(id, notice, cx) {
  const tokens = style();
  const busy = notice.busy === true;
  const actionLabel =
    busy && notice.busyLabel ? notice.busyLabel : (notice.actionLabel ?? "");
  const onActivate = notice.onActivate;
  return h_flex()
    .id(id)
    .flex_none()
    .w_full()
    .items_center()
    .h(tokens.space(30))
    .pl(tokens.space(10))
    .pr(tokens.space(8))
    .gap(tokens.space(6))
    .rounded(tokens.cornerRadius)
    .bg(normalFill(cx))
    .border(tokens.state.normalBorderWidth)
    .border_color(cx.theme().colors.border)
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(tokens.font.caption)
        .text_color(dimColor(cx))
        .child(notice.text),
    )
    .when(Boolean(actionLabel) && typeof onActivate === "function", (row) =>
      row.child(
        // Narrower than the kit's default control padding on purpose: this
        // button lives inside a thirty-pixel line, not on a toolbar.
        new Button(`${id}-action`)
          .label(actionLabel)
          .disabled(busy)
          .size("xsmall")
          .onClick((event, eventCx) => onActivate?.(event, eventCx))
          .build(cx)
          .flex_none()
          .px(tokens.space(8))
          .py(tokens.space(2)),
      ),
    );
}

// The keys that do something the moment the reader is empty. Not every
// shortcut — the ones a hand already on the keyboard can use without learning
// anything first.
const LEGEND = [
  { key: "j / k", action: "Move through the list" },
  { key: "Enter or o", action: "Open the selected message" },
  { key: "e", action: "Archive" },
  { key: "d", action: "Move to trash" },
  { key: "r", action: "Reply" },
  { key: "c", action: "Compose" },
];

/**
 * What the reader shows before a message is picked.
 *
 * An empty pane is a chance to teach, not to decorate: this says which mailbox
 * is open and how much is in it, then lists the keys that do something right
 * now.
 *
 * The QML dropped the legend below three hundred pixels of height. gpui gives a
 * render no measured size to test, so it stays and the column shrinks instead.
 * @param {{label?:string, searchQuery?:string, loading?:boolean, empty?:boolean}} mailbox
 * @param {import("gpui").Context} cx
 */
export function readerBlankSlate(mailbox, cx) {
  const tokens = style();
  const searching = Boolean(mailbox.searchQuery);
  const empty = mailbox.empty === true;
  const heading = searching
    ? `"${mailbox.searchQuery}"`
    : mailbox.label || "Inbox";
  const line = mailbox.loading
    ? "Fetching the mailbox"
    : empty
      ? searching
        ? "Nothing matches that search"
        : "Nothing here"
      : "Pick a message to read it";
  return v_flex()
    .id("reader-blank")
    .flex_1()
    .min_h_0()
    .items_center()
    .justify_center()
    .p(tokens.space(24))
    .child(
      v_flex()
        .id("reader-blank-column")
        .w_full()
        .max_w(tokens.space(340))
        .items_center()
        .gap(tokens.space(10))
        .child(
          // The two-tone mark: an envelope in the panel's own quiet tone with
          // the M in the accent. Two files stacked, because gpui paints an SVG
          // as one mask and nothing inside a file can carry its own colour.
          icon("gmail", cx, {
            size: tokens.space(44),
            color: alpha(dimColor(cx), 0.5),
            mark: true,
          }),
        )
        .child(div().flex_none().h(tokens.space(4)))
        .child(
          div()
            .id("reader-blank-heading")
            .w_full()
            .text_center()
            .truncate()
            .text_size(tokens.font.subtitle)
            .font_bold()
            .text_color(cx.theme().colors.foreground)
            .child(heading),
        )
        .child(
          div()
            .id("reader-blank-line")
            .w_full()
            .text_center()
            .text_size(tokens.font.bodySmall)
            .text_color(dimColor(cx))
            .child(line),
        )
        .when(!empty, (column) =>
          column
            .child(
              // `Item { height: Style.space(14) }` with the rule centred in it,
              // and a `PanelSeparator` rather than a control border: this
              // divides two parts of one pane, it does not frame a control.
              h_flex()
                .flex_none()
                .w_full()
                .h(tokens.space(14))
                .items_center()
                .justify_center()
                .child(
                  div()
                    .flex_none()
                    .w(tokens.space(60))
                    .h(tokens.spacing.hairline)
                    .bg(role("separator", cx.theme().colors.border)),
                ),
            )
            .child(
              v_flex()
                .id("reader-blank-legend")
                .w_full()
                .gap(tokens.space(3))
                .children(
                  LEGEND.map((entry) =>
                    h_flex()
                      .id(`reader-blank-key-${entry.key}`)
                      .w_full()
                      .flex_none()
                      .h(tokens.space(17))
                      .items_center()
                      .child(
                        div()
                          .flex_1()
                          .min_w_0()
                          .text_right()
                          .pr(tokens.space(12))
                          .text_size(tokens.font.caption)
                          .text_color(dimColor(cx))
                          .child(entry.key),
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w_0()
                          .truncate()
                          .text_size(tokens.font.caption)
                          .text_color(dimmerColor(cx))
                          .child(entry.action),
                      ),
                  ),
                )
                .child(div().flex_none().h(tokens.space(6)))
                .child(
                  div()
                    .w_full()
                    .text_center()
                    .text_size(tokens.font.caption)
                    .text_color(dimmerColor(cx))
                    .child("Ctrl+K for every shortcut"),
                ),
            ),
        ),
    );
}

// Subject over sender over meta, then paragraphs of a few lines each with a
// short last line: the shape of the thing that is coming, so the pane does not
// jump when the real message lands. A zero is the gap between paragraphs.
const SKELETON_BODY = [
  0.96, 0.99, 0.72, 0, 0.94, 0.88, 0.97, 0.54, 0, 0.92, 0.63,
];

/**
 * What the reader shows while a message is on its way. A word like "Opening…"
 * tells the reader nothing they did not already know from clicking.
 *
 * The QML pulsed one animation across every bar. gpui redraws on `notify`
 * rather than on a frame clock, so the bars sit at that animation's midpoint
 * instead — the shape is what does the work here, not the movement.
 * @param {string} id
 * @param {import("gpui").Context} cx
 */
export function readerSkeleton(id, cx) {
  const tokens = style();
  const barColor = alpha(cx.theme().colors.foreground, 0.06 + 0.05 * 0.5);
  /** @param {number} widthFactor @param {number} barHeight */
  const bar = (widthFactor, barHeight) =>
    div()
      .flex_none()
      .w(/** @type {`${number}%`} */ (`${Math.round(widthFactor * 100)}%`))
      .h(barHeight)
      .rounded(tokens.cornerRadius)
      .bg(barColor);
  return v_flex()
    .id(id)
    .flex_1()
    .min_h_0()
    .overflow_hidden()
    .p(tokens.space(14))
    .gap(tokens.space(8))
    .child(bar(0.82, tokens.space(13)))
    .child(bar(0.46, tokens.space(13)))
    .child(div().flex_none().h(tokens.space(4)))
    .child(bar(0.38, tokens.space(9)))
    .child(bar(0.52, tokens.space(8)))
    .child(div().flex_none().h(tokens.space(10)))
    .child(
      div()
        .flex_none()
        .w_full()
        .h(tokens.spacing.hairline)
        .bg(role("separator", cx.theme().colors.border)),
    )
    .child(div().flex_none().h(tokens.space(6)))
    .children(
      SKELETON_BODY.map((widthFactor, index) =>
        widthFactor === 0
          ? div().flex_none().h(tokens.space(10))
          : // `Item { implicitHeight: Style.space(15) }` around a bar of eight:
            // the line's pitch is the line's, not the bar's, so the paragraphs
            // are as far apart as the message that replaces them.
            div()
              .id(`${id}-line-${index}`)
              .flex_none()
              .w_full()
              .h(tokens.space(15))
              .child(bar(widthFactor, tokens.space(8))),
      ),
    );
}
