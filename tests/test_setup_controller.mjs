import assert from "node:assert/strict";

import { createSetupController } from "../app/setup/controller.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const gmailStatus = deferred();
const staleBegin = deferred();
const calls = [];
const adapters = {
  gmail: {
    begin: async (deadlineMs) => {
      calls.push(["gmail.begin", deadlineMs]);
      return {
        flowId: "flow-1",
        url: "https://accounts.google.com/o/oauth2/v2/auth",
      };
    },
    status: () => gmailStatus.promise,
    cancel: async (flowId) => calls.push(["gmail.cancel", flowId]),
  },
  imap: {
    verifyAndStore: async (form, deadlineMs) => {
      calls.push(["imap", form, deadlineMs]);
      return {
        account: {
          id: "imap:me@example.test",
          provider: "imap",
          email: "me@example.test",
          imap: {
            username: "me",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
            insecure: false,
          },
        },
        context: {
          kind: "imap",
          accountId: "imap:me@example.test",
          email: "me@example.test",
          username: "me",
          imapHost: "imap.example.test",
          imapPort: 993,
          smtpHost: "smtp.example.test",
          smtpPort: 465,
          insecure: false,
        },
      };
    },
  },
  hey: {
    login: async (deadlineMs) => ({
      launched: true,
      deadlineScope: "launch",
      deadlineMs,
    }),
    status: async () => ({ authenticated: true, expired: false }),
    accounts: async () => ({
      accounts: [{ id: "hey:me@example.test", address: "me@example.test" }],
    }),
    logout: async () => ({ machineGlobal: true }),
  },
};

const gmail = createSetupController(adapters);
assert.equal(gmail.snapshot().phase, "choose");
const nativeStructuredClone = globalThis.structuredClone;
try {
  globalThis.structuredClone = undefined;
  assert.deepEqual(
    gmail.snapshot(),
    { phase: "choose", provider: "", error: "" },
    "the gpui-shell runtime does not provide structuredClone",
  );
} finally {
  globalThis.structuredClone = nativeStructuredClone;
}
gmail.choose("gmail");
assert.equal(gmail.snapshot().phase, "form");
const begun = await gmail.submit({}, 1200);
assert.equal(begun.phase, "authenticating");
assert.deepEqual(begun.intent, {
  kind: "open-browser",
  url: "https://accounts.google.com/o/oauth2/v2/auth",
});
const polling = gmail.poll(900);
assert.equal(gmail.snapshot().phase, "verifying");
gmail.cancel();
gmailStatus.resolve({
  status: "completed",
  account: {
    id: "me@example.test",
    provider: "gmail",
    email: "me@example.test",
    accessToken: "must-drop",
  },
  context: { provider: "gmail", accountId: "me@example.test" },
});
await polling;
assert.equal(
  gmail.snapshot().phase,
  "cancelled",
  "late completion cannot revive a cancelled flow",
);
assert.deepEqual(calls.at(-1), ["gmail.cancel", "flow-1"]);

const imap = createSetupController(adapters);
imap.choose("imap");
const first = imap.submit(
  { email: "me@example.test", password: "secret" },
  700,
);
const duplicate = await imap.submit({ email: "other@example.test" }, 700);
assert.equal(
  duplicate.phase,
  "verifying",
  "double submit does not start another request",
);
await first;
assert.equal(calls.filter((call) => call[0] === "imap").length, 1);
assert.equal(imap.snapshot().phase, "ready");
assert.equal(JSON.stringify(imap.snapshot()).includes("secret"), false);
assert.deepEqual(imap.snapshot().commitIntent, {
  account: {
    id: "imap:me@example.test",
    provider: "imap",
    email: "me@example.test",
    label: "me@example.test",
    imap: {
      username: "me",
      imapHost: "imap.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      insecure: false,
    },
  },
  context: {
    kind: "imap",
    accountId: "imap:me@example.test",
    email: "me@example.test",
    username: "me",
    imapHost: "imap.example.test",
    imapPort: 993,
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    insecure: false,
  },
  compensation: {
    kind: "imap",
    accountId: "imap:me@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    username: "me",
  },
});

const hey = createSetupController(adapters);
hey.choose("hey");
assert.equal((await hey.submit({}, 500)).phase, "authenticating");
assert.equal((await hey.poll(500)).phase, "ready");
assert.equal(hey.snapshot().commitIntent.account.id, "hey:me@example.test");
const loggedOut = await hey.logout(500);
assert.equal(loggedOut.phase, "form");
assert.equal(loggedOut.machineGlobal, true);

const multipleHey = createSetupController({
  ...adapters,
  hey: {
    ...adapters.hey,
    accounts: async () => ({
      accounts: [
        { id: "hey:one@example.test", address: "one@example.test" },
        { id: "hey:two@example.test", address: "two@example.test" },
      ],
    }),
  },
});
multipleHey.choose("hey");
await multipleHey.submit({}, 500);
assert.equal((await multipleHey.poll(500)).phase, "select-account");
assert.equal(multipleHey.selectAccount("hey:two@example.test").phase, "ready");
assert.equal(
  multipleHey.snapshot().commitIntent.account.id,
  "hey:two@example.test",
);

console.log("setup controller tests passed");

const stale = createSetupController({
  ...adapters,
  gmail: {
    ...adapters.gmail,
    begin: () => staleBegin.promise,
  },
});
stale.choose("gmail");
const staleSubmission = stale.submit({}, 1000);
stale.choose("imap");
staleBegin.resolve({
  flowId: "late-flow",
  url: "https://accounts.google.com/o/oauth2/v2/auth",
});
await staleSubmission;
assert.deepEqual(calls.at(-1), ["gmail.cancel", "late-flow"]);

const lateImap = deferred();
const forgottenImap = [];
const cancelledImap = createSetupController({
  ...adapters,
  imap: {
    verifyAndStore: () => lateImap.promise,
    forgetCredential: async (descriptor) => forgottenImap.push(descriptor),
  },
});
cancelledImap.choose("imap");
const lateImapSubmission = cancelledImap.submit({}, 1000);
cancelledImap.cancel();
lateImap.resolve({
  account: {
    id: "imap:late@example.test",
    provider: "imap",
    email: "late@example.test",
    imap: {
      username: "late",
      imapHost: "imap.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      insecure: false,
    },
  },
  context: {},
});
await lateImapSubmission;
assert.deepEqual(forgottenImap, [
  {
    accountId: "imap:late@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    username: "late",
  },
]);

const hostile = createSetupController({
  ...adapters,
  imap: {
    verifyAndStore: async () => ({
      account: {
        id: "imap:me@example.test",
        provider: "imap",
        email: "me@example.test",
        apiKey: "must-not-pass",
        imap: {
          username: "me",
          imapHost: "imap.example.test",
          imapPort: 993,
          smtpHost: "smtp.example.test",
          smtpPort: 465,
          insecure: false,
          privateKey: "must-not-pass",
        },
      },
      context: {
        kind: "imap",
        accountId: "imap:me@example.test",
        email: "me@example.test",
        username: "me",
        imapHost: "imap.example.test",
        imapPort: 993,
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        insecure: false,
        authorization: "must-not-pass",
      },
    }),
  },
});
hostile.choose("imap");
await hostile.submit({}, 1000);
const hostileJson = JSON.stringify(hostile.snapshot().commitIntent);
assert.equal(hostileJson.includes("must-not-pass"), false);
assert.deepEqual(Object.keys(hostile.snapshot().commitIntent.account).sort(), [
  "email",
  "id",
  "imap",
  "label",
  "provider",
]);

const malformed = createSetupController({
  ...adapters,
  imap: {
    verifyAndStore: async () => ({ account: { id: "imap:x" }, context: {} }),
  },
});
malformed.choose("imap");
assert.equal((await malformed.submit({}, 1000)).phase, "error");
