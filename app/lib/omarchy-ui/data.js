// @ts-check

import { h_flex } from "gpui-base";

/** @param {string} id @param {boolean} selected @param {import("gpui").Context} cx */
export const rowShell = (id, selected, cx) =>
  h_flex()
    .id(id)
    .items_center()
    .w_full()
    .min_w_0()
    .gap(cx.theme().spacing.sm)
    .px(cx.theme().spacing.md)
    .py(cx.theme().spacing.sm)
    .bg(selected ? cx.theme().colors.accent : cx.theme().colors.surface)
    .text_color(
      selected ? cx.theme().colors.accent_foreground : cx.theme().colors.foreground,
    )
    .hover((style) => style.bg(cx.theme().colors.muted));
