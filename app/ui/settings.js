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

/** @param {string} id @param {string} heading @param {string} detail @param {any} control @param {import("gpui").Context} cx */
function preferenceRow(id, heading, detail, control, cx) {
  return h_flex()
    .id(id)
    .items_center()
    .justify_between()
    .gap(cx.theme().spacing.lg)
    .p(cx.theme().spacing.md)
    .bg(cx.theme().colors.surface)
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(cx.theme().spacing.xs)
        .child(div().child(heading))
        .child(muted(detail, cx)),
    )
    .child(control);
}

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
  const reading = v_flex()
    .id("settings-preferences-group")
    .gap(cx.theme().spacing.xs)
    .child(sectionLabel("Reading", cx))
    .child(
      preferenceRow(
        "settings-remote-images",
        "Always show remote images",
        model.remoteImages.detail,
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
        cx,
      ),
    )
    .child(
      preferenceRow(
        "settings-heavy-messages",
        "Always render heavy messages",
        model.heavyMessages.detail,
        button(
          "settings-heavy-messages-toggle",
          model.heavyMessages.enabled ? "On" : "Off",
          (_event, eventCx) =>
            model.onHeavyMessages(!model.heavyMessages.enabled, eventCx),
          cx,
          {
            selected: model.heavyMessages.enabled,
            disabled: model.heavyMessages.disabled || model.busy,
          },
        ),
        cx,
      ),
    );
  const writing = v_flex()
    .id("settings-writing-group")
    .gap(cx.theme().spacing.xs)
    .child(sectionLabel("Writing", cx))
    .child(
      preferenceRow(
        "settings-undo-send",
        "Undo send window",
        model.undoSend.detail,
        h_flex()
          .items_center()
          .gap(cx.theme().spacing.xs)
          .child(
            button(
              "settings-undo-send-decrease",
              "−",
              (_event, eventCx) =>
                model.onUndoSend(model.undoSend.seconds - 1, eventCx),
              cx,
              {
                disabled:
                  model.undoSend.disabled ||
                  model.busy ||
                  model.undoSend.seconds <= 0,
              },
            ).accessibility_label("Decrease undo send window"),
          )
          .child(
            div()
              .w("5rem")
              .text_center()
              .child(`${model.undoSend.seconds} seconds`),
          )
          .child(
            button(
              "settings-undo-send-increase",
              "+",
              (_event, eventCx) =>
                model.onUndoSend(model.undoSend.seconds + 1, eventCx),
              cx,
              {
                disabled:
                  model.undoSend.disabled ||
                  model.busy ||
                  model.undoSend.seconds >= 60,
              },
            ).accessibility_label("Increase undo send window"),
          ),
        cx,
      ),
    );
  const column = pageColumn("settings-column", cx, { maxWidth: "38rem" })
    .child(title("Settings", cx))
    .child(reading)
    .child(writing)
    .child(accounts);
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
