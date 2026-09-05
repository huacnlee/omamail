const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapThreads.js")
const protocol = load("providers/JmapProtocol.js")

// One row per conversation, against the reference test account: seven messages
// in the Inbox, five conversations, and one thread of three whose first message
// sits in the Inbox and in Drafts at once.
//
// The mailbox list is the account's own, so the role map every rule below reads
// is the one the client would have built from it.

const boxes = [
  { id: "a", name: "Inbox", parentId: null, role: "inbox" },
  { id: "c", name: "Junk Mail", parentId: null, role: "junk" },
  { id: "d", name: "Drafts", parentId: null, role: "drafts" },
  { id: "b", name: "Deleted Items", parentId: null, role: "trash" },
  { id: "e", name: "Sent Items", parentId: null, role: "sent" }
]
const roles = protocol.roleMap(boxes)

// ------------------------------------------------------------- the request

// The four calls, exactly as the probe measured them.
deepEqual(jmap.listCalls("t", { inMailbox: "a" }, 25, ""), [
  ["Email/query", {
    accountId: "t",
    filter: { inMailbox: "a" },
    sort: [{ property: "receivedAt", isAscending: false }],
    collapseThreads: true,
    limit: 25,
    calculateTotal: true,
    position: 0
  }, "0"],
  ["Email/get", {
    accountId: "t",
    "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
    properties: ["id", "threadId"]
  }, "1"],
  ["Thread/get", {
    accountId: "t",
    "#ids": { resultOf: "1", name: "Email/get", path: "/list/*/threadId" }
  }, "2"],
  ["Email/get", {
    accountId: "t",
    "#ids": { resultOf: "2", name: "Thread/get", path: "/list/*/emailIds" },
    properties: ["id", "threadId", "mailboxIds", "keywords"]
  }, "3"]
])
// A second page is fetched by anchor, and the anchor is a representative's id —
// which is a member of the collapsed result, so the chain is unchanged.
deepEqual(jmap.listCalls("t", { inMailbox: "a" }, 25, "3|maaaaaf")[0][1].anchor, "maaaaaf")
assert.strictEqual(jmap.listCalls("t", { inMailbox: "a" }, 25, "3|maaaaaf")[0][1].position,
  undefined)
deepEqual(jmap.listCalls("t", { inMailbox: "a" }, 25, "3|maaaaaf", true)[0][1].position, 3)

// The member read again, by id, which is what the too-large follow-up sends.
deepEqual(jmap.memberGet("t", ["maaaaad", "maaaaae"]), {
  accountId: "t",
  ids: ["maaaaad", "maaaaae"],
  properties: ["id", "threadId", "mailboxIds", "keywords"]
})

// Two calls in that request are both `Email/get`, so the reply is read by the
// label the request gave each one rather than by its method name.
const twoGets = [
  ["Email/get", { list: [{ id: "maaaaaf", threadId: "d" }] }, "1"],
  ["Email/get", { list: [{ id: "maaaaad" }, { id: "maaaaae" }] }, "3"]
]
deepEqual(jmap.argumentsAt(twoGets, "1").list.length, 1)
deepEqual(jmap.argumentsAt(twoGets, "3").list.length, 2)
assert.strictEqual(jmap.argumentsAt(twoGets, "0"), null, "a call the reply never carried")
// And a call the server refused answers under its own label with the name
// `error`, which is a different thing from one that came back empty.
assert.strictEqual(
  jmap.argumentsAt([["error", { type: "requestTooLarge" }, "3"]], "3"), null)
deepEqual(jmap.invocationAt([["error", { type: "requestTooLarge" }, "3"]], "3"),
  { name: "error", arguments: { type: "requestTooLarge" } })

// The reply the probe recorded, whole. Five representatives, the thread of
// three among them, and every member's mailboxes and keywords.
const member = (id, thread, boxIds, keywords) => ({
  id: id, threadId: thread, mailboxIds: boxIds, keywords: keywords
})
const inboxReply = [
  ["Email/query", {
    accountId: "t", queryState: "shu", position: 0, total: 5,
    ids: ["2aaaaah", "yaaaaag", "maaaaaf", "iaaaaac", "eaaaaab"]
  }, "0"],
  ["Email/get", { list: [
    { id: "2aaaaah", threadId: "h" },
    { id: "yaaaaag", threadId: "g" },
    { id: "maaaaaf", threadId: "d" },
    { id: "iaaaaac", threadId: "c" },
    { id: "eaaaaab", threadId: "b" }
  ] }, "1"],
  ["Thread/get", { list: [
    { id: "h", emailIds: ["2aaaaah"] },
    { id: "g", emailIds: ["yaaaaag"] },
    { id: "d", emailIds: ["maaaaad", "maaaaae", "maaaaaf"] },
    { id: "c", emailIds: ["iaaaaac"] },
    { id: "b", emailIds: ["eaaaaab"] }
  ] }, "2"],
  ["Email/get", { list: [
    member("2aaaaah", "h", { a: true }, {}),
    member("yaaaaag", "g", { a: true }, { $flagged: true, $seen: true }),
    member("maaaaad", "d", { a: true, d: true }, { $draft: true, $seen: true }),
    member("maaaaae", "d", { a: true }, { $seen: true }),
    member("maaaaaf", "d", { a: true }, {}),
    member("iaaaaac", "c", { a: true }, { $seen: true }),
    member("eaaaaab", "b", { a: true }, { $seen: true })
  ] }, "3"]
]

const inboxPage = jmap.collapsedPage(inboxReply, 25, roles, "role:inbox", null)

// Five rows where the uncollapsed inbox has seven, and the estimate counts
// conversations because `total` does.
deepEqual(inboxPage.page, {
  ids: ["2aaaaah", "yaaaaag", "maaaaaf", "iaaaaac", "eaaaaab"],
  threadIds: [],
  nextPageToken: "",
  estimate: 5
})
assert.strictEqual(inboxPage.pending.length, 0)

// The thread row: three counted members oldest first, unread because its last
// reply is, and the representative is the newest member matching the query.
deepEqual(inboxPage.blocks["maaaaaf"], {
  id: "d",
  count: 3,
  unread: true,
  flagged: false,
  memberIds: ["maaaaad", "maaaaae", "maaaaaf"]
})
// A conversation of one is still a block, and one that draws no badge.
deepEqual(inboxPage.blocks["yaaaaag"],
  { id: "g", count: 1, unread: false, flagged: true, memberIds: ["yaaaaag"] })
deepEqual(inboxPage.blocks["2aaaaah"],
  { id: "h", count: 1, unread: true, flagged: false, memberIds: ["2aaaaah"] })

// And every member's mailboxes, which is the map an action on a conversation
// reads to decide what moving it should touch. The thread's first message sits
// in the Inbox and in Drafts at once.
deepEqual(inboxPage.memberships["maaaaad"], ["a", "d"])
deepEqual(inboxPage.memberships["maaaaae"], ["a"])
deepEqual(inboxPage.memberships["eaaaaab"], ["a"])

// ----------------------------------------------------------- counted members
//
// Gmail's rule: every member not in Junk or Trash, and in the Junk and Trash
// views only the members there. A thread with one member in each is what tells
// the three readings apart.

const spread = [
  member("m1", "t1", { a: true }, { $seen: true }),
  member("m2", "t1", { e: true }, { $seen: true }),
  member("m3", "t1", { c: true }, {}),
  member("m4", "t1", { b: true }, { $flagged: true }),
  member("m5", "t1", { a: true }, {})
]
const idsOf = list => list.map(entry => entry.id)

// A rail view: the Inbox member, the sent reply and the newest Inbox message.
// A sent reply counts, which is what makes the Sent view one row for a thread
// answered three times. The junked and trashed members do not.
deepEqual(idsOf(jmap.countedMembers(spread, roles, "role:inbox")), ["m1", "m2", "m5"])
deepEqual(idsOf(jmap.countedMembers(spread, roles, "role:sent")), ["m1", "m2", "m5"])
deepEqual(idsOf(jmap.countedMembers(spread, roles, "role:inbox unseen")), ["m1", "m2", "m5"],
  "a criterion narrows the query, not the conversation the row stands for")

// The Junk view counts only what is in Junk, and the Trash view only what is in
// Trash — so a trashed reply neither counts elsewhere nor keeps a thread unread.
deepEqual(idsOf(jmap.countedMembers(spread, roles, "role:junk")), ["m3"])
deepEqual(idsOf(jmap.countedMembers(spread, roles, "role:trash")), ["m4"])

// Selecting the same mailbox out of the folder list means the same thing: the
// rule is read off the mailbox the query resolves to, not off the word in it.
deepEqual(idsOf(jmap.countedMembers(spread, roles, "mailbox:c")), ["m3"])
deepEqual(idsOf(jmap.countedMembers(spread, roles, "mailbox:d")), ["m1", "m2", "m5"],
  "a user folder is not Junk or Trash, so the ordinary rule applies")

// A search spans the account except Junk and Trash, and collapses under the
// same rule as every other view.
deepEqual(idsOf(jmap.countedMembers(spread, roles, "text:thread of three")),
  ["m1", "m2", "m5"])

// An account with no Junk and no Trash mailbox excludes nothing.
deepEqual(idsOf(jmap.countedMembers(spread, protocol.roleMap([]), "role:inbox")),
  ["m1", "m2", "m3", "m4", "m5"])
deepEqual(jmap.countedMembers(null, roles, "role:inbox"), [])

// ------------------------------------------------------------- the block
//
// `unread` is true when any counted member lacks `$seen`, `flagged` when any
// has `$flagged`, and `count` is how many were counted.

const agree = [
  member("x1", "t2", { a: true }, { $seen: true, $flagged: true }),
  member("x2", "t2", { a: true }, { $seen: true, $flagged: true })
]
deepEqual(jmap.threadBlockFor("t2", agree, roles, "role:inbox"),
  { id: "t2", count: 2, unread: false, flagged: true, memberIds: ["x1", "x2"] })

// Members that disagree: one read and starred, one unread and not. The row says
// both, because the row stands for the conversation rather than for either
// message in it.
const disagree = [
  member("y1", "t3", { a: true }, { $seen: true, $flagged: true }),
  member("y2", "t3", { a: true }, {})
]
deepEqual(jmap.threadBlockFor("t3", disagree, roles, "role:inbox"),
  { id: "t3", count: 2, unread: true, flagged: true, memberIds: ["y1", "y2"] })

// And the same thread seen from the Trash view, where neither member is: a
// count of 0, which means unknown and draws no badge.
deepEqual(jmap.threadBlockFor("t3", disagree, roles, "role:trash"),
  { id: "t3", count: 0, unread: false, flagged: false, memberIds: [] })

// A trashed reply neither counts nor keeps its conversation unread.
deepEqual(jmap.threadBlockFor("t4", [
  member("z1", "t4", { a: true }, { $seen: true }),
  member("z2", "t4", { b: true }, {})
], roles, "role:inbox"),
  { id: "t4", count: 1, unread: false, flagged: false, memberIds: ["z1"] })

// A member id the read did not answer for is dropped rather than counted: the
// threads and their members are the same request, so the only way one goes
// missing is a message destroyed between the two calls.
deepEqual(jmap.threadBlocks(
  [{ id: "m5", threadId: "t1" }],
  { t1: ["m1", "gone", "m5"] },
  jmap.memberIndex([spread[0], spread[4]]),
  roles, "role:inbox")["m5"],
  { id: "t1", count: 2, unread: true, flagged: false, memberIds: ["m1", "m5"] })

// --------------------------------------------- a member read the server refused
//
// A page of long threads can ask for more members than `maxObjectsInGet`
// allows, and the server answers `requestTooLarge` for that one call while the
// other three answer normally. The page is not delivered until every row has
// its block.

const refused = inboxReply.slice(0, 3).concat([
  ["error", { type: "requestTooLarge" }, "3"]
])
const partial = jmap.collapsedPage(refused, 25, roles, "role:inbox", null)

// The page itself is already known, and so is every member id still owed — in
// page order, once each, which is what the follow-up asks for.
deepEqual(partial.page.ids, ["2aaaaah", "yaaaaag", "maaaaaf", "iaaaaac", "eaaaaab"])
deepEqual(partial.pending,
  ["2aaaaah", "yaaaaag", "maaaaad", "maaaaae", "maaaaaf", "iaaaaac", "eaaaaab"])
deepEqual(partial.blocks, {}, "no row has its block yet, so none is handed over")

// The same reply read again with the members the follow-up fetched is the whole
// page: every block, every membership, and the rows the un-refused read gave.
const members = inboxReply[3][1].list
const completed = jmap.collapsedPage(refused, 25, roles, "role:inbox", members)
deepEqual(completed.pending, [])
deepEqual(completed.page, inboxPage.page)
deepEqual(completed.blocks, inboxPage.blocks)
deepEqual(completed.memberships, inboxPage.memberships)

// The follow-up itself: the owed ids split into requests the server will answer.
deepEqual(protocol.chunked(partial.pending, 3),
  [["2aaaaah", "yaaaaag", "maaaaad"], ["maaaaae", "maaaaaf", "iaaaaac"], ["eaaaaab"]])

// A reply carrying no member call at all reads the same way, which is what an
// aborted or truncated response looks like.
deepEqual(jmap.collapsedPage(inboxReply.slice(0, 3), 25, roles, "role:inbox", null).pending,
  partial.pending)
// An empty page owes nothing.
deepEqual(jmap.collapsedPage([
  ["Email/query", { position: 0, ids: [], total: 0 }, "0"],
  ["Email/get", { list: [] }, "1"],
  ["Thread/get", { list: [] }, "2"]
], 25, roles, "role:inbox", null),
  { page: { ids: [], threadIds: [], nextPageToken: "", estimate: 0 },
    blocks: {}, memberships: {}, pending: [] })

// An `anchorNotFound` reply carries no invocation at all, and reading one is
// an empty page rather than a throw — the client checks the error type first,
// and this is the second half of that rule.
deepEqual(jmap.collapsedPage([["error", { type: "anchorNotFound" }, "0"]], 25, roles, "", null),
  { page: { ids: [], threadIds: [], nextPageToken: "", estimate: 0 },
    blocks: {}, memberships: {}, pending: [] })

// ------------------------------------------------- what the client remembers

deepEqual(jmap.membershipsFrom([
  member("m1", "t1", { a: true, d: true }, {}),
  member("m2", "t1", null, {}),
  { id: "" }
]), { m1: ["a", "d"], m2: [] })
deepEqual(jmap.membershipsFrom(null), {})

// Merged rather than replaced: the unread badge runs a query of its own between
// a page's ids arriving and its summaries being asked for.
deepEqual(jmap.mergedInto({ a: 1, b: 2 }, { b: 3, c: 4 }, 0), { a: 1, b: 3, c: 4 })
deepEqual(jmap.mergedInto(null, { c: 4 }, 0), { c: 4 })
deepEqual(jmap.mergedInto({ a: 1 }, null, 0), { a: 1 })
// And bounded by a reset rather than an eviction queue: an entry old enough to
// be dropped belongs to a row that left the window long ago.
deepEqual(jmap.mergedInto({ a: 1, b: 2 }, { c: 4 }, 2), { c: 4 })
deepEqual(jmap.mergedInto({ a: 1 }, { c: 4 }, 2), { a: 1, c: 4 })

console.log("jmap threads ok")
