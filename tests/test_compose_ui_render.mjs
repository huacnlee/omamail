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
    to: {},
    subject: {},
    body: {},
    status: "Sending…",
    sending: true,
    onSend() {},
    onDiscard() {},
  },
  cx,
);
assert.equal(compose.elementId, "compose");
assert.equal(
  compose.childNodes.some((child) => child?.elementId === "compose-body"),
  true,
);
assert.equal(
  compose.childNodes.some(
    (child) =>
      child?.elementId === "compose-discard" && child.isDisabled === true,
  ),
  true,
);
assert.equal(
  compose.childNodes.some(
    (child) =>
      child?.elementId === "compose-status" &&
      child.accessibilityRole === "label",
  ),
  true,
);
assert.equal(
  compose.childNodes.some(
    (child) => child?.elementId === "compose-send" && child.isDisabled === true,
  ),
  true,
);
assert.equal(
  compose.childNodes.some((child) => child?.elementId === "compose-save"),
  false,
  "a provider without draft storage has no Save draft control",
);
assert.equal(
  compose.childNodes.some((child) => child?.childNodes?.includes("Sending…")),
  true,
);
console.log("compose UI render tests passed");
