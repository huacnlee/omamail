// @ts-check

import { h_flex, v_flex } from "gpui-base";
import {
  button,
  field,
  kbd,
  muted,
  statusLine,
  title,
} from "../lib/omarchy-ui/index.js";
import { mailLayout } from "./layout.js";
import { renderMessageList } from "./message-list.js";
import { renderRail } from "./rail.js";
import { renderReader } from "./reader.js";

/** @param {any} model @param {import("gpui").Context} cx */
export function renderMail(model, cx) {
  const layout = mailLayout(model.width, Boolean(model.selectedId));
  const list = v_flex()
    .id("mail-list-pane")
    .flex_1()
    .min_w_0()
    .min_h_0()
    .child(
      h_flex()
        .id("mail-header")
        .items_center()
        .gap(cx.theme().spacing.sm)
        .p(cx.theme().spacing.md)
        .border_b(1)
        .border_color(cx.theme().colors.border)
        .child(title(model.header.title, cx))
        .child(field(model.search.state, cx).accessibility_label("Search mail"))
        .child(
          button("compose", "Compose…", model.header.onCompose, cx, {
            variant: "primary",
          }),
        )
        .child(button("settings", "Settings…", model.header.onSettings, cx)),
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

  return v_flex()
    .id(`mail-layout-${layout.mode}`)
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(
      h_flex()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .children([
          renderRail(model, cx),
          ...(layout.showList ? [list] : []),
          ...(layout.showReader ? [renderReader(model.reader, cx)] : []),
        ]),
    )
    .child(
      h_flex()
        .id("mail-status")
        .items_center()
        .justify_between()
        .px(cx.theme().spacing.md)
        .py(cx.theme().spacing.xs)
        .border_t(1)
        .border_color(cx.theme().colors.border)
        .child(statusLine(model.status.label, model.status.state, cx))
        .child(
          h_flex()
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
        ),
    );
}
