import assert from "node:assert/strict";

import Omamail, {
  createHostExecutor,
  configureHostContexts,
  displayAddress,
  hostContextsFor,
  hostRequestFor,
  mailKeyContext,
  normalizeHostReply,
} from "../app/main.js";
import { createListCache } from "../app/application/list-cache.js";
import { renderRail } from "../app/ui/rail.js";
import { focusHandle } from "./gpui_stub.mjs";

function memoryStorage(initial = null) {
  const values = new Map(
    initial ? [["omamail.accounts", JSON.stringify(initial)]] : [],
  );
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function ids(element, out = []) {
  if (!element || typeof element !== "object") return out;
  if (element.elementId) out.push(element.elementId);
  for (const child of element.childNodes ?? []) ids(child, out);
  return out;
}
function text(element, out = []) {
  if (typeof element === "string") out.push(element);
  if (!element || typeof element !== "object") return out;
  for (const child of element.childNodes ?? []) text(child, out);
  return out;
}
function actionHandler(element, name) {
  if (!element || typeof element !== "object") return null;
  if (element.actionHandlers?.has(name))
    return element.actionHandlers.get(name);
  for (const child of element.childNodes ?? []) {
    const found = actionHandler(child, name);
    if (found) return found;
  }
  return null;
}
function elementById(element, id) {
  if (!element || typeof element !== "object") return null;
  if (element.elementId === id) return element;
  for (const child of element.childNodes ?? []) {
    const found = elementById(child, id);
    if (found) return found;
  }
  return null;
}

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
let notifications = 0;
let boundActions = [];
const cx = {
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
  focus_handle: focusHandle,
  bind_keys: (bindings) => {
    boundActions = bindings;
    return 1;
  },
  spawn: () => {},
  notify: () => {
    notifications += 1;
  },
};
const taskCx = {
  ...cx,
  spawn(task) {
    return task(cx);
  },
};

function expiringContext() {
  let expired = false;
  let taskNotifications = 0;
  const taskCx = {
    notify() {
      taskNotifications += 1;
    },
  };
  return {
    context: {
      notify() {
        if (expired) throw new Error("stale GPUI event context");
      },
      spawn(task) {
        return task(taskCx);
      },
    },
    expire() {
      expired = true;
    },
    taskNotifications() {
      return taskNotifications;
    },
    taskCx,
  };
}
// The rail's user bar shows the mailbox in use and opens the switcher; it is
// the switcher's rows that change account, the way `AccountSwitcher.qml` does.
// Clicking the bar itself must not switch anything — there is nothing to
// switch to until the card is up.
const railEventCx = { notify() {} };
let forwardedRailCx = null;
const rail = renderRail(
  {
    accounts: [{ id: "one", label: "One", provider: "hey", selected: false }],
    mailboxes: [],
    switcherOpen: true,
    onAccount: (_id, _event, eventCx) => {
      forwardedRailCx = eventCx;
    },
    onMailbox() {},
  },
  cx,
);
elementById(rail, "account-switcher-one").clickHandler({}, railEventCx);
assert.equal(forwardedRailCx, railEventCx);

let themeTask = null;
const themeRuntimeCx = {
  ...cx,
  spawn(task) {
    themeTask = task;
  },
};
const themeApp = new Omamail();
themeApp.init({ storage: memoryStorage(), width: 1024 }, themeRuntimeCx);
await assert.doesNotReject(
  () => themeTask({}),
  "the async GPUI context has no synchronous theme() accessor",
);

const saved = {
  version: 1,
  activeId: "reader@example.com",
  accounts: [
    {
      id: "reader@example.com",
      email: "reader@example.com",
      provider: "gmail",
      label: "Reader",
    },
  ],
};
const storage = memoryStorage(saved);
const cache = createListCache(storage);
cache.writeList("reader@example.com", "in:inbox", [
  { id: "cached", subject: "Cached", labelIds: [] },
]);
const completions = [];
const app = new Omamail();
app.init(
  {
    storage,
    cache,
    calendarSources: [
      {
        id: "primary",
        kind: "google",
        accountId: "reader@example.com",
        url: "",
      },
    ],
    execute(_effect, complete) {
      completions.push(complete);
      return { cancel() {} };
    },
    width: 1024,
  },
  cx,
);
assert.equal(
  boundActions.every((binding) =>
    [
      "mail::cursorDown",
      "mail::cursorUp",
      "mail::open",
      "mail::backToList",
      "mail::back",
      "mail::compose",
      "mail::archive",
      "mail::trash",
      "mail::star",
      "mail::spam",
      "mail::markRead",
      "mail::markUnread",
      "mail::reply",
      "mail::replyAll",
      "mail::forward",
      "mail::calendar",
      "mail::calendarView",
      "mail::mailView",
      "mail::send",
      "mail::undoSend",
      "mail::createEvent",
      "mail::calendarNext",
      "mail::calendarPrevious",
      "mail::openCalendarEvent",
      "mail::calendarPreviousPeriod",
      "mail::calendarNextPeriod",
      "mail::calendarToday",
      "mail::calendarWeek",
      "mail::calendarMonth",
      "mail::settings",
      "mail::help",
      "mail::refresh",
      "mail::toggleSidebar",
      "mail::switchAccount",
      "mail::zoomIn",
      "mail::zoomOut",
      "mail::zoomReset",
      // The two the QML reader had from Qt: it drew the body in a
      // read-only TextEdit that selected by mouse, and this host cannot
      // register a text element with the shell's selection layer at all.
      "mail::copyBody",
      "mail::selectAll",
      // The two numbered rows carry their slot in the action's own name: an
      // action is handed to a handler as a name and nothing else, so ten keys
      // on one name are ten keys nothing can tell apart.
      ...Array.from({ length: 10 }, (_value, slot) => [
        `mail::goMailbox::${slot}`,
        `mail::goAccount::${slot}`,
      ]).flat(),
    ].includes(binding.action),
  ),
  true,
);
assert.equal(
  boundActions.some((binding) => binding.action === "mail::search"),
  false,
  "gpui gives an Input no focus handle, so `/` is a key this host cannot honour",
);
assert.equal(
  boundActions.some(
    (binding) =>
      binding.action === "mail::goMailbox::2" &&
      binding.keystroke === "secondary-3",
  ),
  true,
  "Ctrl+3 opens the third row of the rail",
);
assert.equal(
  boundActions.some((binding) => binding.action === "mail::archive"),
  true,
);
assert.equal(
  boundActions.some(
    (binding) =>
      binding.action === "mail::undoSend" && binding.keystroke === "alt-z",
  ),
  true,
  "the standalone shell binds Alt+Z",
);

const setup = new Omamail();
setup.init({ storage: memoryStorage() }, cx);
setup.chooseProvider("imap", cx);
assert.equal(setup.pendingAccountDraft.accounts[0].provider, "imap");
assert.equal(
  setup.pendingAccountDraft.accounts[0].id,
  "",
  "a pending draft is never a saved account",
);
assert.equal(setup.state.setupProviderId, "imap");
setup.back(cx);
assert.equal(setup.state.setupProviderId, null);
assert.equal(setup.pendingAccountDraft, null);

const setupStorage = memoryStorage();
let configuredSetupAccounts = [];
const connected = new Omamail();
connected.init(
  {
    storage: setupStorage,
    setupAdapters: {
      gmail: {
        begin: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
      },
      imap: {
        verifyAndStore: async () => ({
          account: {
            id: "imap:new@example.test",
            provider: "imap",
            email: "new@example.test",
            apiKey: "must-not-persist",
            imap: {
              username: "new",
              imapHost: "imap.example.test",
              imapPort: 993,
              smtpHost: "smtp.example.test",
              smtpPort: 465,
              insecure: false,
            },
          },
          context: {
            kind: "imap",
            accountId: "imap:new@example.test",
            email: "new@example.test",
            username: "new",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
            insecure: false,
          },
        }),
      },
      hey: {
        login: async () => ({}),
        status: async () => ({}),
        accounts: async () => ({}),
        logout: async () => ({}),
      },
    },
    configureHostContexts: async (accounts) => {
      configuredSetupAccounts = accounts;
    },
    execute(_effect, complete) {
      complete({ ok: true, value: { messages: [] } });
      return { cancel() {} };
    },
  },
  cx,
);
connected.chooseProvider("imap", cx);
connected.setupEmail.set_value("new@example.test");
connected.setupUsername.set_value("new");
connected.setupPassword.set_value("password-must-not-persist");
connected.setupImapHost.set_value("imap.example.test");
connected.setupSmtpHost.set_value("smtp.example.test");
await connected.submitSetup(taskCx);
const storedSetup = setupStorage.getItem("omamail.accounts");
assert.equal(storedSetup.includes("password-must-not-persist"), false);
assert.equal(storedSetup.includes("must-not-persist"), false);
assert.equal(configuredSetupAccounts[0].id, "imap:new@example.test");
assert.equal(connected.state.route, "mail");
assert.equal(mailKeyContext({ selectedId: "one" }, false), "MailReader");
assert.equal(mailKeyContext({ selectedId: "one" }, true), "MailList");

let completeLifetimeSetup;
const lifetimeSetup = new Omamail();
lifetimeSetup.init(
  {
    storage: memoryStorage(),
    setupAdapters: {
      gmail: {
        begin: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
      },
      imap: {
        verifyAndStore: () =>
          new Promise((resolve) => {
            completeLifetimeSetup = resolve;
          }),
      },
      hey: {
        login: async () => ({}),
        status: async () => ({}),
        accounts: async () => ({}),
        logout: async () => ({}),
      },
    },
    configureHostContexts: async () => {},
    execute(_effect, complete) {
      complete({ ok: true, value: { messages: [] } });
      return { cancel() {} };
    },
  },
  cx,
);
lifetimeSetup.chooseProvider("imap", cx);
lifetimeSetup.setupEmail.set_value("lifetime@example.test");
lifetimeSetup.setupUsername.set_value("lifetime");
lifetimeSetup.setupPassword.set_value("secret");
lifetimeSetup.setupImapHost.set_value("imap.example.test");
lifetimeSetup.setupSmtpHost.set_value("smtp.example.test");
const setupLifetime = expiringContext();
const pendingLifetimeSetup = lifetimeSetup.submitSetup(setupLifetime.context);
setupLifetime.expire();
completeLifetimeSetup({
  account: {
    id: "imap:lifetime@example.test",
    provider: "imap",
    email: "lifetime@example.test",
    imap: {
      username: "lifetime",
      imapHost: "imap.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      insecure: false,
    },
  },
  context: {
    kind: "imap",
    accountId: "imap:lifetime@example.test",
  },
});
await assert.doesNotReject(() => pendingLifetimeSetup);
assert.equal(setupLifetime.taskNotifications(), 1);

let completeCursorOpen;
let currentDraftDetail = null;
const cursorLifetime = expiringContext();
const cursorApp = new Omamail();
cursorApp.init({ storage: memoryStorage() }, cx);
cursorApp.controller = {
  openCursor(complete) {
    completeCursorOpen = complete;
  },
  snapshot() {
    return {
      detail: currentDraftDetail,
      accounts: {
        activeId: "reader@example.test",
        accounts: [],
      },
    };
  },
};
cursorApp.openCursor(cursorLifetime.context);
cursorLifetime.expire();
currentDraftDetail = {
  id: "draft-message",
  draftId: "draft-id",
  to: "recipient@example.test",
  cc: "",
  bcc: "",
  subject: "Draft",
  body: "Body",
};
assert.doesNotThrow(() => completeCursorOpen(currentDraftDetail));
await Promise.resolve();
assert.equal(cursorApp.state.route, "compose");
assert.equal(cursorLifetime.taskNotifications(), 1);

const listEffect = {
  kind: "hey.cli",
  accountId: "hey:reader@example.test",
  args: ["box", "imbox", "--json"],
  identity: {
    accountId: "hey:reader@example.test",
    query: "box:imbox",
    objectId: "",
    revision: 1,
  },
};
assert.equal(hostRequestFor(listEffect).accountId, "hey:reader@example.test");
assert.deepEqual(hostRequestFor(listEffect).identity, listEffect.identity);
assert.deepEqual(hostRequestFor(listEffect).query, {
  kind: "box",
  box: "imbox",
  unseen: false,
  page: undefined,
});
const normalizedList = normalizeHostReply(listEffect, {
  ok: true,
  data: {
    kind: "imbox",
    postings: [{ id: "17", name: "Host row", app_url: "/topics/99" }],
  },
});
assert.equal(normalizedList.ok, true);
assert.equal(normalizedList.value.messages[0].id, "17:99");
const normalizedDetail = normalizeHostReply(
  { kind: "hey.cli", args: ["threads", "99"], identity: { objectId: "17:99" } },
  { ok: true, data: { subject: "Host detail", text: "host body" } },
);
assert.equal(normalizedDetail.value.subject, "Host detail");
assert.equal(normalizedDetail.value.body, "host body");
assert.equal(normalizedDetail.value.id, "17:99");
assert.equal(normalizedDetail.value.threadId, "99");
assert.equal(
  normalizeHostReply(
    {
      kind: "hey.cli",
      args: ["threads", "99"],
      identity: { objectId: "18:99" },
    },
    { ok: true, data: { id: "17:99", text: "swapped" } },
  ).ok,
  false,
);
for (const objectId of ["17", "17:99:2", "x:99", "17:x", "17:", ":99"]) {
  assert.equal(
    normalizeHostReply(
      { kind: "hey.cli", args: ["threads", "99"], identity: { objectId } },
      { ok: true, data: { text: "host body" } },
    ).ok,
    false,
    `invalid HEY identity ${objectId} is refused`,
  );
}
assert.equal(
  normalizeHostReply(
    { kind: "hey.cli", args: ["seen", "17"], identity: { objectId: "17:99" } },
    { ok: true, data: {} },
  ).ok,
  true,
);
assert.equal(
  normalizeHostReply(listEffect, { ok: true, data: null }).ok,
  true,
  "a valid empty list is distinct from an unsupported request",
);
assert.equal(
  normalizeHostReply(listEffect, { ok: false, error: "unsupported" }).ok,
  false,
);
assert.equal(
  normalizeHostReply(listEffect, {
    ok: false,
    error: "refresh_token=secret ya29.private",
  }).error.includes("secret"),
  false,
);

assert.deepEqual(
  hostRequestFor({
    kind: "gmail.http",
    accountId: "reader@example.com",
    scope: "list",
    identity: { accountId: "reader@example.com", objectId: "", revision: 4 },
    hostOperation: {
      type: "list",
      query: "in:inbox",
      maxResults: 25,
      pageToken: "",
    },
    method: "GET",
    path: "/users/me/messages",
    query: { q: "in:inbox", maxResults: 25 },
    body: null,
  }),
  {
    operation: "gmail.list",
    deadlineMs: 30000,
    identity: { accountId: "reader@example.com", objectId: "", revision: 4 },
    query: "in:inbox",
    maxResults: 25,
    pageToken: null,
  },
);
assert.deepEqual(
  hostRequestFor({
    kind: "gmail.attachment",
    accountId: "a@example.test",
    identity: { accountId: "a@example.test", objectId: "m1", revision: 4 },
    messageId: "m1",
    partId: "part:1",
  }),
  {
    operation: "gmail.attachment",
    deadlineMs: 30000,
    identity: { accountId: "a@example.test", objectId: "m1", revision: 4 },
    messageId: "m1",
    partId: "part:1",
  },
);
assert.equal(
  hostRequestFor({ kind: "gmail.http", method: "DELETE", extra: "leak" }),
  null,
);
assert.equal(
  hostRequestFor({
    kind: "gmail.http",
    method: "GET",
    accountId: "reader@example.com",
    scope: "list",
    identity: { accountId: "reader@example.com", objectId: "", revision: 1 },
    hostOperation: { type: "list", query: "", maxResults: 25, pageToken: "" },
    path: "https://evil.test/",
    query: {},
    body: null,
  }).operation,
  "gmail.list",
);
assert.equal(
  hostRequestFor({ kind: "imap.transport", commands: "not-an-array" }),
  null,
);
assert.deepEqual(
  hostRequestFor({
    type: "compose.send",
    provider: "hey",
    accountId: "hey:me@example.test",
    draft: {
      mode: "reply",
      threadId: "99",
      to: [{ email: "sender@example.test" }],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      body: "Reply body",
    },
  }),
  {
    operation: "hey.compose",
    deadlineMs: 30000,
    accountId: "hey:me@example.test",
    mode: "reply",
    topicId: "99",
    to: [],
    cc: [],
    bcc: [],
    subject: "Re: Hello",
    body: "Reply body",
  },
);
assert.deepEqual(
  hostRequestFor({
    type: "compose.send",
    provider: "hey",
    accountId: "hey:me@example.test",
    draft: {
      mode: "forward",
      threadId: "",
      to: "to@example.test",
      cc: '"Copy, Person" <cc@example.test>',
      bcc: "",
      subject: "Fwd: Hello",
      body: "Forward body",
    },
  }),
  {
    operation: "hey.compose",
    deadlineMs: 30000,
    accountId: "hey:me@example.test",
    mode: "forward",
    topicId: "",
    to: ["to@example.test"],
    cc: ["cc@example.test"],
    bcc: [],
    subject: "Fwd: Hello",
    body: "Forward body",
  },
);
assert.equal(
  hostRequestFor({
    type: "compose.send",
    provider: "hey",
    accountId: "hey:me@example.test",
    draft: { mode: "replyAll", to: "a@example.test", body: "body" },
  }),
  null,
);
const imapIdentity = {
  accountId: "imap:me@example.test",
  objectId: "7:INBOX",
  revision: 2,
};
assert.equal(
  hostRequestFor({
    kind: "imap.list",
    accountId: imapIdentity.accountId,
    identity: { ...imapIdentity, objectId: "" },
    hostOperation: {
      type: "list",
      folder: "INBOX",
      criteria: "ALL",
      maxResults: 25,
      pageToken: "",
    },
    folder: "INBOX",
    criteria: "ALL",
    maxResults: 25,
  }).operation,
  "imap.list",
);
assert.deepEqual(
  hostRequestFor({
    kind: "imap.transport",
    scope: "object",
    accountId: imapIdentity.accountId,
    identity: imapIdentity,
    hostOperation: { type: "detail", messageId: "7:INBOX", full: true },
    folder: "INBOX",
    commands: ["arbitrary transport detail is ignored by host mapping"],
  }).operation,
  "imap.detail",
);
const imapAction = (messageIds) =>
  hostRequestFor({
    kind: "imap.transport",
    scope: "object",
    accountId: imapIdentity.accountId,
    identity: imapIdentity,
    hostOperation: { type: "action", action: "trash", messageIds },
  });
assert.equal(imapAction(["7:INBOX"]).operation, "imap.action");
assert.deepEqual(
  hostRequestFor({
    kind: "imap.runtime",
    accountId: imapIdentity.accountId,
    identity: { ...imapIdentity, objectId: "" },
  }),
  {
    operation: "imap.runtime",
    deadlineMs: 30000,
    identity: { ...imapIdentity, objectId: "" },
  },
);
assert.equal(
  hostRequestFor({
    kind: "imap.runtime",
    accountId: imapIdentity.accountId,
    identity: imapIdentity,
  }),
  null,
);
assert.equal(imapAction(Array(101).fill("7:INBOX")), null);
assert.equal(imapAction([`${"7".repeat(2049)}:INBOX`]), null);
assert.equal(imapAction(Array(40).fill(`${"7".repeat(1690)}:INBOX`)), null);
assert.equal(
  hostRequestFor({
    type: "compose.send",
    provider: "gmail",
    accountId: "a@example.test",
    draft: {
      mode: "new",
      to: "b@example.test",
      cc: "",
      bcc: "",
      subject: "s",
      body: "b",
    },
  }).deadlineMs,
  30000,
);
assert.deepEqual(
  hostRequestFor({
    type: "compose.send",
    provider: "gmail",
    accountId: "a@example.test",
    draft: {
      mode: "new",
      to: '"Doe, Jane" <jane@example.test>, Team <team@example.test>',
      cc: [{ display: "Copy, Person", email: "copy@example.test" }],
      bcc: "",
      subject: "s",
      body: "b",
    },
  }).draft.to,
  ["jane@example.test", "team@example.test"],
  "the host DTO normalizes structured display addresses without splitting quoted commas",
);
assert.equal(
  hostRequestFor({
    type: "calendar.list",
    source: {
      kind: "caldav",
      id: "work",
      url: "https://calendar.example.test/me/",
      accountId: "",
    },
    range: { startMs: 1, endMs: 2 },
  }).sourceUrl,
  "https://calendar.example.test/me/",
);
assert.equal(
  hostRequestFor({
    type: "calendar.list",
    source: { kind: "google", id: "", accountId: "a@example.test" },
    range: { startMs: Number.NaN, endMs: 2 },
  }),
  null,
);
assert.equal(
  hostRequestFor({
    type: "calendar.caldav.write",
    source: {
      kind: "caldav",
      id: "work",
      url: "https://calendar.example.test/me/",
      accountId: "",
    },
    sourceId: "work",
    sourceUrl: "https://calendar.example.test/me/",
    url: "one.ics",
    payload:
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  }).deadlineMs,
  30000,
);
assert.equal(
  hostRequestFor({
    type: "calendar.google.write",
    source: {
      kind: "google",
      id: "primary",
      accountId: "a@example.test",
      url: "",
    },
    sourceId: "primary",
    eventId: "",
    payload: {
      summary: "Event",
      description: "",
      location: "",
      start: { date: "2026-08-29" },
      end: { date: "2026-08-30" },
    },
  }).deadlineMs,
  30000,
);
assert.equal(
  hostRequestFor({
    type: "calendar.google.delete",
    source: {
      kind: "google",
      id: "primary",
      accountId: "a@example.test",
    },
    sourceId: "primary",
    eventId: "event-1",
  }).eventId,
  "event-1",
);
assert.equal(
  hostRequestFor({
    type: "calendar.caldav.delete",
    source: {
      kind: "caldav",
      id: "work",
      url: "https://calendar.example.test/me/",
    },
    sourceId: "work",
    url: "event-1.ics",
  }).url,
  "event-1.ics",
);
assert.equal(
  hostRequestFor({
    type: "compose.send",
    provider: "gmail",
    accountId: "a@example.test",
    draft: {
      mode: "new",
      to: "b@example.test",
      cc: "",
      bcc: "",
      subject: "x".repeat(16385),
      body: "x",
    },
  }),
  null,
);
assert.equal(
  hostRequestFor({
    type: "calendar.google.write",
    source: {
      kind: "google",
      id: "primary",
      accountId: "a@example.test",
      url: "",
    },
    sourceId: "primary",
    eventId: "",
    payload: { summary: "x", start: {}, end: {} },
  }),
  null,
);
assert.deepEqual(
  normalizeHostReply(
    { kind: "gmail.http" },
    { ok: true, data: { status: 200 } },
  ),
  { ok: true, value: { status: 200 } },
);

let rendered = ids(app.render(cx));
assert.ok(rendered.includes("account-reader@example.com"));
assert.ok(rendered.includes("message-cached-cursor"));
assert.ok(rendered.includes("mail-list-pane"));
// 1024 units is a three-column window in `App.qml` — the sidebar stands, the
// list is pinned to its resolved width, and the reader is beside it holding
// its blank slate. The older assertion here said the reader stayed away,
// which was true only of the 1194px split threshold this branch replaced.
assert.ok(
  rendered.includes("mail-rail"),
  "a 1024-unit viewport is wide enough for the sidebar",
);
assert.ok(
  rendered.includes("reader-blank"),
  "with no message chosen the reader shows its blank slate rather than nothing",
);

app.compose.update({ subject: "Keep this draft", body: "Unfinished" });
app.openCompose(cx);
app.back(cx);
app.openCompose(cx);
assert.equal(
  app.compose.snapshot().draft.subject,
  "Keep this draft",
  "leaving and reopening Compose preserves the unsent draft",
);
app.compose.discard();
app.back(cx);

// An uncertain credential deletion deliberately removes the old account and
// asks the user to add it again. A completed replacement is the one event that
// makes that warning stale; a failed commit must leave it visible.
const reauthApp = new Omamail();
reauthApp.init(
  {
    storage: memoryStorage(saved),
    execute() {
      return { cancel() {} };
    },
    configureHostContexts: async () => {},
  },
  cx,
);
reauthApp.hostConfigurationError = "Credential state uncertain; sign in again";
reauthApp.setupFailure = "Previous setup failed";
await reauthApp.commitSetup({
  account: saved.accounts[0],
  context: { kind: "gmail", accountId: saved.accounts[0].id },
});
assert.equal(reauthApp.hostConfigurationError, "");
assert.equal(reauthApp.setupFailure, "");

reauthApp.hostConfigurationError = "Credential state uncertain; sign in again";
reauthApp.setupFailure = "Previous setup failed";
reauthApp.configureNativeHost = async () => {
  throw new Error("configuration failed");
};
await reauthApp.commitSetup({
  account: saved.accounts[0],
  context: { kind: "gmail", accountId: saved.accounts[0].id },
});
assert.equal(
  reauthApp.hostConfigurationError,
  "Credential state uncertain; sign in again",
);
assert.notEqual(
  reauthApp.setupFailure,
  "",
  "failed re-auth keeps an honest setup error",
);

app.openSettings(cx);
rendered = ids(app.render(cx));
assert.ok(rendered.includes("settings-page"));
assert.ok(rendered.includes("settings-account-reader@example.com"));
assert.ok(rendered.includes("settings-remote-images-toggle"));
app.back(cx);
assert.equal(app.state.route, "mail");

completions.shift()({
  status: 200,
  value: {
    messages: [
      {
        id: "live",
        labelIds: ["UNREAD"],
        payload: {
          headers: [{ name: "Subject", value: "Live" }],
          mimeType: "text/plain",
          body: { data: "Qm9keQ" },
        },
      },
    ],
  },
});
assert.ok(notifications > 0, "controller completion schedules a new frame");
rendered = ids(app.render(cx));
assert.ok(rendered.includes("message-live-cursor"));
assert.deepEqual(
  cache.readList("reader@example.com", "in:inbox").map((message) => message.id),
  ["live"],
);

app.openCursor(cx);
// The reader opens on what the list already knows and skeletons the body
// alone. A whole-pane skeleton hid the sender and the subject, which are the
// very things that had just become available.
const opening = app.render(cx);
assert.ok(!ids(opening).includes("reader-loading"));
assert.ok(ids(opening).includes("reader-message-header"));
assert.ok(ids(opening).includes("reader-body-loading"));
assert.ok(
  text(opening).includes("Live"),
  "the header is seeded from the row the reader was opened on",
);
completions.shift()({
  ok: true,
  value: {
    id: "live",
    labelIds: ["UNREAD"],
    payload: {
      headers: [{ name: "Subject", value: "Live" }],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: "aG9zdCBib2R5" } },
        {
          mimeType: "text/html",
          body: {
            data: "PGgyPkhvc3QgaGVhZGluZzwvaDI-PHA-aG9zdCA8Yj5ib2R5PC9iPjwvcD48aW1nIHNyYz0iaHR0cHM6Ly90cmFja2VyLmV4YW1wbGUvb3Blbi5wbmciPg",
          },
        },
      ],
    },
  },
});
assert.ok(
  ids(app.render(cx)).includes("reader-content-live"),
  "normalized host detail reaches the reader",
);
assert.ok(text(app.render(cx)).includes("host body"));
// The mode picker is a segmented track — Reader / Original / Plain — the way
// `MessageReader.qml` draws it, not a single toggle.
assert.ok(ids(app.render(cx)).includes("reader-mode-track"));
assert.ok(ids(app.render(cx)).includes("reader-remote-images-blocked"));
assert.ok(text(app.render(cx)).includes("Host heading"));
assert.equal(
  text(app.render(cx)).some((value) => value.includes("tracker.example")),
  false,
);
app.back(cx);
assert.ok(ids(app.render(cx)).includes("message-live-cursor"));

app.openCompose(cx);
const composeFrame = app.renderCompose(cx);
assert.equal(
  actionHandler(composeFrame, "mail::archive"),
  null,
  "Compose owns only compose actions",
);
assert.ok(actionHandler(composeFrame, "mail::send"));
assert.ok(ids(app.render(cx)).includes("compose"));
const retainedTo = app.composeTo;
const retainedSubject = app.composeSubject;
const retainedBody = app.composeBody;
app.render(cx);
assert.equal(
  app.composeTo,
  retainedTo,
  "compose recipient state survives rendering",
);
assert.equal(
  app.composeSubject,
  retainedSubject,
  "compose subject state survives rendering",
);
assert.equal(
  app.composeBody,
  retainedBody,
  "compose body state survives rendering",
);
app.composeTo.set_value("writer@example.test");
app.composeTo.emit("change", cx);
app.composeSubject.set_value("A retained draft");
app.composeSubject.emit("change", cx);
app.composeBody.set_value("Editable body");
app.composeBody.emit("change", cx);
assert.deepEqual(app.compose.snapshot().draft, {
  accountId: "reader@example.com",
  mode: "new",
  to: "writer@example.test",
  cc: "",
  bcc: "",
  subject: "A retained draft",
  body: "Editable body",
});
await app.settings.setUndoSendSeconds(7);
let requestedSleep = null;
const delayedCx = {
  ...cx,
  spawn(task) {
    return task({
      ...cx,
      sleep(milliseconds) {
        requestedSleep = milliseconds;
        return new Promise(() => {});
      },
    });
  },
};
const completionsBeforeDelayedSend = completions.length;
actionHandler(app.renderCompose(delayedCx), "mail::send")({}, delayedCx);
assert.equal(completions.length, completionsBeforeDelayedSend);
// A beat, not one sleep for the whole delay. The countdown is worked out from
// the clock, so something has to make the clock move — sleeping the delay out
// in one go is why the toast read "Sending in 10s" for ten seconds.
assert.equal(requestedSleep, 250);
assert.ok(app.compose.snapshot().pending, "the preference delays delivery");
// The draft has left the form: the window is back on the list, and the fields
// behind the toast belong to the next message rather than to the queued one.
assert.equal(app.state.route, "mail");
assert.equal(app.compose.snapshot().draft.subject, "");
assert.equal(
  app.compose.snapshot().pending.payload.subject,
  "A retained draft",
);
actionHandler(app.render(delayedCx), "mail::undoSend")({}, delayedCx);
assert.equal(app.compose.snapshot().pending, null);
assert.equal(app.compose.snapshot().sending, false);
app.compose.send(0, 0);
assert.equal(
  completions.length > 0,
  true,
  "compose reaches the injected host executor",
);
const notificationsBeforeComposeCompletion = notifications;
completions.shift()({ ok: false, error: "unsupported by host" });
assert.equal(
  notifications > notificationsBeforeComposeCompletion,
  true,
  "compose completion invalidates the view without another user event",
);
assert.ok(text(app.render(cx)).includes("unsupported by host"));
app.back(cx);
assert.ok(ids(app.render(cx)).includes("message-list"));

app.openCalendar(cx);
const retainedCalendarTitle = app.calendarTitle;
const retainedCalendarStart = app.calendarStart;
const retainedCalendarEnd = app.calendarEnd;
app.calendar.beginCreate();
app.syncCalendarFields();
app.render(cx);
app.render(cx);
assert.equal(app.calendarTitle, retainedCalendarTitle);
assert.equal(app.calendarStart, retainedCalendarStart);
assert.equal(app.calendarEnd, retainedCalendarEnd);
app.calendarTitle.set_value("Planning");
app.calendarTitle.emit("change", cx);
app.calendarStart.set_value("2026-09-01T09:00:00.000Z");
app.calendarStart.emit("change", cx);
app.calendarEnd.set_value("2026-09-01T10:00:00.000Z");
app.calendarEnd.emit("change", cx);
assert.equal(app.calendar.snapshot().editing.fields.title, "Planning");
app.calendar.showMonth(Date.UTC(2026, 7, 1));
assert.ok(ids(app.render(cx)).includes("calendar"));
assert.equal(
  completions.length > 0,
  true,
  "calendar reaches the injected host executor",
);
while (completions.length > 1)
  completions.shift()({ ok: false, error: "stale calendar request" });
completions.shift()({ ok: false, error: "calendar unavailable" });
// Every enabled calendar is read at once now, so a failure names the one that
// failed rather than leaving the user to guess which of several is down. A
// signed-in Gmail account's calendar is synthesised from the account, so the
// name it reports itself under is that address.
assert.ok(
  text(app.render(cx)).some((value) =>
    /^\S+: calendar unavailable$/.test(String(value)),
  ),
);
app.back(cx);
assert.ok(
  ids(app.render(cx)).includes("calendar"),
  "Escape cancels the editor first",
);
assert.equal(app.calendar.snapshot().editing, null);
const preservedAnchor = Date.UTC(2026, 7, 20);
app.calendar.showWeek(preservedAnchor);
completions.shift()({ ok: true, value: [] });
app.back(cx);
assert.ok(ids(app.render(cx)).includes("message-list"));
const completionsBeforeReopen = completions.length;
app.openCalendar(cx);
assert.equal(app.calendar.snapshot().view, "week");
assert.equal(app.calendar.snapshot().anchorMs, preservedAnchor);
assert.equal(
  completions.length,
  completionsBeforeReopen,
  "reopening calendar preserves its loaded range",
);
app.back(cx);

let hostRequest = null;
const hostReplies = [];
const executeHost = createHostExecutor(
  () => {},
  async () => ({
    async dispatch(request) {
      hostRequest = JSON.parse(request);
      return JSON.stringify({
        ok: true,
        data: { kind: "imbox", postings: [] },
      });
    },
  }),
);
await new Promise((resolve) =>
  executeHost(listEffect, (reply) => {
    hostReplies.push(reply);
    resolve();
  }),
);
assert.equal(hostRequest.operation, "hey.list");
assert.deepEqual(hostReplies[0], { ok: true, value: { messages: [] } });

const contextAccounts = [
  {
    id: "me@example.test",
    email: "me@example.test",
    provider: "gmail",
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "never-send",
  },
  {
    id: "imap:me@example.test",
    email: "me@example.test",
    provider: "imap",
    password: "never-send",
    imap: {
      imapHost: "mail.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      username: "me",
      insecure: false,
    },
  },
];
const contextSources = [
  {
    id: "work",
    kind: "google",
    accountId: "me@example.test",
    remoteCalendarId: "primary",
    url: "",
  },
];
const contextPlan = hostContextsFor(contextAccounts, contextSources);
assert.equal(
  JSON.stringify(contextPlan.contexts).includes("never-send"),
  false,
);
assert.equal(contextPlan.contexts.length, 3);
assert.equal(contextPlan.contexts[2].remoteCalendarId, "primary");
assert.deepEqual(contextPlan.accountErrors, {});
assert.deepEqual(contextPlan.sourceErrors, {});

const mixedPlan = hostContextsFor(
  [
    ...contextAccounts,
    {
      id: "imap:broken@example.test",
      email: "broken@example.test",
      provider: "imap",
      imap: {
        imapHost: "bad host",
        imapPort: 993,
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        username: "broken",
      },
    },
  ],
  [
    ...contextSources,
    { id: "wrong-google", kind: "google", accountId: "imap:me@example.test" },
    {
      id: "bad-caldav",
      kind: "caldav",
      accountId: "imap:me@example.test",
      url: "https://user:pass@calendar.example.test/a?leak",
    },
  ],
);
assert.equal(
  mixedPlan.contexts.length,
  3,
  "valid contexts survive malformed siblings",
);
assert.equal(
  mixedPlan.accountErrors["imap:broken@example.test"],
  "IMAP settings are invalid",
);
assert.equal(
  mixedPlan.sourceErrors["wrong-google"],
  "Google Calendar requires a Gmail account",
);
assert.equal(
  mixedPlan.sourceErrors["bad-caldav"],
  "CalDAV source URL is invalid",
);
assert.equal(
  hostRequestFor({ operation: "configure", contexts: mixedPlan.contexts }),
  null,
  "the generic effect dispatcher cannot configure host contexts",
);
// A mailbox with no SMTP server is a supported setup rather than an invalid
// one: `Imap.validateSettings` has always accepted an empty SMTP host and
// `Imap.smtpUrl` answers "" for one. It reaches the host as a context carrying
// no outgoing server, and nothing else about it is relaxed.
const readOnlyPlan = hostContextsFor(
  [
    {
      id: "imap:read@example.test",
      email: "read@example.test",
      provider: "imap",
      imap: {
        imapHost: "mail.example.test",
        imapPort: 993,
        // What the account store leaves behind for a mailbox that names no
        // server: an empty host beside its default port.
        smtpHost: "",
        smtpPort: 465,
        username: "read",
      },
    },
  ],
  [],
);
assert.deepEqual(readOnlyPlan.accountErrors, {});
assert.equal(readOnlyPlan.contexts.length, 1);
assert.equal(readOnlyPlan.contexts[0].smtpHost, "");
assert.equal(
  readOnlyPlan.contexts[0].smtpPort,
  0,
  "a mailbox that names no server carries no port for one",
);
// The loopback rule still judges whatever hosts are present. A clear-text
// account with a remote SMTP server is refused as before, and one with none is
// judged on its IMAP host alone.
assert.equal(
  hostContextsFor(
    [
      {
        id: "imap:bridge@example.test",
        email: "bridge@example.test",
        provider: "imap",
        imap: {
          imapHost: "127.0.0.1",
          imapPort: 1143,
          smtpHost: "smtp.example.test",
          smtpPort: 587,
          username: "bridge",
          insecure: true,
        },
      },
    ],
    [],
  ).accountErrors["imap:bridge@example.test"],
  "IMAP settings are invalid",
);
assert.equal(
  hostContextsFor(
    [
      {
        id: "imap:bridge@example.test",
        email: "bridge@example.test",
        provider: "imap",
        imap: {
          imapHost: "127.0.0.1",
          imapPort: 1143,
          smtpHost: "",
          smtpPort: 0,
          username: "bridge",
          insecure: true,
        },
      },
    ],
    [],
  ).contexts.length,
  1,
);
// And a host that is present and unusable is still invalid rather than being
// read as an absent one.
assert.equal(
  hostContextsFor(
    [
      {
        id: "imap:bad@example.test",
        email: "bad@example.test",
        provider: "imap",
        imap: {
          imapHost: "mail.example.test",
          imapPort: 993,
          smtpHost: "smtp host.example",
          smtpPort: 465,
          username: "bad",
        },
      },
    ],
    [],
  ).accountErrors["imap:bad@example.test"],
  "IMAP settings are invalid",
);
const canonicalPlan = hostContextsFor(
  [
    {
      id: "imap:v6@example.test",
      email: "v6@example.test",
      provider: "imap",
      imap: {
        imapHost: "2001:4860:4860::8888",
        imapPort: 993,
        smtpHost: "bücher.example",
        smtpPort: 465,
        username: "v6",
      },
    },
  ],
  [],
);
assert.equal(
  canonicalPlan.contexts.length,
  1,
  "IPv6 and IDNA hosts reach Rust canonicalization",
);
const loopbackPlan = hostContextsFor(
  [
    {
      id: "imap:local@example.test",
      email: "local@example.test",
      provider: "imap",
      imap: {
        imapHost: "0:0:0:0:0:0:0:1",
        imapPort: 1143,
        smtpHost: "127.1",
        smtpPort: 1025,
        username: "local",
        insecure: true,
      },
    },
  ],
  [],
);
assert.equal(
  loopbackPlan.contexts.length,
  1,
  "expanded IPv6 and canonical IPv4 loopback match Rust",
);
const duplicatePlan = hostContextsFor(
  [...contextAccounts, { ...contextAccounts[0] }],
  [
    ...contextSources,
    { ...contextSources[0] },
    { id: "not allowed", kind: "google", accountId: "me@example.test" },
  ],
);
assert.equal(
  duplicatePlan.contexts.length,
  1,
  "duplicate account/source identities are withheld",
);
assert.equal(
  duplicatePlan.accountErrors["me@example.test"],
  "Account identity is duplicated",
);
assert.equal(
  duplicatePlan.sourceErrors.work,
  "Calendar source identity is duplicated",
);
assert.equal(
  duplicatePlan.sourceErrors["not allowed"],
  "Calendar source identity is invalid",
);
let configuredJson = "";
await configureHostContexts(contextAccounts, contextSources, async () => ({
  async configure(json) {
    configuredJson = json;
    return "{}";
  },
}));
assert.equal(configuredJson.includes("clientSecret"), false);
assert.equal(configuredJson.includes("password"), false);
let emptyConfiguredJson = "not-called";
await configureHostContexts([], [], async () => ({
  async configure(json) {
    emptyConfiguredJson = json;
    return "{}";
  },
}));
assert.equal(
  emptyConfiguredJson,
  "[]",
  "an explicit empty replacement clears every native host context",
);
const order = [];
let releaseConfigure;
const configured = new Promise((resolve) => {
  releaseConfigure = resolve;
});
const orderedExecutor = createHostExecutor(
  () => {},
  async () => ({
    async dispatch() {
      order.push("dispatch");
      return JSON.stringify({ ok: true, data: null });
    },
  }),
  configured,
);
const orderedDone = new Promise((resolve) =>
  orderedExecutor(listEffect, resolve),
);
await Promise.resolve();
assert.deepEqual(order, []);
order.push("configure");
releaseConfigure();
await orderedDone;
assert.deepEqual(order, ["configure", "dispatch"]);
const failedConfigureReply = await new Promise((resolve) =>
  createHostExecutor(
    () => {},
    async () => {
      throw new Error("must not load dispatch after configure failure");
    },
    Promise.reject(new Error("invalid host context")),
  )(listEffect, resolve),
);
assert.deepEqual(failedConfigureReply, {
  ok: false,
  error: "Mail host is unavailable",
});

let heyConfigureAttempts = 0;
const heyOnlyApp = new Omamail();
heyOnlyApp.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "saved@example.com",
      accounts: [
        {
          id: "saved@example.com",
          email: "saved@example.com",
          provider: "hey",
          label: "Saved HEY",
        },
      ],
    }),
    configureHostContexts: async () => {
      heyConfigureAttempts += 1;
      throw new Error("HEY has no native account context");
    },
  },
  cx,
);
assert.equal(
  heyConfigureAttempts,
  0,
  "a HEY-only workspace does not import the native context configurator",
);
assert.ok(
  heyOnlyApp.controller,
  "a HEY-only saved workspace restores before its first provider request",
);

const heyEffects = [];
const heyCompletions = [];
const heyFlow = new Omamail();
heyFlow.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "hey:me@example.test",
      accounts: [
        {
          id: "hey:me@example.test",
          email: "me@example.test",
          provider: "hey",
          label: "HEY",
        },
        {
          id: "hey:other@example.test",
          email: "other@example.test",
          provider: "hey",
          label: "Other HEY",
        },
      ],
    }),
    execute(effect, complete) {
      heyEffects.push(effect);
      heyCompletions.push(complete);
      return { cancel() {} };
    },
  },
  cx,
);
let heyEffect = heyEffects.shift();
heyCompletions.shift()(
  normalizeHostReply(heyEffect, {
    ok: true,
    data: {
      kind: "imbox",
      postings: [
        {
          id: "17",
          name: "HEY thread",
          app_url: "/topics/99",
          creator: {
            name: "Sender",
            email_address: "sender@example.test",
          },
        },
      ],
    },
  }),
);
assert.deepEqual(heyFlow.controller.snapshot().mail.messages[0].from, {
  name: "Sender",
  email: "sender@example.test",
});
assert.equal(
  displayAddress(heyFlow.controller.snapshot().mail.messages[0].from),
  "Sender <sender@example.test>",
);
let clickNotifications = 0;
const clickCx = { notify: () => (clickNotifications += 1) };
elementById(heyFlow.render(cx), "message-17:99-cursor").clickHandler(
  {},
  clickCx,
);
assert.equal(
  clickNotifications,
  1,
  "message click uses its live event context",
);
heyFlow.openCursor(cx);
heyEffect = heyEffects.shift();
assert.deepEqual(heyEffect.identity.objectId, "17:99");
heyCompletions.shift()(
  normalizeHostReply(heyEffect, {
    ok: true,
    data: { subject: "HEY thread", text: "Thread body" },
  }),
);
heyFlow.openResponse("reply", cx);
assert.equal(heyFlow.compose.snapshot().draft.threadId, "99");
assert.equal(
  heyFlow.compose.snapshot().draft.to,
  "Sender <sender@example.test>",
);
heyFlow.compose.update({ body: "Reply body" });
heyFlow.compose.send();
assert.equal(
  heyEffects.at(-1)?.type,
  "compose.send",
  JSON.stringify(heyEffects.at(-1)),
);
assert.equal(hostRequestFor(heyEffects.at(-1)).topicId, "99");
heyCompletions.pop()({ ok: true, value: {} });
heyFlow.openResponse("forward", cx);
assert.equal(heyFlow.compose.snapshot().draft.threadId, undefined);
heyFlow.compose.update({ to: "next@example.test", body: "Forward body" });
heyFlow.compose.send();
assert.equal(hostRequestFor(heyEffects.at(-1)).mode, "forward");

let configureAttempts = 0;
const retryApp = new Omamail();
const retryStorage = memoryStorage({
  version: 1,
  activeId: "reader@example.com",
  accounts: [
    {
      id: "reader@example.com",
      email: "reader@example.com",
      provider: "gmail",
      clientId: "client.apps.googleusercontent.com",
    },
  ],
});
retryApp.init(
  {
    storage: retryStorage,
    configureHostContexts: async () => {
      configureAttempts += 1;
      if (configureAttempts === 1) throw new Error("network token=private");
    },
  },
  cx,
);
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  retryApp.controller,
  undefined,
  "a failed startup configuration does not start mail effects",
);
assert.equal(
  retryApp.hostConfigurationError,
  "Mail host configuration is unavailable",
);
assert.ok(
  text(retryApp.render(cx)).includes("Mail host configuration is unavailable"),
);
retryStorage.setItem(
  "omamail.accounts",
  JSON.stringify({
    version: 1,
    activeId: "reader@example.com",
    accounts: [
      {
        id: "reader@example.com",
        email: "reader@example.com",
        provider: "gmail",
        clientId: "not-a-google-client",
      },
    ],
  }),
);
await retryApp.retryHostConfiguration(taskCx);
assert.equal(
  configureAttempts,
  1,
  "retry rejects a newly-invalid storage snapshot before native configuration",
);
assert.equal(retryApp.controller, undefined);
retryStorage.setItem(
  "omamail.accounts",
  JSON.stringify({
    version: 1,
    activeId: "reader@example.com",
    accounts: [
      {
        id: "reader@example.com",
        email: "reader@example.com",
        provider: "gmail",
        clientId: "client.apps.googleusercontent.com",
      },
    ],
  }),
);
await retryApp.retryHostConfiguration(taskCx);
assert.equal(configureAttempts, 2, "retry uses a fresh configuration attempt");
assert.ok(retryApp.controller, "a successful retry starts the controller");

let mixedConfigureCalls = 0;
const mixedActiveApp = new Omamail();
mixedActiveApp.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "imap:broken@example.test",
      accounts: [
        {
          id: "imap:broken@example.test",
          email: "broken@example.test",
          provider: "imap",
          imap: {
            imapHost: "bad host",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
            username: "broken",
          },
        },
        {
          id: "good@example.test",
          email: "good@example.test",
          provider: "gmail",
          clientId: "good.apps.googleusercontent.com",
        },
      ],
    }),
    async configureHostContexts() {
      mixedConfigureCalls += 1;
    },
  },
  cx,
);
await Promise.resolve();
await Promise.resolve();
assert.equal(mixedConfigureCalls, 1, "valid sibling contexts still configure");
assert.ok(
  mixedActiveApp.controller,
  "invalid active account does not prevent switching to a valid sibling",
);
assert.equal(
  mixedActiveApp.hostConfigurationError,
  "IMAP settings are invalid",
);
assert.ok(
  text(mixedActiveApp.render(cx)).includes("IMAP settings are invalid"),
);
mixedActiveApp.switchAccount("good@example.test", cx);
assert.equal(mixedActiveApp.hostConfigurationError, "");

const imapCalls = [];

const identityEffects = [];
const identityCompletions = [];
const identityApp = new Omamail();
identityApp.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "first@example.test",
      accounts: [
        {
          id: "first@example.test",
          email: "first@example.test",
          provider: "gmail",
        },
        {
          id: "second@example.test",
          email: "second@example.test",
          provider: "gmail",
        },
      ],
    }),
    execute(effect, complete) {
      identityEffects.push(effect);
      identityCompletions.push(complete);
      if (effect.type === "compose.send") complete({ ok: true });
      return { cancel() {} };
    },
  },
  cx,
);
await identityApp.hostReady;
await Promise.resolve();
await Promise.resolve();
assert.ok(
  identityApp.controller,
  "mail action integration requires an initialized controller",
);
identityCompletions.shift()({
  status: 200,
  value: {
    messages: [
      { id: "key-row", labelIds: ["INBOX"], payload: { headers: [] } },
    ],
  },
});
const mailFrame = identityApp.renderMail(cx);
assert.equal(
  mailFrame.actionHandlers.size > 0,
  true,
  `mail frame handlers: ${[...mailFrame.actionHandlers.keys()].join(",")}`,
);
const archiveKeyHandler = actionHandler(mailFrame, "mail::archive");
assert.ok(
  archiveKeyHandler,
  `mail frame handlers: ${[...mailFrame.actionHandlers.keys()].join(",")}`,
);
const replyKeyHandler = actionHandler(mailFrame, "mail::reply");
replyKeyHandler({}, taskCx);
assert.equal(
  identityEffects.at(-1).scope,
  "object",
  "MailList reply first fetches the cursor detail",
);
identityCompletions.shift()({
  status: 200,
  value: {
    id: "key-row",
    threadId: "thread-key",
    payload: {
      headers: [
        { name: "From", value: '"Doe, Jane" <jane@example.test>' },
        { name: "Message-ID", value: "<key-row@example.test>" },
        { name: "Subject", value: "Key reply" },
      ],
      mimeType: "text/plain",
      body: { data: "Qm9keQ" },
    },
  },
});
await Promise.resolve();
assert.equal(identityApp.state.route, "compose");
assert.equal(
  identityApp.compose.snapshot().draft.to,
  '"Doe, Jane" <jane@example.test>',
);
identityApp.openMail(cx);
archiveKeyHandler({}, cx);
assert.equal(
  identityEffects.at(-1).hostOperation?.action,
  "archive",
  "the MailList key handler reaches the shared controller action",
);
identityCompletions.shift()({ ok: true });
identityApp.switchAccount("second@example.test", cx);
// The field is debounced, so the read is issued once the typing settles rather
// than once per keystroke. A context that can sleep is what runs the settle.
let searchSleep = 0;
const searchCx = {
  ...cx,
  spawn(task) {
    return task({
      ...cx,
      sleep(milliseconds) {
        searchSleep = milliseconds;
        return Promise.resolve();
      },
    });
  },
};
const effectsBeforeTyping = identityEffects.length;
identityApp.search.set_value("from:fr");
identityApp.search.emit("change", searchCx);
identityApp.search.set_value("from:friend@example.test");
identityApp.search.emit("change", searchCx);
assert.equal(
  identityEffects.length,
  effectsBeforeTyping,
  "a keystroke does not issue a list read of its own",
);
assert.equal(searchSleep, 250);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  identityEffects.length,
  effectsBeforeTyping + 1,
  "two keystrokes settle into one read",
);
assert.equal(
  identityEffects.at(-1).query.q,
  "from:friend@example.test",
  "the retained search input reaches the active account controller",
);
identityApp.compose.compose({
  accountId: "second@example.test",
  to: "recipient@example.test",
  subject: "Identity",
  body: "Body",
});
identityApp.compose.send(0, 0);
assert.equal(identityEffects.at(-1).type, "compose.send");
assert.equal(identityEffects.at(-1).accountId, "second@example.test");

const imapApp = new Omamail();
imapApp.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "imap:reader@example.test",
      accounts: [
        {
          id: "imap:reader@example.test",
          email: "reader@example.test",
          provider: "imap",
          // A mailbox that can answer, which is what the reply below is
          // about. An IMAP account with no SMTP server is a different
          // mailbox — see the read-only case further down.
          imap: {
            username: "reader@example.test",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
          },
        },
      ],
    }),
    execute(effect, complete) {
      imapCalls.push({ effect, complete });
      return { cancel() {} };
    },
  },
  cx,
);
assert.equal(imapCalls[0].effect.kind, "imap.runtime");
imapCalls.shift().complete({
  ok: true,
  value: { specialUse: { "\\sent": "INBOX" }, supportsMove: false },
});
assert.equal(imapCalls[0].effect.kind, "imap.list");
const imapMime =
  "From: Ada <ada@example.test>\r\n" +
  "To: Reader <reader@example.test>\r\n" +
  "Cc: Copy <copy@example.test>\r\n" +
  "Message-ID: <imap-message@example.test>\r\n" +
  "References: <imap-root@example.test>\r\n" +
  "Subject: Multipart IMAP\r\n" +
  "Content-Type: multipart/alternative; boundary=mail\r\n\r\n" +
  "--mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain IMAP body\r\n" +
  "--mail\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML IMAP body</p>\r\n--mail--\r\n";
const imapWire = `* 1 FETCH (UID 9 FLAGS () RFC822.SIZE ${Buffer.byteLength(imapMime)} BODY[] {${Buffer.byteLength(imapMime)}}\r\n${imapMime})\r\nA1 OK done\r\n`;
imapCalls.shift().complete({
  ok: true,
  value: { responseBase64: Buffer.from(imapWire).toString("base64") },
});
assert.ok(
  imapApp.controller.snapshot().mail.messages[0].labelIds.includes("SENT"),
);
assert.ok(ids(imapApp.render(cx)).includes("message-9:INBOX-cursor"));
imapApp.openCursor(cx);
assert.equal(imapCalls[0].effect.kind, "imap.transport");
imapCalls.shift().complete({
  ok: true,
  value: { responseBase64: Buffer.from(imapWire).toString("base64") },
});
assert.ok(ids(imapApp.render(cx)).includes("reader-content-9:INBOX"));
assert.ok(
  text(imapApp.render(cx)).includes("HTML IMAP body"),
  "an available HTML alternative is reduced to the safe reading presentation",
);
imapApp.openResponse("replyAll", cx);
assert.equal(
  ids(imapApp.render(cx)).includes("compose-save"),
  false,
  "IMAP compose does not offer an unsupported server draft save",
);
assert.equal(imapApp.compose.snapshot().draft.to, "Ada <ada@example.test>");
assert.equal(imapApp.compose.snapshot().draft.cc, "Copy <copy@example.test>");
assert.equal(
  imapApp.compose.snapshot().draft.inReplyTo,
  "<imap-message@example.test>",
);
assert.equal(
  imapApp.compose.snapshot().draft.references,
  "<imap-root@example.test> <imap-message@example.test>",
);

// The same mailbox with no SMTP server. `Imap.validateSettings` accepts one and
// the setup form offers it — "leave empty to read only" — so it opens, lists
// and reads. What it must not do is offer a Compose, a Reply or a Forward that
// the send would refuse afterwards, with the message already written: that is
// the promise `Registry.capabilities` exists to stop, made about an account
// rather than about a service.
const readOnlyCalls = [];
const readOnlyApp = new Omamail();
readOnlyApp.init(
  {
    storage: memoryStorage({
      version: 1,
      activeId: "imap:silent@example.test",
      accounts: [
        {
          id: "imap:silent@example.test",
          email: "silent@example.test",
          provider: "imap",
          imap: {
            username: "silent@example.test",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "",
            smtpPort: 465,
          },
        },
      ],
    }),
    execute(effect, complete) {
      readOnlyCalls.push({ effect, complete });
      return { cancel() {} };
    },
    width: 1024,
  },
  cx,
);
assert.equal(readOnlyCalls[0].effect.kind, "imap.runtime");
readOnlyCalls.shift().complete({
  ok: true,
  value: { specialUse: {}, supportsMove: false },
});
assert.equal(readOnlyCalls[0].effect.kind, "imap.list");
readOnlyCalls.shift().complete({
  ok: true,
  value: { responseBase64: Buffer.from(imapWire).toString("base64") },
});
assert.equal(
  readOnlyApp.hostConfigurationError,
  "",
  "a mailbox with no SMTP server is a configured mailbox",
);
const readOnlyHeader = elementById(readOnlyApp.render(cx), "mail-header-right");
assert.ok(readOnlyHeader, "the mail screen is drawn");
assert.ok(
  ids(readOnlyHeader).includes("mail-refresh"),
  "and keeps everything the mailbox can still do",
);
assert.equal(
  ids(readOnlyHeader).includes("compose"),
  false,
  "no Compose where the mailbox has nowhere to hand a message to",
);
assert.equal(
  text(readOnlyApp.render(cx)).some((line) => String(line).includes("compose")),
  false,
  "and the status row does not offer the key either",
);
// A key is not a button, so `c` has to be refused as well — it is bound in
// every mail context whatever mailbox is open.
readOnlyApp.openCompose(cx);
assert.equal(
  readOnlyApp.controller.snapshot().mail.status,
  "This mailbox has no SMTP server set, so it cannot send",
);
assert.equal(
  readOnlyApp.state.route,
  "mail",
  "the refusal happens before the compose form opens",
);
readOnlyApp.openResponse("reply", cx);
assert.equal(
  readOnlyApp.controller.snapshot().mail.status,
  "This mailbox has no SMTP server set, so it cannot send",
);
assert.equal(readOnlyApp.state.route, "mail");

// And the reader itself. The message opens and reads — everything this mailbox
// is for still works — but the three answering buttons are gone with the
// Compose, because a mailbox that cannot send cannot answer either.
readOnlyApp.openCursor(cx);
assert.equal(readOnlyCalls[0].effect.kind, "imap.transport");
readOnlyCalls.shift().complete({
  ok: true,
  value: { responseBase64: Buffer.from(imapWire).toString("base64") },
});
const readOnlyReader = ids(readOnlyApp.render(cx));
assert.ok(readOnlyReader.includes("reader-content-9:INBOX"));
assert.ok(
  readOnlyReader.includes("reader-action-trash"),
  "what is left of the toolbar is what the mailbox can still do",
);
for (const action of ["reply", "reply-all", "forward"])
  assert.equal(
    readOnlyReader.includes(`reader-action-${action}`),
    false,
    `${action} is not offered by a mailbox that cannot send`,
  );

// The thunk between Settings and the controller. Both ends have tests of their
// own; this is the wire, and a page size that stopped at `localStorage` is the
// defect it exists to catch.
await imapApp.settings.setPreference("maxMessages", 50);
imapCalls.length = 0;
assert.equal(imapApp.controller.refresh(), true);
assert.equal(imapCalls.at(-1).effect.maxResults, 50);
assert.equal(imapCalls.at(-1).effect.hostOperation.maxResults, 50);

// A default search already saved is in the box when the page opens. It is the
// one preference drawn as a text field, and an empty one beside a stored value
// says there is no default search when there is.
{
  const storage = memoryStorage();
  storage.setItem("omamail.defaultQuery", "in:inbox -category:promotions");
  const seeded = new Omamail();
  seeded.init({ storage, execute() { return { cancel() {} }; } }, cx);
  assert.equal(
    seeded.settingsDefaultQuery.value(),
    "in:inbox -category:promotions",
  );
}

console.log("app integration tests passed");
