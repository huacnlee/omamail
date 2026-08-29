import assert from "node:assert/strict";

import { actionBindings, gpuiKeystroke } from "../app/keys/actions.js";

assert.equal(gpuiKeystroke("Ctrl+Return"), "cmd-enter");
assert.equal(gpuiKeystroke("Shift+I"), "shift-i");
assert.equal(gpuiKeystroke("Alt+0"), "alt-0");
assert.equal(gpuiKeystroke("Ctrl++"), "cmd-+");
assert.equal(gpuiKeystroke("Escape"), "escape");
assert.equal(gpuiKeystroke("Up"), "up");

const bindings = actionBindings();
assert.equal(bindings.length > 40, true);
assert.equal(
  bindings.some(
    (binding) =>
      binding.keystroke === "cmd-enter" &&
      binding.action === "mail::send" &&
      binding.context === "Compose",
  ),
  true,
);
assert.equal(
  bindings.some(
    (binding) =>
      binding.keystroke === "e" &&
      binding.action === "mail::archive" &&
      binding.context === "MailList",
  ),
  true,
);
assert.equal(
  bindings.some(
    (binding) => binding.keystroke === "e" && binding.context === "Compose",
  ),
  false,
);

const identities = bindings.map(
  (binding) => `${binding.context}\u0000${binding.keystroke}`,
);
assert.equal(new Set(identities).size, identities.length);

console.log("app action tests passed");
