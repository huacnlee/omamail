import assert from "node:assert/strict";

import { createHeyAdapter } from "../app/adapters/hey.js";
import {
  createEffectPort,
  requestIdentity,
} from "../app/adapters/effect-port.js";

let dispatched = 0;
const port = createEffectPort(
  () => {
    dispatched += 1;
    return { cancel() {} };
  },
  () => ({ accountId: "hey:me@example.com", revision: 2 }),
);
const adapter = createHeyAdapter(port);
let optimistic = 0;
let result = null;
adapter.action(
  {
    identity: requestIdentity({
      accountId: "hey:me@example.com",
      objectId: "7:9",
      revision: 2,
    }),
    action: "archive",
    ids: ["7:9"],
    onOptimistic() {
      optimistic += 1;
    },
  },
  (value) => {
    result = value;
  },
);

assert.equal(dispatched, 0, "an unsupported action creates no effect");
assert.equal(
  optimistic,
  0,
  "an unsupported action is refused before optimistic state changes",
);
assert.deepEqual(result, {
  ok: false,
  value: null,
  error: "HEY cannot archive messages",
  refused: true,
  identity: requestIdentity({
    accountId: "hey:me@example.com",
    objectId: "7:9",
    revision: 2,
  }),
});

const calls = [];
const recordingPort = createEffectPort(
  (effect) => {
    calls.push(effect);
    return { cancel() {} };
  },
  () => messageIdentity,
);
const recordingAdapter = createHeyAdapter(recordingPort);
const messageIdentity = requestIdentity({
  accountId: "hey:me@example.com",
  query: "box:imbox",
  objectId: "1235250884:2106437143",
  revision: 3,
});
recordingAdapter.detail({ identity: messageIdentity, full: true });
let readOptimistic = 0;
recordingAdapter.action({
  identity: messageIdentity,
  action: "markRead",
  ids: [messageIdentity.objectId],
  onOptimistic() {
    readOptimistic += 1;
  },
});

assert.equal(readOptimistic, 1);
assert.deepEqual(calls, [
  {
    kind: "hey.cli",
    scope: "object",
    accountId: "hey:me@example.com",
    identity: messageIdentity,
    args: ["threads", "2106437143", "--allow-partial", "--html"],
    stdin: "",
  },
  {
    kind: "hey.cli",
    scope: "object",
    accountId: "hey:me@example.com",
    identity: messageIdentity,
    args: ["seen", "1235250884"],
    stdin: "",
  },
]);

recordingAdapter.list({
  identity: messageIdentity,
  query: "box:imbox",
  maxResults: 25,
  pageToken: "",
});
assert.deepEqual(calls.at(-1), {
  kind: "hey.cli",
  scope: "list",
  accountId: "hey:me@example.com",
  identity: messageIdentity,
  args: ["box", "imbox", "--json"],
  stdin: "",
});

const pageReplies = [];
const pagingPort = createEffectPort(
  (_effect, reply) => {
    pageReplies.push(reply);
    return { cancel() {} };
  },
  () => messageIdentity,
);
const pagingAdapter = createHeyAdapter(pagingPort);
const receivedPages = [];
pagingAdapter.list(
  {
    identity: messageIdentity,
    query: "box:imbox",
    maxResults: 1,
    pageToken: "",
  },
  (value) => receivedPages.push(value),
);
pageReplies.shift()({
  status: 200,
  value: {
    kind: "imbox",
    next_page: "cursor-2",
    postings: [
      { id: 1, app_url: "https://app.hey.com/topics/11", name: "One" },
      { id: 2, app_url: "https://app.hey.com/topics/22", name: "Two" },
    ],
  },
});
assert.deepEqual(
  receivedPages[0].value.messages.map((row) => row.id),
  ["1:11"],
);
assert.equal(
  receivedPages[0].value.nextPageToken,
  "1|",
  "the first continuation stays within HEY's envelope",
);

pagingAdapter.list(
  {
    identity: messageIdentity,
    query: "box:imbox",
    maxResults: 1,
    pageToken: "1|",
  },
  (value) => receivedPages.push(value),
);
pageReplies.shift()({
  status: 200,
  value: {
    kind: "imbox",
    next_page: "cursor-2",
    postings: [
      { id: 1, app_url: "https://app.hey.com/topics/11", name: "One" },
      { id: 2, app_url: "https://app.hey.com/topics/22", name: "Two" },
    ],
  },
});
assert.deepEqual(
  receivedPages[1].value.messages.map((row) => row.id),
  ["2:22"],
);
assert.equal(
  receivedPages[1].value.nextPageToken,
  "0|cursor-2",
  "the envelope's real cursor continues to page two",
);

let complete = null;
const errorPort = createEffectPort(
  (effect, reply) => {
    complete = reply;
    return { cancel() {} };
  },
  () => messageIdentity,
);
const errorAdapter = createHeyAdapter(errorPort);
let failure = null;
errorAdapter.detail({ identity: messageIdentity }, (value) => {
  failure = value;
});
complete({
  status: 1,
  stdout: "",
  stderr: "Authorization: Bearer sk-live-secret",
});
assert.equal(failure.ok, false);
assert.equal(
  failure.error.includes("sk-live-secret"),
  false,
  "a HEY CLI failure does not disclose a credential",
);
assert.equal(failure.error, "Authorization: Bearer [redacted]");

failure = null;
errorAdapter.detail({ identity: messageIdentity }, (value) => {
  failure = value;
});
complete({ status: 1, stdout: "", stderr: "Authorization: Basic c2VjcmV0" });
assert.equal(failure.error.includes("c2VjcmV0"), false);
assert.equal(failure.error.includes("[redacted]"), true);

console.log("app HEY adapter tests passed");
