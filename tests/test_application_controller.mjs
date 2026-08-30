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

// Star, unstar, and the three the reader and the row menu need from a
// controller that used to have only `act`.
{
  const calls = [];
  const replies = [];
  const starring = createApplicationController({
    storage: storageFor({
      version: 1,
      activeId: "star@example.com",
      accounts: [
        { id: "star@example.com", email: "star@example.com", provider: "gmail" },
      ],
    }),
    execute(effect, complete) {
      calls.push(effect);
      replies.push(complete);
      return { cancel() {} };
    },
  });
  starring.start();
  replies.shift()({
    ok: true,
    value: {
      messages: [
        gmailResource("plain", ["INBOX"]),
        gmailResource("lit", ["INBOX", "STARRED"]),
      ],
    },
  });
  const listed = starring.snapshot().mail.messages;
  assert.deepEqual(
    listed.map((message) => message.id),
    ["plain", "lit"],
  );

  starring.toggleStar("plain");
  assert.equal(calls.at(-1).hostOperation.action, "star");
  assert.deepEqual(calls.at(-1).body.addLabelIds, ["STARRED"]);
  starring.toggleStar("lit");
  assert.equal(
    calls.at(-1).hostOperation.action,
    "unstar",
    "a star that only ever added one could never be taken off",
  );
  assert.deepEqual(calls.at(-1).body.removeLabelIds, ["STARRED"]);

  // The cursor is where the keyboard is; the selection is what the reader
  // shows. Closing the reader puts the selection down and leaves the cursor.
  starring.openMessage("lit");
  assert.equal(starring.snapshot().mail.selectedId, "lit");
  starring.clearSelection();
  assert.equal(starring.snapshot().mail.selectedId, null);
  assert.equal(starring.snapshot().mail.cursorId, "lit");
  assert.equal(starring.snapshot().detail, null);

  starring.placeCursor("plain");
  assert.equal(starring.snapshot().mail.cursorId, "plain");
  starring.placeCursor("not-here");
  assert.equal(
    starring.snapshot().mail.cursorId,
    "plain",
    "a cursor is only ever put on a row that is listed",
  );

  // A search replaces the list; a refresh reloads it.
  starring.search("invoice");
  assert.deepEqual(starring.snapshot().mail.messages, []);
  assert.equal(starring.snapshot().mail.loaded, false);
  replies.at(-1)({ ok: true, value: { messages: [gmailResource("hit")] } });
  assert.equal(starring.snapshot().mail.loaded, true);
  starring.refresh();
  assert.deepEqual(
    starring.snapshot().mail.messages.map((message) => message.id),
    ["hit"],
    "a refresh keeps the rows it is refreshing",
  );

  // A first read that failed is not an empty mailbox.
  const failing = createApplicationController({
    storage: storageFor({
      version: 1,
      activeId: "fail@example.com",
      accounts: [
        { id: "fail@example.com", email: "fail@example.com", provider: "gmail" },
      ],
    }),
    execute(_effect, complete) {
      replies.push(complete);
      return { cancel() {} };
    },
  });
  failing.start();
  replies.at(-1)({ ok: false, error: "Mail is unavailable" });
  assert.equal(failing.snapshot().mail.loaded, false);
  assert.equal(failing.snapshot().mail.status, "Mail is unavailable");
}

// ------------------------------------------------ what the settings change
//
// Three of the shell's four mail settings are answered here, because all three
// are properties of a read: how many messages it asks for, what it asks for,
// and whether what came back is worth saying out loud. Each is asserted
// against the request the adapter built or the notification it raised — a
// stored value nothing reads is the defect these cover.
{
  const preferences = {
    maxMessages: 25,
    defaultQuery: "in:inbox",
    notifyNewMail: "On",
  };
  const requests = [];
  const replies = [];
  const notifications = [];
  const tuned = createApplicationController({
    storage: storageFor(saved),
    preference: (key) => preferences[key],
    notify: (request) => notifications.push(request),
    execute(effect, complete) {
      requests.push(effect);
      replies.push(complete);
      return { cancel() {} };
    },
  });
  const settle = (messages) =>
    replies.shift()({ status: 200, value: { messages } });

  tuned.start();
  assert.equal(requests.at(-1).query.maxResults, 25);
  assert.equal(requests.at(-1).query.q, "in:inbox");
  // The first answer of a session is the baseline it is compared against, not
  // eleven notifications for mail that was already sitting in the inbox.
  settle([gmailResource("first", ["UNREAD", "INBOX"])]);
  assert.deepEqual(notifications, []);

  // Messages per page reaches the request the adapter builds.
  preferences.maxMessages = 50;
  assert.equal(tuned.refresh(), true);
  assert.equal(requests.at(-1).query.maxResults, 50);
  assert.equal(
    requests.at(-1).hostOperation.maxResults,
    50,
    "the native runtime is told the same number the HTTP query carries",
  );

  // A message the list has not held before is new mail; one it already showed
  // is not, however many times it comes back.
  settle([
    gmailResource("first", ["UNREAD", "INBOX"]),
    gmailResource("second", ["UNREAD", "INBOX"]),
  ]);
  assert.deepEqual(notifications, [
    { summary: "Sender", body: "Subject second" },
  ]);
  tuned.refresh();
  settle([
    gmailResource("first", ["UNREAD", "INBOX"]),
    gmailResource("second", ["UNREAD", "INBOX"]),
  ]);
  assert.equal(
    notifications.length,
    1,
    "a message already announced is not announced again",
  );

  // A batch is announced once. One notification per message turns a sync into
  // a wall of popups nobody dismissed.
  tuned.refresh();
  settle([
    gmailResource("third", ["UNREAD", "INBOX"]),
    gmailResource("fourth", ["UNREAD", "INBOX"]),
    gmailResource("first", ["UNREAD", "INBOX"]),
  ]);
  assert.deepEqual(notifications.at(-1), {
    summary: "2 new messages",
    body: "Sender, Sender",
  });

  // Read mail, and mail outside the inbox, are not arrivals.
  tuned.refresh();
  settle([
    gmailResource("read", ["INBOX"]),
    gmailResource("archived", ["UNREAD"]),
  ]);
  assert.equal(notifications.length, 2);

  // The default search applies to the inbox, and applies to the next read
  // rather than waiting for the account to be switched.
  preferences.defaultQuery = "in:inbox -category:promotions";
  tuned.refresh();
  assert.equal(requests.at(-1).query.q, "in:inbox -category:promotions");
  settle([]);
  // Only the inbox: applying it to Starred would quietly filter a mailbox
  // nobody asked to filter.
  tuned.selectMailbox("starred");
  assert.equal(requests.at(-1).query.q, "is:starred");
  settle([]);
  // A typed search wins over it, the way `Registry.query` orders them.
  tuned.selectMailbox("inbox");
  settle([]);
  tuned.search("invoice");
  assert.equal(requests.at(-1).query.q, "invoice");
  settle([gmailResource("hit", ["UNREAD", "INBOX"])]);
  assert.equal(
    notifications.length,
    2,
    "a search that turned up an old unread message is a result, not new mail",
  );

  // Off is off.
  preferences.notifyNewMail = "Off";
  tuned.search("");
  settle([gmailResource("silent", ["UNREAD", "INBOX"])]);
  assert.equal(notifications.length, 2);
}

console.log("application controller tests passed");
