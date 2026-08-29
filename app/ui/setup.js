// @ts-check

import { div } from "gpui";
import { Textarea, v_flex } from "gpui-base";
import {
  button,
  field,
  muted,
  surface,
  title,
} from "../lib/omarchy-ui/index.js";

/** @param {string} caption @param {import("gpui-base").InputState} state @param {import("gpui").Context} cx */
const input = (caption, state, cx) =>
  v_flex()
    .gap(cx.theme().spacing.xs)
    .child(muted(caption, cx))
    .child(field(state, cx).accessibility_label(caption));

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSetupForm(model, cx) {
  const busy = ["authenticating", "verifying", "committing"].includes(
    model.phase,
  );
  const form = surface(cx)
    .id("setup-form")
    .role("form")
    .gap(cx.theme().spacing.md)
    .p(cx.theme().spacing.lg)
    .child(title(model.providerName, cx));
  if (model.provider === "gmail") {
    form
      .child(
        muted(
          "Google OAuth client credentials must already be installed in the protected oauth-client.json file.",
          cx,
        ),
      )
      .child(
        muted(
          "Connect shows the Google authorization URL. Omamail does not save OAuth secrets in application state or local storage.",
          cx,
        ),
      );
  } else if (model.provider === "imap") {
    form
      .child(input("Email", model.fields.email, cx))
      .child(input("Username", model.fields.username, cx))
      .child(input("Password", model.fields.password, cx))
      .child(input("IMAP host", model.fields.imapHost, cx))
      .child(input("IMAP port", model.fields.imapPort, cx))
      .child(input("SMTP host", model.fields.smtpHost, cx))
      .child(input("SMTP port", model.fields.smtpPort, cx))
      .child(
        button(
          "setup-tls",
          model.insecure ? "Plaintext · loopback only" : "TLS required",
          model.onTls,
          cx,
          {
            selected: !model.insecure,
            disabled: busy,
          },
        ),
      );
  } else {
    form
      .child(
        muted(
          "Omamail uses the machine-wide HEY CLI session. Login opens its terminal workflow.",
          cx,
        ),
      )
      .child(
        muted(
          "Signing out affects every application using the HEY CLI on this machine.",
          cx,
        ),
      );
  }
  if (model.intent?.url)
    form.child(
      Textarea.new(model.fields.authorizationUrl)
        .id("setup-authorization-url")
        .accessibility_label("Google authorization URL")
        .h("4rem")
        .p(cx.theme().spacing.sm)
        .border(1)
        .border_color(cx.theme().colors.input)
        .bg(cx.theme().colors.surface),
    );
  if (model.status)
    form.child(
      div()
        .id("setup-status")
        .role(model.phase === "error" ? "alert" : "status")
        .accessibility_label(model.status)
        .text_color(
          model.phase === "error"
            ? cx.theme().colors.destructive
            : cx.theme().colors.muted_foreground,
        )
        .child(model.status),
    );
  if (model.phase === "select-account")
    form.child(
      v_flex()
        .id("setup-account-options")
        .role("list")
        .gap(cx.theme().spacing.xs)
        .children(
          model.accounts.map((/** @type {any} */ account) =>
            button(
              `setup-account-${account.id}`,
              account.label || account.email,
              (_event, eventCx) => model.onAccount(account.id, eventCx),
              cx,
            ),
          ),
        ),
    );
  return form
    .child(
      model.phase !== "select-account"
        ? button(
            "setup-submit",
            busy ? "Working…" : model.submitLabel,
            model.onSubmit,
            cx,
            {
              variant: "primary",
              disabled: busy,
            },
          )
        : "",
    )
    .when(model.phase === "authenticating", (view) =>
      view.child(button("setup-poll", "Check status", model.onPoll, cx)),
    )
    .when(model.provider === "hey", (view) =>
      view.child(
        button("setup-logout", "Sign out on this machine", model.onLogout, cx, {
          variant: "danger",
        }),
      ),
    )
    .child(
      button("setup-cancel", "Choose another provider…", model.onCancel, cx),
    );
}
