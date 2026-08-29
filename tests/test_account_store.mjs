import assert from "node:assert/strict";

import {
  accountSummaries,
  loadAccounts,
  saveAccounts,
} from "../app/application/account-store.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    dump(key) {
      return values.get(key);
    },
  };
}

const emptyStorage = memoryStorage();
assert.deepEqual(loadAccounts(emptyStorage), { version: 1, accounts: [], activeId: "" });

const corruptStorage = memoryStorage({ "omamail.accounts": "{not json" });
assert.deepEqual(loadAccounts(corruptStorage), { version: 1, accounts: [], activeId: "" });

const storage = memoryStorage();
const list = {
  version: 1,
  accounts: [{ email: "Alice@Example.com", provider: "imap", imap: { imapHost: "mail.example.com" } }],
  activeId: "imap:alice@example.com",
};
const saved = saveAccounts(storage, list);
assert.equal(saved.activeId, "imap:alice@example.com");
assert.ok(!storage.dump("omamail.accounts").includes("undefined"));
assert.deepEqual(loadAccounts(storage), saved);
assert.deepEqual(accountSummaries(saved), [
  { id: "imap:alice@example.com", providerId: "imap", email: "Alice@Example.com", label: "Alice" },
]);

const hostileStorage = memoryStorage();
const hostile = saveAccounts(hostileStorage, {
  version: 1,
  accounts: [
    {
      email: "secrets@example.com",
      provider: "gmail",
      clientId: "public-client-id",
      clientSecret: "client-secret-value",
      password: "password-value",
      token: "token-value",
      refreshToken: "refresh-token-value",
      nested: { password: "nested-password-value" },
    },
    {
      email: "",
      provider: "imap",
      password: "pending-password-value",
      refreshToken: "pending-refresh-value",
    },
  ],
  activeId: "secrets@example.com",
});
const hostileJson = hostileStorage.dump("omamail.accounts");
for (const forbidden of [
  "clientSecret",
  "client-secret-value",
  "password",
  "password-value",
  "token",
  "token-value",
  "refreshToken",
  "refresh-token-value",
  "nested-password-value",
  "pending-password-value",
  "pending-refresh-value",
]) {
  assert.equal(hostileJson.includes(forbidden), false, `${forbidden} must not persist`);
}
assert.equal(hostile.accounts[0].clientId, "public-client-id");
assert.equal("clientSecret" in hostile.accounts[0], false);
assert.equal("password" in hostile.accounts[1], false);

console.log("account store tests passed");
