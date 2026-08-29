import assert from "node:assert/strict";

import { createSetupAdapters } from "../app/setup/adapters.js";

const sent = [];
function host(name, answer) {
  return async (request) => {
    sent.push([name, JSON.parse(request)]);
    return JSON.stringify(answer);
  };
}

const adapters = createSetupAdapters({
  gmail: async (request) => {
    const parsed = JSON.parse(request);
    sent.push(["gmail", parsed]);
    return JSON.stringify(
      parsed.operation === "gmail.oauth.revokeLocal"
        ? { ok: true, data: { revoked: true, outcome: "deleted" } }
        : { ok: true, flowId: "f", url: "https://accounts.google.com/auth" },
    );
  },
  imap: async (request) => {
    const parsed = JSON.parse(request);
    sent.push(["imap", parsed]);
    return JSON.stringify(
      parsed.operation === "imap.setup.forgetCredential"
        ? { ok: true, data: { forgotten: true, outcome: "deleted" } }
        : {
            ok: true,
            data: {
              account: { id: "imap:a@example.test" },
              context: { provider: "imap" },
            },
          },
    );
  },
  hey: async (request) => {
    const parsed = JSON.parse(request);
    sent.push(["hey", parsed]);
    return JSON.stringify({
      ok: true,
      data:
        parsed.operation === "hey.auth.login"
          ? { launched: true }
          : { machineGlobal: true },
    });
  },
});
assert.deepEqual(await adapters.gmail.begin(1000), {
  flowId: "f",
  url: "https://accounts.google.com/auth",
});
assert.deepEqual(
  await adapters.imap.verifyAndStore(
    { email: "a@example.test", password: "secret" },
    900,
  ),
  { account: { id: "imap:a@example.test" }, context: { provider: "imap" } },
);
assert.deepEqual(await adapters.hey.logout(800), { machineGlobal: true });
await adapters.hey.login();
await adapters.gmail.revokeLocal(
  "me@example.test",
  "client.apps.googleusercontent.com",
);
await adapters.imap.forgetCredential({
  accountId: "imap:a@example.test",
  imapHost: "imap.example.test",
  imapPort: 993,
  username: "a",
});
assert.deepEqual(
  sent.map((row) => row[1].operation),
  [
    "gmail.oauth.begin",
    "imap.setup.verifyAndStore",
    "hey.auth.logout",
    "hey.auth.login",
    "gmail.oauth.revokeLocal",
    "imap.setup.forgetCredential",
  ],
);
assert.deepEqual(sent[3][1], { operation: "hey.auth.login" });
assert.equal(
  sent[1][1].password,
  "secret",
  "the secret crosses only the dedicated setup module request",
);

const broken = createSetupAdapters({
  gmail: async () => "not json",
  imap: async () => {
    throw new Error("password=leak");
  },
  hey: async () => "{}",
});
await assert.rejects(() => broken.gmail.begin(1000), /Setup host failed/);
await assert.rejects(
  () => broken.imap.verifyAndStore({}, 1000),
  /Setup host failed/,
);

const uncertain = createSetupAdapters({
  gmail: async () =>
    JSON.stringify({
      ok: false,
      credentialOutcome: "uncertain",
      error: "token=leak",
    }),
  imap: async () => {
    throw new Error("process failed after dispatch secret=leak");
  },
  hey: async () => "{}",
});
await assert.rejects(
  () =>
    uncertain.gmail.revokeLocal(
      "me@example.test",
      "client.apps.googleusercontent.com",
    ),
  (error) =>
    error.message === "Credential state uncertain" &&
    error.credentialOutcome === "uncertain",
);
await assert.rejects(
  () =>
    uncertain.imap.forgetCredential({
      accountId: "imap:a@example.test",
      imapHost: "imap.example.test",
      imapPort: 993,
      username: "a",
    }),
  (error) =>
    error.message === "Credential state uncertain" &&
    error.credentialOutcome === "uncertain",
);
await assert.rejects(() => broken.hey.status(1000), /Setup host failed/);

console.log("setup adapter tests passed");
