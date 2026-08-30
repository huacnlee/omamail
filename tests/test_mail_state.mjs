import assert from "node:assert/strict";

import {
  SIGNED_OUT,
  createMailState,
  isSignedOut,
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

// A row that leaves from somewhere other than the cursor takes the cursor
// nowhere: the row's own button and the context menu both act on a message the
// keyboard is not standing on.
const elsewhere = reduceMailState(listed, {
  type: "act",
  action: "archive",
  messageId: "b",
  capabilities: { archive: true },
  providerName: "Gmail",
});
assert.equal(elsewhere.cursorId, "a");
const wide = reduceMailState(loading, {
  type: "list-loaded",
  request: loading.request,
  messages: [{ id: "a" }, { id: "b" }, { id: "c" }],
});
const middle = reduceMailState(wide, {
  type: "act",
  action: "archive",
  messageId: "b",
  capabilities: { archive: true },
  providerName: "Gmail",
});
assert.equal(
  middle.cursorId,
  "a",
  "the cursor keeps the message it is on while that message is still listed",
);
const under = reduceMailState(
  { ...wide, cursorId: "b" },
  {
    type: "act",
    action: "archive",
    messageId: "b",
    capabilities: { archive: true },
    providerName: "Gmail",
  },
);
assert.equal(
  under.cursorId,
  "c",
  "the row below takes the place of the one the cursor was on",
);

// A first read that failed is not an empty mailbox.
assert.equal(empty.loaded, false);
assert.equal(listed.loaded, true);
assert.equal(
  reduceMailState(loading, {
    type: "load-failed",
    request: loading.request,
    error: "Mail is unavailable",
  }).loaded,
  false,
);
assert.equal(mailbox.loaded, false);
assert.equal(
  reduceMailState(listed, { type: "load", query: "in:inbox" }).loaded,
  true,
  "a refresh is the same list being asked about again",
);

// A search replaces the list; a refresh reloads it.
const refreshing = reduceMailState(listed, {
  type: "load",
  query: "in:inbox",
});
assert.deepEqual(
  refreshing.messages.map((message) => message.id),
  ["a", "b"],
  "a refresh keeps the rows it is refreshing",
);
const searching = reduceMailState(listed, {
  type: "load",
  query: "in:inbox invoice",
  searchText: "invoice",
  reset: true,
});
assert.deepEqual(
  searching.messages,
  [],
  "the mailbox's own rows are not results of a search",
);
assert.equal(searching.cursorId, null);
assert.equal(searching.selectedId, null);
assert.equal(searching.loaded, false);

const switched = reduceMailState(archived, {
  type: "account-changed",
  accountId: "imap:two@example.com",
  providerId: "imap",
});
assert.deepEqual(switched.messages, []);
assert.equal(switched.request.revision > archived.request.revision, true);

// A mailbox whose credential the host cannot find is signed out, and that is
// not the same failure as a service that is briefly down: there is nothing to
// retry, and the window has something to offer instead.
const signedOutRequest = { accountId: "one@example.com", query: "", revision: 1 };
const signedOut = reduceMailState(
  { ...loading, request: signedOutRequest },
  {
    type: "load-failed",
    request: signedOutRequest,
    error: SIGNED_OUT,
  },
);
assert.equal(signedOut.signedOut, true);
assert.equal(signedOut.canRetry, false, "a signed-out mailbox offers no retry");
assert.equal(signedOut.status, "This mailbox is signed out");
assert.equal(
  signedOut.status.includes(SIGNED_OUT),
  false,
  "the host's own word for the failure is not what the window says",
);
assert.equal(signedOut.loaded, false, "a read that failed is not an empty mailbox");

const unreachable = reduceMailState(
  { ...loading, request: signedOutRequest },
  {
    type: "load-failed",
    request: signedOutRequest,
    error: "provider timed out",
  },
);
assert.equal(unreachable.signedOut, false);
assert.equal(unreachable.canRetry, true);
assert.equal(unreachable.status, "provider timed out");

assert.equal(
  reduceMailState(signedOut, { type: "load", query: "in:inbox" }).signedOut,
  false,
  "a fresh read starts without the previous answer",
);
assert.equal(isSignedOut(""), false);
assert.equal(isSignedOut(undefined), false);

console.log("mail state tests passed");
