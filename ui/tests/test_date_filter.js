const assert = require("assert")
const { load, deepEqual } = require("./load")

const filter = load("account/DateFilter.js")

// Saturday 4 October 2026, 15:30 local time.
const now = new Date(2026, 9, 4, 15, 30).getTime()
const seconds = function(y, m, d) { return Math.floor(new Date(y, m, d).getTime() / 1000) }

assert.strictEqual(filter.gmailTerms("today", now), "after:" + seconds(2026, 9, 4))
assert.strictEqual(filter.gmailTerms("yesterday", now),
  "after:" + seconds(2026, 9, 3) + " before:" + seconds(2026, 9, 4))
assert.strictEqual(filter.gmailTerms("7d", now), "after:" + seconds(2026, 8, 28))
assert.strictEqual(filter.gmailTerms("30d", now), "after:" + seconds(2026, 8, 5))
assert.strictEqual(filter.gmailTerms("", now), "")
assert.strictEqual(filter.gmailTerms("bogus", now), "")

// Day boundaries come from the calendar, not from 86400-second steps, so a
// daylight-saving change inside the range still lands on midnight.
const range = filter.gmailTerms("30d", new Date(2026, 10, 2, 12).getTime())
assert.strictEqual(new Date(Number(range.slice(6)) * 1000).getHours(), 0)

// Gmail narrows its query; every other provider keeps the query untouched.
assert.strictEqual(filter.apply("in:inbox", "today", "gmail", now),
  "in:inbox after:" + seconds(2026, 9, 4))
assert.strictEqual(filter.apply("in:inbox", "", "gmail", now), "in:inbox")
assert.strictEqual(filter.apply("in:inbox", "today", "imap", now), "in:inbox")
assert.strictEqual(filter.apply("", "7d", "gmail", now), "after:" + seconds(2026, 8, 28))

assert.ok(filter.isKnown("") && filter.isKnown("30d"))
assert.ok(!filter.isKnown("90d"))
deepEqual(filter.FILTERS.map(function(f) { return f.key }),
  ["", "today", "yesterday", "7d", "30d"])

console.log("test_date_filter.js ok")
