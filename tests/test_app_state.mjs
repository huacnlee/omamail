import assert from "node:assert/strict";

import { createApplicationState, reduceApplicationState } from "../app/application/state.js";

const initial = createApplicationState();
assert.equal(initial.route, "setup");
assert.deepEqual(initial.accounts, []);
assert.equal(initial.activeAccountId, null);
assert.equal(initial.overlay, null);

const choosing = reduceApplicationState(initial, { type: "choose-provider", providerId: "gmail" });
assert.equal(choosing.route, "setup");
assert.equal(choosing.setupProviderId, "gmail");
assert.equal(initial.setupProviderId, null, "state transitions do not mutate the previous snapshot");

const loaded = reduceApplicationState(initial, {
  type: "accounts-loaded",
  accounts: [
    { id: "first@example.com", providerId: "gmail" },
    { id: "imap:second@example.com", providerId: "imap" },
  ],
  activeAccountId: "imap:second@example.com",
});
assert.equal(loaded.route, "mail");
assert.equal(loaded.activeAccountId, "imap:second@example.com");
const switched = reduceApplicationState(loaded, {
  type: "switch-account",
  accountId: "first@example.com",
});
assert.equal(switched.activeAccountId, "first@example.com");
assert.equal(
  reduceApplicationState(loaded, { type: "switch-account", accountId: "missing@example.com" }),
  loaded,
  "a stale account selection is refused",
);

const fallback = reduceApplicationState(initial, {
  type: "accounts-loaded",
  accounts: [{ id: "first@example.com", providerId: "gmail" }],
  activeAccountId: "missing@example.com",
});
assert.equal(fallback.activeAccountId, "first@example.com");

const settings = reduceApplicationState(loaded, { type: "open-settings" });
assert.equal(settings.route, "settings");
assert.equal(reduceApplicationState(settings, { type: "back" }).route, "mail");

assert.throws(
  () => reduceApplicationState(initial, { type: "choose-provider", providerId: "unknown" }),
  /unknown provider/,
);

console.log("app state tests passed");
