// @ts-check

import { div } from "gpui";
import { v_flex } from "gpui-base";

/** @param {string | number} value @param {import("gpui").Context} cx */
export const label = (value, cx) =>
  div()
    .text_sm()
    .line_height(1.25)
    .text_color(cx.theme().colors.foreground)
    .child(value);

/** @param {string | number} value @param {import("gpui").Context} cx */
export const muted = (value, cx) =>
  div()
    .text_sm()
    .line_height(1.25)
    .text_color(cx.theme().colors.muted_foreground)
    .child(value);

/** @param {string} value @param {import("gpui").Context} cx */
export const title = (value, cx) =>
  div()
    .text_lg()
    .font_semibold()
    .text_color(cx.theme().colors.foreground)
    .child(value);

/** @param {import("gpui").Context} cx */
export const appFrame = (cx) =>
  v_flex()
    .id("application-frame")
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .text_color(cx.theme().colors.foreground);

/** @param {import("gpui").Context} cx */
export const surface = (cx) =>
  v_flex()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.surface)
    .border(1)
    .border_color(cx.theme().colors.border)
    .rounded(cx.theme().radius.md)
    .overflow_hidden();
