import assert from "node:assert/strict";

import {
  createMailState,
  reduceMailState,
} from "../app/application/mail-state.js";
import { detailSummary } from "../app/account/Model.js";

const mergedHeyDetail = detailSummary(
  {
    id: "1:2",
    subject: "Lunch on Friday",
    from: { name: "Jane", email: "jane@example.com" },
    date: "2026-08-20T10:00:00Z",
    time: "10:00",
    fullTime: "Aug 20, 2026 10:00",
  },
  {
    id: "1:2",
    threadId: "2",
    body: "Hello",
    date: "2026-08-20T10:00:00Z",
  },
);
assert.equal(mergedHeyDetail.subject, "Lunch on Friday");
assert.equal(mergedHeyDetail.from.email, "jane@example.com");
assert.equal(mergedHeyDetail.fullTime, "Aug 20, 2026 10:00");

const empty = createMailState("one@example.com", "gmail");
assert.equal(empty.accountId, "one@example.com");
assert.equal(empty.mailboxKey, "inbox");
assert.deepEqual(empty.messages, []);

const loading = reduceMailState(empty, { type: "load", query: "in:inbox" });
assert.equal(loading.loading, true);
assert.equal(loading.request.revision, 1);
assert.equal(empty.loading, false);

const stale = reduceMailState(loading, {
  type: "list-loaded",
  request: { ...loading.request, revision: 0 },
  messages: [{ id: "stale" }],
});
assert.equal(stale, loading, "an old result cannot replace a newer request");

const listed = reduceMailState(loading, {
  type: "list-loaded",
  request: loading.request,
  messages: [
    { id: "a", labelIds: ["INBOX", "UNREAD"] },
    { id: "b", labelIds: ["INBOX"] },
  ],
});
assert.equal(listed.loading, false);
assert.equal(listed.cursorId, "a");
assert.equal(listed.selectedId, null);
assert.equal(listed.nextPageToken, "");

const pageable = reduceMailState(loading, {
  type: "list-loaded",
  request: loading.request,
  messages: [{ id: "a" }],
  nextPageToken: "next-1",
});
assert.equal(pageable.nextPageToken, "next-1");
const loadingMore = reduceMailState(pageable, { type: "load-more" });
assert.equal(loadingMore.loadingMore, true);
const appended = reduceMailState(loadingMore, {
  type: "page-loaded",
  request: loadingMore.request,
  messages: [{ id: "b" }, { id: "a" }],
  nextPageToken: "",
});
assert.deepEqual(
  appended.messages.map((message) => message.id),
  ["a", "b"],
);
assert.equal(appended.loadingMore, false);

const duplicatePage = reduceMailState(loadingMore, {
  type: "page-loaded",
  request: loadingMore.request,
  messages: [{ id: "b" }, { id: "b" }, { id: "c" }],
  nextPageToken: "next-2",
});
assert.deepEqual(
  duplicatePage.messages.map((message) => message.id),
  ["a", "b", "c"],
  "duplicates within one page are discarded too",
);

const failedPage = reduceMailState(loadingMore, {
  type: "load-failed",
  request: loadingMore.request,
  pageToken: "next-1",
  error: "Temporary failure",
});
assert.equal(failedPage.failedPageToken, "next-1");
assert.deepEqual(
  failedPage.messages,
  loadingMore.messages,
  "a failed continuation preserves loaded rows",
);

const mailbox = reduceMailState(listed, {
  type: "mailbox-changed",
  mailboxKey: "sent",
  query: "in:sent",
});
assert.equal(mailbox.mailboxKey, "sent");
assert.equal(mailbox.query, "in:sent");
assert.deepEqual(mailbox.messages, []);

const moved = reduceMailState(listed, { type: "move-cursor", offset: 1 });
assert.equal(moved.cursorId, "b");
assert.equal(
  moved.selectedId,
  null,
  "moving the keyboard cursor does not open a message",
);
const opened = reduceMailState(moved, { type: "open-cursor" });
assert.equal(opened.selectedId, "b");

const refused = reduceMailState(opened, {
  type: "act",
  action: "archive",
  messageId: "b",
  capabilities: { archive: false },
  providerName: "HEY",
});
assert.equal(
  refused.messages,
  opened.messages,
  "refusal happens before optimistic mutation",
);
assert.equal(refused.status, "HEY has no archive");

const archived = reduceMailState(opened, {
  type: "act",
  action: "archive",
  messageId: "b",
  capabilities: { archive: true },
  providerName: "Gmail",
});
assert.deepEqual(
  archived.messages.map((message) => message.id),
  ["a"],
);
assert.equal(archived.selectedId, null);
assert.equal(archived.cursorId, "a");

const switched = reduceMailState(archived, {
  type: "account-changed",
  accountId: "imap:two@example.com",
  providerId: "imap",
});
assert.deepEqual(switched.messages, []);
assert.equal(switched.request.revision > archived.request.revision, true);

console.log("mail state tests passed");
