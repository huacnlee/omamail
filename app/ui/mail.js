// @ts-check

import { h_flex, v_flex } from "gpui-base";
import {
  appShell,
  bottomBar,
  brandLockup,
  button,
  field,
  kbd,
  muted,
  panelHeader,
  sectionLabel,
  statusLine,
  topBar,
  title,
} from "../lib/omarchy-ui/index.js";
import { MAIL_LIST_WIDTH, mailLayout } from "./layout.js";
import { renderMessageList } from "./message-list.js";
import { renderRail } from "./rail.js";
import { renderReader } from "./reader.js";

/** @param {any} model @param {import("gpui").Context} cx */
export function renderMail(model, cx) {
  const viewportWidth =
    typeof window !== "undefined" &&
    typeof (/** @type {any} */ (window).viewport_size) === "function"
      ? Number(/** @type {any} */ (window).viewport_size().width)
      : model.width;
  const layout = mailLayout(viewportWidth, Boolean(model.selectedId));
  const list = v_flex()
    .id("mail-list-pane-fixed")
    .when(layout.mode === "split", (pane) =>
      pane.flex_none().w(MAIL_LIST_WIDTH).min_w(MAIL_LIST_WIDTH),
    )
    .when(layout.mode === "single", (pane) => pane.flex_1().w_full().min_w_0())
    .min_h_0()
    .border_r(1)
    .border_color(cx.theme().colors.border)
    .child(
      panelHeader(
        "mail-list-header",
        sectionLabel(model.header.title, cx),
        null,
        cx,
      ),
    )
    .child(
      renderMessageList(
        {
          messages: model.messages,
          cursorId: model.cursorId,
          selectedId: model.selectedId,
          onMessage: model.onMessage,
        },
        cx,
      ),
    )
    .children([
      ...(model.loadingMore
        ? [statusLine("Loading more…", "loading", cx)]
        : []),
      ...(model.canLoadMore
        ? [button("mail-load-more", "Load more", model.onLoadMore, cx)]
        : []),
      ...(model.canRetry
        ? [button("mail-retry", "Retry", model.onRetry, cx)]
        : []),
    ]);

  return appShell(
    {
      top: topBar(
        {
          brand: brandLockup(cx),
          center: h_flex()
            .id("mail-topbar")
            .flex_1()
            .min_w_0()
            .items_center()
            .justify_center()
            .child(
              h_flex()
                .w_full()
                .max_w("48rem")
                .child(
                  field(model.search.state, cx).accessibility_label(
                    "Search mail",
                  ),
                ),
            ),
          actions: h_flex()
            .gap(cx.theme().spacing.sm)
            .child(
              button("compose", "Compose…", model.header.onCompose, cx, {
                variant: "primary",
              }),
            )
            .child(
              button("settings", "Settings…", model.header.onSettings, cx),
            ),
        },
        cx,
      ),
      content: h_flex()
        .id(`mail-layout-${layout.mode}`)
        .size_full()
        .min_w_0()
        .min_h_0()
        .child(
          h_flex()
            .id("mail-workspace")
            .size_full()
            .min_w_0()
            .min_h_0()
            .children([
              ...(layout.showRail ? [renderRail(model, cx)] : []),
              ...(layout.showList ? [list] : []),
              ...(layout.showReader
                ? [
                    v_flex()
                      .id("mail-reader-pane")
                      .flex_1()
                      .min_w_0()
                      .min_h_0()
                      .child(renderReader(model.reader, cx)),
                  ]
                : []),
            ]),
        ),
      bottom: bottomBar(
        {
          status: statusLine(model.status.label, model.status.state, cx).id(
            "mail-status",
          ),
          hints: h_flex()
            .id("mail-status-hints")
            .gap(cx.theme().spacing.sm)
            .children(
              model.status.hints.map(
                (/** @type {{key:string,label:string}} */ hint) =>
                  h_flex()
                    .gap(cx.theme().spacing.xs)
                    .child(kbd(hint.key, cx))
                    .child(muted(hint.label, cx)),
              ),
            ),
        },
        cx,
      ),
    },
    cx,
  );
}
