import assert from "node:assert/strict";

import { createApplicationController } from "../app/application/controller.js";

function storageFor(accounts) {
  let serialized = JSON.stringify(accounts);
  return {
    getItem(key) {
      return key === "omamail.accounts" ? serialized : null;
    },
    setItem(key, value) {
      if (key === "omamail.accounts") serialized = value;
    },
  };
}

function gmailResource(id, labels = []) {
  return {
    id,
    labelIds: labels,
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "Subject", value: `Subject ${id}` },
      ],
      mimeType: "text/plain",
      body: { data: "Qm9keQ" },
    },
  };
}

const saved = {
  version: 1,
  activeId: "one@example.com",
  accounts: [
    { id: "one@example.com", email: "one@example.com", provider: "gmail" },
    { id: "imap:two@example.com", email: "two@example.com", provider: "imap" },
  ],
};
const effects = [];
const completions = [];
const unreadTotals = [];
const controller = createApplicationController({
  storage: storageFor(saved),
  execute(effect, complete) {
    effects.push(effect);
    completions.push(complete);
    return { cancel() {} };
  },
  cache: {
    readList(accountId) {
      if (accountId === "one@example.com")
        return [{ id: "cached", labelIds: ["UNREAD"] }];
      return [];
    },
  },
  companion: {
    setUnread(total) {
      unreadTotals.push(total);
    },
  },
});

controller.start();
assert.equal(controller.snapshot().accounts.activeId, "one@example.com");
assert.deepEqual(
  controller.snapshot().mail.messages.map((message) => message.id),
  ["cached"],
  "cache hydrates before live I/O",
);
assert.equal(effects.length, 1);
assert.equal(effects[0].scope, "list");
assert.equal(effects[0].query.q, "in:inbox");
completions.shift()({
  status: 200,
  value: {
    messages: [
      { id: "gmail-live-1", labelIds: ["UNREAD"], payload: { headers: [] } },
      { id: "gmail-live-2", labelIds: ["UNREAD"], payload: { headers: [] } },
    ],
  },
});
assert.deepEqual(
  controller.snapshot().mail.messages.map((message) => message.id),
  ["gmail-live-1", "gmail-live-2"],
);
assert.equal(unreadTotals.at(-1), 2);

{
  let complete;
  const failedList = createApplicationController({
    storage: storageFor(saved),
    execute(_effect, callback) {
      complete = callback;
      return { cancel() {} };
    },
  });
  failedList.start();
  complete({ ok: false, error: "Mail host is unavailable" });
  assert.equal(
    failedList.snapshot().mail.status,
    "Mail host is unavailable",
    "a current list failure is visible in the mail status",
  );
  assert.equal(failedList.snapshot().mail.canRetry, true);
  assert.equal(failedList.retry(), true);
  assert.equal(failedList.snapshot().mail.loading, true);
}

{
  const pending = [];
  let cleared = 0;
  const drafts = createApplicationController({
    storage: storageFor(saved),
    cache: {
      readList() {
        return null;
      },
      clearAccount() {
        cleared += 1;
      },
    },
    execute(_effect, complete) {
      pending.push(complete);
      return { cancel() {} };
    },
  });
  drafts.start();
  pending.shift()({ status: 200, value: { messages: [] } });
  drafts.selectMailbox("drafts");
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("draft:one")] },
  });
  drafts.invalidateDrafts("one@example.com");
  assert.equal(cleared, 1);
  assert.equal(
    drafts.snapshot().mail.loading,
    true,
    "draft mutation authoritatively reloads the open Drafts mailbox",
  );
  pending.shift()({ status: 200, value: { messages: [] } });
  assert.equal(
    drafts.snapshot().mail.messages.length,
    0,
    "a removed draft row cannot be reopened",
  );
}

{
  const pending = [];
  const isolated = createApplicationController({
    storage: storageFor(saved),
    execute(_effect, complete) {
      pending.push(complete);
      return { cancel() {} };
    },
  });
  isolated.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("old", ["INBOX"])] },
  });
  isolated.act("archive", ["old"]);
  const staleAction = pending.shift();
  isolated.switchAccount("imap:two@example.com");
  const before = isolated.snapshot().lastOperation;
  staleAction({ ok: false, error: "old account failure" });
  assert.equal(
    isolated.snapshot().lastOperation,
    before,
    "a stale action completion cannot pollute the active account",
  );
}

{
  const calls = [];
  const pending = [];
  const paging = createApplicationController({
    storage: storageFor(saved),
    execute(effect, complete) {
      calls.push(effect);
      pending.push(complete);
      return { cancel() {} };
    },
  });
  paging.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("inbox")] },
  });
  paging.selectMailbox("sent");
  assert.equal(paging.snapshot().mail.mailboxKey, "sent");
  assert.equal(calls.at(-1).query.q, "in:sent");
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("sent-1")], nextPageToken: "page-2" },
  });
  assert.equal(paging.snapshot().mail.nextPageToken, "page-2");
  paging.loadMore();
  assert.equal(calls.at(-1).query.pageToken, "page-2");
  const pageCompletion = pending.shift();
  paging.search("from:friend@example.test");
  assert.equal(calls.at(-1).query.q, "from:friend@example.test");
  pageCompletion({
    status: 200,
    value: { messages: [gmailResource("stale-page")] },
  });
  assert.equal(
    paging.snapshot().mail.messages.some((row) => row.id === "stale-page"),
    false,
  );
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("search-1")] },
  });
  paging.openMessage("search-1");
  pending.shift()({ status: 200, value: gmailResource("search-1") });
  assert.equal(paging.snapshot().detail.id, "search-1");
  paging.search("");
  assert.equal(
    paging.snapshot().detail,
    null,
    "a new list identity clears detail immediately",
  );
}

{
  const calls = [];
  const pending = [];
  const paging = createApplicationController({
    storage: storageFor(saved),
    execute(effect, complete) {
      calls.push(effect);
      pending.push(complete);
      return { cancel() {} };
    },
  });
  paging.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("one")], nextPageToken: "page-2" },
  });
  paging.loadMore();
  pending.shift()({ ok: false, error: "Page failed" });
  assert.deepEqual(
    paging.snapshot().mail.messages.map((row) => row.id),
    ["one"],
  );
  assert.equal(paging.snapshot().mail.failedPageToken, "page-2");
  paging.retry();
  assert.equal(
    calls.at(-1).query.pageToken,
    "page-2",
    "retry resumes the failed continuation exactly",
  );
}

assert.equal(
  controller.switchAccount("missing"),
  false,
  "an unknown account cannot replace active state",
);
assert.equal(controller.switchAccount("imap:two@example.com"), true);
assert.equal(effects.at(-1).accountId, "imap:two@example.com");
assert.equal(
  effects.at(-1).kind,
  "imap.runtime",
  "IMAP discovery precedes mailbox data",
);
completions.shift()({
  ok: true,
  value: {
    specialUse: { "\\sent": "Sent Items", "\\trash": "Deleted" },
    supportsMove: true,
  },
});
assert.equal(effects.at(-1).kind, "imap.list");
const imapListCompletion = completions.shift();
const imapRaw =
  "From: IMAP <imap@example.test>\r\nSubject: IMAP row\r\n\r\nBody";
imapListCompletion({
  ok: true,
  value: {
    responseBase64: Buffer.from(
      `* 1 FETCH (UID 1 FLAGS () RFC822.SIZE ${imapRaw.length} BODY[] {${imapRaw.length}}\r\n${imapRaw})\r\nA1 OK\r\n`,
    ).toString("base64"),
  },
});
assert.equal(controller.snapshot().mail.accountId, "imap:two@example.com");
assert.equal(
  unreadTotals.at(-1),
  3,
  "the companion receives an aggregate across hydrated accounts",
);

controller.moveCursor(0);
controller.openCursor();
assert.equal(effects.at(-1).scope, "object");
assert.equal(effects.at(-1).folder, "INBOX");
completions.shift()({
  ok: true,
  value: {
    responseBase64: Buffer.from(
      `* 1 FETCH (UID 1 FLAGS () RFC822.SIZE ${imapRaw.length} BODY[] {${imapRaw.length}}\r\n${imapRaw})\r\nA1 OK\r\n`,
    ).toString("base64"),
  },
});
assert.equal(controller.snapshot().detail.id, "1:INBOX");

const effectsBeforeRefusal = effects.length;
controller.act("spam", ["1:INBOX"]);
assert.equal(
  effects.length,
  effectsBeforeRefusal,
  "capability refusal happens before an effect",
);
assert.match(controller.snapshot().mail.status, /no junk/i);

controller.act("markRead", ["1:INBOX", "2:Sent"]);
assert.equal(
  effects.length,
  effectsBeforeRefusal + 2,
  "an IMAP batch sends every folder",
);
const staleActionCompletions = completions.splice(0, 2);
controller.switchAccount("one@example.com");
const operationBeforeStaleActions = controller.snapshot().lastOperation;
staleActionCompletions[0]({ status: 200, value: null });
staleActionCompletions[1]({ status: 200, value: null });
assert.equal(
  controller.snapshot().lastOperation,
  operationBeforeStaleActions,
  "a discarded stale provider batch cannot settle into another account",
);

const staleListCompletion = completions.shift();
controller.switchAccount("imap:two@example.com");
const operationBeforeStaleList = controller.snapshot().lastOperation;
staleListCompletion({
  status: 200,
  value: { messages: [{ id: "stale", labelIds: [] }] },
});
assert.equal(controller.snapshot().mail.accountId, "imap:two@example.com");
assert.equal(
  controller.snapshot().mail.messages.some((message) => message.id === "stale"),
  false,
  "a stale completion cannot overwrite the switched account",
);
assert.notEqual(
  controller.snapshot().lastOperation?.value?.messages?.[0]?.id,
  "stale",
);
assert.equal(
  controller.snapshot().lastOperation,
  operationBeforeStaleList,
  "stale list completion has no visible status effect",
);

{
  const storage = storageFor(saved);
  const pending = [];
  const writes = [];
  const cache = {
    readList(accountId, query) {
      return (
        writes.find(
          (entry) => entry.accountId === accountId && entry.query === query,
        )?.messages ?? null
      );
    },
    writeList(accountId, query, messages) {
      writes.push({ accountId, query, messages });
    },
  };
  const live = createApplicationController({
    storage,
    cache,
    execute(_effect, complete) {
      pending.push(complete);
      return { cancel() {} };
    },
  });
  live.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("persisted-live")] },
  });
  assert.deepEqual(
    writes.map((entry) => ({
      ...entry,
      messages: entry.messages.map((message) => message.id),
    })),
    [
      {
        accountId: "one@example.com",
        query: "in:inbox",
        messages: ["persisted-live"],
      },
    ],
  );

  const restarted = createApplicationController({
    storage,
    cache,
    execute() {
      return { cancel() {} };
    },
  });
  restarted.start();
  assert.deepEqual(
    restarted.snapshot().mail.messages.map((message) => message.id),
    ["persisted-live"],
  );
}

{
  const pending = [];
  const writes = [];
  const stale = createApplicationController({
    storage: storageFor(saved),
    cache: {
      readList() {
        return null;
      },
      writeList(...args) {
        writes.push(args);
      },
    },
    execute(_effect, complete) {
      pending.push(complete);
      return { cancel() {} };
    },
  });
  stale.start();
  const oldCompletion = pending.shift();
  stale.switchAccount("imap:two@example.com");
  oldCompletion({
    status: 200,
    value: { messages: [gmailResource("must-not-cache")] },
  });
  assert.deepEqual(
    writes,
    [],
    "a stale live response never reaches persistent cache",
  );
}

{
  const storage = storageFor(saved);
  const first = createApplicationController({
    storage,
    execute() {
      return { cancel() {} };
    },
  });
  first.start();
  first.switchAccount("imap:two@example.com");

  const restarted = createApplicationController({
    storage,
    execute() {
      return { cancel() {} };
    },
  });
  restarted.start();
  assert.equal(restarted.snapshot().accounts.activeId, "imap:two@example.com");
  assert.equal(restarted.snapshot().mail.accountId, "imap:two@example.com");
}

{
  const pending = [];
  const guarded = createApplicationController({
    storage: storageFor(saved),
    execute(_effect, complete) {
      pending.push(complete);
      return { cancel() {} };
    },
  });
  guarded.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("detail-row")] },
  });
  guarded.openCursor();
  const staleDetail = pending.shift();
  guarded.switchAccount("imap:two@example.com");
  const before = guarded.snapshot().lastOperation;
  staleDetail({ status: 200, value: gmailResource("detail-row") });
  assert.equal(
    guarded.snapshot().lastOperation,
    before,
    "stale detail completion has no visible status effect",
  );
  assert.equal(guarded.snapshot().detail, null);
}

{
  const calls = [];
  const pending = [];
  let cacheReads = 0;
  const recovering = createApplicationController({
    storage: storageFor(saved),
    cache: {
      readList() {
        cacheReads += 1;
        return [gmailResource("cached")];
      },
    },
    execute(effect, complete) {
      calls.push(effect);
      pending.push(complete);
      return { cancel() {} };
    },
  });
  recovering.start();
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("live", ["INBOX"])] },
  });
  recovering.act("archive", ["live"]);
  assert.equal(
    recovering.snapshot().mail.messages.length,
    0,
    "the shared action path applies its optimistic state",
  );
  pending.shift()({
    ok: false,
    discarded: true,
    error: "Action outcome is uncertain",
  });
  assert.equal(
    calls.at(-1).scope,
    "list",
    "an uncertain action starts an authoritative reload",
  );
  assert.equal(
    cacheReads,
    1,
    "recovery does not replay a cached optimistic predecessor",
  );
  assert.equal(
    recovering.snapshot().mail.status,
    "Action outcome is uncertain",
  );
  pending.shift()({
    status: 200,
    value: { messages: [gmailResource("live", ["INBOX"])] },
  });
  assert.equal(recovering.snapshot().mail.messages[0].id, "live");
}

{
  let now = 0;
  const calls = [];
  const replies = [];
  const refreshing = createApplicationController({
    storage: storageFor({ ...saved, activeId: "imap:two@example.com" }),
    now: () => now,
    execute(effect, complete) {
      calls.push(effect);
      replies.push(complete);
      return { cancel() {} };
    },
  });
  refreshing.start();
  assert.equal(calls.at(-1).kind, "imap.runtime");
  replies.shift()({
    ok: true,
    value: { specialUse: { "\\archive": "Old Archive" }, supportsMove: true },
  });
  assert.equal(calls.at(-1).kind, "imap.list");
  replies.shift()({ ok: false, error: "empty fixture" });
  now = 300_001;
  refreshing.act("archive", ["7:INBOX"]);
  assert.equal(
    calls.at(-1).kind,
    "imap.runtime",
    "expired runtime refreshes before action",
  );
  const staleRuntime = replies.shift();
  refreshing.switchAccount("one@example.com");
  refreshing.switchAccount("imap:two@example.com");
  const beforeStaleCompletion = calls.filter(
    (effect) => effect.kind === "imap.runtime",
  ).length;
  staleRuntime({
    ok: true,
    value: { specialUse: { "\\archive": "Stale Archive" }, supportsMove: true },
  });
  assert.notEqual(
    calls.at(-1).hostOperation?.destination,
    "Stale Archive",
    "stale runtime completion cannot execute an action",
  );
  assert.equal(
    calls.at(-1).kind,
    "imap.runtime",
    "a current waiter restarts after stale discovery terminates",
  );
  assert.equal(
    calls.filter((effect) => effect.kind === "imap.runtime").length,
    beforeStaleCompletion + 1,
  );
  replies.pop()({
    ok: true,
    value: {
      specialUse: { "\\archive": "New Archive", "\\sent": "INBOX" },
      supportsMove: false,
    },
  });
  assert.equal(calls.at(-1).kind, "imap.list");
  replies.pop()({
    ok: true,
    value: {
      responseBase64: Buffer.from(
        `* 1 FETCH (UID 1 FLAGS () RFC822.SIZE ${imapRaw.length} BODY[] {${imapRaw.length}}\r\n${imapRaw})\r\nA1 OK done\r\n`,
      ).toString("base64"),
    },
  });
  assert.ok(
    refreshing.snapshot().mail.messages[0].labelIds.includes("SENT"),
    "refreshed map reaches list labels",
  );
  refreshing.openMessage("1:INBOX");
  replies.pop()({
    ok: true,
    value: {
      responseBase64: Buffer.from(
        `* 1 FETCH (UID 1 FLAGS () RFC822.SIZE ${imapRaw.length} BODY[] {${imapRaw.length}}\r\n${imapRaw})\r\nA1 OK done\r\n`,
      ).toString("base64"),
    },
  });
  assert.ok(
    refreshing.snapshot().detail.labelIds.includes("SENT"),
    "refreshed map reaches detail labels",
  );
  refreshing.act("archive", ["7:INBOX"]);
  assert.equal(
    calls.at(-1).hostOperation.destination,
    "New Archive",
    "refreshed map is shared with actions",
  );
  assert.deepEqual(calls.at(-1).commands, [
    'UID COPY 7 "New Archive"',
    "UID STORE 7 +FLAGS.SILENT (\\Deleted)",
    "UID EXPUNGE 7",
  ]);

  now = 600_002;
  const discoveriesBefore = calls.filter(
    (effect) => effect.kind === "imap.runtime",
  ).length;
  refreshing.openMessage("1:INBOX");
  refreshing.act("archive", ["1:INBOX"]);
  assert.equal(
    calls.filter((effect) => effect.kind === "imap.runtime").length,
    discoveriesBefore + 1,
    "same-account concurrent waiters coalesce into one discovery",
  );
  replies.pop()({
    ok: true,
    value: {
      specialUse: { "\\archive": "Newest Archive", "\\sent": "INBOX" },
      supportsMove: true,
    },
  });
  assert.equal(
    calls.filter((effect) => effect.kind === "imap.runtime").length,
    discoveriesBefore + 1,
  );
  assert.ok(
    calls.some(
      (effect) =>
        effect.kind === "imap.transport" &&
        effect.hostOperation?.type === "detail",
    ),
  );
  assert.ok(
    calls.some(
      (effect) => effect.hostOperation?.destination === "Newest Archive",
    ),
  );
}

console.log("application controller tests passed");
