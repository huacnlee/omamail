// @ts-check

import { v_flex } from "gpui-base";
import { glyphButton, iconButton } from "../lib/omarchy-ui/index.js";
import { MAIL_RAIL_WIDTH } from "./layout.js";

/** @type {Record<string,string>} */
const mailboxIcons = {
  inbox: "▣",
  unread: "✉",
  drafts: "✎",
  starred: "☆",
  sent: "➤",
  trash: "⌫",
};

/**
 * @param {{ accounts: Array<{id:string,label:string,provider:string,selected:boolean}>, mailboxes: Array<{id:string,label:string,count:number,selected:boolean}>, onAccount:(id:string,event:any,cx:import("gpui").Context)=>void, onMailbox:(id:string,event:any,cx:import("gpui").Context)=>void, onCalendar?:(event:any,cx:import("gpui").Context)=>void, calendarSelected?:boolean }} model
 * @param {import("gpui").Context} cx
 */
export function renderRail(model, cx) {
  const fallbackIcons = ["▤", "◇"];
  return v_flex()
    .id("mail-rail")
    .flex_none()
    .w(MAIL_RAIL_WIDTH)
    .min_w(MAIL_RAIL_WIDTH)
    .items_center()
    .gap(cx.theme().spacing.xs)
    .p(cx.theme().spacing.xs)
    .bg(cx.theme().colors.surface)
    .border_r(1)
    .border_color(cx.theme().colors.border)
    .child(
      v_flex()
        .id("mailbox-list")
        .items_center()
        .gap(cx.theme().spacing.xs)
        .children(
          model.mailboxes.map((mailbox, index) =>
            glyphButton(
              `mailbox-${mailbox.id}`,
              mailboxIcons[mailbox.id] ||
                fallbackIcons[index % fallbackIcons.length],
              `${mailbox.label}${mailbox.count ? `, ${mailbox.count}` : ""}`,
              (event, eventCx) => model.onMailbox(mailbox.id, event, eventCx),
              cx,
              { selected: mailbox.selected },
            ),
          ),
        ),
    )
    .child(v_flex().flex_1())
    .when(typeof model.onCalendar === "function", (rail) =>
      rail.child(
        glyphButton(
          "navigation-calendar",
          "▦",
          "Calendar",
          (event, eventCx) => model.onCalendar?.(event, eventCx),
          cx,
          { selected: model.calendarSelected === true },
        ),
      ),
    )
    .child(
      v_flex()
        .id("mail-rail-accounts")
        .items_center()
        .gap(cx.theme().spacing.xs)
        .children(
          model.accounts.map((account) => {
            const activate = (
              /** @type {any} */ event,
              /** @type {import("gpui").Context} */ eventCx,
            ) => model.onAccount(account.id, event, eventCx);
            return account.provider === "gmail" || account.provider === "hey"
              ? iconButton(
                  `account-${account.id}`,
                  `assets/${account.provider}.svg`,
                  `${account.label}, ${account.provider}`,
                  activate,
                  cx,
                  { selected: account.selected },
                )
              : glyphButton(
                  `account-${account.id}`,
                  "✉",
                  `${account.label}, ${account.provider}`,
                  activate,
                  cx,
                  { selected: account.selected },
                );
          }),
        ),
    );
}
