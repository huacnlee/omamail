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
assert.equal(
  asynchronous.snapshot().notice,
  "Sent",
  "a send reports through the toast: by the time it answers, the composer is gone",
);
assert.equal(asyncNotifications, 1);
asynchronous.update({ to: "person@example.test", subject: "Try again" });
asynchronous.send(0, 0);
assert.equal(asynchronous.snapshot().sending, true);
asyncDone({ ok: false, error: "Mailbox unavailable" });
assert.equal(asynchronous.snapshot().sending, false);
assert.equal(
  asynchronous.snapshot().notice,
  "Mailbox unavailable",
  "a send that failed after the composer closed still says so",
);
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
assert.equal(
  compose.snapshot().draft.from,
  undefined,
  "`from` is the identity a draft is sent as, and nobody has chosen one",
);
assert.equal(
  compose.snapshot().draft.originalFrom,
  "Ada <ada@example.test>",
  "the original's own sender is kept apart, to pick the reply identity by",
);
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
guarded.update({ to: "person@example.test" });
guarded.send(1_000, 10);
assert.ok(guarded.snapshot().pending);
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

// --------------------------------------------- a queued send leaves the form
//
// The one mechanism behind the undo window: pressing Send takes the draft out
// of the composer and puts it in the outbox, which the form cannot reach. Every
// assertion below is a symptom of not doing that.

const parkedSends = [];
let parkedQueued = 0;
let fakeNow = 1_000;
const parked = createComposeController({
  clock: () => fakeNow,
  currentAccountId: () => "one@example.test",
  onQueued() {
    parkedQueued += 1;
  },
  send(payload, done) {
    parkedSends.push(payload);
    done({ ok: true });
  },
});
parked.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  subject: "Queued",
  body: "Body",
});
parked.send(fakeNow, 10);
assert.equal(
  parkedQueued,
  1,
  "the window is told the form is finished with, so it can go back to the list",
);
assert.deepEqual(
  {
    to: parked.snapshot().draft.to,
    subject: parked.snapshot().draft.subject,
    body: parked.snapshot().draft.body,
  },
  { to: "", subject: "", body: "" },
  "a queued send has left the composer, so the form is empty behind it",
);
assert.equal(
  parked.snapshot().draft.accountId,
  "one@example.test",
  "the mailbox stays: the next message written here belongs to it too",
);
assert.equal(parked.snapshot().pending.payload.subject, "Queued");

// The countdown counts, because it is read against the clock rather than
// against the state. This is what a single sleep for the whole delay could not
// do: the toast read "Sending in 10s" for ten seconds.
assert.equal(parked.snapshot().undoSeconds, 10);
fakeNow = 4_000;
assert.equal(parked.snapshot().undoSeconds, 7);
parked.tick();
assert.equal(parked.snapshot().undoSeconds, 7);
assert.equal(parkedSends.length, 0, "a beat before the message is due sends nothing");

// A keystroke during the undo window edits the next message, not the queued
// one. It used to drop the pending send with no notice at all.
parked.update({ to: "somebody@example.test", body: "A different message" });
assert.ok(
  parked.snapshot().pending,
  "typing during the undo window cannot cancel the send",
);
assert.equal(parked.snapshot().pending.payload.body, "Body");
assert.equal(
  parked.snapshot().pending.payload.to,
  "person@example.test",
  "the queued payload is a snapshot and is not re-read from the form",
);

// The beat that finds it due is the one that sends it.
fakeNow = 11_000;
parked.tick();
assert.equal(parkedSends.length, 1);
assert.equal(parkedSends[0].body, "Body");
assert.equal(parked.snapshot().pending, null);
assert.equal(
  parked.snapshot().draft.body,
  "A different message",
  "the message that went out was never the one being written",
);
assert.equal(parked.snapshot().notice, "Sent");
assert.equal(parked.snapshot().needsTick, true, "a toast is still on screen");
fakeNow = 16_000;
parked.tick();
assert.equal(parked.snapshot().notice, "", "a toast has four seconds");
assert.equal(parked.snapshot().needsTick, false, "nothing left to beat for");

// Undo puts the queued message back where it came from, and hands over what it
// displaced rather than writing over it.
const restoring = createComposeController({
  clock: () => fakeNow,
  currentAccountId: () => "one@example.test",
  send(payload, done) {
    parkedSends.push(payload);
    done({ ok: true });
  },
});
restoring.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  subject: "Take it back",
  body: "Wait",
});
restoring.showCc();
restoring.attach({ filename: "notes.txt", size: 4, data: "y" });
restoring.send(fakeNow, 10);
restoring.update({ to: "other@example.test", body: "Started meanwhile" });
const undone = restoring.undo();
assert.equal(undone.restored, true);
assert.equal(restoring.snapshot().pending, null);
assert.equal(restoring.snapshot().draft.subject, "Take it back");
assert.equal(restoring.snapshot().draft.body, "Wait");
assert.equal(
  restoring.snapshot().ccVisible,
  true,
  "the form comes back the way it was left, copy rows included",
);
assert.equal(
  restoring.snapshot().attachments.length,
  1,
  "and carrying what was attached to it",
);
assert.equal(
  undone.interrupted.body,
  "Started meanwhile",
  "what was started during the undo window is handed back to be saved",
);
assert.equal(undone.interrupted.save, true);
assert.equal(restoring.snapshot().notice, "Send undone");
restoring.undo();
assert.equal(
  restoring.snapshot().draft.subject,
  "Take it back",
  "a second undo has nothing to take back and changes nothing",
);

// Undoing with an empty form displaces nothing worth saving.
restoring.discard();
restoring.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  body: "Only draft",
});
restoring.send(fakeNow, 10);
assert.equal(restoring.undo().interrupted, null);

// Discard is the exit for the draft on the form. A message queued from an
// earlier one is not that draft.
restoring.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  body: "Going out",
});
restoring.send(fakeNow, 10);
restoring.update({ body: "A second message" });
restoring.discard();
assert.ok(
  restoring.snapshot().pending,
  "discarding a later draft cannot destroy a message already queued",
);

// Closing the window spends the rest of the undo window rather than the
// message: nothing queued may end as a send nobody made and nobody was told
// about.
const drained = restoring.drain();
assert.equal(drained.drained, true);
assert.equal(
  parkedSends[parkedSends.length - 1].body,
  "Going out",
  "a queued message goes out at once rather than dying with the process",
);
assert.equal(restoring.snapshot().pending, null);
assert.equal(restoring.drain().drained, false, "draining twice sends nothing twice");

// A window with no undo window is the same mechanism with the delay already
// spent, not a second path through the form.
const immediate = createComposeController({
  currentAccountId: () => "one@example.test",
  onQueued() {
    parkedQueued += 1;
  },
  send(payload, done) {
    parkedSends.push(payload);
    done({ ok: true });
  },
});
immediate.compose({
  accountId: "one@example.test",
  to: "person@example.test",
  body: "No delay",
});
const before = parkedQueued;
immediate.send(0, 0);
assert.equal(parkedQueued, before + 1, "an immediate send leaves the form too");
assert.equal(immediate.snapshot().draft.body, "");
assert.equal(parkedSends[parkedSends.length - 1].body, "No delay");

// ------------------------------------------------------------ the form itself

const form = createComposeController({
  currentAccountId: () => "one@example.test",
  send(_payload, done) {
    done({ ok: true });
  },
});
form.useIdentities([
  {
    id: "one@example.test",
    ready: true,
    email: "me@example.test",
    displayName: "Ada",
    label: "Personal",
    aliases: [
      { email: "me@example.test", displayName: "Ada" },
      { email: "work@example.net", displayName: "Ada at Work" },
    ],
  },
  {
    id: "two@example.test",
    ready: true,
    email: "other@example.test",
    aliases: [],
  },
]);
form.compose({ accountId: "one@example.test" });
assert.equal(form.snapshot().title, "New message");
assert.equal(
  form.snapshot().identities.length,
  3,
  "a new message may be sent as any address on any signed-in mailbox",
);
assert.equal(form.snapshot().canChooseFrom, true);
assert.equal(form.snapshot().draft.from, "me@example.test");
assert.equal(form.snapshot().fromMenuOpen, false);
form.toggleFromMenu();
assert.equal(form.snapshot().fromMenuOpen, true);
form.chooseFrom({ accountId: "two@example.test", email: "other@example.test" });
assert.equal(form.snapshot().fromMenuOpen, false);
assert.equal(form.snapshot().draft.from, "other@example.test");
assert.equal(
  form.snapshot().draft.accountId,
  "two@example.test",
  "choosing an address on another mailbox moves the draft there with it",
);
form.useIdentities([]);
assert.equal(
  form.snapshot().draft.from,
  "other@example.test",
  "a chosen identity survives the alias list being rebuilt",
);

const answering = createComposeController({});
answering.useIdentities([
  {
    id: "one@example.test",
    ready: true,
    email: "me@example.test",
    aliases: [{ email: "me@example.test" }, { email: "team@example.net" }],
  },
  { id: "two@example.test", ready: true, email: "elsewhere@example.test" },
]);
answering.reply({
  accountId: "one@example.test",
  subject: "Topic",
  from: { email: "ada@example.test" },
  to: "team@example.net",
});
assert.equal(answering.snapshot().title, "Reply");
assert.equal(
  answering
    .snapshot()
    .identities.every((identity) => identity.accountId === "one@example.test"),
  true,
  "a reply stays on the mailbox that holds the original",
);
assert.equal(
  answering.snapshot().draft.from,
  "team@example.net",
  "the alias the thread copied you on beats the account's first",
);
answering.replyAll(
  {
    accountId: "one@example.test",
    subject: "Topic",
    from: { email: "ada@example.test" },
    to: "me@example.test",
    cc: "copy@example.test",
  },
  "me@example.test",
);
assert.equal(answering.snapshot().title, "Reply all");
assert.equal(
  answering.snapshot().ccVisible,
  true,
  "a reply-all that fills Cc reveals the row carrying it",
);
assert.equal(answering.snapshot().bccVisible, false);
answering.showBcc();
assert.equal(answering.snapshot().bccVisible, true);
answering.forward({ accountId: "one@example.test", subject: "Topic" });
assert.equal(answering.snapshot().title, "Forward");
assert.equal(
  answering.snapshot().ccVisible,
  false,
  "a new draft starts with the copy rows the new draft actually needs",
);
answering.draft({
  accountId: "one@example.test",
  draftId: "draft-9",
  to: "person@example.test",
});
assert.equal(answering.snapshot().title, "Draft");
assert.equal(
  answering.snapshot().draft.mode,
  "new",
  "a stored draft is titled from its id; the wire mode stays one the gate allows",
);

// ------------------------------------------------------------- completion

const completing = createComposeController({});
completing.compose({ accountId: "one@example.test" });
completing.useContacts([
  { name: "Ada Lovelace", email: "ada@example.test" },
  { name: "Adam Smith", email: "adam@example.test" },
  { name: "Grace Hopper", email: "grace@example.test" },
]);
completing.update({ to: "ad" });
assert.equal(
  completing.snapshot().suggestions.contacts.length,
  0,
  "an unfocused field offers nothing: the popup belongs to what is being typed",
);
completing.focusRecipients("to");
assert.equal(completing.snapshot().suggestions.field, "to");
assert.equal(completing.snapshot().suggestions.contacts.length, 2);
assert.equal(completing.snapshot().suggestions.highlighted, -1);
completing.moveSuggestion(-1);
assert.equal(
  completing.snapshot().suggestions.highlighted,
  1,
  "arrowing up from nowhere lands on the last row",
);
completing.moveSuggestion(1);
assert.equal(completing.snapshot().suggestions.highlighted, 1);
completing.moveSuggestion(-1);
completing.acceptSuggestion();
assert.equal(completing.snapshot().draft.to, "Ada Lovelace <ada@example.test>");
assert.equal(
  completing.snapshot().suggestions.highlighted,
  -1,
  "the popup is offering completions for text that has just been replaced",
);
completing.focusRecipients("");
assert.equal(completing.snapshot().suggestions.contacts.length, 0);

// ------------------------------------------------------------ attachments

let outgoing = null;
const files = createComposeController({
  currentAccountId: () => "one@example.test",
  send(payload, done) {
    outgoing = payload;
    done({ ok: true });
  },
});
files.forward({ accountId: "one@example.test", subject: "Topic" });
files.update({ to: "person@example.test" });
files.loadingForwardAttachments([{ filename: "report.pdf", size: 12 }]);
assert.equal(files.snapshot().forward.loading, true);
files.send(0, 0);
assert.equal(
  outgoing,
  null,
  "a forward whose files are still arriving cannot be sent without them",
);
files.loadedForwardAttachments([], "That attachment could not be read");
files.send(0, 0);
assert.equal(
  outgoing,
  null,
  "a forward whose read failed cannot go out claiming to carry them",
);
assert.equal(
  files.snapshot().forward.error,
  "That attachment could not be read",
);
files.loadedForwardAttachments([
  { filename: "report.pdf", size: 12, data: "x" },
]);
assert.equal(files.snapshot().forward.loading, false);
files.setAttaching();
assert.equal(files.snapshot().attaching, true);
files.attach({ filename: "notes.txt", size: 4, data: "y", path: "/tmp/n" });
assert.equal(files.snapshot().attaching, false);
assert.equal(files.snapshot().attachments.length, 1);
files.send(0, 0);
assert.deepEqual(
  outgoing.attachments.map((file) => file.filename),
  ["report.pdf", "notes.txt"],
  "a forward carries the original's files ahead of the draft's own",
);
assert.equal(
  files.snapshot().attachments.length,
  0,
  "a sent draft leaves nothing attached to the next one",
);
files.compose({ accountId: "one@example.test" });
files.attach({ filename: "pasted.png", size: 8, path: "/tmp/p", owned: true });
const detached = files.detach(0);
assert.equal(
  detached.removed.path,
  "/tmp/p",
  "a pasted file is a temporary this window owns and has to be told about",
);
assert.equal(files.snapshot().attachments.length, 0);
assert.equal(
  files.detach(3).removed,
  undefined,
  "removing a file that is not there removes nothing and reports nothing",
);

files.setNotice("Draft saved");
assert.equal(files.snapshot().notice, "Draft saved");
files.discard();
assert.equal(files.snapshot().notice, "");

// -------------------------------------------------- a draft comes back whole

// `Message.draftFields` restores the threading with the fields, and reopening
// a saved reply without it is a message that answers nothing: no client files
// it under the conversation, and the person who was replied to gets a second
// thread. The From comes back too, or a reply written from an alias silently
// moves to the account's default on the way back in.
const reopened = createComposeController({
  currentAccountId: () => "one@example.test",
  send() {},
});
reopened.useIdentities([
  { id: "one@example.test", email: "one@example.test", provider: "gmail" },
]);
reopened.draft({
  accountId: "one@example.test",
  draftId: "r-99",
  to: [{ email: "ada@example.test" }],
  subject: "Re: Plans",
  body: "Half a sentence",
  threadId: "t-7",
  inReplyTo: "<first@example.test>",
  references: "<older@example.test> <first@example.test>",
  from: { email: "alias@example.test", display: "Alias" },
});
const restored = reopened.snapshot();
assert.equal(restored.draft.threadId, "t-7");
assert.equal(restored.draft.inReplyTo, "<first@example.test>");
assert.equal(
  restored.draft.references,
  "<older@example.test> <first@example.test>",
  "the whole chain the draft was saved with, not the one hop it could be rebuilt from",
);
assert.equal(
  restored.draft.from,
  "alias@example.test",
  "the bare mailbox, because the identity list is matched by address",
);
assert.equal(
  restored.title,
  "Draft",
  "a stored draft is named by its draftId, not by a mode of its own",
);
assert.equal(
  restored.draft.mode,
  "new",
  'the wire mode is a fixed list and "draft" must never reach it',
);

// -------------------------------------------------------- what leaving saves

const leaving = createComposeController({
  currentAccountId: () => "one@example.test",
  send() {},
});
leaving.compose({ accountId: "one@example.test" });
assert.equal(
  leaving.unsavedDraft(),
  null,
  "an untouched form has nothing worth writing to Drafts",
);
leaving.update({ subject: "Half written" });
const unsaved = leaving.unsavedDraft();
assert.equal(unsaved.subject, "Half written");
assert.equal(unsaved.save, true);
leaving.compose({ accountId: "one@example.test" });
leaving.attach({ filename: "notes.txt", size: 4, path: "/tmp/n" });
assert.equal(
  leaving.unsavedDraft()?.attachments.length,
  1,
  "a form holding only a file is still worth saving",
);

// A toast raised from outside a beat has to wake the window's clock.
//
// The send is queued, the countdown runs it down, the outbox empties and the
// window's clock loop ends because nothing is left to redraw. Only *then* does
// the host answer, and `finishSend` puts "Sent" up — against a clock that is no
// longer running. Nothing retired it, so the toast stayed for the life of the
// window. `onNotice` is what makes the window start beating again.
let clockStarts = 0;
let deliver = null;
let late = 5_000;
const lateAnswer = createComposeController({
  clock: () => late,
  currentAccountId: () => "one@example.test",
  send: (_draft, done) => {
    deliver = done;
  },
  onNotice: () => {
    clockStarts += 1;
  },
});
lateAnswer.compose({
  accountId: "one@example.test",
  to: "someone@example.test",
  subject: "Hello",
  body: "Body",
});
lateAnswer.send(late, 0);
assert.equal(clockStarts, 0, "queueing a send raises no toast of its own");
// The undo window is over and the outbox is empty: this is the moment the
// window stops beating.
assert.equal(lateAnswer.snapshot().pending, null);
assert.equal(lateAnswer.snapshot().notice, "");
assert.equal(lateAnswer.snapshot().needsTick, false);
// The host answers now.
deliver({ ok: true });
assert.equal(lateAnswer.snapshot().notice, "Sent");
assert.equal(
  lateAnswer.snapshot().needsTick,
  true,
  "the toast is up, so something has to be beating",
);
assert.equal(clockStarts, 1, "and the window was told to start beating again");
// And one beat past its four seconds takes it down, which is what the window
// could never reach before.
late += 4_000;
lateAnswer.tick(late);
assert.equal(lateAnswer.snapshot().notice, "");
assert.equal(lateAnswer.snapshot().needsTick, false);

// A failure says so on the same mechanism, and an emptied notice wakes nothing.
deliver = null;
lateAnswer.compose({
  accountId: "one@example.test",
  to: "someone@example.test",
  subject: "Hello",
  body: "Body",
});
lateAnswer.send(late, 0);
deliver({ ok: false, error: "refused" });
assert.equal(lateAnswer.snapshot().notice, "refused");
assert.equal(clockStarts, 2);
lateAnswer.setNotice("");
assert.equal(clockStarts, 2, "taking a toast down is not a reason to beat");

console.log("compose controller tests passed");
