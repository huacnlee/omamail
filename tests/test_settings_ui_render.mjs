import assert from "node:assert/strict";
import { renderSettings } from "../app/ui/settings.js";

const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, key) => String(key) }),
    spacing: { xs: 1, sm: 1, md: 1, lg: 1, xl: 1 },
    radius: { sm: 1 },
  }),
};
const view = renderSettings(
  {
    accounts: [
      {
        id: "one@example.com",
        label: "one@example.com",
        providerName: "Gmail",
        status: "Active",
      },
    ],
    pendingRemoval: null,
    busy: false,
    error: "",
    remoteImages: {
      enabled: false,
      disabled: false,
      detail: "Loading images can tell the sender when a message was opened.",
    },
    onAdd() {},
    onBack() {},
    onSwitch() {},
    onRemove() {},
    onCancelRemove() {},
    onConfirmRemove() {},
    onRemoteImages() {},
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
assert.equal(view.elementId, "settings-page");
assert.equal(view.accessibilityRole, "region");
assert.equal(contains(view, "settings-column"), true);
assert.equal(contains(view, "settings-accounts-group"), true);
assert.equal(contains(view, "settings-preferences-group"), true);
assert.equal(contains(view, "settings-account-one@example.com"), true);
assert.equal(contains(view, "settings-remote-images"), true);
assert.equal(contains(view, "settings-remote-images-toggle"), true);

const confirmation = renderSettings(
  {
    accounts: [
      {
        id: "one@example.com",
        label: "one@example.com",
        providerName: "Gmail",
        status: "Active",
      },
    ],
    pendingRemoval: {
      accountId: "one@example.com",
      title: "Remove one@example.com?",
      detail: "The account will be removed from Omamail.",
    },
    busy: false,
    error: "",
    remoteImages: {
      enabled: false,
      disabled: false,
      detail: "Privacy warning",
    },
    onAdd() {},
    onSwitch() {},
    onRemove() {},
    onRemoteImages() {},
    onCancelRemove() {},
    onConfirmRemove() {},
  },
  cx,
);
assert.equal(contains(confirmation, "settings-add-account"), false);
assert.equal(
  find(confirmation, "settings-switch-one@example.com")?.isDisabled,
  true,
);
assert.equal(
  find(confirmation, "settings-remove-one@example.com")?.isDisabled,
  true,
);
assert.equal(
  find(confirmation, "settings-remove-confirmation")?.accessibilityRole,
  "alert_dialog",
);
console.log("settings UI render tests passed");
