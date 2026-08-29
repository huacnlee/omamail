import assert from "node:assert/strict";

import { createSettingsController } from "../app/settings/controller.js";

const gmail = {
  id: "one@example.com",
  email: "one@example.com",
  provider: "gmail",
  clientId: "client.apps.googleusercontent.com",
};
const imap = {
  id: "imap:two@example.com",
  email: "two@example.com",
  provider: "imap",
  imap: {
    username: "two",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    insecure: false,
  },
};

function harness({ failForget = false, uncertainForget = false } = {}) {
  let accounts = { version: 1, activeId: gmail.id, accounts: [gmail, imap] };
  const configured = [];
  const saved = [];
  const forgotten = [];
  const cleared = [];
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts(next) {
      accounts = structuredClone(next);
      saved.push(structuredClone(next));
    },
    async configure(next) {
      configured.push(next.map((entry) => entry.id));
    },
    async revokeGmail(accountId, clientId) {
      forgotten.push(["gmail", accountId, clientId]);
      return { outcome: "deleted" };
    },
    async forgetImap(descriptor) {
      forgotten.push(["imap", descriptor]);
      if (failForget || uncertainForget) {
        const error = new Error("secret details must not escape");
        if (uncertainForget) error.credentialOutcome = "uncertain";
        else error.credentialOutcome = "beforeEffect";
        throw error;
      }
      return { outcome: "deleted" };
    },
    clearCache(accountId) {
      cleared.push(accountId);
    },
  });
  return {
    controller,
    current: () => accounts,
    configured,
    saved,
    forgotten,
    cleared,
  };
}

{
  const { controller, current, configured, cleared } = harness({
    uncertainForget: true,
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(imap.id),
  );
  assert.equal(result.ok, false);
  assert.equal(result.removed, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.error, "Credential state uncertain; sign in again");
  assert.equal(
    current().accounts.length,
    1,
    "uncertain deletion never restores a fake usable account",
  );
  assert.deepEqual(configured, [[gmail.id]], "removed context stays removed");
  assert.deepEqual(cleared, [imap.id], "uncertain account cache is cleared");
}

{
  const { controller } = harness();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts[0].status, "Active");
  assert.equal(snapshot.remoteImages.enabled, false);
  assert.equal(snapshot.remoteImages.disabled, true);
  assert.match(snapshot.remoteImages.detail, /not available/i);
}

{
  const { controller, current } = harness();
  assert.equal(controller.switchAccount(imap.id), true);
  assert.equal(current().activeId, imap.id);
  assert.equal(controller.switchAccount("unknown"), false);
  assert.equal(current().activeId, imap.id);
}

{
  const { controller, current, configured, forgotten, cleared } = harness();
  const confirmation = controller.requestRemoval(imap.id);
  assert.equal(confirmation.accountId, imap.id);
  assert.match(confirmation.title, /two@example\.com/);
  const result = await controller.confirmRemoval(confirmation);
  assert.equal(result.ok, true);
  assert.equal(current().accounts.length, 1);
  assert.equal(current().activeId, gmail.id);
  assert.deepEqual(configured, [[gmail.id]]);
  assert.deepEqual(forgotten, [
    [
      "imap",
      {
        accountId: imap.id,
        imapHost: "imap.example.com",
        imapPort: 993,
        username: "two",
      },
    ],
  ]);
  assert.deepEqual(cleared, [imap.id]);
}

{
  const { controller, current, configured, cleared } = harness({
    failForget: true,
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(imap.id),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "Account could not be removed");
  assert.equal(current().accounts.length, 2, "local state is compensated");
  assert.deepEqual(configured, [[gmail.id], [gmail.id, imap.id]]);
  assert.deepEqual(cleared, [], "cache survives a failed removal");
}

{
  let accounts = { version: 1, activeId: gmail.id, accounts: [gmail] };
  const revoked = [];
  const configured = [];
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts: (next) => {
      accounts = next;
    },
    configure: async (next) => {
      configured.push(next.map((entry) => entry.id));
    },
    revokeGmail: async (accountId, clientId) => {
      revoked.push([accountId, clientId]);
      return { outcome: "deleted" };
    },
    forgetImap: async () => ({ outcome: "deleted" }),
    clearCache() {},
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(gmail.id),
  );
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.equal(accounts.activeId, "");
  assert.deepEqual(accounts.accounts, []);
  assert.deepEqual(
    configured,
    [[]],
    "removing the last account replaces native contexts with the empty set",
  );
  assert.deepEqual(
    revoked,
    [[gmail.id, gmail.clientId]],
    "Gmail revocation is exact",
  );
}

{
  const hey = { id: "hey:me@hey.com", email: "me@hey.com", provider: "hey" };
  let accounts = { version: 1, activeId: hey.id, accounts: [hey] };
  let credentialCalls = 0;
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts: (next) => {
      accounts = next;
    },
    configure: async () => {},
    revokeGmail: async () => {
      credentialCalls += 1;
    },
    forgetImap: async () => {
      credentialCalls += 1;
    },
    clearCache() {},
  });
  const confirmation = controller.requestRemoval(hey.id);
  assert.match(confirmation.detail, /stays signed in/i);
  assert.equal((await controller.confirmRemoval(confirmation)).ok, true);
  assert.equal(
    credentialCalls,
    0,
    "local HEY removal never performs machine-global logout",
  );
}

console.log("settings controller tests passed");
