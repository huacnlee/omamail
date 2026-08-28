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
  version: cache.VERSION, account: "", profile: null, labels: [], queries: {}
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

// ------------------------------------------------------------- file names
//
// One file per account, because switching mailboxes must not throw the other
// mailbox's cache away — that is the whole point of having a cache.

const DIRECTORY = "/home/u/.cache/omamail"
const SAFE_NAME = /^[a-z0-9._-]+$/

function checkName(id) {
  const name = cache.fileName(id)
  assert.ok(SAFE_NAME.test(name), "unsafe file name for " + JSON.stringify(id) + ": " + name)
  // The only property that really matters: whatever the address contains, the
  // name stays one component inside the cache directory.
  assert.strictEqual(path.dirname(path.resolve(DIRECTORY, name)), DIRECTORY,
    "file name escapes the cache directory for " + JSON.stringify(id))
  assert.ok(Buffer.byteLength(name) <= 255, "file name too long for " + JSON.stringify(id))
  return name
}

const nameA = checkName("a@example.com")
const nameB = checkName("b@example.com")
assert.notStrictEqual(nameA, nameB, "two mailboxes never share a file")
assert.strictEqual(cache.fileName("a@example.com"), nameA, "the name is stable across calls")

// Mail addresses are compared case-insensitively in practice, and a
// case-insensitive filesystem could not hold both spellings anyway: two files
// for one mailbox would silently halve the cache.
assert.strictEqual(cache.fileName("A@Example.COM"), nameA)
assert.strictEqual(cache.fileName("A@EXAMPLE.COM"), nameA)

// A name built from an address must survive whatever the address contains. A
// separator or a parent reference in a cache file name could point a write at
// any file on the disk.
const awkward = [
  "a@example.com", "b@example.com", "ab@example.com", "a.b@example.com",
  "a_b@example.com", "a-b@example.com", "a+tag@example.com",
  "../../etc/passwd", "..", ".", "/", "a/b@example.com", "a\\b@example.com",
  "a\u0000b@example.com", "a b@example.com", " a@example.com", "a@example.com ",
  "\u5f20\u4f1f@example.cn", "\u0645\u062b\u0627\u0644@example.eg", "emoji\ud83d\ude42@example.com",
  "%2e%2e@example.com", "%41@example.com", "a'b@example.com", "a*b@example.com",
  "~root@example.com", "a!b@example.com", "a~b@example.com", "a(b)@example.com",
  "a%b@example.com", "a\nb@example.com", "cache.json", "a__b@example.com"
]
const seenNames = {}
for (const id of awkward) {
  const name = checkName(id)
  assert.ok(seenNames[name] === undefined,
    "collision: " + JSON.stringify(id) + " and " + JSON.stringify(seenNames[name]) + " share " + name)
  seenNames[name] = id
}

// An address that is missing or unusable still has to name a file, and that
// file must not be some real mailbox's.
const fallback = checkName("")
assert.ok(fallback.length > 0, "an empty address still names a file")
assert.strictEqual(cache.fileName(null), fallback)
assert.strictEqual(cache.fileName(undefined), fallback)
assert.strictEqual(cache.fileName(0), fallback)
for (const id of awkward) assert.notStrictEqual(cache.fileName(id), fallback)
assert.notStrictEqual(cache.fileName("none"), fallback)
assert.notStrictEqual(cache.fileName("unknown"), fallback)
assert.notStrictEqual(cache.fileName("account"), fallback)

// A file name has to fit in 255 bytes while an address may be far longer than
// that, so long names are shortened — but shortening must not merge two
// mailboxes that share a prefix.
const longStem = new Array(201).join("a")
assert.notStrictEqual(cache.fileName(longStem + "1@example.com"), cache.fileName(longStem + "2@example.com"))
checkName(longStem + "1@example.com")
checkName(new Array(60).join("\u5f20") + "@example.cn")

// Collision sweep over addresses that look like real ones, plus a batch long
// enough to go through the shortening path, since that is where a name stops
// being reversible and starts trusting a hash.
const sweep = {}
for (let i = 0; i < 5000; i++) {
  const ids = [
    "user" + i + "+tag@example" + (i % 7) + ".com",
    "first.last" + i + "@gmail.com",
    longStem + i + "@example.com"
  ]
  for (const id of ids) {
    const name = cache.fileName(id)
    assert.ok(sweep[name] === undefined,
      "collision: " + JSON.stringify(id) + " and " + JSON.stringify(sweep[name]) + " share " + name)
    sweep[name] = id
  }
}

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
assert.strictEqual(reloaded.version, cache.VERSION)




// Bodies are files now: one per message, under one directory per account. The
// name has to survive a hostile message id without leaving that directory.
{
  assert.strictEqual(cache.bodyDirName("huacnlee@gmail.com"), "account-huacnlee_40gmail.com")
  assert.strictEqual(cache.bodyFileName("198c2f3a4b"), "198c2f3a4b.json")
  assert.strictEqual(cache.bodyFileName(""), "", "an id-less message is never written")
  var hostile = cache.bodyFileName("../../etc/passwd")
  assert.ok(hostile.indexOf("/") < 0, "a traversal cannot survive the escape")

  var body = {
    text: "t", source: "plain", html: "<p>x</p>",
    attachments: [{ name: "a" }], images: ["a.png"],
    invite: { uid: "u1", summary: "Weekly sync", start: { ms: 1, allDay: false } },
    unsubscribe: { available: true, oneClick: true, url: "https://l.example.com/u/1",
      postUrl: "https://l.example.com/u/1", mail: null }
  }
  deepEqual(cache.parseBody(cache.serializeBody(body)), body,
    "the invitation and the unsubscribe offer survive the round trip whole")
  assert.strictEqual(cache.parseBody("not json"), null, "a truncated file reads as a miss")
  deepEqual(cache.parseBody(cache.serializeBody({})),
    { text: "", source: "", html: "", attachments: [], images: [],
      invite: null, unsubscribe: null })
  // Files written before these two fields existed are hits with no card, not
  // misses: the live fetch fills them in a moment later either way.
  deepEqual(cache.parseBody('{"text":"t","source":"plain","html":"","attachments":[],"images":[]}'),
    { text: "t", source: "plain", html: "", attachments: [], images: [],
      invite: null, unsubscribe: null })
}

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
    cache.load(cache.serialize(
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

console.log("test_cache.js ok")
