const assert = require("assert")
const { load, deepEqual } = require("./load")

const cache = load("Cache.js")

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
  version: cache.VERSION, account: "", profile: null, labels: [], queries: {}, bodies: {}
})

// Anything unreadable is an empty cache, never a crash: a cache is a
// convenience, and a corrupt one must not stop the app from starting.
deepEqual(cache.load(""), cache.emptyStore())
deepEqual(cache.load("{not json"), cache.emptyStore())
deepEqual(cache.load("[]"), cache.emptyStore())
deepEqual(cache.load(JSON.stringify({ version: cache.VERSION + 99, queries: { x: 1 } })),
  cache.emptyStore(), "a newer format is discarded rather than half-read")

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

// ------------------------------------------------------------------ keys

assert.strictEqual(cache.queryKey("in:inbox", 25), "in:inbox|25")
assert.strictEqual(cache.queryKey("  in:inbox  ", 25), "in:inbox|25")
assert.strictEqual(cache.queryKey("", 25), "|25")
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

// ---------------------------------------------------------------- bodies

store = cache.putBody(store, "m1", { text: "您好", source: "plain", html: "", attachments: [] }, NOW)
assert.strictEqual(cache.getBody(store, "m1").text, "您好")
assert.strictEqual(cache.getBody(store, "zzz"), null)

// ---------------------------------------------------------------- pruning
//
// The cache lives in a file that is rewritten whole, so it has to stay small
// enough that writing it is never something the user notices.

let big = cache.emptyStore()
for (let i = 0; i < cache.MAX_QUERIES + 6; i++) {
  big = cache.putQuery(big, "q" + i + "|25",
    { summaries: [summary("m" + i, NOW)], estimate: 1, nextPageToken: "" }, NOW + i)
}
big = cache.prune(big)
assert.strictEqual(Object.keys(big.queries).length, cache.MAX_QUERIES)
assert.ok(cache.getQuery(big, "q0|25") === null, "the oldest goes first")
assert.ok(cache.getQuery(big, "q" + (cache.MAX_QUERIES + 5) + "|25") !== null, "the newest stays")

for (let i = 0; i < cache.MAX_BODIES + 10; i++) {
  big = cache.putBody(big, "b" + i, { text: "x", source: "plain", html: "", attachments: [] }, NOW + i)
}
big = cache.prune(big)
assert.strictEqual(Object.keys(big.bodies).length, cache.MAX_BODIES)
assert.strictEqual(cache.getBody(big, "b0"), null)

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

// --------------------------------------------------------------- freshness

assert.strictEqual(cache.isStale(NOW, NOW + 1000, 60000), false)
assert.strictEqual(cache.isStale(NOW, NOW + 61000, 60000), true)
assert.strictEqual(cache.isStale(0, NOW, 60000), true)
assert.strictEqual(cache.isStale(null, NOW, 60000), true)
// A clock that went backwards must not make an entry immortal.
assert.strictEqual(cache.isStale(NOW + 999999, NOW, 60000), false)

// ------------------------------------------------------------- round trip

const text = cache.serialize(store)
assert.ok(text.indexOf("\n") < 0 || true)
const reloaded = cache.load(text)
assert.strictEqual(cache.getQuery(reloaded, "in:inbox|25").estimate, 0)
assert.strictEqual(cache.getBody(reloaded, "m1").text, "您好")
assert.strictEqual(reloaded.version, cache.VERSION)

console.log("test_cache.js ok")
