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

// A browser sign-in is minutes, not the seconds a round trip gets, and the
// ceiling here has to match the host's or a request it would have accepted is
// refused before it is sent — which is what "Setup failed" looked like when
// the two disagreed.
const longFlow = await adapters.gmail.begin(240000);
assert.equal(typeof longFlow.url, "string");
await assert.rejects(() => adapters.gmail.begin(300001));
await assert.rejects(() => adapters.gmail.begin(0));

// ------------------------------------------------------ the host's reason
//
// A refusal the host explained has to arrive explained. Every one of these used
// to be flattened into the same fixed string on the way out, so a Gmail sign-in
// that Google, the keyring or the client file had already accounted for reached
// the page as "Setup failed" — which is the reason this took several rounds to
// find.
const speaking = (error) =>
  createSetupAdapters({
    gmail: async () => JSON.stringify({ ok: false, error }),
    imap: async () => JSON.stringify({ ok: false, error }),
    hey: async () => JSON.stringify({ ok: false, error }),
  });

for (const [said, operation] of [
  ["Google's reply could not be read", (a) => a.gmail.status("f")],
  ["Gmail sign-in timed out", (a) => a.gmail.begin(1000)],
  [
    "That is not a Google client ID. It ends in .apps.googleusercontent.com",
    (a) => a.gmail.saveClient("nope", ""),
  ],
  ["mail server transport failed", (a) => a.imap.verifyAndStore({}, 1000)],
  ["the HEY CLI is not installed", (a) => a.hey.status(1000)],
])
  await assert.rejects(
    () => operation(speaking(said)),
    (error) => error.reason === said,
    `the host said "${said}" and the adapter did not carry it`,
  );

// A reason this cannot vouch for is no reason at all: the caller falls back to
// its own wording rather than drawing whatever arrived.
for (const noisy of ["", "   ", "x".repeat(200), "broke\u0000n", 7, null])
  await assert.rejects(
    () => speaking(noisy).gmail.status("f"),
    (error) => error.reason === undefined && error.message === "Setup host failed",
    `a reason of ${JSON.stringify(noisy)} should not have been carried`,
  );

// And a reason that could carry a credential is redacted before it can reach a
// label, which is the rule `providers/OAuth.js` states and this is the last
// place on that journey.
await assert.rejects(
  () =>
    speaking(
      'refused code=4/0AeanS0 and refresh_token=1//04xy plus "access_token":"ya29.z"',
    ).gmail.status("f"),
  (error) =>
    error.reason ===
    'refused code=[redacted] and refresh_token=[redacted] plus "access_token":"[redacted]"',
);

// A credential operation says both what happened to the credential and why.
await assert.rejects(
  () =>
    createSetupAdapters({
      gmail: async () =>
        JSON.stringify({
          ok: false,
          credentialOutcome: "beforeEffect",
          error: "invalid Gmail sign-in request",
        }),
      imap: async () => "{}",
      hey: async () => "{}",
    }).gmail.revokeLocal("a@example.test", "1.apps.googleusercontent.com"),
  (error) =>
    error.credentialOutcome === "beforeEffect" &&
    error.reason ===
      "Credential was not changed — invalid Gmail sign-in request",
);

console.log("setup adapter tests passed");
