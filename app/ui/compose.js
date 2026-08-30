// @ts-check

import { div } from "gpui";
import { Textarea, h_flex, v_flex } from "gpui-base";
import {
  actionBar,
  button,
  field,
  fieldRow,
  kbd,
  muted,
} from "../lib/omarchy-ui/index.js";

/** @param {{from?:string,to:import("gpui-base").InputState,cc?:import("gpui-base").InputState,bcc?:import("gpui-base").InputState,ccVisible?:boolean,bccVisible?:boolean,subject:import("gpui-base").InputState,body:import("gpui-base").TextareaState,status?:string,sending?:boolean,onSend:(event:any,cx:any)=>void,onSave?:(event:any,cx:any)=>void,onAttach?:(event:any,cx:any)=>void,onShowCc?:(event:any,cx:any)=>void,onShowBcc?:(event:any,cx:any)=>void,onDiscard:(event:any,cx:any)=>void}} model @param {import("gpui").Context} cx */
export function renderCompose(model, cx) {
  const unavailableAddressField = () =>
    div()
      .flex_1()
      .text_sm()
      .text_color(cx.theme().colors.muted_foreground)
      .child("Not set");
  /** @param {import("gpui-base").InputState|undefined} state @param {string} id @param {string} label */
  const addressField = (state, id, label) =>
    state
      ? field(state, cx).id(id).accessibility_label(label)
      : unavailableAddressField().id(id).accessibility_label(label);
  const attachmentHandler = model.onAttach;
  const commands = h_flex()
    .items_center()
    .gap(cx.theme().spacing.sm)
    .child(
      button(
        "compose-send",
        model.sending ? "Sending…" : "Send",
        model.onSend,
        cx,
        { variant: "primary", disabled: Boolean(model.sending) },
      ),
    )
    .when(typeof attachmentHandler === "function", (bar) =>
      bar.child(
        button(
          "compose-attach",
          "Attach…",
          (event, eventCx) => attachmentHandler?.(event, eventCx),
          cx,
          { disabled: Boolean(model.sending) },
        ),
      ),
    )
    .when(typeof model.onSave === "function", (bar) =>
      bar.child(
        button("compose-save", "Save draft", model.onSave ?? (() => {}), cx, {
          disabled: Boolean(model.sending),
        }),
      ),
    )
    .child(
      button("compose-discard", "Discard", model.onDiscard, cx, {
        disabled: Boolean(model.sending),
      }),
    );
  const status = model.status
    ? div()
        .id("compose-status")
        .role("status")
        .text_sm()
        .text_color(cx.theme().colors.muted_foreground)
        .child(model.status)
    : null;
  const hints = h_flex()
    .items_center()
    .gap(cx.theme().spacing.xs)
    .child(kbd("Ctrl+Enter", cx))
    .child(muted("Send", cx))
    .child(kbd("Esc", cx))
    .child(muted("Back", cx));
  const actions = actionBar(
    "compose-action-bar",
    { actions: commands, status, hints },
    cx,
  );

  return v_flex()
    .id("compose")
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(
      v_flex()
        .id("compose-header")
        .flex_none()
        .child(
          fieldRow(
            "compose-from-row",
            "From",
            muted(model.from || "No sending account", cx),
            cx,
          ),
        )
        .child(
          fieldRow(
            "compose-to-row",
            "To",
            h_flex()
              .flex_1()
              .min_w_0()
              .items_center()
              .gap(cx.theme().spacing.xs)
              .child(addressField(model.to, "compose-to-field", "To"))
              .when(typeof model.onShowCc === "function", (row) =>
                row.child(
                  button(
                    "compose-cc-toggle",
                    "Cc",
                    model.onShowCc ?? (() => {}),
                    cx,
                    {
                      selected: Boolean(model.ccVisible),
                    },
                  ),
                ),
              )
              .when(typeof model.onShowBcc === "function", (row) =>
                row.child(
                  button(
                    "compose-bcc-toggle",
                    "Bcc",
                    model.onShowBcc ?? (() => {}),
                    cx,
                    {
                      selected: Boolean(model.bccVisible),
                    },
                  ),
                ),
              ),
            cx,
          ),
        )
        .when(Boolean(model.ccVisible), (header) =>
          header.child(
            fieldRow(
              "compose-cc-row",
              "Cc",
              addressField(model.cc, "compose-cc-field", "Cc"),
              cx,
            ),
          ),
        )
        .when(Boolean(model.bccVisible), (header) =>
          header.child(
            fieldRow(
              "compose-bcc-row",
              "Bcc",
              addressField(model.bcc, "compose-bcc-field", "Bcc"),
              cx,
            ),
          ),
        )
        .child(
          fieldRow(
            "compose-subject-row",
            "Subject",
            field(model.subject, cx)
              .id("compose-subject-field")
              .accessibility_label("Subject"),
            cx,
          ),
        ),
    )
    .child(
      v_flex()
        .id("compose-editor")
        .flex_1()
        .min_w_0()
        .min_h_0()
        .p(cx.theme().spacing.lg)
        .child(
          Textarea.new(model.body)
            .id("compose-body")
            .accessibility_label("Message")
            .flex_1()
            .min_h("10rem")
            .p(cx.theme().spacing.sm)
            .rounded(cx.theme().radius.sm)
            .border(1)
            .border_color(cx.theme().colors.input)
            .bg(cx.theme().colors.surface)
            .text_sm()
            .focus((style) => style.border_color(cx.theme().colors.ring)),
        ),
    )
    .child(actions);
}
