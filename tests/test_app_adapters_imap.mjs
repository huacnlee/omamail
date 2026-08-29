import assert from "node:assert/strict";

import { createImapAdapter } from "../app/adapters/imap.js";
import {
  createEffectPort,
  requestIdentity,
} from "../app/adapters/effect-port.js";

let sent = null;
const port = createEffectPort(
  (effect, complete) => {
    sent = effect;
    if (effect.kind === "imap.runtime")
      complete({ ok: true, value: { specialUse: { "\\archive": "Archive", "\\sent": "Sent Items" }, supportsMove: true }, identity: effect.identity });
    return { cancel() {} };
  },
  () => identity,
);
const adapter = createImapAdapter(port);
const identity = requestIdentity({
  accountId: "imap:me@example.com",
  query: "folder:Sent Items",
  objectId: "42:Sent Items",
  revision: 6,
});
let optimistic = 0;
let refusal = null;
adapter.action(
  {
    identity,
    hostOperation: {
      type: "action",
      action: "markRead",
      messageIds: ["42:Sent Items"],
      destination: "",
    },
    action: "spam",
    ids: [identity.objectId],
    onOptimistic() {
      optimistic += 1;
    },
  },
  (value) => {
    refusal = value;
  },
);
assert.equal(
  sent,
  null,
  "a provider capability refusal creates no IMAP effect",
);
assert.equal(
  optimistic,
  0,
  "a provider capability refusal precedes optimistic state",
);
assert.equal(refusal.refused, true);
assert.equal(refusal.identity, identity);

let runtimeEffect = null;
const runtimeAdapter = createImapAdapter(
  createEffectPort(
    (effect, complete) => {
      runtimeEffect = effect;
      complete({
        ok: true,
        value: {
          specialUse: {
            "\\archive": "Archive",
            "\\sent": "Sent Items",
            "\\evil": "Guessed",
          },
          supportsMove: true,
        },
        identity: effect.identity,
      });
      return { cancel() {} };
    },
    () => identity,
  ),
);
let runtimeResult = null;
runtimeAdapter.runtime({ identity: { ...identity, objectId: "" } }, (value) => {
  runtimeResult = value;
});
assert.equal(runtimeEffect.kind, "imap.runtime");
assert.deepEqual(runtimeResult.value, {
  specialUse: { "\\archive": "Archive", "\\sent": "Sent Items" },
  supportsMove: true,
});

adapter.action({ identity, action: "markRead", ids: [identity.objectId] });

assert.deepEqual(sent, {
  kind: "imap.transport",
  scope: "object",
  accountId: "imap:me@example.com",
  identity,
  hostOperation: {
    type: "action",
    action: "markRead",
    messageIds: ["42:Sent Items"],
    destination: "",
  },
  folder: "Sent Items",
  commands: ["UID STORE 42 +FLAGS.SILENT (\\Seen)"],
});

adapter.runtime({ identity: { ...identity, objectId: "" } });

adapter.action({
  identity,
  action: "archive",
  ids: [identity.objectId],
  specialFolders: { "\\archive": "Archive" },
  serverCapabilities: ["MOVE"],
});
assert.deepEqual(sent, {
  kind: "imap.transport",
  scope: "object",
  accountId: "imap:me@example.com",
  identity,
  hostOperation: {
    type: "action",
    action: "archive",
    messageIds: ["42:Sent Items"],
    destination: "Archive",
  },
  folder: "Sent Items",
  commands: ['UID MOVE 42 "Archive"'],
});

adapter.action({
  identity,
  action: "archive",
  ids: [identity.objectId],
  specialFolders: { "\\archive": "Archive" },
  serverCapabilities: [],
});
assert.deepEqual(sent.commands, ['UID MOVE 42 "Archive"'], "caller capabilities cannot override trusted runtime");

adapter.detail({ identity, full: true });
assert.deepEqual(sent, {
  kind: "imap.transport",
  scope: "object",
  accountId: "imap:me@example.com",
  identity,
  hostOperation: { type: "detail", messageId: "42:Sent Items", full: true },
  folder: "Sent Items",
  commands: ["UID FETCH 42 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])"],
});

let complete = null;
const errorPort = createEffectPort(
  (effect, reply) => {
    complete = reply;
    return { cancel() {} };
  },
  () => identity,
);
const errorAdapter = createImapAdapter(errorPort);
let failure = null;
errorAdapter.action(
  { identity, action: "markRead", ids: [identity.objectId] },
  (value) => {
    failure = value;
  },
);
complete({ status: 0, detail: "A1 BAD LOGIN jane@example.org hunter2" });
assert.equal(failure.ok, false);
assert.equal(
  failure.error.includes("hunter2"),
  false,
  "an IMAP failure does not disclose a credential",
);
assert.equal(failure.error, "A1 BAD LOGIN [redacted]");

let listComplete = null;
const normalizedAdapter = createImapAdapter(
  createEffectPort(
    (_effect, complete) => {
      listComplete = complete;
      return { cancel() {} };
    },
    () => identity,
  ),
);
let normalized = null;
normalizedAdapter.runtime({ identity: { ...identity, objectId: "" } });
listComplete({ ok: true, value: { specialUse: { "\\sent": "Sent Items" }, supportsMove: false } });
normalizedAdapter.list({ identity, query: 'folder:"Sent Items"' }, (result) => {
  normalized = result;
});
const raw =
  "From: Ada <ada@example.test>\r\nSubject: IMAP hello\r\n\r\nBody text";
listComplete({
  ok: true,
  value: {
    responseBase64: Buffer.from(
      `* 1 FETCH (UID 42 FLAGS (\\Seen) RFC822.SIZE ${raw.length} BODY[] {${raw.length}}\r\n${raw})\r\nA1 OK done\r\n`,
    ).toString("base64"),
  },
});
assert.equal(normalized.value.messages[0].id, "42:Sent Items");
assert.equal(normalized.value.messages[0].subject, "IMAP hello");
assert.equal(normalized.value.messages[0].unread, false);
normalized = null;
normalizedAdapter.list(
  {
    identity,
    query: 'folder:"Sent Items"',
    specialFolders: { "\\sent": "Sent Items" },
  },
  (result) => {
    normalized = result;
  },
);
listComplete({
  ok: true,
  value: {
    responseBase64: Buffer.from(
      `* 1 FETCH (UID 44 FLAGS () RFC822.SIZE ${raw.length} BODY[] {${raw.length}}\r\n${raw})\r\nA1 OK\r\n`,
    ).toString("base64"),
  },
});
assert.ok(
  normalized.value.messages[0].labelIds.includes("SENT"),
  "closed SPECIAL-USE mapping reaches IMAP labels",
);

normalized = null;
normalizedAdapter.list({ identity, query: 'folder:"Sent Items"' }, (result) => {
  normalized = result;
});
const multibyte = "Subject: café\r\n\r\né";
listComplete({
  ok: true,
  value: {
    responseBase64: Buffer.from(
      `* 1 FETCH (UID 43 FLAGS () RFC822.SIZE 99 BODY[] {${Buffer.byteLength(multibyte) + 2}}\r\n${multibyte})\r\nA1 OK\r\n`,
    ).toString("base64"),
  },
});
assert.equal(normalized.ok, false, "a literal truncated by octets is rejected");
assert.equal(normalized.error, "Mail host returned invalid message data");

let unavailableOptimistic = 0;
let unavailable = null;
sent = null;
const unavailableAdapter = createImapAdapter(port);
unavailableAdapter.action(
  {
    identity,
    action: "archive",
    ids: [identity.objectId],
    specialFolders: {},
    onOptimistic() {
      unavailableOptimistic += 1;
    },
  },
  (value) => {
    unavailable = value;
  },
);
assert.equal(sent, null, "a missing IMAP Archive folder creates no effect");
assert.equal(
  unavailableOptimistic,
  0,
  "a missing IMAP Archive folder is refused before optimism",
);
assert.equal(unavailable.refused, true);

const batchCalls = [];
const batchReplies = [];
const batchPort = createEffectPort(
  (effect, complete) => {
    batchCalls.push(effect);
    batchReplies.push(complete);
    return { cancel() {} };
  },
  () => batchIdentity,
);
const batchAdapter = createImapAdapter(batchPort);
const batchIdentity = requestIdentity({
  accountId: "imap:me@example.com",
  query: "all",
  revision: 7,
});
let batchResult = null;
batchAdapter.action(
  {
    identity: batchIdentity,
    action: "markRead",
    ids: ["42:INBOX", "7:Sent Items"],
  },
  (value) => {
    batchResult = value;
  },
);
assert.deepEqual(
  batchCalls.map((effect) => [effect.folder, effect.commands]),
  [
    ["INBOX", ["UID STORE 42 +FLAGS.SILENT (\\Seen)"]],
    ["Sent Items", ["UID STORE 7 +FLAGS.SILENT (\\Seen)"]],
  ],
);
batchReplies[1]({ status: 200, value: null });
assert.equal(batchResult, null, "a batch action waits for every folder");
batchReplies[0]({ status: 200, value: null });
assert.equal(batchResult.ok, true);

let currentBatchIdentity = batchIdentity;
const staleBatchReplies = [];
const staleBatchPort = createEffectPort(
  (effect, complete) => {
    staleBatchReplies.push(complete);
    return { cancel() {} };
  },
  () => currentBatchIdentity,
);
const staleBatchAdapter = createImapAdapter(staleBatchPort);
let staleBatchResult = null;
staleBatchAdapter.action(
  {
    identity: batchIdentity,
    action: "markRead",
    ids: ["42:INBOX", "7:Sent Items"],
  },
  (value) => {
    staleBatchResult = value;
  },
);
currentBatchIdentity = requestIdentity({
  ...batchIdentity,
  revision: batchIdentity.revision + 1,
});
staleBatchReplies[0]({ status: 200, value: null });
assert.equal(staleBatchResult, null);
staleBatchReplies[1]({ status: 200, value: null });
assert.equal(
  staleBatchResult.discarded,
  true,
  "a stale group settles the batch instead of leaving it pending",
);

failure = null;
errorAdapter.detail({ identity }, (value) => {
  failure = value;
});
complete({
  status: 0,
  detail: "failed at https://jane:hunter2@example.com/INBOX",
});
assert.equal(failure.error.includes("hunter2"), false);
assert.equal(failure.error.includes("[redacted]"), true);

console.log("app IMAP adapter tests passed");
