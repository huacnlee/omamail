// @ts-check

// Omamail's own mark and name.
//
// This is the one part of the window's chrome no library can own: `omarchy-ui`
// supplies the shapes an Omarchy application is built from, and what the
// application is *called* is not one of them.
//
// The name goes when the window is narrow. The mark still says which window
// this is, and at that width the row is needed for the search field.

import { h_flex } from "gpui-base";
import { Title, style } from "omarchy-ui";
import { icon } from "./icons.js";

/**
 * @param {import("gpui").Context} cx
 * @param {{ compact?: boolean }} [options]
 */
export function brandLockup(cx, options = {}) {
  const tokens = style();
  const extent = tokens.font.iconLarge;
  return h_flex()
    .id("application-brand")
    .flex_none()
    .items_center()
    .gap(tokens.space(8))
    .child(
      icon("mail", cx, {
        size: extent,
        color: cx.theme().colors.foreground,
        mark: true,
      }).flex_none(),
    )
    .when(!options.compact, (lockup) =>
      lockup.child(new Title("Omamail").build(cx).flex_none()),
    );
}
