import assert from "node:assert/strict";
import { renderSetupForm } from "../app/ui/setup.js";

const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, key) => String(key) }),
    spacing: { xs: 1, sm: 1, md: 1, lg: 1 },
    radius: { sm: 1 },
  }),
};
const fields = {
  email: {},
  username: {},
  password: {},
  imapHost: {},
  imapPort: {},
  smtpHost: {},
  smtpPort: {},
  authorizationUrl: {},
};
const view = renderSetupForm(
  {
    provider: "imap",
    providerName: "IMAP",
    phase: "verifying",
    fields,
    insecure: false,
    status: "Checking account",
    submitLabel: "Test and save",
    onSubmit() {},
    onPoll() {},
    onLogout() {},
    onTls() {},
    onCancel() {},
  },
  cx,
);
assert.equal(view.elementId, "setup-form");
assert.equal(view.accessibilityRole, "form");
assert.equal(
  view.childNodes.some(
    (child) => child?.elementId === "setup-submit" && child.isDisabled,
  ),
  true,
);
assert.equal(
  view.childNodes.some(
    (child) =>
      child?.elementId === "setup-status" &&
      child.accessibilityRole === "status",
  ),
  true,
);
console.log("setup UI render tests passed");
