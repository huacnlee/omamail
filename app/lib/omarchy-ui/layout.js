// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";

/** @param {string | number} value @param {import("gpui").Context} cx */
export const label = (value, cx) =>
  div()
    .text_size("1rem")
    .line_height(1.25)
    .text_color(cx.theme().colors.foreground)
    .child(value);

/** @param {string | number} value @param {import("gpui").Context} cx */
export const muted = (value, cx) =>
  div()
    .text_size("1rem")
    .line_height(1.25)
    .text_color(cx.theme().colors.muted_foreground)
    .child(value);

/** @param {string} value @param {import("gpui").Context} cx */
export const title = (value, cx) =>
  div()
    .text_size("1.25rem")
    .font_semibold()
    .text_color(cx.theme().colors.foreground)
    .child(value);

/** @param {string} value @param {import("gpui").Context} cx */
export const sectionLabel = (value, cx) =>
  div()
    .text_xs()
    .font_semibold()
    .text_color(cx.theme().colors.muted_foreground)
    .child(String(value).toUpperCase());

/**
 * A compact header for a bordered or tiled region.
 * @param {string} id
 * @param {any} heading
 * @param {any} actions
 * @param {import("gpui").Context} cx
 */
export const panelHeader = (id, heading, actions, cx) =>
  h_flex()
    .id(id)
    .role("section_header")
    .flex_none()
    .items_center()
    .justify_between()
    .gap(cx.theme().spacing.md)
    .h("3rem")
    .px(cx.theme().spacing.md)
    .border_b(1)
    .border_color(cx.theme().colors.border)
    .children([heading, actions].filter(Boolean));

/** @param {import("gpui").Context} cx */
export const brandLockup = (cx) =>
  h_flex()
    .id("application-brand")
    .flex_none()
    .items_center()
    .gap(cx.theme().spacing.sm)
    .child(
      div()
        .flex()
        .items_center()
        .justify_center()
        .size("1.5rem")
        .flex_none()
        .border(1)
        .border_color(cx.theme().colors.ring)
        .text_color(cx.theme().colors.primary)
        .child("M"),
    )
    .child(label("Omamail", cx).font_semibold())
    .child(muted("☰", cx));

/** @param {import("gpui").Context} cx */
export const appFrame = (cx) =>
  v_flex()
    .id("application-frame")
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .text_color(cx.theme().colors.foreground);

/**
 * @param {{brand?:any,center?:any,actions?:any}} options
 * @param {import("gpui").Context} cx
 */
export const topBar = (options, cx) =>
  h_flex()
    .id("application-top-bar")
    .h("5rem")
    .flex_none()
    .items_center()
    .justify_between()
    .gap(cx.theme().spacing.md)
    .px(cx.theme().spacing.lg)
    .border_b(1)
    .border_color(cx.theme().colors.border)
    .bg(cx.theme().colors.background)
    .children([options.brand, options.center, options.actions].filter(Boolean));

/**
 * @param {{status?:any,hints?:any}} options
 * @param {import("gpui").Context} cx
 */
export const bottomBar = (options, cx) =>
  h_flex()
    .id("application-bottom-bar")
    .h("3.5rem")
    .flex_none()
    .items_center()
    .justify_between()
    .gap(cx.theme().spacing.md)
    .px(cx.theme().spacing.lg)
    .border_t(1)
    .border_color(cx.theme().colors.border)
    .bg(cx.theme().colors.background)
    .children([options.status, options.hints].filter(Boolean));

/**
 * A page-local command bar. Domain commands remain owned by the caller.
 * @param {string} id
 * @param {{actions?:any,status?:any,hints?:any}} options
 * @param {import("gpui").Context} cx
 */
export const actionBar = (id, options, cx) =>
  h_flex()
    .id(id)
    .role("toolbar")
    .flex_none()
    .items_center()
    .gap(cx.theme().spacing.sm)
    .px(cx.theme().spacing.lg)
    .py(cx.theme().spacing.sm)
    .border_t(1)
    .border_color(cx.theme().colors.border)
    .children([options.actions].filter(Boolean))
    .child(div().flex_1())
    .children([options.status, options.hints].filter(Boolean));

/**
 * @param {{top:any,content:any,bottom:any}} options
 * @param {import("gpui").Context} cx
 */
export const appShell = (options, cx) =>
  appFrame(cx)
    .child(options.top)
    .child(
      v_flex()
        .id("application-content")
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .child(options.content),
    )
    .child(options.bottom);

/**
 * The single scroll owner for a centered settings, setup, or detail page.
 * @param {string} id
 * @param {any} content
 * @param {import("gpui").Context} cx
 */
export const centeredWorkspace = (id, content, cx) =>
  h_flex()
    .id(id)
    .size_full()
    .min_w_0()
    .min_h_0()
    .justify_center()
    .overflow_y_scroll()
    .child(content);

/**
 * A readable-width page column for form and settings content.
 * @param {string} id
 * @param {import("gpui").Context} cx
 * @param {{maxWidth?:import("gpui").DefiniteLength}} [options]
 */
export const pageColumn = (id, cx, options = {}) =>
  v_flex()
    .id(id)
    .w_full()
    .max_w(options.maxWidth ?? "50rem")
    .gap(cx.theme().spacing.lg)
    .p(cx.theme().spacing.lg);

/** @param {import("gpui").Context} cx */
export const surface = (cx) =>
  v_flex()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.surface)
    .border(1)
    .border_color(cx.theme().colors.border)
    .rounded(cx.theme().radius.sm)
    .overflow_hidden();
