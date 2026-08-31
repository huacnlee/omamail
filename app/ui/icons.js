// @ts-check

// The application's icon set: one SVG per glyph, generated from
// `components/ActionIcon.qml` by `scripts/build-icons.mjs` and committed,
// because gpui reads assets from the application directory on disk. That
// directory is this one's parent — `app/`, the one holding `gpui-shell.json` —
// so the files sit in `app/assets/icons` beside the provider artwork and are
// named `assets/icons/<name>.svg`, the way `assets/gmail.svg` already is.
//
// **A glyph is one colour.** gpui draws an SVG as a mask and paints it with the
// element's text colour, so nothing inside the file — a `fill`, a second
// `<path class="mark">` — can carry a colour of its own. The Gmail mark needs
// two, the envelope in the foreground and the M in the accent, so it is two
// files stacked rather than two paths in one: `gmail-envelope.svg` under
// `gmail-mark.svg`, with the plain `gmail.svg` still there for every caller
// that wants the whole glyph in one colour. `star` is filled the same way, by
// asking for a different file rather than a different paint.
//
// The colour is otherwise inherited and deliberately not set here: an icon in a
// selected row or a primary button takes that context's foreground, and one
// that named its own colour would not.

import { div, svg } from "gpui";
import { style } from "omarchy-ui";

const ICON_DIRECTORY = "assets/icons";

/**
 * Every glyph `icon` answers to, which is every name `ActionIcon.qml` draws.
 * `tests/test_icons.mjs` holds this list to the QML and to the files on disk,
 * so a caller can trust a name here to be a file there.
 */
export const iconNames = [
  "reply",
  "replyAll",
  "forward",
  "archive",
  "trash",
  "spam",
  "unread",
  "star",
  "browser",
  "refresh",
  "send",
  "undo",
  "menu",
  "plus",
  "close",
  "back",
  "chevronLeft",
  "chevronRight",
  "chevronDown",
  "eye",
  "eyeOff",
  "inbox",
  "compose",
  "label",
  "gmail",
  "mail",
  "sidebar",
  "check",
  "attachment",
  "calendar",
  "video",
  "pin",
  "people",
];

/**
 * The asset path for a glyph, which is what `iconButton` and anything else
 * taking an asset string wants. The filled star is a file rather than a paint,
 * so choosing between them belongs here and not at every call site.
 * @param {string} name @param {{ filled?: boolean }} [options]
 */
export function iconAsset(name, options = {}) {
  const file = options.filled && name === "star" ? "star-filled" : name;
  return `${ICON_DIRECTORY}/${file}.svg`;
}

/** @param {string} asset @param {import("gpui").Length} size @param {import("gpui").Color} [color] */
function glyph(asset, size, color) {
  const element = svg(asset).flex_none().size(size);
  return color ? element.text_color(color) : element;
}

/**
 * A glyph at the theme's icon size, in the surrounding text colour.
 *
 * `filled` is the star's "on" state and `mark` is the Gmail mark's accent —
 * both of them the variants `ActionIcon` carries, spelled as options because a
 * caller asks for `star` and says it is set, not for a different icon.
 *
 * @param {string} name
 * @param {import("gpui").Context} cx
 * @param {{ size?: import("gpui").Length, color?: import("gpui").Color, filled?: boolean, mark?: boolean | import("gpui").Color }} [options]
 */
export function icon(name, cx, options = {}) {
  const { size = style().font.icon, color, filled = false, mark } = options;

  if (mark && (name === "gmail" || name === "mail")) {
    const accent = mark === true ? cx.theme().colors.primary : mark;
    return div()
      .relative()
      .flex_none()
      .size(size)
      .child(glyph(iconAsset("gmail-envelope"), size, color))
      .child(glyph(iconAsset("gmail-mark"), size, accent).absolute().inset_0());
  }

  return glyph(iconAsset(name, { filled }), size, color);
}
