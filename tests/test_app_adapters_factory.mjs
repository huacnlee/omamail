import assert from "node:assert/strict";

import { createProviderAdapter } from "../app/adapters/index.js";

assert.throws(
  () => createProviderAdapter("gmail", () => {}),
  /current identity getter is required/,
);

const adapter = createProviderAdapter("hey", () => ({ cancel() {} }), () => ({
  accountId: "hey:me@example.com",
  revision: 1,
}));
assert.equal(typeof adapter.list, "function");
assert.equal(typeof adapter.detail, "function");
assert.equal(typeof adapter.action, "function");

assert.throws(
  () => createProviderAdapter("unknown", () => ({ cancel() {} }), () => ({})),
  /unknown provider/,
);

console.log("app adapter factory tests passed");
