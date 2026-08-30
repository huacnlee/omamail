// @ts-check

import { svg } from "gpui";
import { Button, Input, h_flex, v_flex } from "gpui-base";
import { label, muted } from "./layout.js";
import { alpha, style } from "./style.js";

// gpui's colour vocabulary is a theme token or a hex literal; there is no
// "transparent" keyword, so the absence of a fill is a fully transparent one.
const NO_FILL = /** @type {import("gpui").Color} */ ("#00000000");

/**
 * The kit's state fills, resolved against the live palette.
 *
 * Every fill and border in Omarchy is the control's own colour at one of the
 * theme's alphas — never a literal gray. That is what lets one set of controls
 * sit on a black desktop and a white one without a second palette: the same
 * 0.08 over each ground reads as the same "hover" to the eye.
 * @param {import("gpui").Context} cx
 * @param {string} [color] the control's own colour; defaults to the foreground
 */
function surfaceStates(cx, color) {
  const state = style().state;
  const own = color || cx.theme().colors.foreground;
  return {
    normalFill: alpha(own, state.normalFillAlpha),
    hoverFill: alpha(own, state.hoverFillAlpha),
    selectedFill: alpha(own, state.selectedFillAlpha),
    pressedFill: alpha(own, state.pressedFillAlpha),
    normalBorder: alpha(own, state.normalBorderAlpha),
    hoverBorder: alpha(own, state.hoverBorderAlpha),
    selectedBorder: alpha(own, state.selectedBorderAlpha),
    borderWidth: state.normalBorderWidth,
    selectedBorderWidth: state.selectedBorderWidth,
  };
}

/**
 * The button. One control for every clickable thing in the kit, matching
 * `qs.Ui/Button.qml`: transparent when idle unless `bordered`, and painted by
 * state in the order pressed > selected > hover > idle.
 *
 * There is deliberately no accent-filled "primary" variant. Omarchy's kit has
 * none: a solid accent block is louder than anything else on the desktop, and
 * the accent is reserved for the small marks that carry state — the unread
 * dot, the focus ring, a selected row.
 *
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ variant?: "secondary" | "danger", disabled?: boolean, selected?: boolean, bordered?: boolean, tooltip?: string, fontSize?: number, iconName?: string, color?: import("gpui").Color }} [options]
 */
export function button(id, caption, onClick, cx, options = {}) {
  const {
    variant = "secondary",
    disabled = false,
    selected = false,
    bordered = false,
    tooltip = "",
    fontSize,
    iconName = "",
    color,
  } = options;
  const tokens = style();
  // `color` is for a button the QML gives a tone of its own — a borderless
  // Discard in the dim colour, a back arrow that is quieter than the page it
  // leaves. It paints the glyph as well as the label, which `.text_color()` on
  // the returned element cannot reach.
  const foreground =
    color ??
    (variant === "danger"
      ? cx.theme().colors.destructive
      : cx.theme().colors.foreground);
  const states = surfaceStates(cx, foreground);

  return Button.new(id)
    .disabled(disabled)
    .selected(selected)
    .flex()
    .items_center()
    .justify_center()
    .gap(tokens.spacing.md)
    .px(tokens.spacing.controlPaddingX)
    .py(tokens.spacing.controlPaddingY)
    .rounded(tokens.cornerRadius)
    // The border is always *reserved*, and only its colour changes. A ghost
    // button that grows one by adding it on hover gains a pixel a side and
    // shoves its neighbours along the row — `qs.Ui/Button.qml` reserves the
    // widest border any of its states can paint for exactly this reason.
    .border(states.borderWidth)
    .border_color(
      selected
        ? states.hoverBorder
        : bordered
          ? states.normalBorder
          : NO_FILL,
    )
    .bg(
      selected
        ? states.selectedFill
        : bordered
          ? states.normalFill
          : NO_FILL,
    )
    .text_size(fontSize ?? tokens.font.body)
    .text_color(foreground)
    .when(Boolean(tooltip), (element) => element.tooltip(tooltip))
    .when(Boolean(iconName), (element) =>
      element.child(
        svg(iconAsset(iconName))
          .flex_none()
          .size(tokens.font.iconSmall)
          .text_color(foreground),
      ),
    )
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((appearance) =>
        appearance.bg(states.hoverFill).border_color(states.hoverBorder),
      ),
    )
    .when(!disabled, (element) =>
      element.active((appearance) => appearance.bg(states.pressedFill)),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(caption);
}

/**
 * A bordered button carrying a drawn icon beside its label — the shape the
 * compose bar and the reader's action row are built from. Pinned to the
 * theme's control height so a row of them lines up with the fields beside it.
 * @param {string} id
 * @param {string} iconName
 * @param {string} caption
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean, bordered?: boolean, tooltip?: string, variant?: "secondary" | "danger", color?: import("gpui").Color }} [options]
 */
export function iconTextButton(id, iconName, caption, onClick, cx, options = {}) {
  const tokens = style();
  return button(id, caption, onClick, cx, {
    ...options,
    iconName,
    bordered: options.bordered ?? true,
    fontSize: tokens.font.bodySmall,
  }).h(tokens.spacing.controlHeight);
}

/**
 * The asset path for a drawn icon. gpui paints an SVG as a single mask in the
 * element's text colour, so a filled state is a different file rather than a
 * different paint — which is why choosing between them belongs here and not at
 * every call site.
 * @param {string} name @param {{filled?: boolean}} [options]
 */
function iconAsset(name, options = {}) {
  const file = options.filled && name === "star" ? "star-filled" : name;
  return `assets/icons/${file}.svg`;
}

/**
 * Shared icon-only command presentation, matching `components/IconButton.qml`:
 * a square touch target with the fill inset from its edge, so a row of them
 * reads as icons with breathing room rather than as a strip of tiles.
 * @param {string} id
 * @param {any} content
 * @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean, color?: import("gpui").Color, hoverColor?: import("gpui").Color, size?: import("gpui").Length }} options
 */
function compactCommand(id, content, description, onClick, cx, options) {
  const { disabled = false, selected = false, color } = options;
  // `IconButton.qml` lifts the glyph to the hover colour as well as painting a
  // fill: the icons sit in the dim tone at rest, and a fill alone under a dim
  // glyph reads as a smudge rather than as the icon coming forward.
  const hoverColor = options.hoverColor ?? cx.theme().colors.foreground;
  const tokens = style();
  const foreground = color || cx.theme().colors.foreground;
  const states = surfaceStates(cx, foreground);
  // IconButton.qml: `max(space(24), iconSize + spacing.sm * 2)`, with the
  // painted surface inset by 2 so the hit area stays larger than the fill.
  const extent =
    options.size ??
    Math.max(tokens.space(24), tokens.font.icon + tokens.spacing.sm * 2);
  return Button.new(id)
    .disabled(disabled)
    .selected(selected)
    .accessibility_label(description)
    .tooltip(description)
    .flex()
    .items_center()
    .justify_center()
    .flex_none()
    .size(extent)
    .p(tokens.space(2))
    .rounded(tokens.cornerRadius)
    .bg(selected ? states.selectedFill : NO_FILL)
    .text_color(selected ? hoverColor : foreground)
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((appearance) =>
        appearance.bg(states.hoverFill).text_color(hoverColor),
      ),
    )
    .when(!disabled, (element) =>
      element.active((appearance) => appearance.bg(states.pressedFill)),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(content);
}

/**
 * @param {string} id
 * @param {string} asset a path under the application's asset root
 * @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean, color?: import("gpui").Color, hoverColor?: import("gpui").Color, size?: import("gpui").Length, iconSize?: import("gpui").Length }} [options]
 */
export function iconButton(id, asset, description, onClick, cx, options = {}) {
  return compactCommand(
    id,
    svg(asset)
      .size(options.iconSize ?? style().font.icon)
      .flex_none(),
    description,
    onClick,
    cx,
    options,
  );
}

/**
 * An icon-only command drawn from the app's own icon set.
 * @param {string} id @param {string} name @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean, color?: import("gpui").Color, hoverColor?: import("gpui").Color, size?: import("gpui").Length, iconSize?: import("gpui").Length, filled?: boolean }} [options]
 */
export function actionButton(id, name, description, onClick, cx, options = {}) {
  return compactCommand(
    id,
    // No colour on the glyph itself: it inherits the button's, which is what
    // lets the hover state lift it out of the dim tone.
    svg(iconAsset(name, { filled: options.filled }))
      .size(options.iconSize ?? style().font.icon)
      .flex_none(),
    description,
    onClick,
    cx,
    options,
  );
}

/**
 * @param {string} id @param {string} glyph @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean }} [options]
 */
export function glyphButton(id, glyph, description, onClick, cx, options = {}) {
  return compactCommand(id, glyph, description, onClick, cx, options);
}

/** @param {import("gpui-base").InputState} state @param {import("gpui").Context} cx */
export const field = (state, cx) => {
  const tokens = style();
  const states = surfaceStates(cx);
  return Input.new(state)
    .flex_1()
    .h(tokens.spacing.controlHeight)
    .px(tokens.spacing.controlPaddingX)
    .py(tokens.spacing.inputPaddingY)
    .rounded(tokens.cornerRadius)
    .border(states.borderWidth)
    .border_color(states.normalBorder)
    .bg(states.normalFill)
    .text_size(tokens.font.body)
    .text_color(cx.theme().colors.foreground)
    .hover((appearance) =>
      appearance.bg(states.hoverFill).border_color(states.hoverBorder),
    )
    .focus((appearance) =>
      appearance.bg(states.hoverFill).border_color(states.hoverBorder),
    );
};

/**
 * A horizontal field row for compact editor headers.
 * @param {string} id
 * @param {string} caption
 * @param {any} control
 * @param {import("gpui").Context} cx
 */
export const fieldRow = (id, caption, control, cx) => {
  const tokens = style();
  return h_flex()
    .id(id)
    .flex_none()
    .items_center()
    .gap(tokens.spacing.controlGap)
    .px(tokens.spacing.panelPadding)
    .py(tokens.spacing.xs)
    .border_b(tokens.spacing.hairline)
    .border_color(cx.theme().colors.border)
    .child(
      h_flex()
        .w(tokens.space(52))
        .flex_none()
        .child(label(caption, cx).text_color(cx.theme().colors.muted_foreground)),
    )
    .child(control);
};

/**
 * A stacked labeled control for settings and setup forms.
 * @param {string} id
 * @param {string} caption
 * @param {any} control
 * @param {import("gpui").Context} cx
 * @param {string} [helper]
 */
export const formField = (id, caption, control, cx, helper = "") => {
  const tokens = style();
  return v_flex()
    .id(id)
    .min_w_0()
    .gap(tokens.spacing.labelGap)
    .child(label(caption, cx))
    .child(control)
    .when(Boolean(helper), (element) =>
      element.child(muted(helper, cx).text_size(tokens.font.bodySmall)),
    );
};

/**
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ detail?: string, danger?: boolean, disabled?: boolean, iconName?: string, selected?: boolean, cursor?: boolean, dim?: boolean }} [options]
 */
export function menuItem(id, caption, onClick, cx, options = {}) {
  const {
    detail = "",
    danger = false,
    disabled = false,
    iconName = "",
    selected = false,
    // Where the keyboard is standing, which is not the same as what is chosen.
    // `MenuActionRow.qml` draws it as hover's own fill and nothing else — the
    // border belongs to `AccountSwitcher.qml`, whose rows carry an avatar and
    // two lines and need the extra edge to read as one row. Giving a menu row
    // a border made an open menu look like it had a button pressed in it.
    cursor = false,
    dim = false,
  } = options;
  const tokens = style();
  // `dim` is for a row that leaves the app — it still belongs on the menu, but
  // it is not one of the verbs the menu is mostly for.
  const foreground = danger
    ? cx.theme().colors.destructive
    : dim
      ? cx.theme().colors.muted_foreground
      : cx.theme().colors.foreground;
  const states = surfaceStates(cx, foreground);
  return Button.new(id)
    .role("menu_item")
    .disabled(disabled)
    .flex()
    .items_center()
    .justify_between()
    .w_full()
    .h(tokens.spacing.popupRowHeight)
    .gap(tokens.spacing.controlGap)
    .px(tokens.space(9))
    .rounded(tokens.cornerRadius)

    .bg(
      selected
        ? states.selectedFill
        : cursor
          ? states.hoverFill
          : NO_FILL,
    )
    .text_size(tokens.font.bodySmall)
    .text_color(foreground)
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((appearance) => appearance.bg(states.hoverFill)),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(
      h_flex()
        .items_center()
        .gap(tokens.spacing.md)
        .min_w_0()
        .when(Boolean(iconName), (element) =>
          element.child(
            svg(iconAsset(iconName))
              .flex_none()
              .size(tokens.font.iconSmall)
              .text_color(foreground),
          ),
        )
        .child(label(caption, cx).text_color(foreground).truncate()),
    )
    .when(Boolean(detail), (element) =>
      element.child(
        muted(detail, cx).flex_none().text_size(tokens.font.bodySmall),
      ),
    );
}

/**
 * A one-pixel rule between rows or regions — `Ui/PanelSeparator.qml`.
 *
 * The foreground at 0.12, which is deliberately fainter than a control's
 * border: the shell gives normal chrome 0.4, and a group boundary drawn at
 * that weight competes with the buttons and fields on either side of it.
 * @param {import("gpui").Context} cx
 */
export const separator = (cx) =>
  v_flex()
    .flex_none()
    .h(style().spacing.hairline)
    .w_full()
    .bg(alpha(cx.theme().colors.foreground, 0.12));

/**
 * A rule with the air a menu wants around it. The gap is part of the
 * separator rather than the rows' margin, so a group boundary costs the same
 * whichever rows it falls between.
 * @param {import("gpui").Context} cx
 */
export const menuSeparator = (cx) =>
  v_flex()
    .flex_none()
    .h(style().space(7))
    .w_full()
    .justify_center()
    .child(separator(cx));

/**
 * A key cap on the status line. Fill only, no outline: an outlined cap reads
 * as a button you could press, which draws far more attention than a hint
 * deserves. The quiet fill is there to separate the key from its label by
 * shape, which is what lets the pairs sit close together.
 * @param {string} value @param {import("gpui").Context} cx
 */
export const kbd = (value, cx) => {
  const tokens = style();
  const states = surfaceStates(cx);
  return h_flex()
    .flex_none()
    .items_center()
    .justify_center()
    .px(tokens.space(3))
    .py(tokens.space(1))
    .rounded(tokens.cornerRadius)
    .bg(states.normalFill)
    .text_size(tokens.font.caption)
    .text_color(cx.theme().colors.foreground)
    .child(value);
};

/**
 * What the keyboard offers from wherever you are standing. Rendered from the
 * keymap and nothing else — three hand-written copies of this list used to
 * exist and had already drifted apart.
 * @param {Array<{key:string,label:string}>} hints @param {import("gpui").Context} cx
 */
export const keyHints = (hints, cx) => {
  const tokens = style();
  return h_flex()
    .id("key-hints")
    .flex_none()
    .items_center()
    .gap(tokens.space(7))
    .children(
      hints.map((hint) =>
        h_flex()
          .items_center()
          .gap(tokens.space(3))
          .child(kbd(hint.key, cx))
          .child(
            muted(hint.label, cx).text_size(tokens.font.caption).flex_none(),
          ),
      ),
    );
};
