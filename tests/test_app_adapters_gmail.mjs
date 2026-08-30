import assert from "node:assert/strict";

import { createGmailAdapter } from "../app/adapters/gmail.js";
import {
  createEffectPort,
  requestIdentity,
} from "../app/adapters/effect-port.js";

let sent = null;
const port = createEffectPort(
  (effect) => {
    sent = effect;
    return { cancel() {} };
  },
  () => identity,
);
const adapter = createGmailAdapter(port);
const identity = requestIdentity({
  accountId: "me@example.com",
  query: "from:friend@example.com",
  objectId: "",
  revision: 8,
});
adapter.list({
  identity,
  query: identity.query,
  maxResults: 40,
  pageToken: "next",
});

assert.deepEqual(sent, {
  kind: "gmail.http",
  scope: "list",
  accountId: "me@example.com",
  identity,
  hostOperation: {
    type: "list",
    query: "from:friend@example.com",
    maxResults: 40,
    pageToken: "next",
  },
  method: "GET",
  path: "/users/me/messages",
  query: { q: "from:friend@example.com", maxResults: 40, pageToken: "next" },
  body: null,
});

const messageIdentity = requestIdentity({
  accountId: "me@example.com",
  query: "in:inbox",
  objectId: "18f3a",
  revision: 9,
});
let optimistic = 0;
adapter.action({
  identity: messageIdentity,
  action: "markRead",
  ids: ["18f3a"],
  onOptimistic() {
    optimistic += 1;
  },
});
assert.equal(optimistic, 1);
assert.deepEqual(sent, {
  kind: "gmail.http",
  scope: "object",
  accountId: "me@example.com",
  identity: messageIdentity,
  hostOperation: { type: "action", action: "markRead", messageIds: ["18f3a"] },
  method: "POST",
  path: "/users/me/messages/18f3a/modify",
  query: null,
  body: { addLabelIds: [], removeLabelIds: ["UNREAD"] },
});

adapter.detail({ identity: messageIdentity, full: true });
assert.deepEqual(sent, {
  kind: "gmail.http",
  scope: "object",
  accountId: "me@example.com",
  identity: messageIdentity,
  hostOperation: { type: "detail", messageId: "18f3a", full: true },
  method: "GET",
  path: "/users/me/messages/18f3a",
  query: { format: "full" },
  body: null,
});

let complete = null;
const errorPort = createEffectPort(
  (effect, reply) => {
    complete = reply;
    return { cancel() {} };
  },
  () => identity,
);
const errorAdapter = createGmailAdapter(errorPort);
let failure = null;
errorAdapter.list({ identity, query: identity.query }, (value) => {
  failure = value;
});
complete({
  status: 400,
  payload: { error: { message: "bad token ya29.abcdef123" } },
});
assert.deepEqual(failure, {
  ok: false,
  value: null,
  error: "bad token [redacted]",
  identity,
});

adapter.action({ identity: messageIdentity, action: "trash", ids: ["18f3a"] });
assert.equal(sent.path, "/users/me/messages/18f3a/trash");
assert.equal(sent.body, null);
adapter.action({
  identity: messageIdentity,
  action: "untrash",
  ids: ["18f3a"],
});
assert.equal(sent.path, "/users/me/messages/18f3a/untrash");
assert.equal(sent.body, null);

const trashCalls = [];
const trashReplies = [];
const trashPort = createEffectPort(
  (effect, complete) => {
    trashCalls.push(effect);
    trashReplies.push(complete);
    return { cancel() {} };
  },
  () => messageIdentity,
);
const trashAdapter = createGmailAdapter(trashPort);
let trashResult = null;
trashAdapter.action(
  { identity: messageIdentity, action: "trash", ids: ["a", "b"] },
  (value) => {
    trashResult = value;
  },
);
assert.deepEqual(
  trashCalls.map((effect) => effect.path),
  ["/users/me/messages/a/trash", "/users/me/messages/b/trash"],
);
trashReplies[0]({ status: 200, value: null });
assert.equal(trashResult, null);
trashReplies[1]({ status: 200, value: null });
assert.equal(trashResult.ok, true);

failure = null;
errorAdapter.list({ identity, query: identity.query }, (value) => {
  failure = value;
});
complete({ status: 400, error: "Authorization: Basic c2VjcmV0" });
assert.equal(failure.error.includes("c2VjcmV0"), false);
assert.equal(failure.error.includes("[redacted]"), true);

let hydratedComplete = null;
let hydratedIdentity = identity;
const hydratedAdapter = createGmailAdapter(
  createEffectPort(
    (_effect, complete) => {
      hydratedComplete = complete;
      return { cancel() {} };
    },
    () => hydratedIdentity,
  ),
);
let hydrated = null;
hydratedAdapter.list({ identity, query: identity.query }, (result) => {
  hydrated = result;
});
hydratedComplete({
  ok: true,
  value: {
    nextPageToken: "next-page",
    messages: [
      {
        id: "hydrated-id",
        labelIds: ["UNREAD"],
        snippet: "Preview",
        payload: {
          headers: [
            { name: "From", value: "Ada <ada@example.test>" },
            { name: "Subject", value: "Hello" },
          ],
        },
      },
    ],
  },
});
assert.deepEqual(hydrated.value.messages[0].id, "hydrated-id");
assert.equal(hydrated.value.messages[0].subject, "Hello");
assert.equal(hydrated.value.nextPageToken, "next-page");

hydrated = null;
hydratedAdapter.list({ identity, query: identity.query }, (result) => {
  hydrated = result;
});
hydratedComplete({ ok: true, value: { messages: [{ id: "raw-id" }] } });
assert.deepEqual(hydrated, {
  ok: false,
  value: null,
  error: "Mail host returned invalid message data",
  identity,
});

let detail = null;
hydratedIdentity = messageIdentity;
hydratedAdapter.detail({ identity: messageIdentity, full: true }, (result) => {
  detail = result;
});
hydratedComplete({
  ok: true,
  value: {
    id: "18f3a",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: "PGI-SGVsbG88L2I-" } },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { attachmentId: "part:1", size: 7 },
        },
      ],
    },
  },
});
assert.equal(detail.value.html, "<b>Hello</b>");
assert.equal(detail.value.attachments[0].filename, "report.pdf");


// ------------------------------------------------- the list's own door out

// `List-Unsubscribe` is read out of the same fetch as the body, the way
// `MailAccount`'s detail read does it. Without this the reader's notice had
// nothing to draw from and never appeared, however the message was written.
let listed = null;
hydratedIdentity = messageIdentity;
hydratedAdapter.detail({ identity: messageIdentity, full: true }, (result) => {
  listed = result;
});
hydratedComplete({
  ok: true,
  value: {
    id: "18f3a",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        {
          name: "List-Unsubscribe",
          value:
            "<mailto:leave@list.example.com?subject=off>, <https://list.example.com/off/9>",
        },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Goodbye").toString("base64") },
        },
      ],
    },
  },
});
assert.equal(listed.value.unsubscribe.oneClick, true);
assert.equal(listed.value.unsubscribe.postUrl, "https://list.example.com/off/9");
assert.equal(listed.value.unsubscribe.mail.to, "leave@list.example.com");
assert.equal(listed.value.invite, null);

// --------------------------------------------------- the meeting inside it

const ics = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "SUMMARY:Architecture sync",
  "DTSTART:20260901T090000Z",
  "DTEND:20260901T093000Z",
  "ORGANIZER;CN=Ada:mailto:ada@example.test",
  "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

let carried = null;
hydratedAdapter.detail({ identity: messageIdentity, full: true }, (result) => {
  carried = result;
});
hydratedComplete({
  ok: true,
  value: {
    id: "18f3a",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Please come").toString("base64") },
        },
        {
          mimeType: "text/calendar; method=REQUEST",
          filename: "invite.ics",
          body: { data: Buffer.from(ics).toString("base64"), size: ics.length },
        },
      ],
    },
  },
});
assert.equal(carried.value.invite.summary, "Architecture sync");
assert.equal(carried.value.invite.method, "REQUEST");
assert.equal(carried.value.invite.organizer.email, "ada@example.test");
assert.equal(carried.value.unsubscribe.available, false);

// Gmail withholds the octets of every part the sender named, and Google
// Calendar names both of the two it sends — so on Gmail a Google invitation
// always arrives as an id and one more request. The detail is answered once,
// with the meeting already on it.
const promised = [];
const promisedAdapter = createGmailAdapter(
  createEffectPort(
    (effect, complete) => {
      promised.push({ effect, complete });
      return { cancel() {} };
    },
    () => messageIdentity,
  ),
);
let answered = null;
promisedAdapter.detail({ identity: messageIdentity, full: true }, (result) => {
  answered = result;
});
promised[0].complete({
  ok: true,
  value: {
    id: "18f3a",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Please come").toString("base64") },
        },
        {
          mimeType: "text/calendar",
          filename: "invite.ics",
          body: { attachmentId: "part:cal", size: ics.length },
        },
      ],
    },
  },
});
assert.equal(answered, null, "the detail waits for the invitation it named");
assert.deepEqual(
  { kind: promised[1].effect.kind, partId: promised[1].effect.partId },
  { kind: "gmail.attachment", partId: "part:cal" },
);
promised[1].complete({
  ok: true,
  value: { data: Buffer.from(ics).toString("base64") },
});
assert.equal(answered.value.invite.summary, "Architecture sync");
assert.equal(answered.value.body, "Please come");

// A fetch that failed leaves the message exactly as it was: the invitation is
// the one thing on this card that can be absent without anything else being
// wrong.
answered = null;
promised.length = 0;
promisedAdapter.detail({ identity: messageIdentity, full: true }, (result) => {
  answered = result;
});
promised[0].complete({
  ok: true,
  value: {
    id: "18f3a",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Please come").toString("base64") },
        },
        {
          mimeType: "text/calendar",
          filename: "invite.ics",
          body: { attachmentId: "part:cal", size: ics.length },
        },
      ],
    },
  },
});
promised[1].complete({ ok: false, error: "gone" });
assert.equal(answered.ok, true);
assert.equal(answered.value.invite, null);
assert.equal(answered.value.body, "Please come");

console.log("app Gmail adapter invitation and unsubscribe tests passed");
