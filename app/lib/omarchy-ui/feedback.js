// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { label, muted } from "./layout.js";

/** @param {string} heading @param {string} hint @param {import("gpui").Context} cx */
export const emptyState = (heading, hint, cx) =>
  v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap(cx.theme().spacing.xs)
    .p(cx.theme().spacing.xxl)
    .child(label(heading, cx))
    .child(muted(hint, cx));

/** @param {string} caption @param {"ready" | "loading" | "error"} state @param {import("gpui").Context} cx */
export const statusLine = (caption, state, cx) =>
  h_flex()
    .role("status")
    .items_center()
    .gap(cx.theme().spacing.xs)
    .child(
      div()
        .size("0.375rem")
        .rounded_full()
        .when(state === "loading", (dot) =>
          dot.border(1).border_color(cx.theme().colors.ring),
        )
        .when(state !== "loading", (dot) =>
          dot.bg(
            state === "error"
              ? cx.theme().colors.destructive
              : cx.theme().colors.muted_foreground,
          ),
        ),
    )
    .child(
      state === "error"
        ? label(caption, cx).text_color(cx.theme().colors.destructive)
        : muted(caption, cx),
    );
