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
          .children([
            ...(message.unread
              ? [
                  div()
                    .id(`message-unread-${message.id}`)
                    .flex_none()
                    .size("0.375rem")
                    .rounded_full()
                    .bg(cx.theme().colors.primary),
                ]
              : []),
            v_flex()
              .id(`message-row-${message.id}`)
              .flex_1()
              .min_w_0()
              .gap(cx.theme().spacing.xs)
              .children([
                h_flex()
                  .justify_between()
                  .gap(cx.theme().spacing.sm)
                  .child(
                    label(message.sender, cx)
                      .id(`message-row-${message.id}-sender`)
                      .min_w_0()
                      .truncate()
                      .when(message.unread, (text) => text.font_semibold()),
                  )
                  .child(muted(message.time, cx).flex_none().truncate()),
                label(message.subject, cx)
                  .id(`message-row-${message.id}-subject`)
                  .min_w_0()
                  .truncate()
                  .when(message.unread, (text) => text.font_semibold()),
                muted(message.snippet, cx)
                  .id(`message-row-${message.id}-snippet`)
                  .min_w_0()
                  .truncate(),
              ]),
          ])
          .role("button")
          .accessibility_label(
            `${message.unread ? "Unread, " : ""}${message.sender}, ${message.subject}`,
          )
          .when(cursor, (row) =>
            row
              .border_l(2)
              .border_color(cx.theme().colors.ring)
              .when(!selected, (cursorRow) =>
                cursorRow.bg(cx.theme().colors.muted),
              ),
          )
          .on_click((event, eventCx) =>
            model.onMessage(message.id, event, eventCx),
          );
      }),
    );
}
