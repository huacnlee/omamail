import assert from "node:assert/strict";

import { createApplicationState, reduceApplicationState } from "../app/application/state.js";
import {
  accountCanSend,
  accountIn,
  providerFor,
  sendRefusal,
  unavailableWriting,
  senderRows,
} from "../app/application/account-capabilities.js";
import { identities } from "../app/compose/Senders.js";

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

// An IMAP mailbox with no SMTP server: a supported setup the form offers, and
// a mailbox that reads and cannot answer. The provider still declares `send` —
// this is the account narrowing it, the way HEY's missing star is the provider
// declaring it.
const readOnly = {
  id: "imap:read@example.test",
  email: "read@example.test",
  provider: "imap",
  imap: {
    username: "read@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
  },
};
const sending = {
  ...readOnly,
  id: "imap:writer@example.test",
  email: "writer@example.test",
  imap: { ...readOnly.imap, smtpHost: "smtp.example.test" },
};
assert.equal(accountCanSend(sending), true);
assert.equal(accountCanSend(readOnly), false);
assert.equal(
  accountCanSend({ id: "hey:me@example.test", provider: "hey" }),
  true,
  "only IMAP names its own outgoing server",
);
assert.equal(providerFor(sending).capabilities.send, true);
assert.equal(providerFor(readOnly).capabilities.send, false);
assert.equal(
  providerFor(readOnly).capabilities.star,
  true,
  "narrowing send leaves every other capability the provider declares",
);
assert.equal(
  providerFor(readOnly).id,
  "imap",
  "and leaves the provider it is still a mailbox of",
);
assert.deepEqual(unavailableWriting(providerFor(sending).capabilities), []);
assert.deepEqual(unavailableWriting(providerFor(readOnly).capabilities), [
  "compose",
  "reply",
  "replyAll",
  "forward",
]);
assert.equal(sendRefusal(sending), "");
assert.equal(
  sendRefusal(readOnly),
  "This mailbox has no SMTP server set, so it cannot send",
);
assert.equal(
  accountIn({ accounts: { accounts: [readOnly, sending], activeId: sending.id } }),
  sending,
);
assert.equal(accountIn(undefined), null);

// A host that is present and unusable is not an absent one, and must not buy a
// mailbox its way past the checks by looking read-only.
assert.equal(
  accountCanSend({ ...readOnly, imap: { ...readOnly.imap, smtpHost: "a b c" } }),
  false,
);

// The From picker was empty for every mailbox in the client.
//
// `Senders.identities` skips any row whose `ready` is not exactly `true`, which
// in the QML is `MailAccount.ready` — `setupState === "ready" && !!api`. That is
// a live property of a live object, and the window was handing `useIdentities`
// the account records straight off disk, which have no such field. Every row was
// skipped, so `canChooseFrom` was false everywhere and the picker never opened.
{
  const stored = [
    { id: "gmail:a@example.test", email: "a@example.test", provider: "gmail", label: "Work" },
    {
      id: "imap:b@example.test",
      email: "b@example.test",
      provider: "imap",
      imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test", smtpPort: 465 },
    },
    {
      id: "imap:c@example.test",
      email: "c@example.test",
      provider: "imap",
      imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "", smtpPort: 0 },
    },
    { id: "gmail:d@example.test", email: "d@example.test", provider: "gmail" },
  ];
  assert.equal(
    identities(stored).length,
    0,
    "a stored record carries no `ready`, which is the bug this guards",
  );

  const rows = senderRows(stored, {
    "gmail:d@example.test": "Account setup could not be saved",
  });
  assert.deepEqual(
    identities(rows).map((entry) => entry.email),
    ["a@example.test", "b@example.test"],
  );
  // A mailbox with no SMTP server is not a From address — it cannot send.
  assert.equal(identities(rows).some((entry) => entry.email === "c@example.test"), false);
  // Nor is one the host refused a context for: that refusal is what `!!api`
  // stood for, so it cannot fetch and it cannot send.
  assert.equal(identities(rows).some((entry) => entry.email === "d@example.test"), false);
  // An account with no id at all is skipped rather than made ready.
  assert.equal(senderRows([{ email: "x@example.test" }])[0].ready, false);
  assert.deepEqual(senderRows(null), []);
}

console.log("app state tests passed");
