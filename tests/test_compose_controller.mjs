import assert from "node:assert/strict";
import { createComposeController } from "../app/compose/controller.js";

const sent = [];
let activeAccountId = "one@example.test";
const compose = createComposeController({
  currentAccountId: () => activeAccountId,
  send(draft, done) {
    sent.push(draft);
    return { cancel() {} };
  },
});
compose.compose({
  accountId: "one@example.test",
  to: "Ada\r\nBcc: bad@example.test",
  subject: "Hi\nBcc: bad",
  body: "Hello",
});
assert.equal(
  compose.snapshot().draft.to.includes("\n"),
  false,
  "draft headers cannot retain injected lines",
);
assert.equal(compose.snapshot().draft.subject.includes("\n"), false);
compose.send(1_000, 10);
assert.equal(sent.length, 0, "undo delay holds the send");
const firstDueAt = compose.snapshot().pending.dueAt;
compose.undo();
compose.send(2_000, 10);
compose.flush(12_000, firstDueAt);
assert.equal(sent.length, 0, "a retired timer cannot flush a later send");
compose.undo();
compose.send(1_000, 0);
assert.equal(sent.length, 1);

const invalid = createComposeController({
  send() {
    throw new Error("invalid drafts must not reach the host");
  },
});
invalid.compose({ subject: "Missing recipient", body: "Hello" });
invalid.send(0, 0);
assert.equal(invalid.snapshot().status, "Add a recipient.");
assert.equal(invalid.snapshot().sending, false);

let asyncDone;
let asyncNotifications = 0;
const asynchronous = createComposeController({
  send(_draft, done) {
    asyncDone = done;
  },
  notify() {
    asyncNotifications += 1;
  },
});
asynchronous.compose({ to: "person@example.test", body: "Hello" });
asynchronous.send(0, 0);
assert.equal(asynchronous.snapshot().sending, true);
asyncDone({ ok: true });
assert.equal(asynchronous.snapshot().sending, false);
assert.equal(asynchronous.snapshot().status, "Sent");
assert.equal(asyncNotifications, 1);
asynchronous.update({ to: "person@example.test", subject: "Try again" });
asynchronous.send(0, 0);
assert.equal(asynchronous.snapshot().sending, true);
asyncDone({ ok: false, error: "Mailbox unavailable" });
assert.equal(asynchronous.snapshot().sending, false);
assert.equal(asynchronous.snapshot().status, "Mailbox unavailable");
assert.equal(asyncNotifications, 2);

compose.mailto({
  to: "person@example.test\nBcc: injected",
  subject: "Hello\r\nX: bad",
  body: "Body",
});
assert.equal(compose.snapshot().draft.mode, "mailto");
assert.equal(compose.snapshot().draft.to.includes("\n"), false);
compose.reply({
  id: "message-1",
  threadId: "thread-1",
  messageId: "<message-1@example.test>",
  inReplyTo: "<parent@example.test>",
  references: "<root@example.test> <parent@example.test>",
  subject: "Topic",
  replyTo: "reply@example.test",
  from: { display: "Ada", email: "ada@example.test" },
  to: "me@example.test, team@example.test",
  cc: "copy@example.test",
  fullTime: "Monday",
  body: "Original body",
});
assert.equal(compose.snapshot().draft.subject, "Re: Topic");
assert.match(compose.snapshot().draft.body, /> Original body/);
assert.equal(compose.snapshot().draft.threadId, "thread-1");
assert.equal(compose.snapshot().draft.messageId, "<message-1@example.test>");
assert.equal(compose.snapshot().draft.inReplyTo, "<message-1@example.test>");
assert.equal(
  compose.snapshot().draft.references,
  "<root@example.test> <parent@example.test> <message-1@example.test>",
);
assert.equal(compose.snapshot().draft.from, "Ada <ada@example.test>");
assert.equal(
  compose.snapshot().draft.originalTo,
  "me@example.test, team@example.test",
);
assert.equal(compose.snapshot().draft.originalCc, "copy@example.test");
compose.reply({
  id: "hey-posting:topic",
  subject: "HEY topic",
  from: { name: "Jane", email: "jane@example.com" },
  fullTime: "Aug 20, 2026 10:00",
  body: "HEY body",
});
assert.equal(compose.snapshot().draft.subject, "Re: HEY topic");
assert.match(
  compose.snapshot().draft.body,
  /^On Aug 20, 2026 10:00, Jane wrote:\n> HEY body$/,
);
assert.equal(compose.snapshot().draft.body.includes("undefined"), false);
compose.replyAll(
  {
    subject: "Topic",
    replyTo: "reply@example.test",
    from: { display: "Ada", email: "ada@example.test" },
    to: "me@example.test, team@example.test",
    cc: "copy@example.test",
  },
  "me@example.test",
);
assert.equal(compose.snapshot().draft.mode, "replyAll");
assert.equal(
  compose.snapshot().draft.to,
  "reply@example.test, team@example.test",
);
assert.equal(compose.snapshot().draft.cc, "copy@example.test");
compose.replyAll(
  {
    subject: "Array recipients",
    from: { email: "sender@example.test" },
    to: [
      { email: "me@example.test" },
      { display: "Team", email: "team@example.test" },
    ],
    cc: [{ email: "copy@example.test" }],
  },
  "me@example.test",
);
assert.equal(
  compose.snapshot().draft.to,
  "sender@example.test, Team <team@example.test>",
);
compose.forward({
  accountId: "one@example.test",
  threadId: "thread-forward-must-clear",
  messageId: "<forward@example.test>",
  subject: "Fwd: Topic",
  body: "Forward body",
  from: { display: "Ada" },
});
assert.equal(compose.snapshot().draft.subject, "Fwd: Topic");
assert.match(compose.snapshot().draft.body, /> Forward body/);
assert.equal(compose.snapshot().draft.threadId, undefined);
assert.equal(compose.snapshot().draft.inReplyTo, undefined);
activeAccountId = "two@example.test";
const accountBound = createComposeController({
  currentAccountId: () => activeAccountId,
  send() {
    throw new Error("must not send");
  },
});
accountBound.compose({
  accountId: "one@example.test",
  to: "person@example.test",
});
accountBound.send(0, 0);
assert.equal(
  accountBound.snapshot().status,
  "This draft belongs to another account.",
);
assert.equal(
  sent.length,
  1,
  "switching accounts cannot send the old account's draft",
);
activeAccountId = "one@example.test";

let savedDraft;
const drafts = createComposeController({
  currentAccountId: () => "one@example.test",
  send(payload, done) {
    savedDraft = payload;
    done({ ok: true, value: { id: "draft-1" } });
  },
});
drafts.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  body: "Keep me",
});
drafts.save();
assert.equal(savedDraft.save, true);
assert.equal(drafts.snapshot().draft.draftId, "draft-1");
assert.equal(drafts.snapshot().status, "Draft saved");
drafts.update({ body: "Updated" });
drafts.save();
assert.equal(
  savedDraft.draftId,
  "draft-1",
  "saving an opened draft updates its server id",
);
let staleSaveDone;
const staleDraft = createComposeController({
  currentAccountId: () => activeAccountId,
  send(_payload, done) {
    staleSaveDone = done;
  },
});
staleDraft.compose({
  accountId: "one@example.test",
  to: "person@example.test",
});
staleDraft.save();
staleDraft.update({ subject: "newer edit" });
staleSaveDone({ ok: true, value: { id: "stale-id" } });
assert.equal(staleDraft.snapshot().draft.draftId, undefined);
let sentRoute = 0;
const consumedDraft = createComposeController({
  currentAccountId: () => "one@example.test",
  onSent() {
    sentRoute += 1;
  },
  send(_payload, done) {
    done({ ok: true });
  },
});
consumedDraft.draft({
  accountId: "one@example.test",
  draftId: "draft-1",
  to: "person@example.test",
  body: "Send",
});
consumedDraft.send();
assert.equal(sentRoute, 1);
assert.equal(consumedDraft.snapshot().draft.draftId, undefined);

const callbacks = [];
let completionNotifications = 0;
const guarded = createComposeController({
  send(_draft, done) {
    callbacks.push(done);
  },
  notify() {
    completionNotifications += 1;
  },
});
guarded.compose({ subject: "First" });
guarded.update({ to: "person@example.test" });
guarded.send(0, 0);
assert.equal(guarded.snapshot().sending, true);
guarded.send(0, 0);
assert.equal(callbacks.length, 1, "a pending send cannot be submitted twice");
guarded.update({ subject: "New draft" });
callbacks.shift()({ ok: false, error: "old failure" });
assert.equal(
  completionNotifications,
  1,
  "host completion invalidates the retained compose presentation",
);
assert.equal(
  guarded.snapshot().status,
  "",
  "stale send completion cannot mark the newer draft",
);
guarded.send(1_000, 10);
assert.ok(guarded.snapshot().pending);
guarded.update({ subject: "replacement" });
guarded.flush(20_000);
assert.equal(
  callbacks.length,
  0,
  "editing cancels the obsolete delayed payload",
);
assert.equal(guarded.snapshot().pending, null);
guarded.undo();
guarded.flush(20_000);
assert.equal(callbacks.length, 0, "undo prevents a delayed send from flushing");
guarded.update({ body: "Throw this away" });
guarded.discard();
assert.deepEqual(guarded.snapshot().draft, {
  accountId: "",
  mode: "new",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
});
console.log("compose controller tests passed");
