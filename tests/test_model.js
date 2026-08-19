const assert = require("assert")
const { load, deepEqual } = require("./load")

const model = load("Model.js")

// ------------------------------------------------------------- mailboxes

assert.strictEqual(model.mailbox("inbox").query, "in:inbox")
assert.strictEqual(model.mailbox("unread").query, "in:inbox is:unread category:primary")
assert.strictEqual(model.mailbox("nonsense").key, "inbox", "an unknown key falls back to the inbox")
assert.strictEqual(model.mailboxIndex("starred"), 2)

// The sidebar is icon-first, so every mailbox needs a glyph that ActionIcon
// actually draws. A missing one renders as nothing at all.
const DRAWN = ["inbox", "unread", "star", "send", "archive", "trash"]
for (const box of model.MAILBOXES) {
  assert.ok(DRAWN.indexOf(box.icon) >= 0, box.key + " has no drawable icon: " + box.icon)
  assert.ok(box.label.length > 0, box.key + " needs a label for its tooltip")
}
assert.strictEqual(model.mailboxIndex(""), 0)

// A typed search replaces the mailbox query outright rather than being ANDed
// onto it: searching from the Trash view should search all mail, the way
// Gmail's own search box does.
assert.strictEqual(model.mailboxQuery("inbox", ""), "in:inbox")
assert.strictEqual(model.mailboxQuery("trash", "from:jane"), "from:jane")
assert.strictEqual(model.mailboxQuery("inbox", "   "), "in:inbox")

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
assert.strictEqual(model.setupActionLabel("ready"), "")
// The label opens a multi-step page, which is what the trailing ellipsis says.
assert.ok(model.setupActionLabel("no_credentials").endsWith("..."))
assert.strictEqual(model.setupActionLabel("signing_in"), "Cancel")

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

console.log("test_model.js ok")
