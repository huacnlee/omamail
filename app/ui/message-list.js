// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { label, muted, rowShell } from "../lib/omarchy-ui/index.js";

/**
 * @typedef {{id:string,sender:string,subject:string,snippet:string,time:string,unread:boolean}} MessageRow
 */

/** @param {{ messages:MessageRow[], cursorId:string|null, selectedId:string|null, onMessage:(id:string,event:any,cx:import("gpui").Context)=>void }} model @param {import("gpui").Context} cx */
export function renderMessageList(model, cx) {
  return v_flex()
    .id("message-list")
    .flex_1()
    .min_w_0()
    .min_h_0()
    .overflow_y_scroll()
    .children(
      model.messages.map((message) => {
        const selected = message.id === model.selectedId;
        const cursor = message.id === model.cursorId;
        const suffix = selected ? "selected" : cursor ? "cursor" : "idle";
        return rowShell(`message-${message.id}-${suffix}`, selected, cx)
          .role("button")
          .accessibility_label(
            `${message.unread ? "Unread, " : ""}${message.sender}, ${message.subject}`,
          )
          .when(cursor, (row) =>
            row.border_l(2).border_color(cx.theme().colors.ring),
          )
          .on_click((event, eventCx) =>
            model.onMessage(message.id, event, eventCx),
          )
          .children([
            ...(message.unread
              ? [
                  div()
                    .id(`message-unread-${message.id}`)
                    .size("0.375rem")
                    .rounded_full()
                    .bg(cx.theme().colors.primary),
                ]
              : []),
            v_flex()
              .flex_1()
              .min_w_0()
              .gap(cx.theme().spacing.xs)
              .child(
                h_flex()
                  .justify_between()
                  .gap(cx.theme().spacing.sm)
                  .child(
                    label(message.sender, cx).when(message.unread, (text) =>
                      text.font_semibold(),
                    ),
                  )
                  .child(muted(message.time, cx)),
              )
              .child(
                label(message.subject, cx).when(message.unread, (text) =>
                  text.font_semibold(),
                ),
              )
              .child(muted(message.snippet, cx)),
          ]);
      }),
    );
}
