const assert = require("assert")
const { load, deepEqual } = require("./load")

const model = load("account/Model.js")

// The mailboxes moved to Provider.js along with everything else that differs
// between mail services; tests/test_provider.js covers them there.

// A conversation row and its representative's rail stop share an id but
// express different intent. Repeating one must not erase that distinction.
const rowRead = { id: "m3", action: "markRead", cacheKey: "inbox",
  sourceLabelId: "", quiet: false, memberOnly: false }
const memberRead = { ...rowRead, memberOnly: true }
const memberAgain = model.enqueueAction([memberRead], memberRead)
assert.strictEqual(memberAgain.length, 1)
assert.strictEqual(memberAgain[0].memberOnly, true)
deepEqual(model.enqueueAction([memberRead], rowRead), [memberRead, rowRead])

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
assert.strictEqual(model.setupHeadline("no_credentials", "Outlook", "oauth"),
  "Add this Outlook mailbox")
assert.strictEqual(model.setupHeadline("signing_in", "Outlook", "oauth"),
  "Waiting for Microsoft…")
assert.ok(model.setupDetail("no_credentials", [], "", "Outlook", "oauth")
  .indexOf("Microsoft") >= 0)
// The unavailable detail comes from the provider, because only it knows why.
assert.strictEqual(model.setupDetail("unavailable", [], "no API yet", "HEY"), "no API yet")
assert.strictEqual(model.setupActionLabel("unavailable", "HEY"), "",
  "there is no button that would help")
assert.strictEqual(model.setupActionLabel("ready"), "")
// The label opens a multi-step page, which is what the trailing ellipsis says.
assert.ok(model.setupActionLabel("no_credentials").endsWith("..."))
assert.strictEqual(model.setupActionLabel("signing_in"), "Cancel")
assert.ok(model.setupActionLabel("no_credentials", "IMAP", "password").endsWith("..."))

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

// A move is archive with a destination, so it leaves the same lists archive
// leaves. Reading a user label goes through `rawQuery` and keeps this key on
// "inbox", which is why moving between two labels takes the row away.
assert.strictEqual(model.survivesAction("inbox", "label:Label_7"), false)
assert.strictEqual(model.survivesAction("unread", "label:Label_7"), false)
assert.strictEqual(model.survivesAction("all", "label:Label_7"), true, "All mail still contains a moved message")
assert.strictEqual(model.survivesAction("starred", "label:Label_7", "folder:Receipts"), false,
  "a selected folder leaves even when the previous mailbox key was Starred")

deepEqual(model.labelChangesFor("archive"), { add: [], remove: ["INBOX"] })
deepEqual(model.labelChangesFor("star"), { add: ["STARRED"], remove: [] })
assert.strictEqual(model.labelChangesFor("trash"), null, "trash is its own endpoint, not a label change")

// The destination rides inside the verb, so the pipeline that carries one
// string carries the move too.
deepEqual(model.labelChangesFor("label:Label_7"), { add: ["Label_7"], remove: ["INBOX"] })
deepEqual(model.labelChangesFor("label:Label_7", "Label_3"),
  { add: ["Label_7"], remove: ["INBOX", "Label_3"] },
  "moving from a Gmail label removes the label that supplied the current view")
assert.strictEqual(model.labelTarget("label:Label_7"), "Label_7")
assert.strictEqual(model.labelTarget("archive"), "", "a verb that is not a move names no label")
assert.strictEqual(model.labelChangesFor("label:"), null, "a move with no destination is not a change")

// Not the `labels` capability, which is about the strip the reader draws: a
// mailbox with one folder per message is the case where moving is the plain
// thing to do. What the guard in `act` asks is whether the destination is the
// user's to name, which on HEY it is not.
assert.strictEqual(model.actionCapability("label:Label_7"), "move")
assert.strictEqual(model.actionUnavailable("label:Label_7", "HEY"), "HEY has no destination you can name")

// ------------------------------------------------------- movable labels
//
// The rail draws the system labels, so offering them here would put a second
// archive in a list whose job is the destinations with no key of their own.
const labelSet = [
  { id: "L2", name: "zebra" },
  { id: "S1", name: "Inbox", system: true },
  { id: "L1", name: "Archive notes" },
  { id: "L3", name: "banana" }
]
deepEqual(model.movableLabels(labelSet, "").map(l => l.id), ["L1", "L3", "L2"])
deepEqual(model.movableLabels(labelSet, "an").map(l => l.id), ["L3"], "filtering is case-insensitive and matches anywhere")
deepEqual(model.movableLabels(labelSet, "  ZEB  ").map(l => l.id), ["L2"], "a typed query is trimmed")
deepEqual(model.movableLabels(labelSet, "inbox").map(l => l.id), [], "a system label is not a destination")
deepEqual(model.movableLabels(labelSet, "", "L3").map(l => l.id), ["L1", "L2"],
  "the current Gmail label or IMAP folder is not a move destination")
deepEqual(model.movableLabels(null, ""), [])

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

// ------------------------------------------------------ a row is a conversation
//
// A row on a provider that collapses its listing stands for a conversation: a
// representative plus counted members, in a `thread` block whose `unread` and
// `flagged` are any-member and whose `count` is `memberIds.length`, 0 meaning
// unknown. What an action on such a row acts on is decided here, above the
// client seam, so no client expands anything.

// Scope is a property of the verb, in one table. Gmail's rule: everything
// reaches the conversation except star, which is a note about one message.
// Unstar is not star's mirror — the row's star is the conversation's, so an
// unstar that left a reply starred would leave the row starred.
assert.strictEqual(model.actionScope("archive"), "conversation")
assert.strictEqual(model.actionScope("unarchive"), "conversation")
assert.strictEqual(model.actionScope("trash"), "conversation")
assert.strictEqual(model.actionScope("untrash"), "conversation")
assert.strictEqual(model.actionScope("spam"), "conversation")
assert.strictEqual(model.actionScope("markRead"), "conversation")
assert.strictEqual(model.actionScope("markUnread"), "conversation")
assert.strictEqual(model.actionScope("unstar"), "conversation")
assert.strictEqual(model.actionScope("star"), "message")
assert.strictEqual(model.actionScope(""), "message")

const block = (over) => Object.assign(
  { id: "t1", count: 3, unread: true, flagged: false,
    memberIds: ["m1", "m2", "m3"] }, over || {})
const conversation = (over) => Object.assign(
  { id: "m1", labelIds: ["INBOX"], unread: true, starred: false, inInbox: true,
    thread: block() }, over || {})

// Expansion is a property of the row. Every counted member for a
// conversation-scoped verb, the representative alone for star.
deepEqual(model.actionTargets(conversation(), "markRead"), ["m1", "m2", "m3"])
deepEqual(model.actionTargets(conversation(), "archive"), ["m1", "m2", "m3"])
deepEqual(model.actionTargets(conversation(), "star"), ["m1"])
// A row with no block is its own only target, which is Gmail, IMAP, and HEY's
// posting — already the conversation its client acts on.
deepEqual(model.actionTargets({ id: "g1" }, "markRead"), ["g1"])
deepEqual(model.actionTargets({ id: "h1", thread: { id: "t", memberIds: [] } },
  "trash"), ["h1"])
// A conversation of one expands to the one member it counted.
deepEqual(model.actionTargets(
  conversation({ thread: block({ count: 1, memberIds: ["m1"] }) }), "markRead"),
  ["m1"])
deepEqual(model.actionTargets(null, "markRead"), [])

// A member is found by its row: own ids first, so a representative is never
// found as somebody else's member.
const rows = [{ id: "z", thread: { id: "t0", memberIds: ["m2", "z"] } },
  conversation()]
assert.strictEqual(model.rowIndexForMember(rows, "z"), 0)
assert.strictEqual(model.rowIndexForMember(rows, "m1"), 1)
assert.strictEqual(model.rowIndexForMember(rows, "m3"), 1)
assert.strictEqual(model.rowIndexForMember(rows, "nobody"), -1)
assert.strictEqual(model.rowIndexForMember(rows, ""), -1)
assert.strictEqual(model.rowHoldsMember(conversation(), "m2"), true)
assert.strictEqual(model.rowHoldsMember(conversation(), "m1"), true)
assert.strictEqual(model.rowHoldsMember(conversation(), "other"), false)
assert.strictEqual(model.rowHoldsMember(null, "m1"), false)

// The block after one member changed. A member's own flag is read from its
// labels: `unread` on a summary is already the OR with its conversation, so
// reading that would keep the row unread for ever.
const members = (over) => Object.assign({
  m1: { id: "m1", labelIds: ["INBOX"] },
  m2: { id: "m2", labelIds: ["INBOX", "UNREAD"] },
  m3: { id: "m3", labelIds: ["INBOX"] }
}, over || {})

// All three known and one still unread: the row stays unread.
deepEqual(model.threadAfterMemberChange(conversation(), members()),
  block({ unread: true }))
// All three known and all read: it clears, on evidence.
deepEqual(model.threadAfterMemberChange(conversation(),
  members({ m2: { id: "m2", labelIds: ["INBOX"] } })),
  block({ unread: false }))
// One unknown and the row already unread: it stays unread, because the member
// nobody has a summary for may be the unread one.
deepEqual(model.threadAfterMemberChange(conversation(),
  { m1: { id: "m1", labelIds: ["INBOX"] }, m3: { id: "m3", labelIds: ["INBOX"] } }),
  block({ unread: true }))
// One unknown and the row already read: an unknown member never flips a flag
// *on* either, so it stays read.
deepEqual(model.threadAfterMemberChange(conversation({ thread: block({ unread: false }) }),
  { m1: { id: "m1", labelIds: ["INBOX"] }, m3: { id: "m3", labelIds: ["INBOX"] } }),
  block({ unread: false }))
// A starred member makes the row starred the same way.
deepEqual(model.threadAfterMemberChange(conversation(),
  members({ m3: { id: "m3", labelIds: ["INBOX", "STARRED"] } })),
  block({ unread: true, flagged: true }))
assert.strictEqual(model.threadAfterMemberChange({ id: "g1" }, {}), null)

// A conversation action asserts the block outright, because every counted
// member was sent the same patch.
deepEqual(model.threadAfterAction(conversation(), "markRead"), block({ unread: false }))
deepEqual(model.threadAfterAction(conversation({ thread: block({ unread: false }) }),
  "markUnread"), block({ unread: true }))
deepEqual(model.threadAfterAction(conversation({ thread: block({ flagged: true }) }),
  "unstar"), block({ flagged: false }))
// Star is message-scoped, so it asserts nothing about the conversation.
deepEqual(model.threadAfterAction(conversation({ thread: block({ flagged: false }) }),
  "star"), block({ flagged: false }))

// The row's own flags stay the OR `Message.summarize` made them: a
// representative read while a reply is not is still an unread row.
const readRow = model.applyLabelChange(conversation(), "markRead")
assert.strictEqual(readRow.unread, true, "a member is still unread")
deepEqual(readRow.labelIds, ["INBOX"])
const readConversation = model.applyLabelChange(conversation(), "markRead", "",
  model.threadAfterAction(conversation(), "markRead"))
assert.strictEqual(readConversation.unread, false)
assert.strictEqual(readConversation.thread.unread, false)

// Whether the row leaves. With a block the recomputed conversation decides; the
// verb rule is what every row without one keeps, so Gmail and IMAP are
// untouched.
// The row is the last argument, after the view's own facts.
const survives = (key, action, row) => model.survivesAction(key, action, "", false, "", row)
assert.strictEqual(survives("unread", "markRead", conversation()), true)
assert.strictEqual(survives("unread", "markRead",
  conversation({ thread: block({ unread: false }) })), false)
assert.strictEqual(survives("unread", "markRead", { id: "g1" }), false)
assert.strictEqual(survives("starred", "unstar",
  conversation({ thread: block({ flagged: true }) })), true)
assert.strictEqual(survives("starred", "unstar",
  conversation({ thread: block({ flagged: false }) })), false)
assert.strictEqual(survives("starred", "unstar", { id: "g1" }), false)
// Every other case is the verb rule, block or no block.
assert.strictEqual(survives("inbox", "archive", conversation()), false)
assert.strictEqual(survives("inbox", "markRead", conversation()), true)
assert.strictEqual(survives("trash", "trash", conversation()), true)

// "Mark these read" counts rows, because rows are what the user saw, and names
// them from evidence: "conversations" only where a row stood for more than one.
assert.strictEqual(model.markAllReadNote(3, true), "3 conversations marked read")
assert.strictEqual(model.markAllReadNote(3, false), "3 messages marked read")
assert.strictEqual(model.markAllReadNote(1, true), "1 conversation marked read")
assert.strictEqual(model.markAllReadNote(1, false), "1 message marked read")

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
// The footer follows the same evidence as the note above it. A row carrying a
// block of two or more has been collapsed, so what is counted is conversations;
// a listing that reports no members — HEY's, Gmail's, IMAP's — stays "messages",
// because a row there stands for a number nobody can see.
assert.strictEqual(model.resultSummary(
  [{ thread: { id: "t", memberIds: ["a", "b"] } }, {}], 2, false), "2 conversations")
assert.strictEqual(model.resultSummary(
  [{ thread: { id: "t", memberIds: ["a", "b"] } }, {}], 87, true), "2 of about 87")
assert.strictEqual(model.resultSummary(
  [{ thread: { id: "t", memberIds: ["a", "b"] } }], 1, true), "1 conversation so far")
assert.strictEqual(model.resultSummary(
  [{ thread: { id: "t", memberIds: ["a"] } }, {}], 2, false), "2 messages")

// The foot of the window names the account and then its sync age, in a
// form short enough to sit after an address.
assert.strictEqual(model.syncedShort("Synced 1m ago"), "1m ago")
assert.strictEqual(model.syncedShort("Synced just now"), "just now")
assert.strictEqual(model.syncedShort("Checking for mail"), "checking")
assert.strictEqual(model.syncedShort(""), "")
assert.strictEqual(model.accountStatusLine("me@example.com", "Synced 1m ago"), "me@example.com · 1m ago")
assert.strictEqual(model.accountStatusLine("me@example.com", ""), "me@example.com",
  "nothing synced yet is just the address, not a dangling dot")
assert.strictEqual(model.accountStatusLine("", "Synced 1m ago"), "Not connected")

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

// ------------------------------------------------------------- rail labels
//
// The rail draws the user's labels A to Z, whatever order the server keeps them
// in: Gmail answers in creation order, and a column in creation order can only
// be read by somebody who remembers when each label was made.
{
  const reported = [
    { id: "L2", name: "zebra", rawName: "zebra" },
    { id: "S1", name: "Inbox", rawName: "INBOX", system: true },
    { id: "L4", name: "Work/Invoices", rawName: "Work/Invoices" },
    { id: "L1", name: "Bills", rawName: "Bills" },
    { id: "L3", name: "Work", rawName: "Work" },
    { id: "L5", name: "archive notes", rawName: "archive notes" }
  ]
  deepEqual(model.railLabels(reported).map(l => l.id), ["L5", "L1", "L3", "L4", "L2"],
    "A to Z, case folded, a nested folder under its parent, and no system label")
  const twins = [
    { id: "b", name: "Work" }, { id: "c", name: "Bills" }, { id: "a", name: "work" }
  ]
  deepEqual(model.railLabels(twins).map(l => l.id), ["c", "a", "b"],
    "two labels that print the same are ordered by id, so the pair never swaps")
  deepEqual(model.railLabels(twins.slice().reverse()).map(l => l.id), ["c", "a", "b"],
    "whatever order the server handed them over in")
  deepEqual(reported.map(l => l.id), ["L2", "S1", "L4", "L1", "L3", "L5"],
    "the provider's own list is not reordered underneath it")
  deepEqual(model.railLabels(null), [])
  deepEqual(model.railLabels([null, { id: "L9", name: "x" }]).map(l => l.id), ["L9"])
}

// One numbered list over the rail: mailboxes first, then the labels A to Z,
// and no number at all past the tenth row.
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
  // What App hands over is the rail's own order — the tree, siblings A to
  // Z — and the slots keep it, so a digit and the row beside it agree.
  const slots = model.sidebarSlots(boxes, model.visibleLabels(labels, []), 10)
  assert.strictEqual(slots.length, 5, "system labels are not rows and get no number")
  assert.strictEqual(slots[0].kind, "mailbox")
  assert.strictEqual(slots[0].key, "inbox")
  assert.strictEqual(slots[3].kind, "label")
  assert.strictEqual(slots[3].id, "L2",
    "Bills is numbered before Work: the digits follow the rail, and the rail is A to Z")
  assert.strictEqual(model.sidebarSlots(boxes, labels, 10)[3].id, "L1",
    "in the order given: the caller says what the rail draws")
  // A child is numbered right after its parent, before a sibling the
  // alphabet would put between them.
  const treeLabels = [
    { id: "Work (old)", name: "Work (old)", delimiter: "/" }, { id: "Work/Invoices", name: "Work/Invoices", delimiter: "/" },
    { id: "Work", name: "Work", delimiter: "/" }]
  deepEqual(model.sidebarSlots([], model.visibleLabels(treeLabels, []), 10).map(function (s) { return s.id }),
    ["Work", "Work/Invoices", "Work (old)"])
  deepEqual(model.sidebarSlots([], model.visibleLabels(treeLabels, ["Work"]), 10).map(function (s) { return s.id }),
    ["Work", "Work (old)"], "a folded child has no number: a digit never opens a row that is not on screen")
  assert.strictEqual(slots[3].name, "Bills", "the name a provider selects a label by")

  assert.strictEqual(model.slotNumberOf(slots, "mailbox", "inbox"), 1)
  assert.strictEqual(model.slotNumberOf(slots, "mailbox", "sent"), 3)
  assert.strictEqual(model.slotNumberOf(slots, "label", "L1"), 5)
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

// The number a row's badge shows, and the floor under it: two or more on a
// provider that grouped its listing, else nothing — a count of 0 is a provider
// that never grouped, a count of 1 would say nothing, and a row cached before
// rows carried a block has no block to read.
assert.strictEqual(model.badgeCount({ thread: { id: "d", count: 3, memberIds: ["a", "b", "c"] } }), 3)
assert.strictEqual(model.badgeCount({ thread: { id: "d", count: 1, memberIds: ["a"] } }), 0)
assert.strictEqual(model.badgeCount({ thread: { id: "d", count: 0, memberIds: [] } }), 0)
assert.strictEqual(model.badgeCount({ id: "m" }), 0)
assert.strictEqual(model.badgeCount(null), 0)

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
  sidebarCollapsed: false, sidebarWidth: 0, listWidth: 0, collapsedFolders: [], bodyZoom: 1, bodyMode: "reader",
  alwaysShowImages: false, windowOpen: false
})
assert.strictEqual(model.windowPrefs('{"plainTextForced":true}').bodyMode, "plain",
  "the old two-mode preference migrates to the three-mode setting")
assert.strictEqual(model.windowPrefs('{"bodyMode":"original"}').bodyMode, "original")
assert.strictEqual(model.windowPrefs('{"bodyMode":"unknown"}').bodyMode, "reader")
assert.strictEqual(model.windowPrefs('{"windowOpen":true}').windowOpen, true)
assert.strictEqual(model.windowPrefs('{"sidebarWidth":180,"listWidth":"420"}').sidebarWidth, 180)
assert.strictEqual(model.windowPrefs('{"sidebarWidth":180,"listWidth":"420"}').listWidth, 420)
assert.strictEqual(model.windowPrefs('{"sidebarWidth":-3,"listWidth":"wide"}').sidebarWidth, 0,
  "a bad width is a default, not a pane of no width")
assert.strictEqual(model.paneWidth(99999), 4000)
assert.strictEqual(model.paneWidth(0), 0)
deepEqual(model.windowPrefs('{"collapsedFolders":["Archive","",3,"Archive"]}').collapsedFolders, ["Archive", "3"])
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

// A detail read is one message and knows nothing about the conversation it sits
// in, so its block reports a count of 0 — unknown, not "one". The row's own
// block stands until a listing replaces it, or opening a conversation would
// drop its count.
const grouped = {
  id: "maaaaaf", subject: "Re: Thread of three",
  from: { name: "Bea", email: "bea@example.org" }, snippet: "Third",
  date: new Date("2026-08-22T10:00:00Z"), time: "10:00", fullTime: "x",
  unread: true, starred: false,
  thread: { id: "d", count: 3, unread: true, flagged: false,
    memberIds: ["maaaaad", "maaaaae", "maaaaaf"] }
}
const opened = model.detailSummary(grouped, {
  id: "maaaaaf", subject: "Re: Thread of three",
  from: { name: "Bea", email: "bea@example.org" }, snippet: "Third",
  date: new Date("2026-08-22T10:00:00Z"), time: "10:00", fullTime: "x",
  unread: false, starred: false,
  thread: { id: "d", count: 0, unread: false, flagged: false, memberIds: [] }
})
assert.strictEqual(opened.thread.count, 3, "the row keeps the count the listing gave it")
deepEqual(opened.thread.memberIds, ["maaaaad", "maaaaae", "maaaaaf"])
// Only the block. `unread` is something the detail read does carry, so it stays
// its answer — restoring it from a block composed before the message was opened
// would put the unread mark back on the row the reader is showing.
assert.strictEqual(opened.unread, false)

// A detail read that does know wins, as everything else it carries does.
assert.strictEqual(model.detailSummary(grouped, {
  id: "maaaaaf", subject: "Re: Thread of three",
  from: { name: "Bea", email: "bea@example.org" }, snippet: "Third",
  date: new Date("2026-08-22T10:00:00Z"), time: "10:00", fullTime: "x",
  thread: { id: "d", count: 2, unread: false, flagged: false,
    memberIds: ["maaaaae", "maaaaaf"] }
}).thread.count, 2)

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

// Switching accounts keeps the mailbox the person was using when the target
// provider offers the same one. Provider-specific mailboxes do not get
// invented on a provider that has no such destination.
assert.strictEqual(model.mailboxAfterAccountSwitch("unread", [
  { key: "inbox" }, { key: "unread" }, { key: "all" }
]), "unread")
assert.strictEqual(model.mailboxAfterAccountSwitch("starred", [
  { key: "inbox" }, { key: "unread" }
]), "")

// ------------------------------------------------------- settings sidebar

// The sidebar names the section the reader is looking at: the last heading
// scrolled past the top of the viewport. Above the first heading it is the
// first section.
const sections = [
  { key: "reading", title: "Reading", y: 40 },
  { key: "writing", title: "Writing", y: 300 },
  { key: "mailboxes", title: "Mailboxes", y: 700 }
]
assert.strictEqual(model.activeSettingsSection(sections, 0), "reading")
assert.strictEqual(model.activeSettingsSection(sections, 299), "reading")
assert.strictEqual(model.activeSettingsSection(sections, 300), "writing")
assert.strictEqual(model.activeSettingsSection(sections, 699), "writing")
assert.strictEqual(model.activeSettingsSection(sections, 700), "mailboxes")
assert.strictEqual(model.activeSettingsSection(sections, 5000), "mailboxes")
assert.strictEqual(model.activeSettingsSection([], 100), "", "no sections, no answer")
// Order on screen, not order given: a page whose sections are listed out of
// order still highlights the one that is actually at the top.
assert.strictEqual(model.activeSettingsSection([sections[2], sections[0], sections[1]], 300), "writing")

// The content is padded so the last heading can reach the top: a 900px page
// in a 500px viewport scrolls to 1200, not 400, when its last heading is at
// 700. A page already taller than that needs no padding.
assert.strictEqual(model.settingsContentHeight(sections, 900, 500), 1200)
assert.strictEqual(model.settingsContentHeight(sections, 1500, 500), 1500)
assert.strictEqual(model.settingsContentHeight([], 900, 500), 900, "nothing to reach, nothing to pad")

// Where a click scrolls to: the heading's y, clamped into what the content can
// actually scroll to — a no-op once the content is padded, and the guard that
// keeps a stale geometry from asking for a gap under the page. An unknown key
// scrolls nowhere.
assert.strictEqual(model.settingsScrollTarget(sections, "writing", 1200, 500), 300)
assert.strictEqual(model.settingsScrollTarget(sections, "mailboxes", 1200, 500), 700)
assert.strictEqual(model.settingsScrollTarget(sections, "mailboxes", 1000, 500), 500, "clamped to the end")
assert.strictEqual(model.settingsScrollTarget(sections, "reading", 400, 500), 0, "a page shorter than its viewport does not scroll")
assert.strictEqual(model.settingsScrollTarget(sections, "nope", 1200, 500), -1)
assert.strictEqual(model.settingsScrollTarget(null, "reading", 1200, 500), -1)

// --------------------------------------------- what a scroller can reach

// `contentY` does not run from 0 to `contentHeight - height`, which is what
// three clamps in this repository assumed.

// A plain view is the range that assumption described.
deepEqual(model.contentYBounds(0, 5000, 300, 0, 0), { min: 0, max: 4700 })

// Margins extend both ends. A view resting at the top of its own top margin
// sits at a negative contentY, and a floor of 0 answers a scroll *up* there by
// moving *down*, after which the margin can never be seen again.
deepEqual(model.contentYBounds(0, 5000, 300, 50, 70), { min: -50, max: 4770 })

// `originY` moves the start. A ListView with a 200-tall header reports -200,
// and a floor of 0 makes the header unreachable — measured against a real
// ListView, which settles at exactly these two values.
deepEqual(model.contentYBounds(-200, 4200, 300, 0, 0), { min: -200, max: 3700 })

// Content shorter than its own view has one position rather than a negative
// range, and that position is the top of it.
deepEqual(model.contentYBounds(0, 100, 300, 0, 0), { min: 0, max: 0 })
deepEqual(model.contentYBounds(0, 100, 300, 50, 70), { min: -50, max: -50 })

assert.strictEqual(model.clampContentY(9999, { min: -50, max: 4770 }), 4770)
assert.strictEqual(model.clampContentY(-9999, { min: -50, max: 4770 }), -50)
assert.strictEqual(model.clampContentY(100, { min: -50, max: 4770 }), 100)

// ------------------------------------------------------------- the wheel

// A Flickable answers each wheel event with its own flick, so the distance
// depends on how the turn was reported rather than on how far the wheel went.
// Rotation is the part that does not change: a notch is 120 units of
// angleDelta, and eight fractions of a notch still add up to one notch.
const NOTCH = 120
assert.strictEqual(model.wheelDistance(-NOTCH), -model.WHEEL_PIXELS_PER_NOTCH,
  "a notch moves a notch's worth, whatever that is set to")
assert.strictEqual(model.WHEEL_PIXELS_PER_NOTCH, 120,
  "and it is three lines of text, which is what a GTK application moves")

// The same turn, chopped up the way a high-resolution wheel reports it.
let fine = 0
for (let i = 0; i < 8; i++) fine += model.wheelDistance(-NOTCH / 8)
assert.strictEqual(fine, -120, "eight fractions of a notch are still one notch")

assert.strictEqual(model.wheelDistance(-3 * NOTCH), -360, "three notches")
assert.strictEqual(model.wheelDistance(0), 0)
assert.strictEqual(model.wheelDistance(null), 0)

// Nothing is capped. A cap on one event would put the chunking dependence
// straight back at the coarse end: a free-spinning wheel delivers ten notches
// as one event, and a bound would have moved it a notch and a half while the
// same ten notches arriving as ten events moved ten.
assert.strictEqual(model.wheelDistance(-10 * NOTCH), -1200)
let asTen = 0
for (let i = 0; i < 10; i++) asTen += model.wheelDistance(-NOTCH)
assert.strictEqual(asTen, model.wheelDistance(-10 * NOTCH),
  "ten notches move the same distance however they arrive")

// Where the view lands, inside what it can actually reach.
assert.strictEqual(model.wheelScrollTarget(0, -NOTCH, 5000, 300), 120)
assert.strictEqual(model.wheelScrollTarget(500, NOTCH, 5000, 300), 380)
assert.strictEqual(model.wheelScrollTarget(0, 2 * NOTCH, 5000, 300), 0,
  "there is nothing above the first row")
assert.strictEqual(model.wheelScrollTarget(4700, -2 * NOTCH, 5000, 300), 4700)
assert.strictEqual(model.wheelScrollTarget(0, -2 * NOTCH, 100, 300), 0,
  "content shorter than its view cannot scroll")

// A margined view scrolled up at the top stays in its margin. With a floor of
// 0 this moved *down* to 0 in answer to a scroll up.
assert.strictEqual(model.wheelScrollTarget(-50, NOTCH, 5000, 300, 0, 50, 70), -50)
assert.strictEqual(model.wheelScrollTarget(-50, -NOTCH, 5000, 300, 0, 50, 70), 70)
assert.strictEqual(model.wheelScrollTarget(4770, -NOTCH, 5000, 300, 0, 50, 70), 4770,
  "and the bottom margin is reachable rather than cut off")

// A ListView with a header: one notch is one notch, not a jump to 0.
assert.strictEqual(model.wheelScrollTarget(-200, -NOTCH, 4200, 300, -200, 0, 0), -80)
assert.strictEqual(model.wheelScrollTarget(-200, NOTCH, 4200, 300, -200, 0, 0), -200,
  "and the header stays reachable")

// A touchpad reports pixels, not notches. The same clamp, the same sign:
// positive pixels are a scroll up, so contentY decreases.
assert.strictEqual(model.wheelScrollByPixels(0, -40, 5000, 300), 40)
assert.strictEqual(model.wheelScrollByPixels(500, 40, 5000, 300), 460)
assert.strictEqual(model.wheelScrollByPixels(0, 40, 5000, 300), 0,
  "there is nothing above the first row")
assert.strictEqual(model.wheelScrollTarget(0, -NOTCH, 5000, 300),
  model.wheelScrollByPixels(0, model.wheelDistance(-NOTCH), 5000, 300),
  "a notch is the pixel helper fed a notch's worth")

assert.strictEqual(model.WHEEL_GAIN, 2)
assert.strictEqual(model.wheelPixels(-NOTCH, 0), -240,
  "a notch on screen is two GTK notches, which is what Chromium travels")
assert.strictEqual(model.wheelPixels(0, -40), -80,
  "a touchpad's pixels get the same gain")
assert.strictEqual(model.wheelPixels(-NOTCH, -40), -80,
  "pixelDelta wins when the device reports both")
// ------------------------------------------- moving back into the inbox

// The same pattern a `label:` move already writes: a message filed under a
// label and pulled back into the inbox has been dealt with, and leaving the
// label on it means it is still waiting in a list it is no longer in.
deepEqual(model.labelChangesFor("unarchive", "Label_17"),
  { add: ["INBOX"], remove: ["Label_17"] })
deepEqual(model.labelChangesFor("unarchive"), { add: ["INBOX"], remove: [] })
deepEqual(model.labelChangesFor("unarchive", ""), { add: ["INBOX"], remove: [] })

// Never a system label: INBOX would undo the move it is part of, and UNREAD,
// STARRED or a CATEGORY_ are states rather than places a message is filed
// under. `survivesAction` asks this function rather than reading the rule
// again, which is asserted below rather than assumed here.
deepEqual(model.labelChangesFor("unarchive", "INBOX"), { add: ["INBOX"], remove: [] })
deepEqual(model.labelChangesFor("unarchive", "CATEGORY_PERSONAL"),
  { add: ["INBOX"], remove: [] })
assert.strictEqual(model.isSystemLabelId("Label_17"), false)
assert.strictEqual(model.isSystemLabelId("IMPORTANT"), true)
assert.strictEqual(model.isSystemLabelId("CATEGORY_UPDATES"), true)

// A provider that files by folder answers this with a UID MOVE: the message is
// given a new id in INBOX, nothing parses COPYUID, and a surviving row would
// point at a message that is no longer there.
assert.strictEqual(model.survivesAction("archive", "unarchive", "", false), false,
  "a folder provider relocates, so the row cannot stay")
assert.strictEqual(model.survivesAction("all", "unarchive", "label:TODO", false), false)

// A label provider keeps the message in a mailbox or a search, and takes it
// out of the label whose list it was found in.
assert.strictEqual(model.survivesAction("all", "unarchive", "", true), true)
assert.strictEqual(model.survivesAction("all", "unarchive", "label:TODO", true), false,
  "a label view with nothing naming its label cannot say the label stayed")

// The two answering together, which is the whole of it: a system label's list
// is not a place a message is filed under, so the label stays on the message
// and the row stays in the list. Paired against `labelChangesFor` rather than
// against a constant, because a constant would let the two drift apart again.
deepEqual(model.labelChangesFor("unarchive", "IMPORTANT").remove, [])
assert.strictEqual(
  model.survivesAction("all", "unarchive", "label:important", true, "IMPORTANT"), true,
  "the label stays, so the row stays")
deepEqual(model.labelChangesFor("unarchive", "Label_17").remove, ["Label_17"])
assert.strictEqual(
  model.survivesAction("all", "unarchive", "label:todo", true, "Label_17"), false,
  "the label comes off, so the row goes")

// The third argument is still main's query string, not a boolean. Passing a
// boolean here would have read every non-empty query as "in a label view" at
// every existing call site.
assert.strictEqual(model.survivesAction("inbox", "archive", ""), false,
  "archive still leaves the inbox")
assert.strictEqual(model.survivesAction("all", "archive", ""), true)

// End to end on a summary: the label goes, INBOX arrives, the derived flags
// follow, and the original is untouched.
const filed = { id: "m1", labelIds: ["Label_17", "IMPORTANT"], unread: false,
  starred: false, inInbox: false }
const moved = model.applyLabelChange(filed, "unarchive", "Label_17")
deepEqual(moved.labelIds, ["IMPORTANT", "INBOX"])
assert.strictEqual(moved.inInbox, true)
assert.strictEqual(filed.labelIds.indexOf("Label_17"), 0)

// Every flag that mirrors a label follows the labels, not the three that used
// to be read. Reporting spam is the press that moves a row between two of
// them, and a menu asking a stale `inSpam` offers "Move to Inbox" on the
// message just reported — a press that would add INBOX, keep SPAM, and leave
// it sitting in Spam.
const reported = model.applyLabelChange(
  { id: "m2", labelIds: ["UNREAD", "INBOX"], inInbox: true, inSpam: false }, "spam")
deepEqual(reported.labelIds, ["UNREAD", "SPAM"])
assert.strictEqual(reported.inInbox, false)
assert.strictEqual(reported.inSpam, true, "the row is in Spam the moment it is reported")
const binned = model.applyLabelChange(
  { id: "m3", labelIds: ["Label_17"], isSent: true, isDraft: true, inTrash: true },
  "unarchive", "Label_17")
assert.strictEqual(binned.isSent, false)
assert.strictEqual(binned.isDraft, false)
assert.strictEqual(binned.inTrash, false)

// -------------------------------------------------- what is being read

// The foot of the rail names the mailbox and how long ago it was checked.
assert.strictEqual(model.readingStatusLine(false, "me@example.org", "Synced 2 min ago"),
  "me@example.org · 2 min ago")
assert.strictEqual(model.readingStatusLine(false, "me@example.org", ""), "me@example.org")

// A combined view has no address to give, and no age either: the sync label
// belongs to one mailbox, so putting it after "All mailboxes" would be a claim
// about every one of them made from whichever was active underneath.
assert.strictEqual(model.readingStatusLine(true, "me@example.org", "Synced 2 min ago"),
  "All mailboxes")
assert.strictEqual(model.readingStatusLine(true, "", ""), "All mailboxes")

// One string in one place, because the switcher names the row and this names
// what the row selected.
assert.strictEqual(model.UNIFIED_LABEL, "All mailboxes")

assert.strictEqual(model.readingStatusLine(false, "", ""), "Not connected")

// ------------------------------------------------ what a preview may do

// Arrival marks an opened message read and leaves a previewed one alone.
assert.strictEqual(model.marksReadOnArrival({ unread: true }, false), true)
assert.strictEqual(model.marksReadOnArrival({ unread: true }, true), false,
  "stepping down a list would otherwise read every message it passed")
assert.strictEqual(model.marksReadOnArrival({ unread: false }, false), false)
assert.strictEqual(model.marksReadOnArrival(null, false), false)

// Only `true` is a preview, so a call that forgot the argument opens rather
// than silently previewing — the safe way round for the read mark.
assert.strictEqual(model.marksReadOnArrival({ unread: true }, undefined), true)

// The sender learns nothing from a message nobody opened.
assert.strictEqual(model.showsRemoteImages(true, false), true)
assert.strictEqual(model.showsRemoteImages(true, true), false,
  "the standing answer is about a message somebody chose to read")
assert.strictEqual(model.showsRemoteImages(false, false), false)
assert.strictEqual(model.showsRemoteImages(false, true), false)

// A dwell has something to mark only while the message is still in the list
// and still unread.
const dwelt = [{ id: "m1", unread: true }, { id: "m2", unread: false }]
assert.strictEqual(model.previewReadable(dwelt, "m1"), true)
assert.strictEqual(model.previewReadable(dwelt, "m2"), false, "already read")
assert.strictEqual(model.previewReadable(dwelt, "gone"), false,
  "a search or a mailbox switch takes the row out from under the dwell")
assert.strictEqual(model.previewReadable([], "m1"), false)
assert.strictEqual(model.previewReadable(dwelt, ""), false)

// ------------------------------------------------------------ selection
{
  const list = [{ id: "a", starred: true }, { id: "b" }, { id: "c", starred: true }, { id: "d" }]

  deepEqual(model.toggleId([], "b"), ["b"])
  deepEqual(model.toggleId(["b", "c"], "b"), ["c"])
  deepEqual(model.toggleId(["b"], ""), ["b"], "an empty id toggles nothing")

  deepEqual(model.idsBetween(list, "b", "d"), ["b", "c", "d"])
  deepEqual(model.idsBetween(list, "d", "b"), ["b", "c", "d"], "either direction")
  deepEqual(model.idsBetween(list, "", "c"), ["c"], "no anchor means the row itself")
  deepEqual(model.idsBetween(list, "zz", "yy"), [])
  deepEqual(model.unionIds(["a"], ["a", "c"]), ["a", "c"])

  deepEqual(model.toggleRange(["a"], list, "b", "d"), ["a", "b", "c", "d"],
    "an unchecked endpoint selects the range and keeps selections outside it")
  deepEqual(model.toggleRange(["a", "b", "c", "d"], list, "d", "b"), ["a"],
    "a checked endpoint clears the range in either direction")
  deepEqual(model.toggleRange(["b", "d"], list, "b", "d"), [],
    "a checked endpoint clears a mixed range instead of inverting its gaps")
  deepEqual(model.toggleRange(["a"], list, "", "a"), [],
    "without an anchor the endpoint can still be unchecked")
  deepEqual(model.toggleRange(["a"], list, "a", "gone"), ["a"],
    "an endpoint removed from the list leaves selection alone")

  deepEqual(model.retainIds(["a", "gone", "c"], list), ["a", "c"])
  deepEqual(model.allIds(list), ["a", "b", "c", "d"])
  deepEqual(model.summariesById(list, ["c", "nope", "a"]), [list[2], list[0]])

  // The cursor steps over every departing row to the first that stays, and
  // back up the list only when nothing below survives.
  assert.strictEqual(model.cursorAfterRemovals(list, ["b", "c"], "b"), "d")
  assert.strictEqual(model.cursorAfterRemovals(list, ["c", "d"], "c"), "b")
  assert.strictEqual(model.cursorAfterRemovals(list, ["a", "b", "c", "d"], "b"), "")
  assert.strictEqual(model.cursorAfterRemovals(list, ["a"], "b"), "b", "a cursor off the selection stays")
  assert.strictEqual(model.cursorAfterRemovals(list, ["a"], "nope"), "")

  assert.strictEqual(model.starActionFor([list[0], list[2]]), "unstar")
  assert.strictEqual(model.starActionFor([list[0], list[1]]), "star", "a mixed selection stars")
  assert.strictEqual(model.starActionFor([]), "star")

  assert.strictEqual(model.batchNote(3, "Archived"), "3 messages archived")
  assert.strictEqual(model.batchNote(1, "Moved to Todo"), "1 message moved to Todo")
  assert.strictEqual(model.selectionStatus(0), "")
  assert.strictEqual(model.selectionStatus(2), "2 selected")
}

// A partly failed batch puts back only the rows that failed, in their old places.
{
  const before = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
  const afterAction = [{ id: "a" }, { id: "d" }]
  deepEqual(model.restoreRows(afterAction, before, ["c"]).map(function (r) { return r.id }), ["a", "c", "d"])
  deepEqual(model.restoreRows(afterAction, before, ["b", "c"]).map(function (r) { return r.id }), ["a", "b", "c", "d"])
  deepEqual(model.restoreRows([{ id: "a" }], before, ["d"]).map(function (r) { return r.id }), ["a", "d"], "no later row left means the end")
  deepEqual(model.restoreRows([{ id: "a", unread: false }], [{ id: "a", unread: true }], ["a"]), [{ id: "a", unread: true }],
    "a row still listed is put back as it was")
  deepEqual(model.restoreRows(afterAction, before, []).map(function (r) { return r.id }), ["a", "d"])
  assert.strictEqual(model.batchFailureNote(5, 2, "Moved to trash", "server said no"), "2 of 5 could not be moved to trash: server said no")
  assert.strictEqual(model.batchFailureNote(3, 1, "Archived", ""), "1 of 3 could not be archived")
}

// ------------------------------------------------------------ folder tree
{
  const labels = [
    { id: "INBOX", name: "INBOX", system: true },
    { id: "Archive/2025", name: "Archive/2025", rawName: "Archive/2025", delimiter: "/", unread: 2 },
    { id: "Archive", name: "Archive", rawName: "Archive", delimiter: "/", unread: 1 },
    { id: "Archive/2026/Q1", name: "Archive/2026/Q1", rawName: "Archive/2026/Q1", delimiter: "/", unread: 4 },
    { id: "Receipts", name: "Receipts", rawName: "Receipts", delimiter: "/", unread: 0 },
    { id: "Label_3", name: "todo", rawName: "todo", unread: 1 }]

  const open = model.labelTree(labels, [])
  deepEqual(open.map(function (r) { return [r.path, r.depth, r.selectable, r.hasChildren, r.unread] }), [
    ["Archive", 0, true, true, 1],
    ["Archive/2025", 1, true, false, 2],
    ["Archive/2026", 1, false, true, 0],
    ["Archive/2026/Q1", 2, true, false, 4],
    ["Receipts", 0, true, false, 0],
    ["todo", 0, true, false, 1]],
    "children hang under parents, a missing ancestor is a row of its own, siblings sort by name")
  assert.strictEqual(open[0].name, "Archive")
  assert.strictEqual(open[3].name, "Q1", "a row shows its own segment")
  assert.strictEqual(open[3].id, "Archive/2026/Q1", "and keeps the whole id")

  const folded = model.labelTree(labels, ["Archive"])
  deepEqual(folded.map(function (r) { return r.path }), ["Archive", "Receipts", "todo"])
  assert.strictEqual(folded[0].expanded, false)
  assert.strictEqual(folded[0].unread, 7, "a folded parent counts its subtree")

  const partly = model.labelTree(labels, ["Archive/2026"])
  deepEqual(partly.map(function (r) { return r.path }), ["Archive", "Archive/2025", "Archive/2026", "Receipts", "todo"])
  assert.strictEqual(partly[2].unread, 4)

  // A server delimiter that is not a slash, and a Gmail label with none.
  const dotted = model.labelTree([
    { id: "a.b", name: "a.b", delimiter: "." }, { id: "a", name: "a", delimiter: "." },
    { id: "x/y", name: "x/y" }], [])
  deepEqual(dotted.map(function (r) { return [r.path, r.depth] }), [["a", 0], ["a.b", 1], ["x", 0], ["x/y", 1]])

  deepEqual(model.visibleLabels(labels, ["Archive"]).map(function (l) { return l.id }),
    ["Archive", "Receipts", "Label_3"], "the digits follow what is on screen")
  deepEqual(model.visibleLabels(labels, []).map(function (l) { return l.id }),
    ["Archive", "Archive/2025", "Archive/2026/Q1", "Receipts", "Label_3"])
  deepEqual(model.togglePath(["Archive"], "Archive"), [])
  deepEqual(model.togglePath([], "Archive/2026"), ["Archive/2026"])
  deepEqual(model.labelTree(null, null), [])
  // A label named like an Object property is still a label.
  const odd = model.labelTree([{ id: "constructor", name: "constructor" },
    { id: "constructor/2026", name: "constructor/2026" }, { id: "__proto__", name: "__proto__" },
    { id: "toString", name: "toString" }], [])
  deepEqual(odd.map(function (r) { return r.path }), ["__proto__", "constructor", "constructor/2026", "toString"])

  // The delimiter is the server's word. Reported: nest on it. Not reported:
  // "/", which is what Gmail nests with. Reported as none — IMAP's NIL, which
  // the provider passes on as "" — no nesting at all, so a folder named
  // "a/b" is one folder and a dot in a name is only a dot.
  assert.strictEqual(model.labelDelimiter({ delimiter: "." }), ".")
  assert.strictEqual(model.labelDelimiter({ delimiter: "/" }), "/")
  assert.strictEqual(model.labelDelimiter({ name: "todo" }), "/")
  assert.strictEqual(model.labelDelimiter(null), "/")
  assert.strictEqual(model.labelDelimiter({ delimiter: "" }), "")
  const flat = model.labelTree([
    { id: "a/b", name: "a/b", rawName: "a/b", delimiter: "" },
    { id: "a", name: "a", rawName: "a", delimiter: "" },
    { id: "x.y", name: "x.y", rawName: "x.y", delimiter: "" }], [])
  deepEqual(flat.map(function (r) { return [r.path, r.depth, r.hasChildren, r.selectable] }),
    [["a", 0, false, true], ["a/b", 0, false, true], ["x.y", 0, false, true]],
    "a NIL delimiter makes a flat list, slashes and all")
  deepEqual(model.visibleLabels([{ id: "a/b", name: "a/b", delimiter: "" }, { id: "a", name: "a", delimiter: "" }], ["a"])
    .map(function (l) { return l.id }), ["a", "a/b"], "and nothing folds under anything")
  const slashed = model.labelTree([{ id: "a.b", name: "a.b", delimiter: "/" }, { id: "a", name: "a", delimiter: "/" }], [])
  deepEqual(slashed.map(function (r) { return [r.path, r.depth] }), [["a", 0], ["a.b", 0]],
    "a slash server does not nest on a dot")
}

// A cache-first paint restores rows the list is usually already showing, and
// `Cache.hydrate` rebuilds every one of them, so the rows are never the same
// objects. Only their values can say whether anything changed.
function summaryRows() {
  return [
    { id: "m1", subject: "One", unread: true, from: { email: "a@x", display: "A" },
      to: [{ name: "Me", email: "me@x", display: "Me" }],
      thread: { id: "t1", count: 2, memberIds: ["m1", "m0"] }, date: new Date(3000) },
    { id: "m2", subject: "Two", unread: false, from: { email: "b@x", display: "B" },
      to: [], thread: { id: "t2", count: 0, memberIds: [] }, date: new Date(2000) }
  ]
}

const painted = summaryRows()
assert.strictEqual(model.sameSummaries(painted, summaryRows()), true,
  "rebuilt rows carrying the same values are the same list")
assert.strictEqual(model.sameSummaries(painted, painted), true)
assert.strictEqual(model.sameSummaries([], []), true)
assert.strictEqual(model.sameSummaries(null, undefined), true, "neither list has rows")

// Anything a row says differently is a change, however deep it sits. The
// deepest a summary actually goes is a thread's member ids and a recipient's
// own fields, so the comparison has to reach both.
const markedRead = summaryRows()
markedRead[0].unread = false
assert.strictEqual(model.sameSummaries(painted, markedRead), false, "a row was read")

const renamed = summaryRows()
renamed[0].from.display = "Someone else"
assert.strictEqual(model.sameSummaries(painted, renamed), false,
  "a nested field is still a field")

const addressed = summaryRows()
addressed[0].to[0].email = "someone@else"
assert.strictEqual(model.sameSummaries(painted, addressed), false,
  "a recipient's own field, two levels down")

const grown = summaryRows()
grown[0].to.push({ email: "cc@x" })
assert.strictEqual(model.sameSummaries(painted, grown), false, "a recipient arrived")

const answered = summaryRows()
answered[0].thread.memberIds.push("m3")
assert.strictEqual(model.sameSummaries(painted, answered), false,
  "a conversation gained a member, three levels down")

// A field the new row carries and the old one does not is a change the
// comparison has to see, which reading only the old row's keys would miss.
const tagged = summaryRows()
tagged[0].pinned = true
assert.strictEqual(model.sameSummaries(painted, tagged), false, "a field appeared")

// Where a row sits is part of what the list says: the cursor steps by index.
const reordered = summaryRows()
reordered.reverse()
assert.strictEqual(model.sameSummaries(painted, reordered), false,
  "the same rows in another order are another list")

// A date is the instant it names: hydrate builds a new Date on every read.
assert.strictEqual(model.sameSummaries([{ id: "m", date: new Date(1000) }],
  [{ id: "m", date: new Date(1000) }]), true)
assert.strictEqual(model.sameSummaries([{ id: "m", date: new Date(1000) }],
  [{ id: "m", date: new Date(2000) }]), false)
assert.strictEqual(model.sameSummaries([{ id: "m", date: new Date(1000) }],
  [{ id: "m", date: null }]), false, "a row that lost its date changed")

// The answer cannot depend on which list was handed in first. A field holding
// `undefined` is a field the row does not have — `JSON.stringify` drops the key
// on the way to the cache, so a live row carrying one and the copy restored
// from disk are the same row — and a field that holds a value is a difference
// read from either side.
const withUndefined = [{ id: "m1", subject: "One", snippet: undefined }]
const withoutKey = [{ id: "m1", subject: "One" }]
assert.strictEqual(model.sameSummaries(withUndefined, withoutKey), true,
  "a key the cache drops is not a change")
assert.strictEqual(model.sameSummaries(withoutKey, withUndefined), true,
  "and it is not a change the other way round either")

const withValue = [{ id: "m1", subject: "One", snippet: "new" }]
assert.strictEqual(model.sameSummaries(withValue, withoutKey), false)
assert.strictEqual(model.sameSummaries(withoutKey, withValue), false,
  "a field that arrived is a change read from either side")

// A shorter or longer list is a different list without looking at a row.
assert.strictEqual(model.sameSummaries(painted, [painted[0]]), false)
assert.strictEqual(model.sameSummaries([painted[0]], painted), false)

// Deeper than the bound reads as changed rather than as equal: repainting a
// list that did not need it is recoverable, hiding mail that did is not. A
// summary nests three deep at most, so the bound is not in a row's way.
const deep = { id: "m", a: { b: { c: { d: { e: 1 } } } } }
const alsoDeep = { id: "m", a: { b: { c: { d: { e: 1 } } } } }
assert.strictEqual(model.sameSummaries([deep], [alsoDeep]), false,
  "the comparison stops rather than following an unbounded structure")

// ------------------------------------------------------------ label names
{
  assert.strictEqual(model.labelLeaf("Archive/2026/Q1", "/"), "Q1")
  assert.strictEqual(model.labelLeaf("Receipts", "/"), "Receipts")
  assert.strictEqual(model.labelParent("Archive/2026/Q1", "/"), "Archive/2026")
  assert.strictEqual(model.labelParent("Receipts", "/"), "")
  assert.strictEqual(model.labelPathJoin("Archive", " 2026 ", "/"), "Archive/2026")
  assert.strictEqual(model.labelPathJoin("", "Receipts", "/"), "Receipts")
  assert.strictEqual(model.labelPathJoin("a", "b", "."), "a.b")
  assert.strictEqual(model.labelDelimiter({ delimiter: "." }), ".")
  assert.strictEqual(model.labelDelimiter({}), "/")
  assert.strictEqual(model.labelNameProblem("  ", "/"), "A label needs a name")
  assert.strictEqual(model.labelNameProblem("a/b", "/").indexOf("cannot contain /") > 0, true)
  assert.strictEqual(model.labelNameProblem("Receipts", "/"), "")

  const labels = [
    { id: "INBOX", name: "INBOX", system: true },
    { id: "Archive", rawName: "Archive" },
    { id: "Archive/2026", rawName: "Archive/2026" },
    { id: "Archive/2026/Q1", rawName: "Archive/2026/Q1" },
    { id: "Receipts", rawName: "Receipts" }]
  deepEqual(model.labelMoveTargets(labels, "Archive/2026", "/").map(function (t) { return t.path }),
    ["", "Receipts"], "not itself, not its children, not its current parent, never a system label")
  deepEqual(model.labelMoveTargets(labels, "Receipts", "/").map(function (t) { return t.path }),
    ["", "Archive", "Archive/2026", "Archive/2026/Q1"])
  assert.strictEqual(model.labelMoveTargets(labels, "Receipts", "/")[0].name, "Top level")
}

assert.strictEqual(model.monitoredNote([{ name: "Receipts", delta: 3 }]), "3 new in Receipts")
assert.strictEqual(model.monitoredNote([{ name: "A", delta: 1 }, { name: "B", delta: 4 }, { name: "C", delta: 2 }]),
  "4 new in B, 2 new in C and 1 more")
assert.strictEqual(model.monitoredNote([]), "")

// ------------------------------------------------------------ label paths
{
  // A server with no hierarchy — IMAP's NIL delimiter, passed on as "" —
  // has leaves only: nothing has a parent and nothing goes under anything.
  assert.strictEqual(model.labelLeaf("a/b", ""), "a/b")
  assert.strictEqual(model.labelParent("a/b", ""), "")
  assert.strictEqual(model.labelPathJoin("", "a/b", ""), "a/b")
  assert.strictEqual(model.labelNameProblem("a/b", ""), "", "a slash is only a slash")
  assert.ok(model.labelNameProblem("a/b", "/").indexOf("cannot contain /") >= 0)
  assert.strictEqual(model.labelNestProblem("", ""), "")
  assert.strictEqual(model.labelNestProblem("Work", "/"), "")
  assert.ok(model.labelNestProblem("Work", "").indexOf("flat list") >= 0)
  deepEqual(model.labelMoveTargets([{ id: "a", name: "a" }, { id: "b", name: "b" }], "a", ""),
    [{ id: "", name: "Top level", path: "" }], "nowhere to move to but where it is")
  assert.strictEqual(model.labelLeaf("a.b", "."), "b")
  assert.strictEqual(model.labelParent("a.b", "."), "a")
  assert.strictEqual(model.labelLeaf("a.b", undefined), "a.b", "no word from the provider means a slash")
  assert.strictEqual(model.labelPathJoin("a", "b", undefined), "a/b")
}

// ------------------------------------------------------------ watched ids
{
  // On IMAP a folder's id is its wire name: a rename changes it, and every
  // folder beneath it. The watch follows to the id the fresh listing gives
  // the same path.
  const before = [
    { id: "Work", name: "Work", delimiter: "/" }, { id: "Work/2026", name: "Work/2026", delimiter: "/" },
    { id: "Work/2026/Q1", name: "Work/2026/Q1", delimiter: "/" }, { id: "Receipts", name: "Receipts", delimiter: "/" }]
  const after = [
    { id: "Jobs", name: "Jobs", delimiter: "/" }, { id: "Jobs/2026", name: "Jobs/2026", delimiter: "/" },
    { id: "Jobs/2026/Q1", name: "Jobs/2026/Q1", delimiter: "/" }, { id: "Receipts", name: "Receipts", delimiter: "/" }]
  deepEqual(model.migrateMonitoredIds(["Work", "Receipts", "Work/2026/Q1"], before, after, "Work", "Jobs", "/"),
    ["Jobs", "Receipts", "Jobs/2026/Q1"])
  deepEqual(model.migrateMonitoredIds(["Work/2026"], before, after, "Work", "Jobs", "/"), ["Jobs/2026"])
  // A move: the same, with the new path under another parent.
  const moved = [
    { id: "Archive", name: "Archive", delimiter: "/" }, { id: "Archive/Work", name: "Archive/Work", delimiter: "/" },
    { id: "Archive/Work/2026", name: "Archive/Work/2026", delimiter: "/" }, { id: "Receipts", name: "Receipts", delimiter: "/" }]
  deepEqual(model.migrateMonitoredIds(["Work/2026", "Receipts"], before, moved, "Work", "Archive/Work", "/"),
    ["Archive/Work/2026", "Receipts"])
  // A watch on a folder the listing no longer has is dropped, deleted
  // parent and children alike; the rest stay.
  const gone = [{ id: "Receipts", name: "Receipts", delimiter: "/" }]
  deepEqual(model.migrateMonitoredIds(["Work", "Work/2026", "Receipts"], before, gone, "Work", "", "/"), ["Receipts"])
  // The same array back when nothing it held was touched: Gmail keeps its
  // ids across a rename, and a watch on a folder beside the renamed one is
  // not a change either.
  const same = ["Receipts"]
  assert.strictEqual(model.migrateMonitoredIds(same, before, after, "Work", "Jobs", "/"), same)
  const gmail = [{ id: "Label_1", name: "Work" }, { id: "Label_2", name: "Work/2026" }]
  const gmailAfter = [{ id: "Label_1", name: "Jobs" }, { id: "Label_2", name: "Jobs/2026" }]
  const kept = ["Label_2"]
  assert.strictEqual(model.migrateMonitoredIds(kept, gmail, gmailAfter, "Work", "Jobs", "/"), kept)
  // With no hierarchy only the folder itself is renamed; "Work/2026" is
  // another folder and stays watched under its own id.
  const flatBefore = [{ id: "Work", name: "Work", delimiter: "" }, { id: "Work/2026", name: "Work/2026", delimiter: "" }]
  const flatAfter = [{ id: "Jobs", name: "Jobs", delimiter: "" }, { id: "Work/2026", name: "Work/2026", delimiter: "" }]
  deepEqual(model.migrateMonitoredIds(["Work", "Work/2026"], flatBefore, flatAfter, "Work", "Jobs", ""), ["Jobs", "Work/2026"])
  deepEqual(model.migrateMonitoredIds(null, before, after, "Work", "Jobs", "/"), [])
}
