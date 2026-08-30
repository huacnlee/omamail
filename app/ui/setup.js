// @ts-check

import { div } from "gpui";
import { Textarea, h_flex, v_flex } from "gpui-base";
import {
  button,
  centeredWorkspace,
  field,
  formField,
  kbd,
  muted,
  pageColumn,
  sectionLabel,
  surface,
  title,
} from "../lib/omarchy-ui/index.js";

/** @param {string} id @param {string} caption @param {import("gpui-base").InputState} state @param {import("gpui").Context} cx */
const input = (id, caption, state, cx) =>
  formField(
    `setup-field-${id}`,
    caption,
    field(state, cx).accessibility_label(caption),
    cx,
  );

/** @param {any} model @param {import("gpui").Context} cx */
function providerFields(model, cx) {
  if (model.provider === "gmail")
    return v_flex()
      .id("setup-gmail-guidance")
      .gap(cx.theme().spacing.sm)
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
  if (model.provider === "imap")
    return v_flex()
      .id("setup-imap-fields")
      .gap(cx.theme().spacing.md)
      .child(sectionLabel("Account details", cx))
      .child(input("email", "Email", model.fields.email, cx))
      .child(input("password", "Password", model.fields.password, cx))
      .child(
        button(
          "setup-advanced-toggle",
          model.advanced ? "Hide server settings" : "Server settings…",
          model.onAdvanced,
          cx,
          { selected: Boolean(model.advanced), disabled: model.busy },
        ),
      )
      .when(Boolean(model.advanced), (form) =>
        form
          .child(sectionLabel("Server details", cx))
          .child(input("username", "Username", model.fields.username, cx))
          .child(input("imap-host", "IMAP host", model.fields.imapHost, cx))
          .child(input("imap-port", "IMAP port", model.fields.imapPort, cx))
          .child(input("smtp-host", "SMTP host", model.fields.smtpHost, cx))
          .child(input("smtp-port", "SMTP port", model.fields.smtpPort, cx))
          .child(
            button(
              "setup-tls",
              model.insecure ? "Plaintext · loopback only" : "TLS required",
              model.onTls,
              cx,
              { selected: !model.insecure, disabled: model.busy },
            ),
          ),
      );
  return v_flex()
    .id("setup-hey-guidance")
    .gap(cx.theme().spacing.sm)
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

/** @param {any} model @param {import("gpui").Context} cx */
function authenticationForm(model, cx) {
  if (!model.provider) return "";
  const form = surface(cx)
    .id("setup-form")
    .role("form")
    .gap(cx.theme().spacing.md)
    .p(cx.theme().spacing.lg)
    .child(title(model.providerName, cx))
    .child(providerFields(model, cx));
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
  return form;
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSetupForm(model, cx) {
  const providers = Array.isArray(model.providers) ? model.providers : [];
  const column = pageColumn("setup-column", cx)
    .child(
      title(
        model.provider
          ? `Add a ${model.providerName} mailbox`
          : "Add a mailbox",
        cx,
      ),
    )
    .child(
      muted(
        model.provider
          ? model.provider === "imap"
            ? "Any mailbox that speaks IMAP. Your address and app password are usually all it takes."
            : `Connect Omamail to ${model.providerName}.`
          : "Which kind?",
        cx,
      ),
    )
    .when(!model.provider, (page) =>
      page.child(
        v_flex()
          .id("setup-provider-selector")
          .role("list")
          .gap(cx.theme().spacing.sm)
          .children(
            providers.map(
              (
                /** @type {{id:string,name:string,summary?:string}} */ provider,
              ) =>
                surface(cx)
                  .id(`setup-provider-${provider.id}`)
                  .p(cx.theme().spacing.sm)
                  .gap(cx.theme().spacing.xs)
                  .child(
                    button(
                      `provider-${provider.id}`,
                      provider.name,
                      (_event, eventCx) =>
                        model.onProvider(provider.id, eventCx),
                      cx,
                      {
                        selected: model.provider === provider.id,
                        disabled: model.busy,
                      },
                    )
                      .w_full()
                      .justify_start(),
                  )
                  .child(
                    muted(
                      provider.summary || `${provider.name} mailbox`,
                      cx,
                    ).id(`setup-provider-${provider.id}-summary`),
                  ),
            ),
          ),
      ),
    )
    .when(Boolean(model.configurationError), (view) =>
      view.child(
        div()
          .id("setup-configuration-error")
          .role("alert")
          .text_color(cx.theme().colors.destructive)
          .child(model.configurationError),
      ),
    )
    .when(Boolean(model.provider), (page) =>
      page.child(authenticationForm(model, cx)),
    );
  return v_flex()
    .id("setup-page")
    .role("region")
    .accessibility_label("Add an email account")
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(
      centeredWorkspace(
        "setup-scroll",
        h_flex()
          .id("setup-workspace")
          .w_full()
          .min_w_0()
          .justify_center()
          .child(column),
        cx,
      ),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSetupFooter(model, cx) {
  const busy = ["authenticating", "verifying", "committing"].includes(
    model.phase,
  );
  const committing = model.phase === "committing";
  return h_flex()
    .id("setup-footer")
    .flex_1()
    .min_w_0()
    .items_center()
    .gap(cx.theme().spacing.sm)
    .when(Boolean(model.provider) && model.phase !== "select-account", (bar) =>
      bar.child(
        button(
          "setup-submit",
          busy ? "Working…" : model.submitLabel,
          model.onSubmit,
          cx,
          { variant: "primary", disabled: busy },
        ),
      ),
    )
    .when(model.phase === "authenticating", (bar) =>
      bar.child(button("setup-poll", "Check status", model.onPoll, cx)),
    )
    .when(model.provider === "hey", (bar) =>
      bar.child(
        button("setup-logout", "Sign out on this machine", model.onLogout, cx, {
          variant: "danger",
          disabled: busy,
        }),
      ),
    )
    .when(Boolean(model.provider), (bar) =>
      bar.child(
        button("setup-cancel", "Choose another provider…", model.onCancel, cx, {
          disabled: committing,
        }),
      ),
    )
    .child(div().flex_1())
    .when(Boolean(model.status), (bar) =>
      bar.child(
        div()
          .id("setup-status")
          .role(model.phase === "error" ? "alert" : "status")
          .accessibility_label(model.status)
          .text_sm()
          .text_color(
            model.phase === "error"
              ? cx.theme().colors.destructive
              : cx.theme().colors.muted_foreground,
          )
          .child(model.status),
      ),
    )
    .child(
      h_flex()
        .id("setup-key-hints")
        .items_center()
        .gap(cx.theme().spacing.xs)
        .when(Boolean(model.provider), (hints) =>
          hints.child(kbd("Esc", cx)).child(muted("back", cx)),
        ),
    );
}
