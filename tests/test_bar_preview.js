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

console.log("test_bar_preview.js ok")
