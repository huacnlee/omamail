// @ts-check

import { v_flex } from "gpui-base";
import { label, muted } from "./layout.js";
import { style } from "./style.js";

/** @param {string} heading @param {string} hint @param {import("gpui").Context} cx */
export const emptyState = (heading, hint, cx) => {
  const tokens = style();
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap(tokens.spacing.labelGap)
    .p(tokens.spacing.panelPadding)
    .child(label(heading, cx))
    .child(muted(hint, cx));
};

/**
 * A line of text saying how things stand. Deliberately just text: the status
 * line carries it at the caption size in the dim colour, and a coloured dot
 * beside it would be the loudest thing on a bar whose whole job is to stay
 * quiet. An error takes the urgent colour, which is the one state worth
 * interrupting for — and it is a colour *plus* a different sentence, never
 * colour alone.
 * @param {string} caption
 * @param {"ready" | "loading" | "error"} state
 * @param {import("gpui").Context} cx
 */
export const statusLine = (caption, state, cx) =>
  (state === "error"
    ? label(caption, cx).text_color(cx.theme().colors.destructive)
    : muted(caption, cx)
  )
    .role("status")
    .text_size(style().font.caption);
