const assert = require("assert")
const { load, deepEqual } = require("./load")

const unified = load("account/Unified.js")

// --------------------------------------------------------------- row ids

// A merged row is addressed by account and id together, because an id is
// unique inside the thing that issued it and nowhere else.
// The separator is U+001F, named here so the tests read as intent rather than
// as a control character nobody can see in a diff.
const SEP = "\u001f"

assert.strictEqual(unified.unifiedId("me@example.org", "42"), "me@example.org" + SEP + "42")
assert.strictEqual(unified.unifiedId("", "42"), "", "an id with no account addresses nothing")
assert.strictEqual(unified.unifiedId("me@example.org", ""), "")

deepEqual(unified.splitUnifiedId("me@example.org" + SEP + "42"),
  { accountId: "me@example.org", id: "42" })

// It has to be a character no id can hold. An IMAP folder cannot carry a
// control character — the protocol forbids it — and Gmail issues hex.
assert.strictEqual(unified.unifiedId("a@b.com", "42:Sent Items").indexOf(SEP), 7,
  "the only separator in a composed id is the one that was put there")
assert.strictEqual(
  unified.unifiedId("a@b.com", "42:Sent Items").split(SEP).length, 2)

// Anything that is not a composed id addresses nothing rather than being
// guessed at.
deepEqual(unified.splitUnifiedId("42"), { accountId: "", id: "" })
deepEqual(unified.splitUnifiedId(""), { accountId: "", id: "" })
deepEqual(unified.splitUnifiedId(unified.unifiedId("", "42")),
  { accountId: "", id: "" }, "an empty account is not an account")

// The case that made the separator a control character. "42:Sent Items" is a
// whole IMAP id, and a space separator read it as the account "42:Sent" — safe
// only because nothing is named that.
deepEqual(unified.splitUnifiedId("42:Sent Items"), { accountId: "", id: "" },
  "a bare IMAP id is not a composed one")
assert.strictEqual(unified.accountOf("42:Sent Items"), "")
assert.strictEqual(unified.sourceIdOf("42:Sent Items"), "")
deepEqual(unified.splitUnifiedId("1a0682969660774e"), { accountId: "", id: "" },
  "nor is a bare Gmail id")

// And a folder with a space in it survives being carried.
deepEqual(unified.splitUnifiedId(unified.unifiedId("me@fastmail.com", "42:Sent Items")),
  { accountId: "me@fastmail.com", id: "42:Sent Items" })

assert.strictEqual(unified.accountOf("me@example.org" + SEP + "42"), "me@example.org")
assert.strictEqual(unified.sourceIdOf("me@example.org" + SEP + "42"), "42")
assert.strictEqual(unified.accountOf("42"), "")

// ---------------------------------------------------------------- merging

const sources = [
  { id: "a@example.org", label: "Personal", messages: [
    { id: "1", date: 3000, subject: "newest" },
    { id: "2", date: 1000, subject: "oldest" }
  ]},
  { id: "b@example.net", label: "Work", messages: [
    { id: "1", date: 2000, subject: "middle" }
  ]}
]
const merged = unified.mergeMessages(sources)

assert.strictEqual(merged.length, 3)
deepEqual(merged.map(function(row) { return row.subject }),
  ["newest", "middle", "oldest"], "newest first, across mailboxes")

// Two accounts numbering their own messages from 1 is the collision this
// addressing exists for: three rows, three distinct ids.
deepEqual(merged.map(function(row) { return row.id }),
  [unified.unifiedId("a@example.org", "1"), unified.unifiedId("b@example.net", "1"), unified.unifiedId("a@example.org", "2")])
deepEqual(merged.map(function(row) { return row.sourceId }), ["1", "1", "2"])

// The row says which mailbox it came from, and keeps everything the provider
// put on it.
assert.strictEqual(merged[0].accountId, "a@example.org")
assert.strictEqual(merged[0].sourceLabel, "Personal")
assert.strictEqual(merged[1].sourceLabel, "Work")
assert.strictEqual(merged[0].subject, "newest", "the provider's own fields survive")

// Copied, not referenced: the account goes on replacing its own list, and a
// row that was the same object would change under the panel between a click
// and the action it starts.
sources[0].messages[0].subject = "changed underneath"
assert.strictEqual(merged[0].subject, "newest")

// A source with no id cannot address its rows, so it contributes none.
deepEqual(unified.mergeMessages([{ label: "Nameless", messages: [{ id: "1" }] }]), [])
// And a row with no id of its own is not addressable either.
assert.strictEqual(unified.mergeMessages(
  [{ id: "a@example.org", messages: [{ subject: "no id" }] }]).length, 0)

// The same message offered twice by one account is one row.
assert.strictEqual(unified.mergeMessages([
  { id: "a@example.org", messages: [{ id: "1", date: 1 }, { id: "1", date: 1 }] }
]).length, 1)

deepEqual(unified.mergeMessages(null), [])
deepEqual(unified.mergeMessages([]), [])

// Providers disagree about which field carries the time, and all of them have
// to sort against each other.
const mixedTimes = unified.mergeMessages([
  { id: "a@example.org", messages: [{ id: "date-object", date: new Date(5000) }] },
  { id: "b@example.net", messages: [{ id: "internal", internalDate: 9000 }] },
  { id: "c@example.com", messages: [{ id: "string", date: "1970-01-01T00:00:07Z" }] }
])
deepEqual(mixedTimes.map(function(row) { return row.sourceId }),
  ["internal", "string", "date-object"])

// A tie is broken by account and id so the order is total: one message copied
// to two of these mailboxes arrives with the same date in both, and a cursor
// must not move on its own between one merge and the next.
const tied = unified.mergeMessages([
  { id: "b@example.net", messages: [{ id: "x", date: 1000 }] },
  { id: "a@example.org", messages: [{ id: "x", date: 1000 }] }
])
deepEqual(tied.map(function(row) { return row.id }), [unified.unifiedId("a@example.org", "x"), unified.unifiedId("b@example.net", "x")])
deepEqual(unified.mergeMessages([
  { id: "a@example.org", messages: [{ id: "x", date: 1000 }] },
  { id: "b@example.net", messages: [{ id: "x", date: 1000 }] }
]).map(function(row) { return row.id }), [unified.unifiedId("a@example.org", "x"), unified.unifiedId("b@example.net", "x")],
  "the same rows in the other order merge to the same order")

// ----------------------------------------------------------------- cursor

// Over the merged order, which neither account can answer for: neither knows
// what sits between its own rows.
assert.strictEqual(unified.cursorOffset(merged, unified.unifiedId("a@example.org", "1"), 1), unified.unifiedId("b@example.net", "1"))
assert.strictEqual(unified.cursorOffset(merged, unified.unifiedId("b@example.net", "1"), 1), unified.unifiedId("a@example.org", "2"))
assert.strictEqual(unified.cursorOffset(merged, unified.unifiedId("b@example.net", "1"), -1), unified.unifiedId("a@example.org", "1"))

// Off either end is nowhere, rather than wrapping.
assert.strictEqual(unified.cursorOffset(merged, unified.unifiedId("a@example.org", "1"), -1), "")
assert.strictEqual(unified.cursorOffset(merged, unified.unifiedId("a@example.org", "2"), 1), "")

// No cursor yet lands on an end rather than nowhere, so the first press moves.
assert.strictEqual(unified.cursorOffset(merged, "", 1), unified.unifiedId("a@example.org", "1"))
assert.strictEqual(unified.cursorOffset(merged, "", -1), unified.unifiedId("a@example.org", "2"))
assert.strictEqual(unified.cursorOffset([], "anything", 1), "")

// A row that has gone — archived, or dropped by a refresh — is not a cursor,
// and the next press starts over rather than doing nothing.
assert.strictEqual(unified.cursorOffset(merged, "gone@example.org 9", 1), unified.unifiedId("a@example.org", "1"))

deepEqual(unified.rowOf(merged, unified.unifiedId("b@example.net", "1")).subject, "middle")
assert.strictEqual(unified.rowOf(merged, "nothing"), null)
assert.strictEqual(unified.rowOf(merged, ""), null)

// ------------------------------------------------------------------ rails

// Two mailboxes on one service ask one provider's questions, not two.
deepEqual(unified.providersOf([
  { provider: "gmail" }, { provider: "gmail" }, { provider: "imap" }
]), ["gmail", "imap"])
deepEqual(unified.providersOf([]), [])
deepEqual(unified.providersOf([{ provider: "" }]), [])

// One provider answers with its own whole rail.
deepEqual(unified.sharedMailboxes(["gmail"]).map(function(row) { return row.key }),
  ["inbox", "unread", "starred", "sent", "drafts", "all", "spam", "trash"])

// Several answer with the rows all of them have, in the first one's order —
// a rail is a reading order, not a set.
const shared = unified.sharedMailboxes(["gmail", "imap"]).map(function(row) { return row.key })
deepEqual(shared, ["inbox", "unread", "starred", "sent", "drafts", "spam", "trash"])

// HEY has neither a starred box nor a sent one it can serve, so a rail beside
// it loses both rather than offering a row that answers for two mailboxes out
// of three.
const withHey = unified.sharedMailboxes(["gmail", "hey"]).map(function(row) { return row.key })
assert.ok(withHey.indexOf("inbox") >= 0)
assert.ok(withHey.indexOf("starred") < 0, "HEY has no star, so a unified rail beside it has no starred row")
assert.ok(withHey.indexOf("sent") < 0, "the HEY client serves no Sent box")

assert.strictEqual(unified.hasSharedMailbox(["gmail", "imap"], "spam"), true)
assert.strictEqual(unified.hasSharedMailbox(["gmail", "hey"], "starred"), false)
deepEqual(unified.sharedMailboxes([]), [])

// ----------------------------------------------------------- capabilities

// A capability only some of them declare is a button that fails on the rest,
// after the row has already moved.
assert.strictEqual(unified.sharedCapability(["gmail"], "spam"), true)
assert.strictEqual(unified.sharedCapability(["gmail", "imap"], "spam"), false,
  "IMAP cannot teach a server anything by moving a message, so nothing may offer it")
assert.strictEqual(unified.sharedCapability(["gmail", "imap"], "archive"), true)
assert.strictEqual(unified.sharedCapability(["gmail", "hey"], "star"), false)
assert.strictEqual(unified.sharedCapability(["gmail", "imap"], "search"), true)
// Opening a message on the web is a capability like any other. An IMAP
// mailbox has no address this plugin could know, so a list holding one of
// its rows must not draw the button beside every row in it.
assert.strictEqual(unified.sharedCapability(["gmail", "imap"], "web"), false)
assert.strictEqual(unified.sharedCapability(["gmail", "hey"], "web"), true)
assert.strictEqual(unified.sharedCapability([], "search"), false,
  "no mailboxes can honour nothing")

// -------------------------------------------------------------- the state

assert.strictEqual(unified.totalUnread([{ unread: 3 }, { unread: 0 }, { unread: 7 }]), 10)
assert.strictEqual(unified.totalUnread([{ unread: -1 }, { unread: "4" }]), 4)
assert.strictEqual(unified.totalUnread(null), 0)

// Still loading while any of them is: a list gaining rows is still loading
// however many have arrived.
assert.strictEqual(unified.anyLoading([{ loading: false }, { loading: true }]), true)
assert.strictEqual(unified.anyLoading([{ loading: false }]), false)
assert.strictEqual(unified.anyLoading([]), false)

// Loaded only once all of them are: "nothing here" is a claim about every
// mailbox, and one that has not answered makes it wrong.
assert.strictEqual(unified.allLoaded([{ loaded: true }, { loaded: true }]), true)
assert.strictEqual(unified.allLoaded([{ loaded: true }, { loaded: false }]), false)
assert.strictEqual(unified.allLoaded([]), false, "no mailboxes have not loaded")

// A signed-out mailbox never loads, and holding the list open for it left the
// panel on nothing: no skeleton, because loading had stopped, and no "Nothing
// here", because nothing had loaded. An error is a finished mailbox.
assert.strictEqual(
  unified.allLoaded([{ loaded: true }, { loaded: false, error: "Not signed in" }]),
  true,
  "a mailbox that cannot load is not a mailbox still loading")

// Retrying is not settled, even holding the error from the last attempt.
assert.strictEqual(
  unified.allLoaded([{ loaded: true }, { loading: true, error: "Not signed in" }]),
  false)

// And a blank error is no error, or a mailbox that has simply not started
// would count as done.
assert.strictEqual(unified.allLoaded([{ loaded: false, error: "   " }]), false)

assert.strictEqual(unified.anyHasMore([{ hasMore: false }, { hasMore: true }]), true)
assert.strictEqual(unified.anyHasMore([{ hasMore: false }]), false)

// An error names the mailbox it came from, because a bare sentence about a
// server says nothing once three servers are involved.
assert.strictEqual(unified.firstError([
  { label: "Personal", error: "" },
  { label: "Fastmail", error: "the server refused that command" }
]), "Fastmail: the server refused that command")
assert.strictEqual(unified.firstError([{ error: "no label to give" }]), "no label to give")
assert.strictEqual(unified.firstError([{ error: "" }]), "")
assert.strictEqual(unified.firstError([]), "")

console.log("Unified.js ok")

// ------------------------------------------------------------- paging

// Every source is asked for its own page and the pages do not end at the same
// date, so drawing all of them puts the gap on screen rather than avoiding it:
// the tail is the deepest mailbox's mail with the shallowest one's missing
// from among it.
const deepAndShallow = [
  { id: "a@example.org", hasMore: true, messages: [
    { id: "1", date: 900 }, { id: "2", date: 800 },
    { id: "3", date: 300 }, { id: "4", date: 200 } ] },
  { id: "b@example.net", hasMore: true, messages: [
    { id: "1", date: 850 }, { id: "2", date: 700 } ] }
]

// The newest of the sources' own last rows. Above it every source has
// reported, so the list is complete.
assert.strictEqual(unified.pageWatermark(deepAndShallow), 700)
deepEqual(unified.mergeMessages(deepAndShallow).map(function(row) { return row.date }),
  [900, 850, 800, 700],
  "everything at or above the watermark, and nothing that would have a hole under it")

// A source that has run out cannot leave a hole, so it does not hold the list
// back — otherwise one finished mailbox would truncate every other.
const oneFinished = [
  { id: "a@example.org", hasMore: false, messages: [
    { id: "1", date: 900 }, { id: "2", date: 200 } ] },
  { id: "b@example.net", hasMore: false, messages: [{ id: "1", date: 500 }] }
]
assert.strictEqual(unified.pageWatermark(oneFinished), 0)
deepEqual(unified.mergeMessages(oneFinished).map(function(row) { return row.date }),
  [900, 500, 200], "nothing is withheld once every source is complete")

// A finished source beside one that is not: only the unfinished one sets the
// floor.
assert.strictEqual(unified.pageWatermark([
  { id: "a@example.org", hasMore: false, messages: [{ id: "1", date: 100 }] },
  { id: "b@example.net", hasMore: true, messages: [{ id: "1", date: 600 }] }
]), 600)

// An empty source sets no floor, so a mailbox that has not answered yet does
// not empty the list.
assert.strictEqual(unified.pageWatermark([
  { id: "a@example.org", hasMore: true, messages: [] },
  { id: "b@example.net", hasMore: true, messages: [{ id: "1", date: 600 }] }
]), 600)
