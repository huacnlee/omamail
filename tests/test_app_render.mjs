import assert from "node:assert/strict";

import Omamail, { hostFontFamily } from "../app/main.js";
import { focusHandle } from "./gpui_stub.mjs";

const colors = new Proxy(
  {},
  { get: (_target, name) => `color:${String(name)}` },
);
const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
const radius = { sm: 4, md: 8 };
const cx = {
  theme: () => ({ colors, spacing, radius }),
  bind_keys: (bindings) => bindings.length,
  focus_handle: focusHandle,
  spawn: () => {},
  notify: () => {},
};

globalThis.localStorage = {
  value: null,
  getItem() {
    return this.value;
  },
  setItem(_key, value) {
    this.value = value;
  },
};

const app = new Omamail();
app.init?.({}, cx);
const rendered = app.render(cx);

function ids(element, out = []) {
  if (!element || typeof element !== "object") return out;
  if (element.elementId) out.push(element.elementId);
  for (const child of element.childNodes ?? []) ids(child, out);
  return out;
}

// The chooser's rows are named for the page they sit on: `setup-provider-*`
// rather than a bare `provider-*`, which would collide with every other place
// a provider is named.
assert.deepEqual(
  ids(rendered).filter((id) => /^setup-provider-(?!selector$)[a-z]+$/.test(id)),
  ["setup-provider-gmail", "setup-provider-hey", "setup-provider-imap"],
);
assert.ok(ids(rendered).includes("application-top-bar"));
assert.ok(ids(rendered).includes("application-bottom-bar"));
assert.ok(ids(rendered).includes("setup-page"));
assert.ok(ids(rendered).includes("setup-column"));
// With nothing to report the status line carries how current the mailbox is
// instead of the setup page's own status, so `setup-footer` is absent here.
// The page's actions are in the body: that is where `SetupPage.qml` puts them.
assert.ok(ids(rendered).includes("application-bottom-bar"));
assert.equal(app.boundKeys > 10, true);

globalThis.localStorage.value = JSON.stringify({
  version: 1,
  accounts: [
    { email: "reader@example.com", provider: "gmail", label: "Reader" },
  ],
  activeId: "reader@example.com",
});
const hydrated = new Omamail();
hydrated.init?.({}, cx);
const mailbox = hydrated.render(cx);
assert.ok(ids(mailbox).includes("account-reader@example.com"));
assert.ok(ids(mailbox).includes("mailbox-list"));
assert.ok(ids(mailbox).includes("message-list"));
assert.ok(ids(mailbox).includes("message-reader"));

hydrated.openCompose(cx);
const compose = hydrated.render(cx);
// Composing takes the window header away. The form carries its own title band
// — a header above it would be two answers to "what am I looking at" — and the
// status line stays, because it is still this window doing the work.
assert.equal(ids(compose).includes("application-top-bar"), false);
assert.ok(ids(compose).includes("compose-title-bar"));
assert.ok(ids(compose).includes("application-content"));
assert.ok(ids(compose).includes("application-bottom-bar"));
assert.ok(ids(compose).includes("compose-action-bar"));
assert.ok(ids(compose).includes("compose-cc-toggle"));
assert.ok(ids(compose).includes("compose-bcc-toggle"));
assert.equal(ids(compose).includes("compose-cc-field"), false);
assert.equal(ids(compose).includes("compose-bcc-field"), false);

hydrated.openSettings(cx);
const settings = hydrated.render(cx);
assert.ok(ids(settings).includes("application-top-bar"));
assert.ok(ids(settings).includes("application-bottom-bar"));
assert.ok(ids(settings).includes("settings-column"));
assert.ok(ids(settings).includes("settings-accounts-group"));

// Both credential fields are masked until their eye is pressed. A client secret
// left in plain text on a shoulder-surfable window is the worse default; the
// QML says so about the same two fields.
assert.equal(app.setupPassword.is_masked(), true);
assert.equal(app.setupClientSecret.is_masked(), true);

// The window asks for a family by name where no fontconfig answered, and the
// name it must not ask for on macOS is `monospace`: that is a fontconfig alias
// macOS has not got, and asking for it draws in whatever gpui falls back to.
//
// `process.platform` in the shell is the host's name for the platform --
// Rust's `std::env::consts::OS`, so `macos` -- while these tests see node's
// `darwin`. Matching only one of them is a silent failure on exactly the
// system the fallback exists for.
assert.equal(hostFontFamily("macos"), "Menlo");
assert.equal(hostFontFamily("darwin"), "Menlo");
// Everywhere else fontconfig answers, and the empty family lets the kit keep
// its own `monospace` alias.
assert.equal(hostFontFamily("linux"), "");
assert.equal(hostFontFamily("windows"), "");
assert.equal(hostFontFamily(""), "");

console.log("app render tests passed");
