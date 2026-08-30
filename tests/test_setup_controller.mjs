import assert from "node:assert/strict";

import {
  createSetupController,
  imapSuggestion,
} from "../app/setup/controller.js";

// An address names its servers, and says what that provider wants instead of
// the password its website takes.
{
  const fastmail = imapSuggestion("someone@fastmail.com");
  assert.equal(fastmail.imapHost, "imap.fastmail.com");
  assert.equal(fastmail.imapPort, 993);
  assert.match(fastmail.note, /app password/i);
  const unknown = imapSuggestion("someone@example.test");
  assert.equal(unknown.imapHost, "imap.example.test");
  assert.equal(unknown.note, "");
  // Nothing typed yet is not an error.
  assert.equal(imapSuggestion(null).note, "");
  assert.equal(imapSuggestion("").imapHost, "");
}

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
    {
      phase: "choose",
      provider: "",
      error: "",
      // Beside the phase rather than in it: the OAuth client outlives every
      // sign-in, and `state` is replaced wholesale on each phase change.
      client: {
        present: false,
        clientId: "",
        description: "",
        busy: false,
        error: "",
      },
    },
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

// ------------------------------------------------------- the OAuth client

// One client for the whole app: Gmail's first step is configuring it, and
// without one there is nothing for a sign-in to go through.
const clientCalls = [];
let stored = { present: false, clientId: "", description: "" };
let storedSecret = "";
const clientController = createSetupController({
  ...adapters,
  gmail: {
    ...adapters.gmail,
    readClient: async (options = {}) => {
      clientCalls.push(["read", options.includeSecret === true]);
      return options.includeSecret === true
        ? { ...stored, clientSecret: storedSecret }
        : stored;
    },
    saveClient: async (clientId, clientSecret) => {
      clientCalls.push(["save", clientId, clientSecret]);
      stored = {
        present: true,
        clientId,
        description: "Omamail desktop client",
      };
      storedSecret = clientSecret;
      return {};
    },
  },
});

assert.deepEqual(clientController.snapshot().client, {
  present: false,
  clientId: "",
  description: "",
  busy: false,
  error: "",
});

// A blank id is refused here rather than writing a client that could never
// sign anything in — and the adapter is not called at all.
const blank = await clientController.saveClient("   ", "secret");
assert.equal(blank.client.error, "A client ID is required");
assert.deepEqual(clientCalls, []);

// A saved client is read back rather than assumed: the host decides whether
// one is usable, and saying "saved" over a file it refused would be the setup
// page lying about the one thing it is for.
const saved = await clientController.saveClient(
  " 000000-abc.apps.googleusercontent.com ",
  " shh ",
);
// Read back *with* the secret: the field has to be able to show what is
// stored, or a save can only ever overwrite it and the client can never be
// read back off this machine.
assert.deepEqual(clientCalls, [
  ["save", "000000-abc.apps.googleusercontent.com", " shh "],
  ["read", true],
]);
assert.equal(saved.client.clientSecret, " shh ");
assert.equal(saved.client.present, true);
assert.equal(saved.client.description, "Omamail desktop client");
assert.equal(saved.client.busy, false);
assert.equal(saved.client.error, "");

// The client survives a phase change, because it is a fact about the app and
// not about the sign-in in progress.
clientController.choose("gmail");
assert.equal(clientController.snapshot().phase, "form");
assert.equal(clientController.snapshot().client.present, true);

// A host that cannot store one says so instead of pretending.
const hostless = createSetupController(adapters);
const refused = await hostless.saveClient("000000-abc.apps.googleusercontent.com", "");
assert.equal(refused.client.error, "This host cannot store a client");
// And reading from such a host is not an error: no client is the state the
// setup page exists to change.
assert.equal((await hostless.readClient()).client.present, false);

// The settings page does not ask for the secret, so it never holds one.
clientCalls.length = 0;
const described = await clientController.readClient();
assert.deepEqual(clientCalls, [["read", false]]);
assert.equal(described.client.clientSecret, undefined);


// -------------------------------------------------- what the page is told
//
// The reason the host gave, and not "Setup failed". A flow that stopped for
// something somebody could act on — a client that is not a Google client, a
// reply Google sent that this could not read — used to reach the page as the
// same two characterless words whatever had happened, which is why a sign-in
// that failed and a sign-in nobody had finished looked identical.
{
  const reasoned = (reason) => {
    const error = new Error("this message is for a developer, not a label");
    if (reason !== undefined) error.reason = reason;
    return error;
  };
  const refusing = createSetupController({
    gmail: {
      begin: async () => {
        throw reasoned("Gmail sign-in is unavailable");
      },
      status: async () => ({ status: "pending" }),
      cancel: async () => ({}),
      readClient: async () => {
        throw reasoned("oauth-client.json is not a plain file");
      },
      saveClient: async () => {
        throw reasoned("That is not a Google client ID");
      },
    },
    imap: {
      verifyAndStore: async () => {
        throw reasoned(undefined);
      },
      forgetCredential: async () => ({}),
    },
    hey: { login: async () => ({}) },
  });

  refusing.choose("gmail");
  const failed = await refusing.submit({}, 1000);
  assert.equal(failed.phase, "error");
  assert.equal(failed.error, "Gmail sign-in is unavailable");

  // The client's own box, which is the one place a reason is a fix rather than
  // a note: "That is not a Google client ID" names the thing to change.
  assert.equal(
    (await refusing.saveClient("nope", "")).client.error,
    "That is not a Google client ID",
  );
  assert.equal(
    (await refusing.readClient()).client.error,
    "oauth-client.json is not a plain file",
  );

  // A fault carrying no reason of its own still says something rather than
  // nothing, and an ordinary JavaScript message is never the something.
  refusing.choose("imap");
  const blank = await refusing.submit({}, 1000);
  assert.equal(blank.phase, "error");
  assert.equal(blank.error, "Setup failed");
}

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

// A mailbox with no SMTP server. The host reports it back as an empty server on
// port zero — there is nothing for a port to be the port of — and the account
// commits rather than being read as malformed. The port rule still applies to a
// server that is named.
function readOnlyImapAdapters(smtpHost, smtpPort) {
  const imap = {
    username: "me",
    imapHost: "imap.example.test",
    imapPort: 993,
    smtpHost,
    smtpPort,
    insecure: false,
  };
  return {
    ...adapters,
    imap: {
      verifyAndStore: async () => ({
        account: {
          id: "imap:me@example.test",
          provider: "imap",
          email: "me@example.test",
          imap,
        },
        context: {
          kind: "imap",
          accountId: "imap:me@example.test",
          email: "me@example.test",
          ...imap,
        },
      }),
    },
  };
}

const readOnly = createSetupController(readOnlyImapAdapters("", 0));
readOnly.choose("imap");
const readOnlySnapshot = await readOnly.submit({}, 1000);
assert.equal(readOnlySnapshot.phase, "ready");
assert.equal(readOnlySnapshot.commitIntent.account.imap.smtpHost, "");
assert.equal(readOnlySnapshot.commitIntent.account.imap.smtpPort, 0);
assert.equal(readOnlySnapshot.commitIntent.context.smtpHost, "");

// A named server with no port is a mailbox nobody could send from either, and
// is refused rather than quietly becoming a read-only one.
const portless = createSetupController(readOnlyImapAdapters("smtp.example.test", 0));
portless.choose("imap");
assert.equal((await portless.submit({}, 1000)).phase, "error");
