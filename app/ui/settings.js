// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  button,
  centeredWorkspace,
  muted,
  pageColumn,
  panelHeader,
  rowShell,
  sectionLabel,
  surface,
  title,
} from "../lib/omarchy-ui/index.js";

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSettings(model, cx) {
  const confirmingRemoval = Boolean(model.pendingRemoval);
  const accounts = surface(cx)
    .id("settings-accounts-group")
    .child(
      panelHeader(
        "settings-accounts-header",
        sectionLabel("Accounts", cx),
        confirmingRemoval
          ? null
          : button("settings-add-account", "Add account…", model.onAdd, cx, {
              variant: "primary",
            }),
        cx,
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
              .min_w_0()
              .child(div().child(account.label))
              .child(muted(`${account.providerName} · ${account.status}`, cx)),
          )
          .child(
            button(
              `settings-switch-${account.id}`,
              account.status === "Active" ? "Active" : "Switch",
              (_event, eventCx) => model.onSwitch(account.id, eventCx),
              cx,
              {
                disabled:
                  account.status === "Active" ||
                  model.busy ||
                  confirmingRemoval,
              },
            ),
          )
          .child(
            button(
              `settings-remove-${account.id}`,
              "Remove…",
              (_event, eventCx) => model.onRemove(account.id, eventCx),
              cx,
              {
                variant: "danger",
                disabled: model.busy || confirmingRemoval,
              },
            ),
          )
          .when(confirmingRemoval, (row) => row.opacity(0.4)),
      ),
    );
  const preferences = surface(cx)
    .id("settings-preferences-group")
    .child(
      v_flex()
        .id("settings-remote-images")
        .gap(cx.theme().spacing.sm)
        .p(cx.theme().spacing.md)
        .child(sectionLabel("Privacy", cx))
        .child(title("Remote images", cx))
        .child(muted(model.remoteImages.detail, cx))
        .child(
          button(
            "settings-remote-images-toggle",
            model.remoteImages.enabled ? "On" : "Off",
            (_event, eventCx) =>
              model.onRemoteImages(!model.remoteImages.enabled, eventCx),
            cx,
            {
              selected: model.remoteImages.enabled,
              disabled: model.remoteImages.disabled || model.busy,
            },
          ),
        ),
    );
  const column = pageColumn("settings-column", cx, { maxWidth: "38rem" })
    .child(title("Settings", cx))
    .child(accounts)
    .child(preferences);
  if (model.error)
    column.child(
      div()
        .id("settings-error")
        .role("alert")
        .text_color(cx.theme().colors.destructive)
        .child(model.error),
    );
  if (model.pendingRemoval)
    column.child(
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
  return v_flex()
    .id("settings-page")
    .role("region")
    .accessibility_label("Settings")
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(centeredWorkspace("settings-workspace", column, cx));
}
