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

// The same account with an Archive mailbox, for the actions below. The test
// account has none, which is what makes its archive refusal worth asserting
// and its archive patches worth asserting against a second role map.
const archiveRoles = protocol.roleMap(
  boxes.concat([{ id: "f", name: "Archive", parentId: null, role: "archive" }]))

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


// -------------------------------------------------- acting on a whole row
//
// An action on a conversation row arrives here as every counted member, and
// where each member sits decides whether the move reaches it at all. The map
// is the client's, `{ emailId: [mailboxId, ...] }`, last written by a list
// read; an id it does not carry is *unknown* rather than "not in the Inbox".
//
// The account's own ids: `a` Inbox, `b` Trash, `c` Junk, `d` Drafts, `e` Sent.

// Archive on a member in the Inbox is the swap ticket 06 defined, and it is a
// patch rather than a replace so a message that also sits in a user folder
// keeps that membership.
deepEqual(protocol.patchFor([], ["INBOX"], archiveRoles, ["a"]),
  { "mailboxIds/f": true, "mailboxIds/a": null })
// The same member on an account with no Archive mailbox — this one — fails
// before any request, whatever the membership says.
assert.strictEqual(protocol.patchFor([], ["INBOX"], roles, ["a"]),
  "This account has no Archive mailbox")
// A member in Sent only is not in the Inbox, so archiving the conversation
// does not touch it: Gmail's archive is "remove INBOX", which does nothing to
// a message that never had it, and adding one to Archive would file a reply
// the user never archived.
deepEqual(protocol.patchFor([], ["INBOX"], archiveRoles, ["e"]), {})
// A member the map does not name gets ticket 06's single-message patch, which
// is also the right answer for a lone search hit in a user folder.
deepEqual(protocol.patchFor([], ["INBOX"], archiveRoles, null),
  { "mailboxIds/f": true, "mailboxIds/a": null })
deepEqual(protocol.patchFor([], ["INBOX"], archiveRoles),
  { "mailboxIds/f": true, "mailboxIds/a": null })

// Spam is the mirror: every member is reported except the ones the account
// sent, because moving its own replies into Junk would train the classifier on
// them. The keywords go with the move, so a skipped member is not marked
// `$junk` either.
deepEqual(protocol.patchFor(["SPAM"], ["INBOX"], roles, ["a"]),
  { mailboxIds: { c: true }, "keywords/$junk": true, "keywords/$notjunk": null })
deepEqual(protocol.patchFor(["SPAM"], ["INBOX"], roles, ["e"]), {})
deepEqual(protocol.patchFor(["SPAM"], ["INBOX"], roles, ["a", "e"]), {})
deepEqual(protocol.patchFor(["SPAM"], ["INBOX"], roles, null),
  { mailboxIds: { c: true }, "keywords/$junk": true, "keywords/$notjunk": null })

// Trash keeps the whole replace for every member, membership or not: Gmail
// trashes sent replies with the conversation, and so does this.
deepEqual(protocol.patchFor(["TRASH"], [], roles, ["e"]), { mailboxIds: { b: true } })
deepEqual(protocol.patchFor([], ["TRASH"], roles, ["b"]),
  { "mailboxIds/a": true, "mailboxIds/b": null })
// And a keyword change is about the message rather than about where it sits.
deepEqual(protocol.patchFor([], ["UNREAD"], roles, ["e"]), { "keywords/$seen": true })

// ------------------------------------------------------------- the groups

// One action over many ids is one plan: the ids that share a patch share a
// request, and a member the map excluded is dropped rather than sent an empty
// one.
deepEqual(jmap.patchPlan(["maaaaad", "maaaaae", "maaaaaf"], [], ["UNREAD"], roles,
  { maaaaad: ["a", "d"], maaaaae: ["a"], maaaaaf: ["a"] }),
  [{ ids: ["maaaaad", "maaaaae", "maaaaaf"], patch: { "keywords/$seen": true } }])
// Archive over a conversation whose reply is in Sent and whose third member the
// last read did not carry: two go, one is left where it is.
deepEqual(jmap.patchPlan(["maaaaad", "maaaaae", "maaaaaf"], [], ["INBOX"], archiveRoles,
  { maaaaad: ["a"], maaaaae: ["e"] }),
  [{ ids: ["maaaaad", "maaaaaf"],
     patch: { "mailboxIds/f": true, "mailboxIds/a": null } }])
// A multi-id trash and untrash, which every client takes as one id or an array.
deepEqual(jmap.patchPlan(["maaaaad", "maaaaae", "maaaaaf"], ["TRASH"], [], roles, {}),
  [{ ids: ["maaaaad", "maaaaae", "maaaaaf"], patch: { mailboxIds: { b: true } } }])
deepEqual(jmap.patchPlan(["m1", "m2"], [], ["TRASH"], roles, { m1: ["b"], m2: ["b"] }),
  [{ ids: ["m1", "m2"], patch: { "mailboxIds/a": true, "mailboxIds/b": null } }])
// Which is the request that crosses.
deepEqual(protocol.emailSet("t", ["m1", "m2"], { mailboxIds: { b: true } }), {
  accountId: "t",
  update: { m1: { mailboxIds: { b: true } }, m2: { mailboxIds: { b: true } } }
})
// Ids are deduped, empties dropped, and a conversation every member of which
// the map excluded is no request at all rather than an `Email/set` that asks
// for nothing.
deepEqual(jmap.patchPlan(["m1", "m1", "", "m2"], [], ["UNREAD"], roles, {}),
  [{ ids: ["m1", "m2"], patch: { "keywords/$seen": true } }])
deepEqual(jmap.patchPlan(["m1", "m2"], [], ["INBOX"], archiveRoles, { m1: ["e"], m2: ["e"] }), [])
deepEqual(jmap.patchPlan([], [], ["UNREAD"], roles, {}), [])
// The map speaks only for the members a row action reached without being
// asked about. One id is the message the user acted on — a row of one, or the
// member open in the reader — and its move goes whatever the map says, so the
// same key on the same message does the same thing whether or not the last
// read happened to carry it.
deepEqual(jmap.patchPlan(["m1"], [], ["INBOX"], archiveRoles, { m1: ["e"] }),
  [{ ids: ["m1"], patch: { "mailboxIds/f": true, "mailboxIds/a": null } }])
deepEqual(jmap.patchPlan(["m1"], [], ["INBOX"], archiveRoles, {}),
  [{ ids: ["m1"], patch: { "mailboxIds/f": true, "mailboxIds/a": null } }])
deepEqual(jmap.patchPlan(["m1", "m1"], [], ["INBOX"], archiveRoles, { m1: ["e"] }),
  [{ ids: ["m1"], patch: { "mailboxIds/f": true, "mailboxIds/a": null } }],
  "the same id twice is still one message")
deepEqual(jmap.patchPlan(["m1", "m2"], ["SPAM"], ["INBOX"], roles, { m1: ["e"], m2: ["a"] }),
  [{ ids: ["m2"], patch: { mailboxIds: { c: true }, "keywords/$junk": true, "keywords/$notjunk": null } }],
  "in a row action the map still keeps the account's own reply out of Junk")
// One refusal is the whole action's: the mailbox is missing from the account
// rather than from this member.
assert.strictEqual(jmap.patchPlan(["m1", "m2"], [], ["INBOX"], roles, {}),
  "This account has no Archive mailbox")

// Which server, and as whom. The client forgets its session when this
// changes and keeps it when it does not: the settings object is rebuilt on
// every save of the account list, and sign-in itself rewrites the scheme and
// the account id, neither of which makes it a different mailbox.
assert.strictEqual(
  protocol.serverIdentity({ sessionUrl: " https://a.example/jmap/session ", username: "me",
    authScheme: "basic", accountId: "" }),
  protocol.serverIdentity({ sessionUrl: "https://a.example/jmap/session", username: "me",
    authScheme: "bearer", accountId: "t" }),
  "the scheme and the account id sign-in learns do not make a new server")
assert.notStrictEqual(
  protocol.serverIdentity({ sessionUrl: "https://a.example/jmap/session", username: "me" }),
  protocol.serverIdentity({ sessionUrl: "https://b.example/jmap/session", username: "me" }),
  "a different URL is a different server")
assert.notStrictEqual(
  protocol.serverIdentity({ sessionUrl: "https://a.example/jmap/session", username: "me" }),
  protocol.serverIdentity({ sessionUrl: "https://a.example/jmap/session", username: "you" }),
  "a different username is a different account on it")
assert.strictEqual(protocol.serverIdentity(null), protocol.serverIdentity({}),
  "no settings at all is one identity, not an error")

console.log("jmap threads ok")
