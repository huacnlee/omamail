import assert from "node:assert/strict";

import { actionBindings, gpuiKeystroke } from "../app/keys/actions.js";

// `secondary`, not `cmd`: gpui reads `cmd` as the platform modifier, which on
// Linux is Super. Spelled that way, every Ctrl binding in the keymap lands on a
// chord the compositor takes first and the user never reaches.
assert.equal(gpuiKeystroke("Ctrl+Return"), "secondary-enter");
assert.equal(gpuiKeystroke("Shift+I"), "shift-i");
assert.equal(gpuiKeystroke("Alt+0"), "alt-0");
assert.equal(gpuiKeystroke("Ctrl++"), "secondary-+");
assert.equal(gpuiKeystroke("Escape"), "escape");
assert.equal(gpuiKeystroke("Up"), "up");
assert.equal(gpuiKeystroke("Ctrl+K"), "secondary-k");
assert.equal(gpuiKeystroke("Ctrl+Shift+M"), "secondary-shift-m");
// `Meta` is the one spelling that really does mean the platform key.
assert.equal(gpuiKeystroke("Meta+K"), "cmd-k");

const bindings = actionBindings();
assert.equal(bindings.length > 40, true);
assert.equal(
  bindings.some(
    (binding) =>
      binding.keystroke === "secondary-enter" &&
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
