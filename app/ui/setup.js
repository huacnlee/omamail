// @ts-check

// Connecting a mailbox.
//
// One page per provider, because the three setups have nothing in common. Gmail
// is a browser round trip through Google; HEY is a program 37signals publish
// and a button; IMAP is an address, a password, and — only if the guess was
// wrong — the servers. What they share is the chooser in front of them, the way
// out at the top, and the footnotes at the bottom.
//
// Held to `components/SetupPage.qml`, `components/ImapSetupPage.qml` and
// `components/HeySetupPage.qml` measurement by measurement: every page is a
// column at `Style.space(16)`, every group inside one is `Style.space(10)`, and
// the command that finishes a page sits inside the step or the group it
// finishes rather than on the window's status line. A Connect button parked in
// the chrome reads as part of the window instead of as the last thing the form
// asks for.

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  actionButton,
  alpha,
  button,
  centeredWorkspace,
  field,
  label,
  muted,
  pageColumn,
  separator,
  style,
} from "../lib/omarchy-ui/index.js";
import { imapSuggestion } from "../setup/controller.js";
import { icon } from "./icons.js";
import {
  linkLabel,
  pageHeading,
  providerHero,
  providerPicker,
  providerRecord,
} from "./setup-provider.js";

const BUSY_PHASES = ["authenticating", "verifying", "committing"];
// The one line somebody has to run to get the HEY CLI. Written out rather than
// run from here: this window would be piping a script off the internet into a
// shell on the user's behalf, which is a thing to decide in a terminal you are
// looking at.
const HEY_INSTALL = "curl -fsSL https://hey.com/install-cli | bash";

// The three console pages `MailAccount.qml` opens by name. Deep links rather
// than the console's front door: "create an OAuth client" is four navigations
// in from there, and a walkthrough that drops the user at the top has not
// saved them anything.
const GOOGLE_CLIENT_URL =
  "https://console.cloud.google.com/auth/clients/create";
const GOOGLE_API_URL =
  "https://console.cloud.google.com/apis/library/gmail.googleapis.com";
const GOOGLE_CONSENT_URL = "https://console.cloud.google.com/auth/overview";

/** @param {any} state the field's text state, if the host offered one */
function textOf(state) {
  try {
    return typeof state?.value === "function" ? String(state.value()) : "";
  } catch (_) {
    return "";
  }
}

/**
 * A bordered notice on the theme's idle fill — a missing dependency, a command
 * to paste, the address a browser was sent to.
 *
 * The QML is a `Rectangle` whose height is its text plus `Style.space(20)`,
 * with the text inset `Style.space(12)` from the sides.
 * @param {string} id @param {any} content @param {import("gpui").Context} cx
 */
function notice(id, content, cx) {
  const tokens = style();
  const foreground = cx.theme().colors.foreground;
  return v_flex()
    .id(id)
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.md)
    .px(tokens.spacing.rowPaddingX)
    .py(tokens.spacing.xl)
    .rounded(tokens.cornerRadius)
    .border(tokens.state.normalBorderWidth)
    .border_color(alpha(foreground, tokens.state.hoverBorderAlpha))
    .bg(alpha(foreground, tokens.state.normalFillAlpha))
    .child(content);
}

/**
 * `SetupPage.qml`'s Step: a number, a title, and a body that is only present
 * while this is the step that needs the user. A finished step collapses to one
 * line with a check, so the page never shows more than one thing to do.
 *
 * The marker is a `Style.space(20)` column and the text butts straight against
 * it — no gap, because the twenty pixels *are* the indent.
 *
 * @param {{id:string,number:string,title:string,done?:boolean,waiting?:boolean,summary?:string,aside?:any}} model
 * @param {any} body
 * @param {import("gpui").Context} cx
 */
function step(model, body, cx) {
  const tokens = style();
  const done = model.done === true;
  const waiting = model.waiting === true;
  const active = !done && !waiting;
  return h_flex()
    .id(model.id)
    .role("group")
    .accessibility_label(model.title)
    .w_full()
    .min_w_0()
    .items_start()
    .when(waiting, (element) => element.opacity(0.45))
    .child(
      div()
        .flex_none()
        .w(tokens.space(20))
        .flex()
        .items_center()
        .h(tokens.space(18))
        .text_size(tokens.font.bodySmall)
        .text_color(
          active ? cx.theme().colors.ring : cx.theme().colors.muted_foreground,
        )
        .when(active, (marker) => marker.font_bold())
        .child(
          done
            ? icon("check", cx, {
                size: tokens.font.bodySmall,
                color: cx.theme().colors.ring,
              })
            : model.number,
        ),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(tokens.spacing.controlGap)
        .child(
          label(done && model.summary ? model.summary : model.title, cx)
            .text_size(tokens.font.bodySmall)
            .truncate()
            .when(!done, (line) => line.font_bold())
            .when(done, (line) =>
              line.text_color(cx.theme().colors.muted_foreground),
            ),
        )
        .when(active, (column) => column.child(body)),
    )
    .children([done && model.aside ? model.aside : null].filter(Boolean));
}

/**
 * The disclosure `ImapSetupPage.qml` puts the servers behind: an
 * `IconTextButton` at the caption size in the dim tone, keeping the kit's
 * control height so it lines up with the fields above it.
 * @param {string} id @param {string} caption @param {boolean} open
 * @param {((event:any,cx:any)=>void)|undefined} onToggle
 * @param {import("gpui").Context} cx
 */
function disclosure(id, caption, open, onToggle, cx) {
  const tokens = style();
  return button(id, caption, onToggle ?? (() => {}), cx, {
    iconName: open ? "chevronDown" : "chevronRight",
    fontSize: tokens.font.caption,
    color: cx.theme().colors.muted_foreground,
    bordered: true,
    disabled: typeof onToggle !== "function",
  })
    .role("disclosure_triangle")
    .flex_none()
    .self_start()
    .h(tokens.spacing.controlHeight);
}

/**
 * The other disclosure: one dim line of prose with no chrome at all, which is
 * what `SetupPage.qml` uses for "Need more detail?" — a plain `Button` with
 * `bordered: false`, `leftAlign: true` and `horizontalPadding: 0`, so the words
 * sit on the same left edge as the paragraph they open.
 * @param {string} id @param {string} caption
 * @param {((event:any,cx:any)=>void)|undefined} onToggle
 * @param {import("gpui").Context} cx
 */
function proseDisclosure(id, caption, onToggle, cx) {
  const tokens = style();
  return button(id, caption, onToggle ?? (() => {}), cx, {
    fontSize: tokens.font.caption,
    color: cx.theme().colors.muted_foreground,
    disabled: typeof onToggle !== "function",
  })
    .role("disclosure_triangle")
    .flex_none()
    .self_start()
    .px(0)
    .justify_start();
}

/** @param {any} state @param {string} id @param {string} description @param {import("gpui").Context} cx */
function textInput(state, id, description, cx) {
  const tokens = style();
  return state
    ? field(state, cx)
        .id(id)
        .accessibility_label(description)
        // `TextField` on every setup page is `Style.font.bodySmall`; the kit's
        // own default is body, which is a size the QML never draws a form at.
        .text_size(tokens.font.bodySmall)
    : muted(`${description} is unavailable`, cx).id(id);
}

/**
 * A masked field with the reveal control sitting inside its right edge, the way
 * both QML pages build one: an `IconButton` of `Style.space(22)` anchored
 * `Style.space(4)` in from the field's right, with the field's own right
 * padding opened up so the text never runs under it.
 *
 * The control appears only once there is something to reveal — an eye over an
 * empty box offers to show nothing.
 *
 * @param {string} id @param {any} state @param {string} description
 * @param {{visible:boolean,onReveal?:(next:boolean,cx:any)=>void,show:string,hide:string}} reveal
 * @param {import("gpui").Context} cx
 */
function maskedField(id, state, description, reveal, cx) {
  const tokens = style();
  const extent = tokens.space(22);
  const inset = tokens.space(4);
  const room = tokens.spacing.controlPaddingX + tokens.space(26);
  const offered =
    typeof reveal.onReveal === "function" && textOf(state) !== "";
  return div()
    .id(id)
    .relative()
    .w_full()
    .min_w_0()
    // The role goes on the wrapper, not on the `Input`: base's Input owns its
    // own focus and accessibility, and refuses one with a warning.
    .role("password_input")
    .child(textInput(state, `${id}-field`, description, cx).pr(room))
    .when(offered, (row) =>
      row.child(
        actionButton(
          `${id}-reveal`,
          reveal.visible ? "eyeOff" : "eye",
          reveal.visible ? reveal.hide : reveal.show,
          (_event, eventCx) => reveal.onReveal?.(!reveal.visible, eventCx),
          cx,
          {
            selected: reveal.visible,
            color: cx.theme().colors.muted_foreground,
            size: extent,
            iconSize: tokens.font.iconSmall,
          },
        )
          .absolute()
          .right(inset)
          // `anchors.verticalCenter` against a field of the kit's control
          // height: the difference, halved.
          .top(Math.round((tokens.spacing.controlHeight - extent) / 2)),
      ),
    );
}

/**
 * The Google OAuth client, which is what the whole first step is for: without
 * one there is nothing to sign in *through*, and a Connect button with no
 * client can only fail.
 *
 * One client for the app rather than one per mailbox — which is why adding a
 * second Gmail account never asks for another.
 * @param {any} model @param {import("gpui").Context} cx
 */
function clientForm(model, cx) {
  const tokens = style();
  const client = model.client ?? {};
  const save = model.onSaveClient;
  if (!model.fields?.clientId) return null;
  return v_flex()
    .id("setup-gmail-client")
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.xl)
    .child(
      textInput(
        model.fields.clientId,
        "setup-gmail-client-id",
        "Client ID — 000000-xxxx.apps.googleusercontent.com",
        cx,
      ),
    )
    .child(
      maskedField(
        "setup-gmail-client-secret",
        model.fields.clientSecret,
        "Client secret — optional",
        {
          visible: model.clientSecretVisible === true,
          onReveal: model.onRevealClientSecret,
          show: "Show the secret",
          hide: "Hide the secret",
        },
        cx,
      ),
    )
    .when(typeof save === "function", (column) =>
      column.child(
        button(
          "setup-gmail-client-save",
          client.busy === true ? "Saving..." : "Save client",
          save,
          cx,
          {
            bordered: true,
            fontSize: tokens.font.bodySmall,
            disabled: client.busy === true,
          },
        )
          .flex_none()
          .self_start(),
      ),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
function gmailForm(model, cx) {
  const tokens = style();
  const phase = String(model.phase || "");
  const busy = BUSY_PHASES.includes(phase);
  const client = model.client ?? {};
  // `root.configured` — the client on disk, which is what step one produces and
  // what step two waits for. A finished step can be reopened, because the
  // client changes when somebody moves Cloud projects.
  const configured = client.present === true && model.clientStepOpen !== true;
  // The same precedence the status line uses: the window's own failure, then
  // the controller's, then whatever the client write said. Read from `status`
  // rather than `error` so a failure the window recorded after the controller
  // had finished — a mailbox that could not be saved — is not the one thing the
  // page stays silent about.
  const failure =
    (phase === "error" ? String(model.status || model.error || "") : "") ||
    String(client.error || "");
  const url = String(model.intent?.url || "");
  const open = model.onOpenUrl;
  /**
   * @param {string} id @param {string} caption @param {string} target
   * @param {{bordered?:boolean}} [options]
   */
  const openButton = (id, caption, target, options = {}) =>
    typeof open === "function"
      ? button(id, caption, (_event, eventCx) => open(target, eventCx), cx, {
          bordered: options.bordered ?? true,
          fontSize: tokens.font.bodySmall,
          color:
            options.bordered === false
              ? cx.theme().colors.muted_foreground
              : undefined,
        })
      : null;

  const clientBody = v_flex()
    .id("setup-gmail-step-client-body")
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.xl)
    .child(
      muted(
        "Create an OAuth client with application type Desktop app, and enable the Gmail API on the same project.",
        cx,
      ).text_size(tokens.font.caption),
    )
    .child(
      h_flex()
        .gap(tokens.spacing.controlGap)
        .children(
          /** @type {any[]} */ ([
            openButton(
              "setup-gmail-console",
              "Open Google Cloud...",
              GOOGLE_CLIENT_URL,
            ),
            openButton(
              "setup-gmail-api",
              "Enable Gmail API...",
              GOOGLE_API_URL,
            ),
          ]).filter(Boolean),
        ),
    )
    // Absent rather than empty when the window has no fields to offer: a
    // labelled box nobody can type into is worse than no box.
    .children(/** @type {any[]} */ ([clientForm(model, cx)]).filter(Boolean));

  const signInBody = v_flex()
    .id("setup-gmail-step-signin-body")
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.xl)
    .child(
      // The one piece of the walkthrough that cannot be hidden: a project left
      // in Testing is issued seven-day refresh tokens, so Google would sign the
      // user out every week. It belongs beside the button it affects.
      muted(
        'Press "Publish app" on your project first, or Google expires the session every seven days. An "unverified app" warning is expected — you are the developer.',
        cx,
      ).text_size(tokens.font.caption),
    )
    .child(
      h_flex()
        .items_center()
        .gap(tokens.spacing.controlGap)
        .children(
          /** @type {any[]} */ ([
            button(
              "setup-submit",
              busy ? "Signing in" : "Sign in with Google...",
              model.onSubmit ?? (() => {}),
              cx,
              {
                bordered: true,
                fontSize: tokens.font.bodySmall,
                disabled: busy || typeof model.onSubmit !== "function",
              },
            ),
            openButton(
              "setup-gmail-consent",
              "Consent screen...",
              GOOGLE_CONSENT_URL,
              { bordered: false },
            ),
            phase === "authenticating" && typeof model.onPoll === "function"
              ? button("setup-poll", "Check status", model.onPoll, cx, {
                  fontSize: tokens.font.bodySmall,
                  color: cx.theme().colors.muted_foreground,
                })
              : null,
          ]).filter(Boolean),
        ),
    )
    .when(Boolean(url), (column) =>
      column.child(
        notice(
          "setup-authorization-url",
          v_flex()
            .gap(tokens.spacing.xs)
            .child(
              muted(
                "If the browser did not open, this is the address:",
                cx,
              ).text_size(tokens.font.caption),
            )
            .child(
              // Clickable, not just readable. There is no selectable text in
              // this toolkit, so an address nobody can copy and nobody can
              // press is an address nobody can use — and this one is six lines
              // of query string.
              (typeof open === "function"
                ? div()
                    .id("setup-authorization-url-value")
                    .cursor_pointer()
                    .on_click((_event, eventCx) => open(url, eventCx))
                    .hover((appearance) =>
                      appearance.text_color(cx.theme().colors.foreground),
                    )
                : div().id("setup-authorization-url-value")
              )
                .text_size(tokens.font.caption)
                .text_color(cx.theme().colors.muted_foreground)
                .underline()
                .child(url),
            ),
          cx,
        ),
      ),
    );

  return v_flex()
    .id("setup-gmail-form")
    .role("form")
    .w_full()
    .min_w_0()
    .gap(tokens.space(16))
    .child(
      step(
        {
          id: "setup-gmail-step-client",
          number: "1",
          title: "Create a client in Google Cloud",
          done: configured,
          summary: `Client connected · ${client.description || "Google OAuth client"}`,
          // `reopenable`: the one step somebody comes back to, so it keeps a
          // way back in rather than being sealed by its own success.
          aside:
            typeof model.onReopenClient === "function"
              ? button(
                  "setup-gmail-client-change",
                  "Change...",
                  model.onReopenClient,
                  cx,
                  {
                    fontSize: tokens.font.caption,
                    color: cx.theme().colors.muted_foreground,
                  },
                ).flex_none()
              : null,
        },
        clientBody,
        cx,
      ),
    )
    .child(
      step(
        {
          id: "setup-gmail-step-signin",
          number: "2",
          title: "Sign in",
          done: phase === "ready",
          waiting: !configured,
          summary: model.commitIntent?.account?.email
            ? `Signed in as ${model.commitIntent.account.email}`
            : "Signed in",
        },
        signInBody,
        cx,
      ),
    )
    // Whatever went wrong. Without this a rejected client ID looks exactly like
    // a button that does nothing — the status line carries it too, but that
    // line is one truncated caption at the foot of the window, and a sign-in
    // that stopped is read where the user was looking.
    .when(Boolean(failure), (column) =>
      column.child(
        div()
          .id("setup-gmail-error")
          .role("alert")
          .w_full()
          .min_w_0()
          .text_size(tokens.font.caption)
          .text_color(cx.theme().colors.destructive)
          .child(failure),
      ),
    )
    .child(separator(cx))
    .child(
      proseDisclosure(
        "setup-gmail-detail-toggle",
        model.detailVisible ? "Hide the details" : "Need more detail?",
        model.onDetail,
        cx,
      ),
    )
    .when(model.detailVisible === true, (column) =>
      column.child(
        muted(
          "In Google Cloud, pick or create a project. Under APIs and Services, enable the Gmail API. On the consent screen add the Gmail address you want to read as a test user, then press Publish app. Under Credentials, create an OAuth client with application type Desktop app, and paste its client ID above.\n\nThe client is saved to a file readable only by you, never to application state and never to this window. You can also copy the JSON the console downloads to that path instead of pasting.\n\nThe refresh token goes to GNOME Keyring; the access token never leaves memory.",
          cx,
        )
          .id("setup-gmail-detail")
          .text_size(tokens.font.caption),
      ),
    );
}

/** @param {any} model @param {any} actions @param {import("gpui").Context} cx */
function imapForm(model, actions, cx) {
  const tokens = style();
  // What a provider wants instead of the website password, shown as soon as the
  // address names one — somebody typing their everyday password into this box
  // will otherwise be told only that it was rejected. Derived from the field
  // the way `ImapSetupPage.qml` bound it, because the host owns the text state
  // and the note is a fact about whatever is in it right now.
  const address = textOf(model.fields?.email);
  const note = String(model.suggestion?.note ?? imapSuggestion(address).note);
  const advanced = model.advanced === true;
  const port = (
    /** @type {string} */ id,
    /** @type {any} */ state,
    /** @type {string} */ name,
  ) => textInput(state, id, name, cx).flex_none().w(tokens.space(90));
  return v_flex()
    .id("setup-imap-fields")
    .role("form")
    .w_full()
    .min_w_0()
    .gap(tokens.space(16))
    .child(
      // No captions above the address and the password: the fields carry their
      // own placeholders, which is one line of chrome rather than two for a
      // form whose two questions are already obvious.
      v_flex()
        .id("setup-imap-account")
        .w_full()
        .min_w_0()
        .gap(tokens.spacing.xl)
        .child(
          textInput(model.fields?.email, "setup-field-email", "Email address", cx),
        )
        .when(Boolean(note), (form) =>
          form.child(
            muted(note, cx).id("setup-imap-note").text_size(tokens.font.caption),
          ),
        )
        .child(
          maskedField(
            "setup-field-password",
            model.fields?.password,
            "Password, or app password",
            {
              visible: model.passwordVisible === true,
              onReveal: model.onRevealPassword,
              show: "Show the password",
              hide: "Hide the password",
            },
            cx,
          ),
        )
        .when(Boolean(model.error), (form) =>
          form.child(
            div()
              .id("setup-imap-error")
              .role("alert")
              .text_size(tokens.font.caption)
              .text_color(cx.theme().colors.destructive)
              .child(model.error),
          ),
        ),
    )
    .child(
      v_flex()
        .id("setup-imap-servers-group")
        .w_full()
        .min_w_0()
        .gap(tokens.spacing.xl)
        .child(
          // Behind a disclosure, because for a known provider they are already
          // right and four more fields on screen would suggest otherwise.
          disclosure(
            "setup-advanced-toggle",
            advanced ? "Hide the server settings" : "Server settings",
            advanced,
            model.onAdvanced,
            cx,
          ),
        )
        .when(advanced, (group) =>
          group
            .child(
              v_flex()
                .id("setup-imap-servers")
                .w_full()
                .min_w_0()
                .gap(tokens.spacing.controlGap)
                .child(
                  h_flex()
                    .w_full()
                    .min_w_0()
                    .gap(tokens.spacing.controlGap)
                    .child(
                      textInput(
                        model.fields?.imapHost,
                        "setup-field-imap-host",
                        "IMAP server",
                        cx,
                      ),
                    )
                    .child(
                      port(
                        "setup-field-imap-port",
                        model.fields?.imapPort,
                        "IMAP port",
                      ),
                    ),
                )
                .child(
                  h_flex()
                    .w_full()
                    .min_w_0()
                    .gap(tokens.spacing.controlGap)
                    .child(
                      textInput(
                        model.fields?.smtpHost,
                        "setup-field-smtp-host",
                        "SMTP server — leave empty to read only",
                        cx,
                      ),
                    )
                    .child(
                      port(
                        "setup-field-smtp-port",
                        model.fields?.smtpPort,
                        "SMTP port",
                      ),
                    ),
                )
                // Only for the servers where the login name is not the address,
                // which is common enough on self-hosted mail to be worth a
                // field and rare enough to keep out of the way.
                .child(
                  textInput(
                    model.fields?.username,
                    "setup-field-username",
                    "Username — only if it is not the address",
                    cx,
                  ),
                ),
            )
            // The QML derives this from the server being loopback and shows no
            // control at all; this host is told rather than deciding, so the
            // one control the page adds sits above the sentence that explains
            // it rather than in place of it.
            .child(
              button(
                "setup-tls",
                model.insecure ? "Plain text · loopback only" : "TLS required",
                model.onTls ?? (() => {}),
                cx,
                {
                  bordered: true,
                  selected: model.insecure !== true,
                  fontSize: tokens.font.bodySmall,
                  disabled:
                    typeof model.onTls !== "function" || model.busy === true,
                },
              )
                .flex_none()
                .self_start(),
            )
            .child(
              muted(
                "Connections are TLS on the port given. Plain text is refused unless the server is on this machine.",
                cx,
              )
                .id("setup-imap-tls-note")
                .text_size(tokens.font.caption),
            ),
        ),
    )
    .children(/** @type {any[]} */ ([actions]).filter(Boolean));
}

/** @param {any} model @param {any} actions @param {import("gpui").Context} cx */
function heyForm(model, actions, cx) {
  const tokens = style();
  const phase = String(model.phase || "");
  const busy = BUSY_PHASES.includes(phase);
  const signedIn = phase === "ready";
  const provider = providerRecord(model);
  // There is no probe for the HEY CLI on this host yet, so the install
  // instructions surface exactly when they are needed: after a sign-in that did
  // not start, or when the host has said the program is missing.
  const showInstall = model.toolsMissing === true || phase === "error";
  return v_flex()
    .id("setup-hey-form")
    .role("form")
    .w_full()
    .min_w_0()
    .gap(tokens.space(16))
    .when(showInstall, (column) =>
      column.child(
        v_flex()
          .id("setup-hey-install")
          .w_full()
          .min_w_0()
          .gap(tokens.spacing.xl)
          .child(
            // The name of the thing to install is also where to read about it.
            // Split rather than set as rich text: only the client's name is the
            // link, and a whole heading that opened a browser would be a
            // heading somebody made clickable by accident.
            h_flex()
              .items_center()
              .child(
                div()
                  .text_size(tokens.font.bodySmall)
                  .font_bold()
                  .child("Install the "),
              )
              .child(
                linkLabel(
                  "setup-hey-client-link",
                  "HEY CLI",
                  String(provider?.clientUrl || ""),
                  model.onOpenUrl,
                  cx,
                  {
                    tooltip: "Open the HEY CLI on GitHub",
                    size: tokens.font.bodySmall,
                    bold: true,
                  },
                ),
              ),
          )
          .child(
            muted("Run this in a terminal:", cx).text_size(tokens.font.caption),
          )
          .child(
            notice(
              "setup-hey-command",
              div().text_size(tokens.font.bodySmall).child(HEY_INSTALL),
              cx,
            ),
          )
          .child(
            muted(
              "Recent versions of Omarchy install it for you — omarchy-mise-install github:basecamp/hey-cli hey does the same thing. Either way it lands in ~/.local/bin.",
              cx,
            ).text_size(tokens.font.caption),
          ),
      ),
    )
    .when(!signedIn, (column) =>
      column.child(
        v_flex()
          .id("setup-hey-signin")
          .w_full()
          .min_w_0()
          .gap(tokens.spacing.xl)
          .child(
            label("Sign in to HEY", cx)
              .text_size(tokens.font.bodySmall)
              .font_bold(),
          )
          .child(
            muted(
              "This opens HEY in your browser. The token comes back to the HEY CLI, which keeps it in your keyring and refreshes it — Omamail never holds it and never asks for your HEY password.",
              cx,
            ).text_size(tokens.font.caption),
          )
          .child(
            h_flex()
              .items_center()
              .gap(tokens.spacing.controlGap)
              .children(
                /** @type {any[]} */ ([
                  button(
                    "setup-submit",
                    busy ? "Waiting for the browser" : "Sign in to HEY...",
                    model.onSubmit ?? (() => {}),
                    cx,
                    {
                      bordered: true,
                      fontSize: tokens.font.bodySmall,
                      disabled: busy || typeof model.onSubmit !== "function",
                    },
                  ),
                  phase === "authenticating" &&
                  typeof model.onPoll === "function"
                    ? button("setup-poll", "Check status", model.onPoll, cx, {
                        fontSize: tokens.font.bodySmall,
                        color: cx.theme().colors.muted_foreground,
                      })
                    : null,
                ]).filter(Boolean),
              ),
          ),
      ),
    )
    .when(signedIn, (column) =>
      column.child(
        v_flex()
          .id("setup-hey-connected")
          .w_full()
          .min_w_0()
          .gap(tokens.spacing.labelGap)
          .child(
            label("Connected", cx)
              .text_size(tokens.font.bodySmall)
              .font_bold(),
          )
          .child(
            muted(
              model.commitIntent?.account?.email
                ? `${model.commitIntent.account.email} — signed in through the HEY CLI.`
                : "Signed in through the HEY CLI.",
              cx,
            ).text_size(tokens.font.caption),
          ),
      ),
    )
    .child(
      // Said here rather than discovered later. Every one of these is a button
      // this provider does not draw, and somebody who came from Gmail will look
      // for two of them within a minute.
      v_flex()
        .id("setup-hey-differences")
        .w_full()
        .min_w_0()
        .gap(tokens.spacing.labelGap)
        .child(
          label("What is different about HEY", cx)
            .text_size(tokens.font.caption)
            .font_bold(),
        )
        .child(
          muted(
            "No star and no archive — HEY has neither. A thread is moved to Set Aside, Reply Later or Paper Trail instead, and those are mailboxes in the rail. No Sent either: the HEY CLI does not serve one yet. Reading, marking read, replying, searching, labels and reporting spam all work. A row here is one conversation rather than one message, and attachments and the Screener stay in HEY's own app.",
            cx,
          ).text_size(tokens.font.caption),
        ),
    )
    .children(/** @type {any[]} */ ([actions]).filter(Boolean))
    .child(
      // The sign-out above is `hey`'s own, because the token is `hey`'s. Said
      // next to the button rather than after it has been pressed.
      muted(
        "Signing out signs the HEY CLI out, so anything else on this machine that uses it — the HEY terminal app, the bar plugin — is signed out too.",
        cx,
      )
        .id("setup-hey-logout-note")
        .text_size(tokens.font.caption),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
function accountChooser(model, cx) {
  const tokens = style();
  return v_flex()
    .id("setup-account-options")
    .role("list")
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.lg)
    .child(
      muted(
        "This sign-in serves more than one mailbox. Which one?",
        cx,
      ).text_size(tokens.font.caption),
    )
    .children(
      (model.accounts || []).map((/** @type {any} */ account) =>
        button(
          `setup-account-${account.id}`,
          account.label || account.email,
          (_event, eventCx) => model.onAccount?.(account.id, eventCx),
          cx,
          { bordered: true, fontSize: tokens.font.bodySmall },
        )
          .w_full()
          .justify_start(),
      ),
    );
}

/** @param {any} model @param {any} actions @param {import("gpui").Context} cx */
function providerForm(model, actions, cx) {
  if (model.provider === "gmail") return gmailForm(model, cx);
  if (model.provider === "imap") return imapForm(model, actions, cx);
  return heyForm(model, actions, cx);
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSetupForm(model, cx) {
  const tokens = style();
  const provider = providerRecord(model);
  const column = pageColumn("setup-column", cx)
    // `spacing: Style.space(16)` on all three pages. The kit's panel gap is
    // fourteen, which is the density a settings panel wants and not the one a
    // walkthrough does.
    .gap(tokens.space(16))
    .when(
      typeof model.onCancel === "function",
      // `BackBar.qml` — the page's own way out, above its heading and on a line
      // of its own. Outlined rather than flat, so the box is the aligned edge
      // and both its states sit on the same left edge as everything under them.
      (page) =>
        page.child(
          h_flex().child(
            button(
              "setup-back",
              "Back",
              (event, eventCx) => model.onCancel(event, eventCx),
              cx,
              {
                iconName: "back",
                bordered: true,
                fontSize: tokens.font.bodySmall,
                color: cx.theme().colors.muted_foreground,
                tooltip: "Back · Esc",
              },
            ).h(tokens.spacing.controlHeight),
          ),
        ),
    );

  if (!model.provider)
    column
      .child(
        pageHeading("setup-chooser-heading", "Add a mailbox", "Which kind?", cx),
      )
      .child(providerPicker(model, cx));
  // IMAP is a protocol rather than a service, so its page opens with a plain
  // heading: there is no brand to name, and an envelope in the theme's colour
  // beside a heading would be a logo that is not one. Its own sentence rather
  // than the chooser card's, because the card answers "which kind" and the page
  // answers "what will this ask me for".
  else if (model.provider === "imap")
    column.child(
      pageHeading(
        "setup-hero",
        "Add a mailbox",
        "Any mailbox that speaks IMAP — Fastmail, iCloud, Zoho, a server of your own. The address is usually all it takes.",
        cx,
      ),
    );
  else
    column.child(
      providerHero(
        {
          id: "setup-hero",
          provider: provider ?? {
            id: model.provider,
            name: model.providerName,
          },
          // The brand is in the heading because the heading is half the link,
          // and "Connect your mailbox" named no service at all.
          heading: `Add a ${model.providerName || "mailbox"} mailbox`,
          detail: heroDetail(model),
          onOpenUrl: model.onOpenUrl,
        },
        cx,
      ),
    );

  if (model.configurationError)
    column.child(
      div()
        .id("setup-configuration-error")
        .role("alert")
        .text_size(tokens.font.caption)
        .text_color(cx.theme().colors.destructive)
        .child(model.configurationError),
    );

  if (model.provider)
    column.child(
      model.phase === "select-account"
        ? accountChooser(model, cx)
        : providerForm(
            model,
            hasSetupActions(model) ? setupActions(model, cx) : null,
            cx,
          ),
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

/**
 * What connecting this service involves, in one line under the heading. The
 * page's own sentence rather than the chooser card's: the card answers "which
 * kind of mailbox is this" and the hero answers "what am I about to do".
 * @param {any} model
 */
function heroDetail(model) {
  if (model.provider === "gmail")
    return "Google issues Gmail API access per project, so this app signs in with an OAuth client you own. About two minutes, once.";
  if (model.provider === "hey")
    return "HEY does not speak IMAP or POP. Omamail reads it through the HEY CLI, the client 37signals publish for exactly this — install it once, then sign in here.";
  return String(providerRecord(model)?.summary || "");
}

/**
 * Whether the page has a trailing command row at all. Asked before the row is
 * built rather than by counting its children: an element is a description of
 * what to draw and not a list this side can read back.
 * @param {any} model
 */
function hasSetupActions(model) {
  if (model.phase === "select-account") return false;
  if (model.provider === "imap") return true;
  return model.provider === "hey" && typeof model.onLogout === "function";
}

/**
 * The row of commands that closes a page — `SetupPage.qml`'s and
 * `ImapSetupPage.qml`'s trailing `Row`, at `Style.space(8)`.
 *
 * Only what the QML puts *after* the form is here. The command that finishes a
 * step lives inside that step, because a page whose last question is "sign in"
 * should not answer it somewhere else.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function setupActions(model, cx) {
  const tokens = style();
  const busy = BUSY_PHASES.includes(String(model.phase));
  const row = h_flex()
    .id("setup-actions")
    .flex_none()
    .items_center()
    .gap(tokens.spacing.controlGap);
  if (model.provider === "imap" && model.phase !== "select-account") {
    // `enabled: !busy && addressField.text.trim() !== "" && passwordField.text
    // !== ""`. A mailbox cannot be tested without both, so the button says so
    // before it is pressed rather than after.
    const ready =
      textOf(model.fields?.email).trim() !== "" &&
      textOf(model.fields?.password) !== "";
    row.child(
      button(
        "setup-submit",
        busy ? "Checking" : "Connect the mailbox",
        model.onSubmit ?? (() => {}),
        cx,
        {
          bordered: true,
          fontSize: tokens.font.bodySmall,
          disabled: busy || !ready || typeof model.onSubmit !== "function",
        },
      ),
    );
  }
  if (model.provider === "hey" && typeof model.onLogout === "function")
    row.child(
      button("setup-logout", "Sign out of HEY", model.onLogout, cx, {
        bordered: true,
        fontSize: tokens.font.bodySmall,
        disabled: busy,
      }),
    );
  return row;
}

/**
 * The status line's share of the setup page.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderSetupFooter(model, cx) {
  const tokens = style();
  // What the page has to say, and nothing it can be asked to do — the commands
  // are in the page beside the step that offers them. An empty status leaves
  // the line to whatever the window puts there.
  return h_flex()
    .id("setup-footer")
    .flex_1()
    .min_w_0()
    .items_center()
    .when(Boolean(model.status), (bar) =>
      bar.child(
        div()
          .id("setup-status")
          .role(model.phase === "error" ? "alert" : "status")
          .accessibility_label(model.status)
          .min_w_0()
          .truncate()
          .text_size(tokens.font.caption)
          .text_color(
            model.phase === "error"
              ? cx.theme().colors.destructive
              : cx.theme().colors.muted_foreground,
          )
          .child(model.status),
      ),
    );
}
