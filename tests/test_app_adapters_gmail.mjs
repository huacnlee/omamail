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

console.log("app Gmail adapter tests passed");
