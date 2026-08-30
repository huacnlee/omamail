// @ts-check

import { svg } from "gpui";
import { Button, Input, h_flex, v_flex } from "gpui-base";
import { label, muted } from "./layout.js";

/** @param {string} variant @param {import("gpui").Context} cx */
function palette(variant, cx) {
  const colors = cx.theme().colors;
  if (variant === "primary") {
    return {
      background: colors.primary,
      foreground: colors.primary_foreground,
      border: colors.primary,
      hover: colors.primary,
    };
  }
  return {
    background: colors.surface,
    foreground: variant === "danger" ? colors.destructive : colors.foreground,
    border: colors.border,
    hover: colors.muted,
  };
}

/**
 * Shared icon-only command presentation. The caller supplies either an SVG or
 * a font glyph so brand marks and functional icons retain distinct sources.
 * @param {string} id
 * @param {any} content
 * @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean }} options
 */
function compactCommand(id, content, description, onClick, cx, options) {
  const { disabled = false, selected = false } = options;
  const colors = cx.theme().colors;
  return Button.new(id)
    .disabled(disabled)
    .selected(selected)
    .accessibility_label(description)
    .tooltip(description)
    .flex()
    .items_center()
    .justify_center()
    .size("2.25rem")
    .rounded(cx.theme().radius.sm)
    .border(1)
    .border_color(selected ? colors.ring : colors.surface)
    .bg(selected ? colors.accent : colors.surface)
    .text_color(selected ? colors.accent_foreground : colors.muted_foreground)
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((style) =>
        style
          .bg(colors.muted)
          .border_color(colors.border)
          .text_color(colors.foreground),
      ),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(content);
}

/**
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ variant?: "primary" | "secondary" | "danger", disabled?: boolean, selected?: boolean }} [options]
 */
export function button(id, caption, onClick, cx, options = {}) {
  const { variant = "secondary", disabled = false, selected = false } = options;
  const colors = cx.theme().colors;
  const tones = palette(variant, cx);
  return Button.new(id)
    .disabled(disabled)
    .selected(selected)
    .flex()
    .items_center()
    .justify_center()
    .h("2.25rem")
    .px(cx.theme().spacing.md)
    .rounded(cx.theme().radius.sm)
    .border(1)
    .border_color(selected ? colors.ring : tones.border)
    .bg(selected ? colors.accent : tones.background)
    .text_size("1rem")
    .text_color(selected ? colors.accent_foreground : tones.foreground)
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((style) => style.bg(tones.hover)),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(caption);
}

/**
 * @param {string} id
 * @param {string} asset
 * @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ disabled?: boolean, selected?: boolean }} [options]
 */
export function iconButton(id, asset, description, onClick, cx, options = {}) {
  return compactCommand(
    id,
    svg(asset).size("0.875rem").flex_none(),
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
export const field = (state, cx) =>
  Input.new(state)
    .flex_1()
    .h("2.25rem")
    .px(cx.theme().spacing.sm)
    .rounded(cx.theme().radius.sm)
    .border(1)
    .border_color(cx.theme().colors.input)
    .bg(cx.theme().colors.surface)
    .text_size("1rem")
    .focus((style) => style.border_color(cx.theme().colors.ring));

/**
 * A horizontal field row for compact editor headers.
 * @param {string} id
 * @param {string} caption
 * @param {any} control
 * @param {import("gpui").Context} cx
 */
export const fieldRow = (id, caption, control, cx) =>
  h_flex()
    .id(id)
    .flex_none()
    .items_center()
    .gap(cx.theme().spacing.md)
    .px(cx.theme().spacing.lg)
    .py(cx.theme().spacing.xs)
    .border_b(1)
    .border_color(cx.theme().colors.border)
    .child(
      h_flex()
        .w("4.5rem")
        .flex_none()
        .child(label(caption, cx).font_semibold()),
    )
    .child(control);

/**
 * A stacked labeled control for settings and setup forms.
 * @param {string} id
 * @param {string} caption
 * @param {any} control
 * @param {import("gpui").Context} cx
 * @param {string} [helper]
 */
export const formField = (id, caption, control, cx, helper = "") =>
  v_flex()
    .id(id)
    .min_w_0()
    .gap(cx.theme().spacing.xs)
    .child(label(caption, cx).font_semibold())
    .child(control)
    .when(Boolean(helper), (field) => field.child(muted(helper, cx)));

/**
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onClick
 * @param {import("gpui").Context} cx
 * @param {{ detail?: string, danger?: boolean, disabled?: boolean }} [options]
 */
export function menuItem(id, caption, onClick, cx, options = {}) {
  const { detail = "", danger = false, disabled = false } = options;
  return Button.new(id)
    .role("menu_item")
    .disabled(disabled)
    .flex()
    .items_center()
    .justify_between()
    .w_full()
    .gap(cx.theme().spacing.md)
    .px(cx.theme().spacing.sm)
    .py(cx.theme().spacing.xs)
    .rounded(cx.theme().radius.sm)
    .border(0)
    .bg(cx.theme().colors.surface)
    .text_color(
      danger ? cx.theme().colors.destructive : cx.theme().colors.foreground,
    )
    .when(!disabled, (element) => element.on_click(onClick))
    .when(!disabled, (element) =>
      element.hover((style) => style.bg(cx.theme().colors.accent)),
    )
    .when(disabled, (element) => element.opacity(0.4))
    .child(label(caption, cx))
    .when(Boolean(detail), (element) => element.child(muted(detail, cx)));
}

/** @param {string} value @param {import("gpui").Context} cx */
export const kbd = (value, cx) =>
  h_flex()
    .items_center()
    .justify_center()
    .px(cx.theme().spacing.xs)
    .py(cx.theme().spacing.xxs)
    .rounded(cx.theme().radius.sm)
    .border(1)
    .border_color(cx.theme().colors.border)
    .bg(cx.theme().colors.muted)
    .child(muted(value, cx));
