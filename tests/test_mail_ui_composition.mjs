import assert from "node:assert/strict";

import { renderMail } from "../app/ui/mail.js";
import { renderMessageList } from "../app/ui/message-list.js";

const colors = new Proxy(
  {},
  { get: (_target, name) => `semantic:${String(name)}` },
);
const cx = {
  theme: () => ({
    colors,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { sm: 4, md: 8 },
  }),
};

function collect(element, result = { ids: [], text: [] }) {
  if (typeof element === "string" || typeof element === "number") {
    result.text.push(String(element));
    return result;
  }
  if (!element || typeof element !== "object") return result;
  if (element.elementId) result.ids.push(element.elementId);
  for (const child of element.childNodes ?? []) collect(child, result);
  return result;
}

function find(element, target) {
  if (!element || typeof element !== "object") return null;
  if (element.elementId === target) return element;
  for (const child of element.childNodes ?? []) {
    const found = find(child, target);
    if (found) return found;
  }
  return null;
}

const noop = () => {};
const model = {
  width: 1920,
  accounts: [
    { id: "gmail:me", label: "Personal", provider: "gmail", selected: true },
  ],
  mailboxes: [{ id: "inbox", label: "Inbox", count: 3, selected: true }],
  search: { state: {}, onChange: noop },
  header: { title: "Inbox", onCompose: noop, onSettings: noop },
  messages: [
    {
      id: "m-1",
      sender: "Alice <alice@example.test>",
      subject: "Quarterly <results>",
      snippet: "Revenue & margin",
      time: "09:10",
      unread: true,
      starred: true,
    },
    {
      id: "m-2",
      sender: "Bob",
      subject: "Dinner",
      snippet: "Tomorrow?",
      time: "Yesterday",
      unread: false,
      starred: false,
    },
  ],
  cursorId: "m-2",
  selectedId: "m-1",
  reader: {
    state: "content",
    message: {
      id: "m-1",
      subject: "Quarterly <results>",
      sender: "Alice",
      body: "Plain body",
    },
    capabilities: {
      archive: false,
      star: false,
      trash: true,
      spam: true,
      reply: true,
    },
    onReply: noop,
    onArchive: noop,
    onStar: noop,
    onTrash: noop,
    onSpam: noop,
  },
  status: {
    label: "2 messages",
    state: "ready",
    hints: [{ key: "j/k", label: "Move" }],
  },
  loadingMore: false,
  canLoadMore: true,
  canRetry: false,
  onLoadMore: noop,
  onRetry: noop,
  onAccount: noop,
  onMailbox: noop,
  onMessage: noop,
};

const rendered = collect(renderMail(model, cx));
assert.ok(rendered.ids.includes("mail-topbar"));
assert.ok(rendered.ids.includes("mail-rail-accounts"));
assert.ok(rendered.ids.includes("mail-list-pane"));
assert.ok(rendered.ids.includes("mail-reader-pane"));
assert.ok(rendered.ids.includes("key-hints"));
assert.ok(rendered.ids.includes("account-gmail:me"));
assert.ok(rendered.ids.includes("mailbox-inbox"));
assert.ok(rendered.ids.includes("message-m-1-selected"));
assert.ok(rendered.ids.includes("message-m-2-cursor"));
assert.ok(rendered.ids.includes("message-row-m-1"));
assert.ok(rendered.ids.includes("message-row-m-1-sender"));
assert.ok(rendered.ids.includes("message-row-m-1-subject"));
assert.ok(rendered.ids.includes("message-row-m-1-snippet"));
assert.ok(rendered.ids.includes("message-unread-m-1"));
assert.ok(!rendered.ids.includes("message-unread-m-2"));
assert.equal(
  collect(find(renderMail(model, cx), "message-m-1-selected").childNodes[0])
    .ids[0],
  "message-unread-m-1",
  "the unread marker stays in the leading column of a dense row",
);
// A starred message keeps its star whether or not the row is hot, because that
// is state; archive and trash are affordances and appear under the cursor.
assert.ok(rendered.ids.includes("message-star-m-1"));
assert.ok(!rendered.ids.includes("message-archive-m-1"));
assert.ok(rendered.ids.includes("message-star-m-2"));
assert.ok(rendered.ids.includes("message-archive-m-2"));
assert.ok(rendered.ids.includes("message-trash-m-2"));
assert.ok(rendered.ids.includes("reader-content-m-1"));
assert.ok(rendered.ids.includes("reader-action-reply"));
assert.ok(rendered.ids.includes("reader-action-trash"));
assert.ok(!rendered.ids.includes("reader-action-archive"));
assert.ok(!rendered.ids.includes("reader-action-star"));
assert.ok(rendered.text.includes("Load more"));
assert.ok(rendered.text.includes("Quarterly <results>"));
assert.ok(rendered.text.includes("j/k"));

const narrowReader = renderMail({
  ...model,
  width: 500,
  reader: { ...model.reader, onBack: noop },
}, cx);
const narrow = collect(narrowReader);
assert.ok(!narrow.ids.includes("mail-rail"));
assert.ok(!narrow.ids.includes("mail-list-pane"));
assert.ok(narrow.ids.includes("mail-reader-pane"));
assert.ok(narrow.ids.includes("reader-back"));

// The list's own states, which the mail view has no way to reach through the
// four fields it passes down.
const listModel = {
  messages: model.messages,
  cursorId: "m-2",
  selectedId: "m-1",
  onMessage: noop,
};

const loadingList = collect(
  renderMessageList({ ...listModel, messages: [], loading: true }, cx),
);
assert.ok(loadingList.ids.includes("message-list-skeleton"));
assert.ok(!loadingList.ids.includes("message-list-empty"));

const emptyList = collect(
  renderMessageList({ ...listModel, messages: [], loaded: true }, cx),
);
assert.ok(emptyList.text.includes("Nothing here"));

const emptySearch = collect(
  renderMessageList(
    { ...listModel, messages: [], loaded: true, searchQuery: "invoice" },
    cx,
  ),
);
assert.ok(emptySearch.text.includes("Nothing matches that search"));

const unloaded = collect(renderMessageList({ ...listModel, messages: [] }, cx));
assert.ok(
  unloaded.ids.includes("message-list-empty") &&
    !unloaded.text.includes("Nothing here"),
  "nothing loaded yet is not the same answer as loaded and empty",
);

// Refusing a verb the provider does not have, rather than offering one that
// would quietly do nothing.
let menuAction = null;
const menuList = renderMessageList(
  {
    ...listModel,
    capabilities: { archive: false, spam: false },
    menu: {
      messageId: "m-1",
      x: 40,
      y: 12,
      cursorIndex: 0,
      onAction: (action, id) => {
        menuAction = [action, id];
      },
    },
  },
  cx,
);
const menuIds = collect(menuList).ids;
assert.ok(
  collect(find(menuList, "message-m-1-selected")).ids.includes("message-menu"),
  "the menu is anchored inside the row it was opened on",
);
assert.ok(menuIds.includes("message-menu-reply"));
assert.ok(menuIds.includes("message-menu-trash"));
assert.ok(menuIds.includes("message-menu-browser"));
assert.ok(!menuIds.includes("message-menu-archive"));
assert.ok(!menuIds.includes("message-menu-spam"));
assert.ok(
  collect(menuList).text.includes("Mark as read"),
  "the read row names what the item does to an unread message",
);
assert.ok(collect(menuList).text.includes("Unstar"));
find(menuList, "message-menu-trash").clickHandler({}, cx);
assert.deepEqual(menuAction, ["trash", "m-1"]);
assert.ok(
  !collect(renderMessageList(listModel, cx)).ids.includes("message-menu"),
  "a closed menu adds no layer over the list",
);

console.log("mail UI composition tests passed");
