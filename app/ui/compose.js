// @ts-check
import { div } from "gpui";
import { Textarea, v_flex } from "gpui-base";
import { button, field, muted, title } from "../lib/omarchy-ui/index.js";
/** @param {{to:import("gpui-base").InputState,subject:import("gpui-base").InputState,body:import("gpui-base").TextareaState,status?:string,sending?:boolean,onSend:(event:any,cx:any)=>void,onSave?:(event:any,cx:any)=>void,onDiscard:(event:any,cx:any)=>void}} model @param {import("gpui").Context} cx */
export function renderCompose(model, cx) {
  const view = v_flex()
    .id("compose")
    .bg(cx.theme().colors.background)
    .gap(cx.theme().spacing.md)
    .p(cx.theme().spacing.lg)
    .child(title("Compose", cx))
    .child(muted("To", cx))
    .child(field(model.to, cx).accessibility_label("To"))
    .child(muted("Subject", cx))
    .child(field(model.subject, cx).accessibility_label("Subject"))
    .child(muted("Message", cx))
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
    );
  if (model.status)
    view.child(
      div()
        .id("compose-status")
        .role("label")
        .accessibility_label(model.status)
        .text_sm()
        .text_color(cx.theme().colors.muted_foreground)
        .child(model.status),
    );
  if (typeof model.onSave === "function")
    view.child(
      button("compose-save", "Save draft", model.onSave, cx, {
        disabled: Boolean(model.sending),
      }),
    );
  return view
    .child(
      button(
        "compose-send",
        model.sending ? "Sending…" : "Send",
        model.onSend,
        cx,
        {
          variant: "primary",
          disabled: Boolean(model.sending),
        },
      ),
    )
    .child(
      button("compose-discard", "Discard", model.onDiscard, cx, {
        disabled: Boolean(model.sending),
      }),
    );
}
