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
      disabled: true,
      detail: "Not available yet",
    },
    onAdd() {},
    onBack() {},
    onSwitch() {},
    onRemove() {},
    onCancelRemove() {},
    onConfirmRemove() {},
  },
  cx,
);
function contains(node, id) {
  return (
    node?.elementId === id ||
    (node?.childNodes || []).some((child) => contains(child, id))
  );
}
assert.equal(view.elementId, "settings-page");
assert.equal(view.accessibilityRole, "region");
assert.equal(contains(view, "settings-account-one@example.com"), true);
assert.equal(contains(view, "settings-remote-images"), true);
console.log("settings UI render tests passed");
