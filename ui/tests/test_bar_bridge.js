const assert = require("assert")
const { load, deepEqual } = require("./load")
const bridge = load("bar/Bridge.js")

const secret = "SYNTHETIC-SECRET-MUST-NOT-LEAVE-SERVICE"
const source = {
  ready: true, windowOpen: true, showBarIcon: false, unreadTotal: 7,
  barTooltip: "Ada · 7 unread messages", contentDirection: "Auto",
  auth: { accessToken: secret }, current: { clientSecret: secret },
  barMessages: Array.from({ length: 10 }, () => ({
    id: "mail-1", accountId: "ada@example.org", subject: "<b>Hello</b>", subjectDirection: "rtl",
    unread: true, from: { display: "Ada", token: secret },
    sourceLabel: "Ada · Inbox", receivedLabel: "Today", body: secret
  })),
  barEvents: Array.from({ length: 8 }, () => ({
    uid: "event-1", summary: "Meeting", sourceLabel: "Work",
    start: { ms: 1780000000000, privateData: secret },
    callUrl: "https://meet.google.com/abc-defg-hij", credentials: secret
  }))
}
let refreshes = 0
let calendarRefreshes = 0
let applied = null
const first = bridge.publish(() => source, values => { applied = values },
  () => { refreshes++ }, () => { calendarRefreshes++ })
const result = first.snapshot()
assert(!JSON.stringify(result).includes(secret), "credentials and full message bodies must not cross")
deepEqual(Object.keys(first).sort(), ["applySettings", "refresh", "refreshCalendarPreview", "snapshot"])
assert(Object.isFrozen(first))
assert.equal(result.barMessages.length, 3)
assert.equal(result.barEvents.length, 2)
assert.equal(result.barMessages[0].subject, "<b>Hello</b>")
assert.equal(result.barMessages[0].subjectDirection, "rtl", "reply subjects retain their resolved direction")
for (const direction of ["ltr", "rtl", "", null, { secret }, "x".repeat(4097)]) {
  const message = bridge.snapshot({ barMessages: [{ subjectDirection: direction }] }).barMessages[0]
  assert.equal(message.subjectDirection, direction === "rtl" || direction === "ltr" ? direction : "")
}
result.barMessages[0].from.display = "Changed"
result.barEvents[0].start.ms = 0
assert.equal(source.barMessages[0].from.display, "Ada", "snapshots cannot mutate the service")
assert.equal(source.barEvents[0].start.ms, 1780000000000)
first.applySettings({ refreshIntervalSec: 300 })
first.refresh()
first.refreshCalendarPreview()
assert.equal(applied.refreshIntervalSec, 300)
assert.equal(refreshes, 1)
assert.equal(calendarRefreshes, 1)

const second = bridge.publish(() => source, () => {}, () => {}, () => {})
bridge.clear(first)
assert.equal(bridge.current(), second, "retiring a service must not clear its replacement")
assert.equal(first.snapshot(), null)
first.refresh()
assert.equal(refreshes, 1, "stale callbacks must not reach a destroyed service")
bridge.clear(second)
assert.equal(bridge.current(), null)
assert.equal(second.snapshot(), null)

const bounded = bridge.snapshot({
  unreadTotal: Infinity,
  barMessages: [{ id: "x".repeat(4097), subject: "x".repeat(100000) }],
  barEvents: [{ start: { ms: NaN } }]
})
assert.equal(bounded.unreadTotal, 0)
assert.equal(bounded.barMessages[0].id, "", "oversized identifiers cannot be silently retargeted")
assert.equal(bounded.barMessages[0].subject.length, 4096)
assert.equal(bounded.barEvents.length, 0)
deepEqual(bridge.settings({ refreshIntervalSec: 300, showBarIcon: false,
  maxMessages: Infinity, defaultQuery: { secret }, credential: secret },
  { refreshIntervalSec: 120, showBarIcon: true, maxMessages: 25, defaultQuery: "in:inbox" }),
  { refreshIntervalSec: 300, showBarIcon: false })
console.log("bar bridge: bounded, detached previews and revocable actions pass")
