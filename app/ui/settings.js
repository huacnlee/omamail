// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  button,
  muted,
  rowShell,
  surface,
  title,
} from "../lib/omarchy-ui/index.js";

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSettings(model, cx) {
  const page = v_flex()
    .id("settings-page")
    .role("region")
    .accessibility_label("Settings")
    .size_full()
    .gap(cx.theme().spacing.lg)
    .p(cx.theme().spacing.xl)
    .bg(cx.theme().colors.background)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .child(title("Settings", cx))
        .child(button("settings-back", "Back", model.onBack, cx)),
    )
    .child(
      surface(cx)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .p(cx.theme().spacing.md)
            .child(title("Accounts", cx))
            .child(
              button("settings-add-account", "Add account…", model.onAdd, cx, {
                variant: "primary",
              }),
            ),
        )
        .children(
          model.accounts.map((/** @type {any} */ account) =>
            rowShell(
              `settings-account-${account.id}`,
              account.status === "Active",
              cx,
            )
              .role("list_item")
              .child(
                v_flex()
                  .flex_1()
                  .child(div().child(account.label))
                  .child(
                    muted(`${account.providerName} · ${account.status}`, cx),
                  ),
              )
              .child(
                button(
                  `settings-switch-${account.id}`,
                  account.status === "Active" ? "Active" : "Switch",
                  (_event, eventCx) => model.onSwitch(account.id, eventCx),
                  cx,
                  { disabled: account.status === "Active" || model.busy },
                ),
              )
              .child(
                button(
                  `settings-remove-${account.id}`,
                  "Remove…",
                  (_event, eventCx) => model.onRemove(account.id, eventCx),
                  cx,
                  { variant: "danger", disabled: model.busy },
                ),
              ),
          ),
        ),
    )
    .child(
      surface(cx)
        .id("settings-remote-images")
        .p(cx.theme().spacing.md)
        .child(title("Remote images", cx))
        .child(muted(model.remoteImages.detail, cx))
        .child(
          button(
            "settings-remote-images-disabled",
            "Unavailable",
            () => {},
            cx,
            { disabled: true },
          ),
        ),
    );
  if (model.error)
    page.child(
      div()
        .id("settings-error")
        .role("alert")
        .text_color(cx.theme().colors.destructive)
        .child(model.error),
    );
  if (model.pendingRemoval)
    page.child(
      surface(cx)
        .id("settings-remove-confirmation")
        .role("alert_dialog")
        .accessibility_label(model.pendingRemoval.title)
        .gap(cx.theme().spacing.sm)
        .p(cx.theme().spacing.md)
        .child(title(model.pendingRemoval.title, cx))
        .child(muted(model.pendingRemoval.detail, cx))
        .child(
          h_flex()
            .gap(cx.theme().spacing.sm)
            .child(
              button(
                "settings-remove-cancel",
                "Cancel",
                model.onCancelRemove,
                cx,
                { disabled: model.busy },
              ),
            )
            .child(
              button(
                "settings-remove-confirm",
                model.busy ? "Removing…" : "Remove",
                model.onConfirmRemove,
                cx,
                { variant: "danger", disabled: model.busy },
              ),
            ),
        ),
    );
  return page;
}
