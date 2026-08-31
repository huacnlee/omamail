// @ts-check

// The two controls that carry a glyph from this application's own icon set.
//
// `omarchy-ui` takes a complete asset path and deliberately resolves nothing:
// choosing a file is the application's job, because the application is what
// knows where its assets live and which of them is the "on" state of another.
// So these supply the path and nothing else — each returns the library's own
// builder, mid-chain, for the caller to finish. There is no second control
// vocabulary here to keep in step with the first.
//
//   actionIcon("mail-refresh", "refresh", "Check mail · F5")
//     .quiet()
//     .onClick(model.onRefresh)
//     .build(cx)

import { Button, IconButton, style } from "omarchy-ui";
import { iconAsset } from "./icons.js";

/**
 * An icon-only command drawn from the application's icon set.
 *
 * `filled` picks the star's "on" file rather than a second paint, which is the
 * only way a one-colour mask can carry two states.
 *
 * @param {string} id
 * @param {string} name a glyph in `iconNames`
 * @param {string} description the accessible name and the tooltip
 * @param {{ filled?: boolean }} [options]
 */
export function actionIcon(id, name, description, options = {}) {
  return new IconButton(id)
    .icon(iconAsset(name, options))
    .description(description);
}

/**
 * `components/IconTextButton.qml` is pinned to the theme's control height
 * whatever type size it carries, so a row of these lines up with the fields
 * and buttons everywhere else in the window and a smaller label only makes the
 * label smaller. The kit moves a control's box and its type together, which is
 * the right default and the wrong one here — so the height is pinned back
 * after the kit has drawn it, in one place rather than at thirty call sites.
 */
class IconTextButton extends Button {
  /** @param {import("gpui").Context} cx */
  build(cx) {
    return super.build(cx).h(style().spacing.controlHeight);
  }
}

/**
 * A bordered button carrying a glyph beside its label — the shape the compose
 * bar and the reader's action row are built from.
 *
 * Bordered by default because that is what every caller of it wants: a row of
 * these lines up with the fields beside it, and a borderless one in that row
 * reads as a link. `.bordered(false)` still says otherwise.
 *
 * The glyph is optional, so one row can hold a button that has a mark and one
 * that does not without the caller branching: a blank name is a button with a
 * label and nothing else, which is what `Save` beside `Set password` wants.
 *
 * @param {string} id
 * @param {string} name a glyph in `iconNames`, or "" for a label alone
 * @param {string} label
 */
export function iconTextButton(id, name, label) {
  const control = new IconTextButton(id).label(label).bordered().size("small");
  return name ? control.icon(iconAsset(name)) : control;
}
