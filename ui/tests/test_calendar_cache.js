const assert = require("assert")
const { load } = require("./load")
const cache = load("calendar/Cache.js")

const first = { uid: "one", sourceId: "google:a@example.com", start: { ms: 100 }, end: { ms: 200 } }
const second = { uid: "two", sourceId: "caldav:work", start: { ms: 300 }, end: { ms: 400 } }
let store = cache.putRange(cache.emptyStore(), "a@example.com", 0, 1000, [first, second], 10)

assert.deepStrictEqual(JSON.parse(JSON.stringify(
  cache.eventsFor(store, "a@example.com", 0, 1000, ["google:a@example.com"]))), [first])
assert.deepStrictEqual(JSON.parse(JSON.stringify(
  cache.eventsFor(store, "a@example.com", 1000, 2000, ["google:a@example.com"]))), [])
assert.deepStrictEqual(JSON.parse(JSON.stringify(
  cache.eventsFor(store, "b@example.com", 0, 1000, ["google:a@example.com"]))), [],
  "the same date range in another account must not reuse this account's cache")
assert.deepStrictEqual(JSON.parse(JSON.stringify(cache.load("not json"))),
  JSON.parse(JSON.stringify(cache.emptyStore())))
assert.deepStrictEqual(JSON.parse(JSON.stringify(cache.load(cache.serialize(store)))),
  JSON.parse(JSON.stringify(store)))

// Version 1 calendar ranges predate googleId. Restoring one would make every
// cached Google event look unwritable until a refresh happened to replace it,
// so the schema change invalidates those ranges instead of drawing a calendar
// whose Edit... and Delete... controls silently disappear.
const versionOne = JSON.stringify({ version: 1, ranges: {
  old: { events: [{ uid: "legacy", sourceId: "google:a@example.com" }] }
} })
assert.deepStrictEqual(JSON.parse(JSON.stringify(cache.load(versionOne))),
  JSON.parse(JSON.stringify(cache.emptyStore())),
  "a cache without Google item ids must be refreshed rather than restored")

for (let i = 0; i < 20; i++)
  store = cache.putRange(store, "a@example.com", i * 1000, (i + 1) * 1000, [first], i + 20)
assert.ok(Object.keys(store.ranges).length <= cache.MAX_RANGES)

console.log("test_calendar_cache.js ok")
