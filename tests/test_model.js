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
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: true,
  recoveringSession: true, signedIn: false }), "reconnecting")
assert.strictEqual(model.setupState({ toolsPresent: true, credentialsPresent: true, signedIn: true }), "ready")
assert.strictEqual(model.setupState(null), "tools_missing")

// Missing tools have to be named. "Something is missing" is not actionable.
assert.ok(model.setupDetail("tools_missing", ["socat", "secret-tool"]).indexOf("socat, secret-tool") > 0)
assert.strictEqual(model.setupHeadline("ready"), "")
assert.strictEqual(model.setupHeadline("reconnecting"), "Reconnecting to Gmail…")
assert.ok(model.setupDetail("reconnecting").indexOf("retry automatically") > 0)
assert.strictEqual(model.setupActionLabel("reconnecting"), "")
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
assert.strictEqual(model.messageById(list, [{ id: "preview" }], "preview").id, "preview")
assert.strictEqual(model.messageById(list, [{ id: "preview" }], "a").id, "a")
assert.strictEqual(model.messageById(list, [{ id: "preview" }], "missing"), null)
assert.strictEqual(model.unreadCount(list), 2)
assert.strictEqual(model.unreadCount([]), 0)

// Local search rows stay visible while live metadata arrives. A live copy
// replaces the cached one, a new result takes its chronological place, and a
// request finishing twice cannot draw the same id twice.
const cachedSearch = [
  { id: "old", subject: "cached", date: new Date("2026-08-20T10:00:00Z") },
  { id: "same", subject: "stale", date: new Date("2026-08-22T10:00:00Z") }
]
const liveSearch = [
  { id: "new", subject: "live", date: new Date("2026-08-24T10:00:00Z") },
  { id: "same", subject: "fresh", date: new Date("2026-08-22T10:00:00Z") }
]
const searchMerged = model.mergeSearchResults(cachedSearch, liveSearch)
deepEqual(searchMerged.map(entry => entry.id), ["new", "same", "old"])
assert.strictEqual(searchMerged[1].subject, "fresh")
deepEqual(model.mergeSearchResults(null, liveSearch).map(entry => entry.id), ["new", "same"])

// The union is only the in-flight preview. A settled server page removes a
// cached false positive, replaces confirmed stale metadata, and may use a
// confirmed cached row when that row's metadata request failed.
const settledSearch = model.settledSearchResults([], cachedSearch, liveSearch,
  ["new", "same"], false)
deepEqual(settledSearch.map(entry => entry.id), ["new", "same"])
assert.strictEqual(settledSearch[1].subject, "fresh")
deepEqual(model.settledSearchResults([], cachedSearch, [], ["same"], false)
  .map(entry => entry.id), ["same"], "a server-confirmed cached row may fill in")
deepEqual(model.settledSearchResults([], cachedSearch, liveSearch, [], false), [],
  "an empty server answer removes every preview row")
deepEqual(model.settledSearchResults([{ id: "page-1" }], cachedSearch,
  liveSearch, ["new"], true).map(entry => entry.id), ["new", "page-1"],
  "an appended authoritative page keeps the pages already settled")
deepEqual(model.missingSearchSummaryIds(liveSearch, ["new", "same"]), [])
deepEqual(model.missingSearchSummaryIds(liveSearch, ["new", "missing", "same"]),
  ["missing"], "a partial metadata answer names the paging hole")

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

// The floor keeps an old unread message that was never on the cached page from
// being announced as an arrival the first time a fetch returns it.
const floor = Date.parse("2026-08-01T00:00:00Z")
const timeInbox = [
  { id: "old", unread: true, inInbox: true, date: new Date(floor - 1000000) },
  { id: "new", unread: true, inInbox: true, date: new Date(floor + 1000) },
  { id: "nodate", unread: true, inInbox: true, date: null }
]
deepEqual(model.newArrivals(timeInbox, {}, true, floor).map(entry => entry.id),
  ["new", "nodate"],
  "an older message is not an arrival, and one with no date is still announced")

// The floor is the mailbox's own newest timestamp, not this machine's clock.
// Taken from `Date.now()` on a machine running fast, every arrival is older
// than a "now" the server has not reached and notifications stop for the whole
// session — so what seeds it is the page, and it has to come out of the page.
assert.strictEqual(model.newestDate(timeInbox), floor + 1000)
assert.strictEqual(model.newestDate([{ id: "x", date: null }]), 0)
assert.strictEqual(model.newestDate([]), 0)
assert.strictEqual(model.newestDate(null), 0)

// A clock an hour ahead of the server used to silence the mailbox entirely.
const skewed = model.newestDate(timeInbox)
deepEqual(model.newArrivals(timeInbox, {}, true, skewed).map(entry => entry.id),
  ["new", "nodate"],
  "the newest row is itself never below the floor it set")

// No floor at all is the shape every caller had before one existed.
deepEqual(model.newArrivals(timeInbox, {}, true, 0).map(entry => entry.id),
  ["old", "new", "nodate"])

assert.strictEqual(model.notificationBody({ subject: "Invoice", snippet: "Due Friday" }), "Invoice\nDue Friday")
assert.strictEqual(model.notificationBody({ subject: "Invoice", snippet: "" }), "Invoice")
assert.strictEqual(model.notificationBody(null), "")
assert.ok(model.notificationBody({ subject: "s", snippet: "x".repeat(400) }).length < 160)

// ------------------------------------------------------------- formatting

assert.strictEqual(model.resultSummary([], 0, false), "No messages")
assert.strictEqual(model.resultSummary([{}], 1, false), "1 message")
assert.strictEqual(model.resultSummary([{}, {}], 2, false), "2 messages")
assert.strictEqual(model.resultSummary([{}, {}], 87, true), "2 of about 87")
// An estimate no larger than the page it came with is not a total: Gmail's can
// come back low, and a listing that carries none at all — HEY's box index — is
// counted as what was read. Either way "3 of about 3" would be a claim nobody
// made, and there is a Load more below saying the rest exists.
assert.strictEqual(model.resultSummary([{}, {}, {}], 1, true), "3 messages so far")
assert.strictEqual(model.resultSummary([{}, {}, {}], 3, true), "3 messages so far")

assert.strictEqual(model.statusSummary("Checking for mail"), "Checking for mail")
assert.strictEqual(model.statusSummary("Synced just now"), "Synced just now")
assert.strictEqual(model.statusSummary(""), "")

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

// ------------------------------------------- what a provider cannot honour
//
// The panel hides the buttons for these, and for two providers that was the
// whole of it. A key is not a button: `e` and `s` are bound in every mail
// context, so on a mailbox with neither archive nor star they reached the
// action anyway — the row left the list and the note said "Archived", for a
// request no server ever saw.

assert.strictEqual(model.actionCapability("archive"), "archive")
assert.strictEqual(model.actionCapability("unarchive"), "archive")
assert.strictEqual(model.actionCapability("star"), "star")
assert.strictEqual(model.actionCapability("unstar"), "star")
assert.strictEqual(model.actionCapability("spam"), "spam")
assert.strictEqual(model.actionCapability("trash"), "", "every provider can trash")
assert.strictEqual(model.actionCapability("markRead"), "")

// Named after the thing the service does not have rather than after the key:
// "e does nothing here" answers a question nobody asked.
assert.strictEqual(model.actionUnavailable("archive", "HEY"), "HEY has no archive")
assert.strictEqual(model.actionUnavailable("star", "HEY"), "HEY has no star")
assert.strictEqual(model.actionUnavailable("spam", "IMAP"),
  "IMAP has no junk verb to report to")
assert.strictEqual(model.actionUnavailable("trash", "HEY"), "")

deepEqual(model.unavailableActions({ archive: true, star: true, spam: true }), [])
deepEqual(model.unavailableActions({ archive: false, star: false }), ["archive", "star"])
deepEqual(model.unavailableActions(null), ["archive", "star"],
  "an unknown provider offers nothing it cannot prove")

console.log("test_model.js ok")

// ------------------------------------------------------------- reading zoom

// A step lands on a twentieth, so the same scroll back returns to where it was
// and a saved zoom reads back as the one that was set.
assert.strictEqual(model.zoomAfterStep(1, 0.1), 1.1)
assert.strictEqual(model.zoomAfterStep(1.1, -0.1), 1)
assert.strictEqual(model.zoomAfterStep(1.37, 0), 1.35)
// The bounds hold however hard the wheel is turned.
assert.strictEqual(model.zoomAfterStep(2.5, 0.1), 2.5)
assert.strictEqual(model.zoomAfterStep(0.6, -0.1), 0.6)
assert.strictEqual(model.zoomAfterStep(99, 0), 2.5)

// What comes back off disk is a file somebody could have edited by hand, and
// the answer to anything that is not a number is the size it shipped at.
assert.strictEqual(model.clampZoom(undefined), 1)
assert.strictEqual(model.clampZoom(null), 1)
assert.strictEqual(model.clampZoom("nonsense"), 1)
assert.strictEqual(model.clampZoom(0), 0.6, "but zero is a number, and clamps")
assert.strictEqual(model.clampZoom("1.5"), 1.5, "including one written as text")

deepEqual(model.windowPrefs(""), {
  sidebarCollapsed: false, bodyZoom: 1, bodyMode: "reader",
  alwaysShowImages: false, windowOpen: false
})
assert.strictEqual(model.windowPrefs('{"plainTextForced":true}').bodyMode, "plain",
  "the old two-mode preference migrates to the three-mode setting")
assert.strictEqual(model.windowPrefs('{"bodyMode":"original"}').bodyMode, "original")
assert.strictEqual(model.windowPrefs('{"bodyMode":"unknown"}').bodyMode, "reader")
assert.strictEqual(model.windowPrefs('{"windowOpen":true}').windowOpen, true)
assert.strictEqual(model.windowPrefs('{"windowOpen":"yes"}').windowOpen, false)

// ------------------------------------------------- what a detail read carries
//
// A detail read is authoritative about everything it carries and silent about
// the rest. HEY is why: `hey threads` answers with a conversation's entries and
// no subject line of its own, so a message opened before its list had loaded
// would have replaced the subject the cache knew with "(no subject)".

const listed = {
  id: "1:2",
  subject: "Lunch on Friday",
  from: { name: "Jane", email: "jane@example.com" },
  snippet: "Are you free",
  date: new Date("2026-08-20T10:00:00Z"),
  time: "10:00",
  fullTime: "Aug 20, 2026 10:00"
}
const bodyless = {
  id: "1:2",
  subject: "(no subject)",
  from: { name: "", email: "" },
  snippet: "",
  date: null,
  time: "",
  fullTime: "",
  unread: false
}

const merged = model.detailSummary(listed, bodyless)
assert.strictEqual(merged.subject, "Lunch on Friday")
assert.strictEqual(merged.from.email, "jane@example.com")
assert.strictEqual(merged.snippet, "Are you free")
assert.strictEqual(merged.time, "10:00")
// Everything the detail did carry still wins: the row is the fallback, not the
// answer.
assert.strictEqual(merged.unread, false)

const full = model.detailSummary(listed, {
  id: "1:2", subject: "Re: Lunch on Friday",
  from: { name: "Jane", email: "jane@example.com" },
  snippet: "Yes", date: new Date("2026-08-21T10:00:00Z"), time: "10:00", fullTime: "x"
})
assert.strictEqual(full.subject, "Re: Lunch on Friday", "a detail read that knows wins")
assert.strictEqual(full.snippet, "Yes")

// A message not in the list has nothing to fall back to, which is the ordinary
// case rather than an error.
assert.strictEqual(model.detailSummary(null, bodyless).subject, "(no subject)")
assert.strictEqual(model.detailSummary(listed, null), listed)

// ------------------------------------------------------ a CLI-shaped sign-in
//
// A provider whose sign-in is a program of its own says which program: the
// generic sentence sends somebody looking through Omarchy for a package this
// plugin never named.

assert.strictEqual(model.setupHeadline("tools_missing", "HEY", "cli"),
  "Install the HEY CLI")
assert.strictEqual(model.setupHeadline("tools_missing", "Gmail", "oauth"),
  "Missing system tools")
assert.strictEqual(model.setupHeadline("no_credentials", "HEY", "cli"), "Sign in to HEY")
assert.strictEqual(model.setupHeadline("signing_in", "HEY", "cli"), "Waiting for HEY…")
// HEY is a brand word: upper case in prose, lower case only where it is the
// command being run. A string that says "hey" about the product is a typo.
assert.ok(model.setupDetail("tools_missing", ["hey"], "", "HEY", "cli").indexOf("HEY CLI") >= 0)
assert.ok(model.setupDetail("signed_out", [], "", "HEY", "cli").indexOf("The HEY CLI") === 0)
assert.ok(model.setupDetail("no_credentials", [], "", "HEY", "cli").indexOf("never sees") >= 0)
assert.strictEqual(model.setupActionLabel("tools_missing", "HEY", "cli"), "Check again")
assert.strictEqual(model.setupActionLabel("no_credentials", "HEY", "cli"), "Sign in to HEY...")

// The setup page is chosen by the provider being edited, falling back to the
// one on screen.
assert.strictEqual(model.setupProvider("hey", "gmail"), "hey")
assert.strictEqual(model.setupProvider("", "hey"), "hey")

// Switching accounts keeps the mailbox the person was using when the target
// provider offers the same one. Provider-specific mailboxes do not get
// invented on a provider that has no such destination.
assert.strictEqual(model.mailboxAfterAccountSwitch("unread", [
  { key: "inbox" }, { key: "unread" }, { key: "all" }
]), "unread")
assert.strictEqual(model.mailboxAfterAccountSwitch("starred", [
  { key: "inbox" }, { key: "unread" }
]), "")
