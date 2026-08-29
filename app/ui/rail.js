// @ts-check

import { v_flex } from "gpui-base";
import { button, muted } from "../lib/omarchy-ui/index.js";

/**
 * @param {{ accounts: Array<{id:string,label:string,provider:string,selected:boolean}>, mailboxes: Array<{id:string,label:string,count:number,selected:boolean}>, onAccount:(id:string,event:any,cx:import("gpui").Context)=>void, onMailbox:(id:string,event:any,cx:import("gpui").Context)=>void }} model
 * @param {import("gpui").Context} cx
 */
export function renderRail(model, cx) {
  return v_flex()
    .id("mail-rail")
    .flex_none()
    .min_w_0()
    .gap(cx.theme().spacing.lg)
    .p(cx.theme().spacing.md)
    .bg(cx.theme().colors.surface)
    .border_r(1)
    .border_color(cx.theme().colors.border)
    .child(
      v_flex()
        .id("account-list")
        .gap(cx.theme().spacing.xs)
        .child(muted("Accounts", cx))
        .children(
          model.accounts.map((account) =>
            button(
              `account-${account.id}`,
              account.label,
              (event, eventCx) => model.onAccount(account.id, event, eventCx),
              cx,
              { selected: account.selected },
            ).accessibility_label(`${account.label}, ${account.provider}`),
          ),
        ),
    )
    .child(
      v_flex()
        .id("mailbox-list")
        .gap(cx.theme().spacing.xs)
        .child(muted("Mailboxes", cx))
        .children(
          model.mailboxes.map((mailbox) =>
            button(
              `mailbox-${mailbox.id}`,
              `${mailbox.label}${mailbox.count ? ` ${mailbox.count}` : ""}`,
              (event, eventCx) => model.onMailbox(mailbox.id, event, eventCx),
              cx,
              { selected: mailbox.selected },
            ),
          ),
        ),
    );
}
