import assert from "node:assert/strict";

import Omamail from "../app/main.js";

const colors = new Proxy(
  {},
  { get: (_target, name) => `color:${String(name)}` },
);
const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
const radius = { sm: 4, md: 8 };
const cx = {
  theme: () => ({ colors, spacing, radius }),
  bind_keys: (bindings) => bindings.length,
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

assert.deepEqual(
  ids(rendered).filter((id) => id.startsWith("provider-")),
  ["provider-gmail", "provider-hey", "provider-imap"],
);
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

console.log("app render tests passed");
