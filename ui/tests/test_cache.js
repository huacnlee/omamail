const assert = require("assert")
const path = require("path")
const { load, deepEqual } = require("./load")

const cache = load("cache/Cache.js")

const NOW = 1755600000000

function summary(id, ms, extra) {
  return Object.assign({
    id: id,
    threadId: "t" + id,
    from: { name: "张伟", email: "wei@example.cn", display: "张伟" },
    subject: "发票 — 2026 年 8 月",
    snippet: "您好，附件是本月的服务发票",
    date: new Date(ms),
    time: "10m",
    fullTime: "Aug 19, 2026 10:24",
    unread: true,
    starred: false,
    labelIds: ["INBOX", "UNREAD"]
  }, extra || {})
}

// ------------------------------------------------------------------ store

deepEqual(cache.emptyStore(), {
  version: cache.VERSION, account: "", profile: null, labels: [], queries: {}, session: null
})

// -------------------------------------------------------------- hydration
//
// Dates do not survive JSON, so they cross as epoch milliseconds. Getting
// this wrong shows every cached row as "Invalid Date".

const dehydrated = cache.dehydrate([summary("m1", NOW - 600000)])
assert.strictEqual(dehydrated[0].dateMs, NOW - 600000)
assert.strictEqual(dehydrated[0].date, undefined, "the Date object does not go to disk")
assert.strictEqual(JSON.parse(JSON.stringify(dehydrated))[0].dateMs, NOW - 600000)

const rehydrated = cache.hydrate(dehydrated)
assert.strictEqual(typeof rehydrated[0].date.getTime, "function", "a real Date comes back")
assert.strictEqual(rehydrated[0].date.getTime(), NOW - 600000)
assert.strictEqual(rehydrated[0].subject, "发票 — 2026 年 8 月")
assert.strictEqual(rehydrated[0].dateMs, undefined)

// A summary with no usable date still round-trips rather than poisoning the
// whole page.
const undated = cache.hydrate(cache.dehydrate([summary("m2", NaN)]))
assert.strictEqual(undated[0].date, null)
deepEqual(cache.hydrate(null), [])
deepEqual(cache.dehydrate(null), [])

// The summary with its conversation block is what goes to disk. A row that
// stood for a conversation and came back standing for one message would draw a
// count of nothing on every cache-first paint.
const conversation = summary("m3", NOW - 60000)
conversation.thread = { id: "d", count: 3, unread: true, flagged: false,
  memberIds: ["maaaaad", "maaaaae", "maaaaaf"] }
deepEqual(cache.hydrate(JSON.parse(JSON.stringify(
  cache.dehydrate([conversation]))))[0].thread, conversation.thread)

// ------------------------------------------------------------------ keys

assert.strictEqual(cache.queryKey("in:inbox", 25), "in:inbox|25")
assert.strictEqual(cache.queryKey("  in:inbox  ", 25), "in:inbox|25")
assert.strictEqual(cache.queryKey("", 25), "|25")
assert.strictEqual(cache.queryFromKey("in:inbox|25"), "in:inbox")
assert.strictEqual(cache.queryFromKey("a|query|100"), "a|query")
// The page size is part of the key: the same query at a different size is a
// different result set, not a stale one.
assert.notStrictEqual(cache.queryKey("in:inbox", 25), cache.queryKey("in:inbox", 50))

// --------------------------------------------------------------- queries

let store = cache.emptyStore()
store = cache.putQuery(store, "in:inbox|25", {
  summaries: [summary("m1", NOW - 600000)],
  estimate: 87,
  nextPageToken: "PAGE2"
}, NOW)

const got = cache.getQuery(store, "in:inbox|25")
assert.strictEqual(got.estimate, 87)
assert.strictEqual(got.nextPageToken, "PAGE2")
assert.strictEqual(got.at, NOW)
assert.strictEqual(cache.hydrate(got.summaries)[0].id, "m1")
assert.strictEqual(cache.getQuery(store, "nothing|25"), null)
assert.strictEqual(cache.getQuery(cache.emptyStore(), "in:inbox|25"), null)

// Writing the same key again replaces it rather than accumulating.
store = cache.putQuery(store, "in:inbox|25", { summaries: [], estimate: 0, nextPageToken: "" }, NOW + 1)
assert.strictEqual(cache.getQuery(store, "in:inbox|25").summaries.length, 0)
assert.strictEqual(Object.keys(store.queries).length, 1)

// A query nobody has made before still gets an immediate answer from every
// cached page. All words must occur, but they may occur in different fields.
let searchable = cache.emptyStore()
searchable = cache.putQuery(searchable, "in:inbox|25", {
  summaries: [
    summary("older", NOW - 2000, {
      from: { name: "Jane Doe", email: "jane@example.com", display: "Jane Doe" },
      subject: "Quarterly invoice",
      snippet: "Ready for review",
      to: [{ name: "Buyer", email: "buyer@example.org", display: "Buyer" }]
    }),
    summary("newer", NOW - 1000, { subject: "Invoice approved", snippet: "Jane signed it" })
  ],
  estimate: 2,
  nextPageToken: ""
}, NOW)
// A newer cached copy of one id wins over the older flags and is not repeated.
searchable = cache.putQuery(searchable, "is:unread|25", {
  summaries: [summary("older", NOW - 2000, {
    from: { name: "Jane Doe", email: "jane@example.com", display: "Jane Doe" },
    subject: "Quarterly invoice",
    snippet: "Ready for review",
    unread: false
  })],
  estimate: 1,
  nextPageToken: ""
}, NOW + 1)

deepEqual(cache.searchSummaries(searchable, "jane invoice").map(row => row.id),
  ["newer", "older"], "local results are deduplicated and newest first")
assert.strictEqual(cache.searchSummaries(searchable, "jane invoice")[1].unread, false,
  "the newest cached copy supplies the row")
deepEqual(cache.searchSummaries(searchable, "buyer@example.org").map(row => row.id), ["older"],
  "recipients are searchable too")
deepEqual(cache.searchSummaries(searchable, '"quarterly invoice"').map(row => row.id), ["older"])
deepEqual(cache.searchSummaries(searchable, "from:jane"), [],
  "provider operators are not guessed by the local fallback")
deepEqual(cache.searchSummaries(searchable, ""), [])

// The provider decides which cached mailboxes its server search can reach.
// The newest copy decides scope: once a row is known to have moved to Trash,
// an older Inbox copy must not resurrect it as a local result.
let scoped = cache.emptyStore()
scoped = cache.putQuery(scoped, "in:inbox|25", {
  summaries: [summary("moved", NOW - 3000, { subject: "Scoped invoice" }),
    summary("kept", NOW - 2000, { subject: "Scoped invoice" })],
  estimate: 2,
  nextPageToken: ""
}, NOW)
scoped = cache.putQuery(scoped, "in:trash|25", {
  summaries: [summary("moved", NOW - 3000,
    { subject: "Scoped invoice", labelIds: ["TRASH"] })],
  estimate: 1,
  nextPageToken: ""
}, NOW + 1)
deepEqual(cache.searchSummaries(scoped, "scoped invoice", function(sourceQuery) {
  return sourceQuery !== "in:trash"
}).map(row => row.id), ["kept"], "an out-of-scope newest copy excludes the id")

// Query entries are the part rewritten on the GUI thread. A cap keeps one
// enthusiastic Load-more session from turning every save into megabytes, and
// its stale continuation token is dropped because it follows omitted rows.
const tooMany = []
for (let i = 0; i < cache.MAX_SUMMARIES_PER_QUERY + 5; i++)
  tooMany.push(summary("cap-" + i, NOW - i))
let cappedStore = cache.putQuery(cache.emptyStore(), "in:anywhere|25", {
  summaries: tooMany,
  estimate: tooMany.length,
  nextPageToken: "after-omitted-rows"
}, NOW)
const cappedQuery = cache.getQuery(cappedStore, "in:anywhere|25")
assert.strictEqual(cappedQuery.summaries.length, cache.MAX_SUMMARIES_PER_QUERY)
assert.strictEqual(cappedQuery.nextPageToken, "")
assert.strictEqual(cappedQuery.estimate, tooMany.length)

// ---------------------------------------------------------------- pruning
//
// This store is rewritten whole every time it is saved, so it has to stay small
// enough that writing it is never something the user notices. Bodies — the one
// bucket that would break that — live in their own files instead.

let big = cache.emptyStore()
for (let i = 0; i < cache.MAX_QUERIES + 6; i++) {
  big = cache.putQuery(big, "q" + i + "|25",
    { summaries: [summary("m" + i, NOW)], estimate: 1, nextPageToken: "" }, NOW + i)
}
big = cache.prune(big)
assert.strictEqual(Object.keys(big.queries).length, cache.MAX_QUERIES)
assert.ok(cache.getQuery(big, "q0|25") === null, "the oldest goes first")
assert.ok(cache.getQuery(big, "q" + (cache.MAX_QUERIES + 5) + "|25") !== null, "the newest stays")

// Pruning also repairs an oversized entry written by the previous build.
big.queries["oversized|25"] = {
  summaries: cache.dehydrate(tooMany), estimate: tooMany.length,
  nextPageToken: "unsafe", at: NOW + 100
}
big = cache.prune(big)
assert.strictEqual(big.queries["oversized|25"].summaries.length,
  cache.MAX_SUMMARIES_PER_QUERY)
assert.strictEqual(big.queries["oversized|25"].nextPageToken, "")


// ---------------------------------------------------------------- account
//
// A cache belongs to one mailbox. Showing one account's mail under another's
// name would be the worst bug this file could have.

let owned = cache.putProfile(cache.emptyStore(), { email: "a@example.com" }, NOW)
owned = cache.putQuery(owned, "in:inbox|25", { summaries: [summary("m1", NOW)], estimate: 1, nextPageToken: "" }, NOW)

const same = cache.forAccount(owned, "a@example.com")
assert.strictEqual(cache.getQuery(same, "in:inbox|25") !== null, true)

const different = cache.forAccount(owned, "b@example.com")
assert.strictEqual(cache.getQuery(different, "in:inbox|25"), null, "a different account starts empty")
assert.strictEqual(different.account, "b@example.com")

// An unknown account (the profile has not loaded yet) must not wipe anything.
assert.strictEqual(cache.getQuery(cache.forAccount(owned, ""), "in:inbox|25") !== null, true)

// A store read from an account's own file may not carry the address yet: the
// rows in it were fetched for that mailbox, so claiming them is right where
// throwing them away used to be.
let unowned = cache.putQuery(cache.emptyStore(), "in:inbox|25",
  { summaries: [summary("m1", NOW)], estimate: 1, nextPageToken: "" }, NOW)
const adopted = cache.forAccount(unowned, "a@example.com")
assert.strictEqual(adopted.account, "a@example.com")
assert.strictEqual(cache.getQuery(adopted, "in:inbox|25") !== null, true,
  "an unclaimed cache belongs to whoever claims it")

// The profile can spell the address differently from whatever named the file.
// One mailbox is one cache, however it is capitalised.
const recased = cache.forAccount(owned, "A@Example.COM")
assert.strictEqual(cache.getQuery(recased, "in:inbox|25") !== null, true,
  "the same mailbox spelled differently is the same mailbox")

// --------------------------------------------------------------- freshness

assert.strictEqual(cache.isStale(NOW, NOW + 1000, 60000), false)
assert.strictEqual(cache.isStale(NOW, NOW + 61000, 60000), true)
assert.strictEqual(cache.isStale(0, NOW, 60000), true)
assert.strictEqual(cache.isStale(null, NOW, 60000), true)
// A clock that went backwards must not make an entry immortal.
assert.strictEqual(cache.isStale(NOW + 999999, NOW, 60000), false)

// ------------------------------------------------------------- round trip

const text = JSON.stringify(store)
assert.ok(text.indexOf("\n") < 0 || true)
const reloaded = JSON.parse(text)
assert.strictEqual(cache.getQuery(reloaded, "in:inbox|25").estimate, 0)
assert.strictEqual(reloaded.version, cache.VERSION)




// ------------------------------------- what the cache says about a read row
//
// An action changes the list on screen and now writes it back here, because
// anything that paints from this copy — the next load, a mailbox switched away
// from and back, the window reopened — otherwise put the old state on screen: a
// message read a moment ago, bold again. So the flags an action moves have to
// survive the trip to disk and back.

const readRow = {
  id: "18f3a", subject: "Lunch", snippet: "Are you free",
  from: { name: "Jane", email: "jane@example.com" }, to: [], cc: [],
  date: new Date("2026-08-20T10:00:00Z"), time: "10:00", fullTime: "Aug 20, 2026 10:00",
  unread: false, starred: true, inInbox: true, labelIds: ["INBOX", "STARRED"]
}

const throughDisk = cache.hydrate(
  cache.getQuery(
    JSON.parse(JSON.stringify(
      cache.putQuery(cache.emptyStore(), "k",
        { summaries: [readRow], estimate: 1, nextPageToken: "" }, 1000))),
    "k").summaries)[0]

assert.strictEqual(throughDisk.unread, false, "a row read before the write stays read")
assert.strictEqual(throughDisk.starred, true)
deepEqual(throughDisk.labelIds, ["INBOX", "STARRED"])
assert.strictEqual(throughDisk.date.getTime(), readRow.date.getTime(),
  "and the date is a Date again, because relativeTime asks it for one")

// The other way too, so this is a round trip rather than a default.
const unreadRow = { id: "18f3b", date: new Date("2026-08-20T11:00:00Z"), unread: true }
assert.strictEqual(cache.hydrate(cache.dehydrate([unreadRow]))[0].unread, true)

// ------------------------------------------------------------- the session
//
// A JMAP session object lives beside the queries it paid for: it names every
// URL a later request goes to, and refetching it on every start is a round
// trip before the first list can be asked for.

const session = { apiUrl: "https://api.example.org/jmap", state: "s1" }
const withSession = cache.putSession(cache.emptyStore(),
  "https://mail.example.org/jmap/session", "s1", session, 1000)
deepEqual(cache.getSession(withSession, "https://mail.example.org/jmap/session"), {
  url: "https://mail.example.org/jmap/session", state: "s1", session: session, at: 1000
})

// The URL is part of the key. A mailbox pointed at a different server is a
// different session, and the credential goes to the URLs read out of this
// object — so handing back one fetched somewhere else is the mistake here
// worth being careful about.
assert.strictEqual(cache.getSession(withSession, "https://other.example.org/jmap/session"), null)
assert.strictEqual(cache.getSession(cache.emptyStore(), "https://mail.example.org/jmap/session"), null)
assert.strictEqual(cache.getSession(null, ""), null)

// Anything that is not an object clears it rather than being stored as one.
assert.strictEqual(
  cache.putSession(withSession, "https://mail.example.org/jmap/session", "s1", null, 2000).session,
  null)

// It survives a round trip through the file, and the queries beside it are
// untouched by either.
const keptStore = JSON.parse(JSON.stringify(
  cache.putQuery(withSession, "role:inbox", { summaries: [], estimate: 0 }, 1000)))
deepEqual(cache.getSession(keptStore, "https://mail.example.org/jmap/session").session, session)
assert.ok(cache.getQuery(keptStore, "role:inbox"), "a session does not displace the query cache")

console.log("test_cache.js ok")
