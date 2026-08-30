import assert from "node:assert/strict";
import { renderSetupForm, renderSetupFooter } from "../app/ui/setup.js";

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
    providers: [
      { id: "gmail", name: "Gmail" },
      { id: "hey", name: "HEY" },
      { id: "imap", name: "IMAP" },
    ],
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
    onProvider() {},
  },
  cx,
);
function contains(node, id) {
  return (
    node?.elementId === id ||
    (node?.childNodes || []).some((child) => contains(child, id))
  );
}

assert.equal(view.elementId, "setup-page");
assert.equal(view.accessibilityRole, "region");
assert.equal(contains(view, "setup-workspace"), true);
assert.equal(contains(view, "setup-scroll"), true);
assert.equal(contains(view, "setup-column"), true);
assert.equal(contains(view, "setup-provider-selector"), true);
assert.equal(contains(view, "setup-form"), true);
assert.equal(contains(view, "setup-imap-fields"), true);
assert.equal(contains(view, "setup-field-email"), true);
assert.equal(contains(view, "setup-field-smtp-port"), true);
const footer = renderSetupFooter(
  {
    provider: "imap",
    phase: "verifying",
    status: "Checking account",
    submitLabel: "Test and save",
    onSubmit() {},
    onPoll() {},
    onLogout() {},
    onCancel() {},
  },
  cx,
);
assert.equal(footer.elementId, "setup-footer");
assert.equal(
  footer.childNodes.some(
    (child) => child?.elementId === "setup-submit" && child.isDisabled,
  ),
  true,
);
assert.equal(
  footer.childNodes.some(
    (child) =>
      child?.elementId === "setup-status" &&
      child.accessibilityRole === "status",
  ),
  true,
);
assert.equal(contains(footer, "setup-key-hints"), true);

const authenticatingFooter = renderSetupFooter(
  {
    provider: "hey",
    phase: "authenticating",
    status: "Waiting for HEY",
    submitLabel: "Connect",
    onSubmit() {},
    onPoll() {},
    onLogout() {},
    onCancel() {},
  },
  cx,
);
const authCancel = authenticatingFooter.childNodes.find(
  (child) => child?.elementId === "setup-cancel",
);
assert.equal(authCancel?.isDisabled, false);

const committingFooter = renderSetupFooter(
  {
    provider: "imap",
    phase: "committing",
    status: "Saving account",
    submitLabel: "Save",
    onSubmit() {},
    onPoll() {},
    onLogout() {},
    onCancel() {},
  },
  cx,
);
const commitCancel = committingFooter.childNodes.find(
  (child) => child?.elementId === "setup-cancel",
);
assert.equal(commitCancel?.isDisabled, true);
console.log("setup UI render tests passed");
