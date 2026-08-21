const assert = require("assert")
const { load, deepEqual } = require("./load")

const model = load("account/Model.js")

// The mailboxes moved to Provider.js along with everything else that differs
// between mail services; tests/test_provider.js covers them there.

// ------------------------------------------------------------ setup state

assert.strictEqual(model.setupState({ toolsPresent: false }), "tools_missing")
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: false }), "no_credentials")
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: true, signedIn: false }), "signed_out")
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: true, signingIn: true }), "signing_in")
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: true, signedIn: true }), "ready")
assert.strictEqual(model.setupState(null), "tools_missing")

// Missing tools have to be named. "Something is missing" is not actionable.
assert.ok(model.setupDetail("tools_missing", ["socat", "secret-tool"]).indexOf("socat, secret-tool") > 0)
assert.strictEqual(model.setupHeadline("ready"), "")
assert.strictEqual(model.setupHeadline("signed_out"), "Sign in to Gmail",
  "an account with no provider recorded is a Gmail account")
assert.strictEqual(model.setupHeadline("signed_out", "IMAP"), "Sign in to IMAP")
assert.strictEqual(model.setupHeadline("no_credentials", "IMAP", "password"),
  "Add this mailbox", "only one of the two sends anyone to a Cloud console")
assert.strictEqual(model.setupHeadline("no_credentials", "Gmail", "oauth"),
  "Connect a Google Cloud project")
// The unavailable detail comes from the provider, because only it knows why.
assert.strictEqual(model.setupDetail("unavailable", [], "no API yet", "HEY"), "no API yet")
assert.strictEqual(model.setupActionLabel("unavailable", "HEY"), "",
  "there is no button that would help")
assert.strictEqual(model.setupActionLabel("ready"), "")
// The label opens a multi-step page, which is what the trailing ellipsis says.
assert.ok(model.setupActionLabel("no_credentials").endsWith("..."))
assert.strictEqual(model.setupActionLabel("signing_in"), "Cancel")
assert.ok(model.setupActionLabel("no_credentials", "IMAP", "password").endsWith("..."))

// Rebuilding an account briefly leaves the service with no current host. The
// edit page keeps the provider it opened for instead of following the
// service's temporary Gmail fallback.
assert.strictEqual(model.setupProvider("imap", "gmail"), "imap")
assert.strictEqual(model.setupProvider("", "imap"), "imap")
// An IMAP sign-in never opens a browser, so it must not say it will.
assert.ok(model.setupDetail("signing_in", [], "", "IMAP", "password").indexOf("browser") < 0)
assert.ok(model.setupDetail("signing_in", [], "", "Gmail", "oauth").indexOf("browser") > 0)

// ------------------------------------------------------- list consistency
//
// After an action a row either belongs in the current mailbox or it does not.
// Getting this wrong either strands a row that is gone from the server or
// hides one that is still there.

assert.strictEqual(model.survivesAction("inbox", "archive"), false)
assert.strictEqual(model.survivesAction("all", "archive"), true, "All mail still contains an archived message")
assert.strictEqual(model.survivesAction("starred", "archive"), true)
assert.strictEqual(model.survivesAction("unread", "markRead"), false)
assert.strictEqual(model.survivesAction("inbox", "markRead"), true)
assert.strictEqual(model.survivesAction("starred", "unstar"), false)
assert.strictEqual(model.survivesAction("inbox", "unstar"), true)
assert.strictEqual(model.survivesAction("inbox", "trash"), false)
assert.strictEqual(model.survivesAction("trash", "trash"), true)
assert.strictEqual(model.survivesAction("trash", "untrash"), false)

deepEqual(model.labelChangesFor("archive"), { add: [], remove: ["INBOX"] })
deepEqual(model.labelChangesFor("star"), { add: ["STARRED"], remove: [] })
assert.strictEqual(model.labelChangesFor("trash"), null, "trash is its own endpoint, not a label change")

// The optimistic update has to move the derived flags too, or a row shows a
// filled star with `starred: false` underneath it until the next refresh.
const row = { id: "a", labelIds: ["INBOX", "UNREAD"], unread: true, starred: false, inInbox: true }
const read = model.applyLabelChange(row, "markRead")
assert.strictEqual(read.unread, false)
deepEqual(read.labelIds, ["INBOX"])
assert.strictEqual(row.unread, true, "the original row is left alone")

const starred = model.applyLabelChange(row, "star")
assert.strictEqual(starred.starred, true)
deepEqual(starred.labelIds, ["INBOX", "UNREAD", "STARRED"])
// Starring twice must not add the label twice.
deepEqual(model.applyLabelChange(starred, "star").labelIds, ["INBOX", "UNREAD", "STARRED"])
assert.strictEqual(model.applyLabelChange(row, "archive").inInbox, false)
assert.strictEqual(model.applyLabelChange(null, "star"), null)

// ------------------------------------------------------------ list edits

assert.strictEqual(model.showInitialListSkeleton(true, 0), true,
  "an empty initial fetch uses rows shaped like the list")
assert.strictEqual(model.showInitialListSkeleton(true, 3), false,
  "pagination keeps the messages already on screen")
assert.strictEqual(model.showInitialListSkeleton(false, 0), false,
  "an empty result is not still loading")
assert.strictEqual(model.showListFooter(0), false,
  "an empty state must not compete with pagination controls")
assert.strictEqual(model.showListFooter(1), true,
  "loaded messages retain their result summary and pagination")

const list = [{ id: "a", unread: true }, { id: "b", unread: false }, { id: "c", unread: true }]
deepEqual(model.removeById(list, "b").map(entry => entry.id), ["a", "c"])
deepEqual(model.removeById(list, "zzz").map(entry => entry.id), ["a", "b", "c"])
deepEqual(model.replaceById(list, { id: "b", unread: true }).map(entry => entry.unread), [true, true, true])
assert.strictEqual(model.indexById(list, "c"), 2)
assert.strictEqual(model.indexById(list, "zzz"), -1)
assert.strictEqual(model.indexById(null, "a"), -1)
assert.strictEqual(model.unreadCount(list), 2)
assert.strictEqual(model.unreadCount([]), 0)

// ---------------------------------------------------------------- the bar

assert.strictEqual(model.badgeText(0), "")
assert.strictEqual(model.badgeText(7), "7")
assert.strictEqual(model.badgeText(99), "99")
assert.strictEqual(model.badgeText(100), "99+")
assert.strictEqual(model.badgeText(1500, 99), "99+")
assert.strictEqual(model.badgeText(-3), "")

assert.strictEqual(model.barTooltip("ready", "me@example.com", 0), "me@example.com · No unread mail")
assert.strictEqual(model.barTooltip("ready", "me@example.com", 1), "me@example.com · 1 unread message")
assert.strictEqual(model.barTooltip("ready", "me@example.com", 4), "me@example.com · 4 unread messages")
assert.strictEqual(model.barTooltip("ready", "", 2), "Gmail · 2 unread messages")
assert.strictEqual(model.barTooltip("signed_out", "me@example.com", 9), "Gmail · Sign in to Gmail")
assert.strictEqual(model.barTooltip("signed_out", "me@example.com", 9, "IMAP"),
  "IMAP · Sign in to IMAP")
assert.strictEqual(model.barTooltip("ready", "", 2, "IMAP"), "IMAP · 2 unread messages")

// --------------------------------------------------------------- new mail
//
// The first load after the shell starts must not fire a notification for every
// message already sitting in the inbox, so arrivals only count once the seen
// set has been primed by that first load.

const inbox = [
  { id: "a", unread: true, inInbox: true, subject: "one" },
  { id: "b", unread: false, inInbox: true, subject: "two" },
  { id: "c", unread: true, inInbox: true, subject: "three" },
  { id: "d", unread: true, inInbox: false, subject: "archived elsewhere" }
]

deepEqual(model.newArrivals(inbox, {}, false), [], "nothing fires before priming")
deepEqual(model.newArrivals(inbox, { a: true }, true).map(entry => entry.id), ["c"])
deepEqual(model.newArrivals(inbox, { a: true, c: true }, true), [])
deepEqual(model.newArrivals([], {}, true), [])

assert.strictEqual(model.notificationBody({ subject: "Invoice", snippet: "Due Friday" }), "Invoice\nDue Friday")
assert.strictEqual(model.notificationBody({ subject: "Invoice", snippet: "" }), "Invoice")
assert.strictEqual(model.notificationBody(null), "")
assert.ok(model.notificationBody({ subject: "s", snippet: "x".repeat(400) }).length < 160)

// ------------------------------------------------------------- formatting

assert.strictEqual(model.resultSummary([], 0, false), "No messages")
assert.strictEqual(model.resultSummary([{}], 1, false), "1 message")
assert.strictEqual(model.resultSummary([{}, {}], 2, false), "2 messages")
assert.strictEqual(model.resultSummary([{}, {}], 87, true), "2 of about 87")
// Gmail's estimate can come back lower than the page it just returned.
assert.strictEqual(model.resultSummary([{}, {}, {}], 1, true), "3 of about 3")

assert.strictEqual(model.statusSummary("Checking for mail…", "25 of about 80", true),
  "Checking for mail…", "loading status must not compete with stale pagination")
assert.strictEqual(model.statusSummary("Synced just now", "25 messages", false),
  "Synced just now  ·  25 messages")
assert.strictEqual(model.statusSummary("", "No messages", false), "No messages")

assert.strictEqual(model.truncate("short", 20), "short")
assert.strictEqual(model.truncate("a much longer string", 10), "a much lo…")
assert.strictEqual(model.pluralize(1, "message"), "1 message")
assert.strictEqual(model.pluralize(0, "message"), "0 messages")

// A notification is markup to the daemons that draw it, and its two strings are
// arguments to notify-send. Neither is a place for a sender's angle brackets or
// for a display name that starts with a dash.
{
  const crafted = {
    subject: "<img src=\"http://tracker.example.com/p.gif\">",
    snippet: "a & b",
    from: { display: "-u critical" }
  }
  assert.ok(model.notificationBody(crafted).indexOf("<img") < 0)
  assert.ok(model.notificationBody(crafted).indexOf("&amp;") > 0)
  assert.strictEqual(model.notificationTitle(crafted), "u critical")
  assert.strictEqual(model.notificationTitle({ from: { display: "" } }), "New message")
  assert.strictEqual(model.notificationTitle(null), "New message")
}

// ------------------------------------------------------------- list cursor

// The cursor moves relative to itself. It used to be anchored to `selectedId`
// — the message the reader has open — which pinned it: nothing is open in list
// view, so every step resolved to row 0, and in the reader the anchor never
// advanced, so the cursor moved once and then stopped.
{
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

  assert.strictEqual(model.cursorAfterOffset(rows, "", 1), "a",
    "with no cursor yet, j starts at the top")
  assert.strictEqual(model.cursorAfterOffset(rows, "", -1), "d",
    "with no cursor yet, k starts at the bottom")

  // The regression this exists for: pressing j repeatedly keeps moving.
  assert.strictEqual(model.cursorAfterOffset(rows, "a", 1), "b")
  assert.strictEqual(model.cursorAfterOffset(rows, "b", 1), "c")
  assert.strictEqual(model.cursorAfterOffset(rows, "c", 1), "d")
  assert.strictEqual(model.cursorAfterOffset(rows, "d", 1), "d",
    "the last row is where moving down stops")

  assert.strictEqual(model.cursorAfterOffset(rows, "c", -1), "b")
  assert.strictEqual(model.cursorAfterOffset(rows, "a", -1), "a",
    "the first row is where moving up stops")

  assert.strictEqual(model.cursorAfterOffset([], "a", 1), "",
    "an empty list has nowhere to go")
  assert.strictEqual(model.cursorAfterOffset(rows, "gone", 1), "a",
    "a cursor whose message left the list starts over rather than sticking")
  assert.strictEqual(model.cursorAfterOffset(rows, "a", 0), "a",
    "a zero step is a no-op, not a jump to the top")
}

// --------------------------------------------------- keeping the cursor seen

// The list is a Column in a Flickable rather than a ListView — the panel
// already owns a scroller — so there is no positionViewAtIndex, and keyboard
// movement has to say where the scroller goes itself.
{
  // A 100-tall viewport over 500 of content, rows 20 tall, 4px of margin.
  const view = 100
  const content = 500
  const pad = 4

  assert.strictEqual(
    model.contentYToReveal(0, view, 40, 20, content, pad), 0,
    "a row already on screen does not move the list under the reader")

  assert.strictEqual(
    model.contentYToReveal(0, view, 90, 20, content, pad), 14,
    "a row off the bottom scrolls just far enough, plus the margin")

  assert.strictEqual(
    model.contentYToReveal(200, view, 180, 20, content, pad), 176,
    "a row off the top scrolls back to it, plus the margin")

  assert.strictEqual(
    model.contentYToReveal(10, view, 0, 20, content, pad), 0,
    "the top of the list is as far up as it goes: no negative offset")

  assert.strictEqual(
    model.contentYToReveal(380, view, 480, 20, content, pad), 400,
    "the bottom clamps to the last screenful rather than scrolling past it")

  assert.strictEqual(
    model.contentYToReveal(0, view, 40, 300, content, pad), 36,
    "a row taller than the viewport shows its top rather than its bottom")

  assert.strictEqual(
    model.contentYToReveal(0, 500, 40, 20, 400, pad), 0,
    "content shorter than the viewport never scrolls")
}


// ------------------------------------------- the cursor outliving its message

// Two ways a cursor stops pointing at anything: the row it is on is acted on
// and leaves, or the whole list is replaced under it by a mailbox switch, a
// search, or a refresh. Both used to leave the cursor on a message that is no
// longer there, and cursorAfterOffset restarts at the top from that — so one
// archive sent the next j back to the first row.
{
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }]

  // Acting on a row: the cursor takes the row's place, which is the one below.
  assert.strictEqual(model.cursorAfterRemoval(rows, "a"), "b")
  assert.strictEqual(model.cursorAfterRemoval(rows, "b"), "c")
  // Except at the end, where there is nothing below and the one above is where
  // the eye already is.
  assert.strictEqual(model.cursorAfterRemoval(rows, "c"), "b")
  assert.strictEqual(model.cursorAfterRemoval([{ id: "only" }], "only"), "",
    "emptying the list leaves no cursor to hold")
  assert.strictEqual(model.cursorAfterRemoval(rows, "gone"), "",
    "a cursor that is already adrift has no neighbour to inherit")
  assert.strictEqual(model.cursorAfterRemoval([], "a"), "")

  // A list replaced underneath: keep the cursor if its message survived the
  // reload, otherwise start at the top.
  assert.strictEqual(model.cursorAfterReload(rows, "b"), "b",
    "a refresh that kept the message keeps the cursor")
  assert.strictEqual(model.cursorAfterReload(rows, "gone"), "a",
    "a mailbox switch lands on the first row rather than nowhere")
  assert.strictEqual(model.cursorAfterReload(rows, ""), "a",
    "and so does a list arriving for the first time")
  assert.strictEqual(model.cursorAfterReload([], "b"), "",
    "an empty mailbox has no row to sit on")
}

// One numbered list over the rail: mailboxes first, then the labels the server
// reported, and no number at all past the tenth row.
{
  const boxes = [
    { key: "inbox", label: "Inbox" },
    { key: "unread", label: "Unread" },
    { key: "sent", label: "Sent" }
  ]
  const labels = [
    { id: "SYS", name: "Category", rawName: "Category", system: true },
    { id: "L1", name: "Work", rawName: "Work" },
    { id: "L2", name: "Bills", rawName: "Bills" }
  ]
  const slots = model.sidebarSlots(boxes, labels, 10)
  assert.strictEqual(slots.length, 5, "system labels are not rows and get no number")
  assert.strictEqual(slots[0].kind, "mailbox")
  assert.strictEqual(slots[0].key, "inbox")
  assert.strictEqual(slots[3].kind, "label")
  assert.strictEqual(slots[3].id, "L1")
  assert.strictEqual(slots[3].name, "Work", "the name a provider selects a label by")

  assert.strictEqual(model.slotNumberOf(slots, "mailbox", "inbox"), 1)
  assert.strictEqual(model.slotNumberOf(slots, "mailbox", "sent"), 3)
  assert.strictEqual(model.slotNumberOf(slots, "label", "L2"), 5)
  assert.strictEqual(model.slotNumberOf(slots, "label", "SYS"), 0)
  assert.strictEqual(model.slotNumberOf(slots, "mailbox", "L1"), 0,
    "a key and an id are not the same handle")
  assert.strictEqual(model.slotNumberOf([], "mailbox", "inbox"), 0)

  // The ceiling is where a row stops having a key, not where the rail stops.
  const many = []
  for (let i = 0; i < 14; i++) many.push({ id: "L" + i, name: "n" + i, rawName: "n" + i })
  assert.strictEqual(model.sidebarSlots(boxes, many, 10).length, 10)
  assert.strictEqual(model.slotNumberOf(model.sidebarSlots(boxes, many, 10), "label", "L7"), 0,
    "past the tenth row there is no digit left to offer")
  assert.strictEqual(model.sidebarSlots(null, null, 10).length, 0)
}

// The switcher's cursor wraps where the message list clamps: a menu of two or
// three rows that stopped at the bottom would make `j` do nothing on the row
// you use most.
assert.strictEqual(model.wrappedIndex(0, 1, 3), 1)
assert.strictEqual(model.wrappedIndex(2, 1, 3), 0, "past the last row comes back to the first")
assert.strictEqual(model.wrappedIndex(0, -1, 3), 2, "and backwards off the top wraps too")
assert.strictEqual(model.wrappedIndex(1, 0, 3), 1)
assert.strictEqual(model.wrappedIndex(0, 1, 1), 0, "one mailbox has nowhere to go")
assert.strictEqual(model.wrappedIndex(0, 1, 0), 0, "and no mailboxes must not divide by zero")
assert.strictEqual(model.wrappedIndex(-1, 1, 3), 0)

console.log("test_model.js ok")
