import assert from "node:assert/strict";
import { renderCompose } from "../app/ui/compose.js";
const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, k) => String(k) }),
    spacing: { md: 1, lg: 1 },
    radius: { sm: 1 },
  }),
};
const compose = renderCompose(
  {
    from: "me@example.com",
    to: {},
    cc: {},
    bcc: {},
    subject: {},
    body: {},
    status: "Sending…",
    sending: true,
    onSend() {},
    onDiscard() {},
  },
  cx,
);
function contains(node, id) {
  return (
    node?.elementId === id ||
    (node?.childNodes || []).some((child) => contains(child, id))
  );
}
function find(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.childNodes || []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function hasText(node, value) {
  return (
    node === value ||
    (node?.childNodes || []).some((child) => hasText(child, value))
  );
}
assert.equal(compose.elementId, "compose");
assert.equal(
  contains(compose, "compose-from-row"),
  true,
  "the sending account stays visible in a compact From row",
);
assert.equal(
  contains(compose, "compose-to-row"),
  true,
  "recipient controls share the compact address header",
);
assert.equal(
  contains(compose, "compose-cc-field"),
  true,
  "Cc is available without leaving compose",
);
assert.equal(
  contains(compose, "compose-bcc-field"),
  true,
  "Bcc is available without leaving compose",
);
assert.equal(
  contains(compose, "compose-subject-row"),
  true,
  "subject remains part of the compact header",
);
assert.equal(contains(compose, "compose-body"), true);
assert.equal(
  contains(compose, "compose-editor"),
  true,
  "the message editor fills the workspace below the headers",
);
assert.equal(
  contains(compose, "compose-action-bar"),
  true,
  "send, attachment, and discard controls stay together at the bottom",
);
assert.equal(
  contains(compose, "compose-attach"),
  false,
  "a provider without attachment support has no attachment command",
);
assert.equal(find(compose, "compose-discard")?.isDisabled === true, true);
assert.equal(
  find(compose, "compose-status")?.accessibilityRole === "status",
  true,
);

const withAttachments = renderCompose(
  {
    from: "me@example.com",
    to: {},
    subject: {},
    body: {},
    onSend() {},
    onAttach() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(contains(withAttachments, "compose-attach"), true);
assert.equal(find(compose, "compose-send")?.isDisabled === true, true);
assert.equal(
  contains(compose, "compose-save"),
  false,
  "a provider without draft storage has no Save draft control",
);
assert.equal(hasText(compose, "Sending…"), true);
console.log("compose UI render tests passed");
