const assert = require("assert")
const { load } = require("./load")
const preview = load("bar/Preview.js")

const messages = preview.latestMessages([
  { id: "work", label: "Work", inbox: "Inbox", messages: [
    { id: "old", subject: "Older", date: new Date(100), fullTime: "Jan 1, 1970 01:00",
      unread: true, from: { display: "Ada" } },
    { id: "new", subject: "Newest", date: new Date(300), fullTime: "Jan 1, 1970 01:00",
      unread: true, from: { display: "Lin" } },
    { id: "read", subject: "Read and newer", date: new Date(400), unread: false,
      from: { display: "Pat" } }
  ] },
  { id: "home", label: "Personal", inbox: "Inbox", messages: [
    { id: "middle", subject: "Middle", date: new Date(200), fullTime: "Jan 1, 1970 01:00",
      unread: true, from: { display: "Sam" } },
    { id: "fourth", subject: "Fourth", date: new Date(50), unread: true,
      from: { display: "Jo" } }
  ] }
], 3)
assert.strictEqual(JSON.stringify(messages.map(function (item) { return item.id })),
  JSON.stringify(["new", "middle", "old"]))
assert.strictEqual(messages[0].sourceLabel, "Work · Inbox")
assert.strictEqual(messages[0].accountId, "work")
assert.strictEqual(messages[0].receivedLabel, "Jan 1, 1970 01:00")
assert.strictEqual(messages.some(function (item) { return item.id === "read" }), false)

const hydrated = preview.latestMessages([
  { id: "work", label: "Work", messages: [
    { id: "iso", unread: true, date: "2026-08-23T14:04:00Z" },
    { id: "epoch", unread: true, date: 2000000000000 }
  ] }
], 2)
assert.strictEqual(hydrated[0].id, "epoch")

const now = new Date(2026, 7, 23, 9, 0).getTime()
const events = preview.upcomingEvents([
  { uid: "past", summary: "Past", start: { ms: now - 1 }, sourceName: "Team" },
  { uid: "later", summary: "Later", start: { ms: now + 2000 }, sourceName: "Personal",
    location: "https://zoom.us/j/123" },
  { uid: "next", summary: "Next", start: { ms: now + 1000 }, sourceName: "Team",
    meetLink: "https://meet.google.com/abc" }
], now, 2)
assert.strictEqual(JSON.stringify(events.map(function (item) { return item.uid })),
  JSON.stringify(["next", "later"]))
assert.strictEqual(events[0].sourceLabel, "Team")
assert.strictEqual(events[0].callUrl, "https://meet.google.com/abc")
assert.strictEqual(events[1].callUrl, "https://zoom.us/j/123")
assert.strictEqual(preview.upcomingEvents([
  { uid: "lan", summary: "LAN", start: { ms: now + 1000 },
    location: "http://192.168.1.1/join" }
], now, 1)[0].callUrl, "")


// The range is the cache key. Starting it at the moment of the call made
// every refresh a miss, and the cache kept eight copies of the same month.
const morning = new Date(2026, 8, 15, 9, 41, 7, 250).getTime()
const evening = new Date(2026, 8, 15, 22, 3, 0, 0).getTime()
assert.strictEqual(JSON.stringify(preview.previewRange(morning)),
  JSON.stringify(preview.previewRange(evening)))
assert.strictEqual(preview.previewRange(morning)[0], new Date(2026, 8, 15).getTime())
assert.strictEqual(preview.previewRange(morning)[1], new Date(2026, 8, 15 + 31).getTime())
assert.notStrictEqual(preview.previewRange(morning)[0],
  preview.previewRange(new Date(2026, 8, 16, 0, 0, 1).getTime())[0])

console.log("test_bar_preview.js ok")
