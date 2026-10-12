const assert = require("assert")
const { load, deepEqual } = require("./load")
const exchange = load("calendar/ExchangeEvents.js")
const sources = load("calendar/Sources.js")
const calendar = load("calendar/Calendar.js")
const accounts = load("account/Accounts.js")

const SOURCE = "exchange:exchange:alice@example.org"

function withZone(zone, work) {
  const previous = process.env.TZ
  process.env.TZ = zone
  try { work() } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

const timed = (extra) => Object.assign({
  id: "t1", uid: "u-t1", title: "Standup", location: "Room 4", organizer: "Ada Example",
  allDay: false, startMs: Date.UTC(2026, 9, 23, 7, 0), endMs: Date.UTC(2026, 9, 23, 7, 30),
  busy: "busy", private: false, changeKey: "key-1", editable: true, lock: ""
}, extra || {})

// The instants an Austrian server keeps for the day, which are not the day anywhere else.
const allDay = (title, startDate, endDate) => timed({ id: "d-" + startDate, title, allDay: true,
  startMs: Date.UTC(2026, 9, 4, 22, 0), endMs: Date.UTC(2026, 9, 5, 22, 0), startDate, endDate, busy: "free" })

const drawn = (rows) => exchange.eventsFromExchange({ events: rows }, SOURCE)

// ---------------------------------------------------------------- reading

{
  const [event] = drawn([timed()])
  assert.strictEqual(event.sourceId, SOURCE)
  assert.strictEqual(event.exchangeId, "t1")
  assert.strictEqual(event.exchangeKey, "key-1")
  assert.strictEqual(event.lockReason, "")
  assert.strictEqual(event.summary, "Standup")
  deepEqual(event.organizer, { email: "", displayName: "Ada Example" })
  assert.strictEqual(event.start.ms, Date.UTC(2026, 9, 23, 7, 0))
  assert.strictEqual(event.start.allDay, false)
  assert.strictEqual(event.transparency, "opaque")
  assert.strictEqual(event.description, "", "no body is read")
  const [masked] = drawn([timed({ title: "Private", location: "", organizer: "", private: true, busy: "free" })])
  assert.strictEqual(masked.isPrivate, true)
  assert.strictEqual(masked.organizer, null)
  assert.strictEqual(masked.transparency, "transparent")
  deepEqual(drawn([timed({ id: "z", title: "Zed", startMs: Date.UTC(2026, 9, 23, 9) }), timed({ id: "b", title: "Beta" }),
    timed({ id: "a", title: "Alpha" })]).map(e => e.summary), ["Alpha", "Beta", "Zed"], "by start, then title")
}

// An all-day event is midnight of its days on the clock of the screen it is drawn on, in every zone,
// whatever instants the server holds for it, the 25-hour day included.
for (const zone of ["UTC", "Europe/Vienna", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  withZone(zone, () => {
    const [holiday, long] = drawn([allDay("Holiday", "2026-10-05", "2026-10-06"), allDay("Long day", "2026-10-25", "2026-10-26")])
    for (const [event, d] of [[holiday, 5], [long, 25]]) {
      assert.strictEqual(event.start.ms, new Date(2026, 9, d).getTime(), zone + " " + event.summary)
      assert.strictEqual(event.end.ms, new Date(2026, 9, d + 1).getTime(), zone + " " + event.summary)
      assert.strictEqual(event.start.allDay, true)
    }
    const day = (d) => ({ startMs: new Date(2026, 9, d).getTime(), endMs: new Date(2026, 9, d + 1).getTime() })
    deepEqual([4, 5, 6].map(d => calendar.allDayEventsOnDay([holiday], day(d)).length), [0, 1, 0], zone)
  })
}
withZone("Europe/Vienna", () => {
  const [short, long] = drawn([allDay("Long day", "2026-10-25", "2026-10-26"), allDay("Short day", "2026-03-29", "2026-03-30")]) // by start
  assert.strictEqual((long.end.ms - long.start.ms) / 3600000, 25)
  assert.strictEqual((short.end.ms - short.start.ms) / 3600000, 23)
  assert.strictEqual(short.start.ms, new Date(2026, 2, 29).getTime())
})

{
  // What is not an event is left out; a day that is not a day is drawn from its instants.
  const rows = [timed({ id: "ok" }), timed({ id: "a", startMs: null }), timed({ id: "b", endMs: "soon" }), null, "text"]
  deepEqual(drawn(rows).map(e => e.exchangeId), ["ok"])
  for (const bad of [null, {}, { events: "x" }]) deepEqual(exchange.eventsFromExchange(bad, SOURCE), [])
  for (const [first, after] of [["2026-02-30", "2026-03-01"], ["2026-10-06", "2026-10-05"], ["2026-10-5", "2026-10-6"], [undefined, undefined]]) {
    const [event] = drawn([allDay("Odd", first, after)])
    assert.strictEqual(event.start.allDay, false, String(first))
    assert.strictEqual(event.start.ms, Date.UTC(2026, 9, 4, 22, 0))
  }
  // An occurrence and an exception at the same time are two events.
  const [one, two] = drawn([timed({ id: "o-1", uid: "series" }), timed({ id: "o-2", uid: "series" })])
  assert.notStrictEqual(calendar.eventKey(one), calendar.eventKey(two))
  assert.strictEqual(calendar.eventKey({ sourceId: "g", googleId: "x", exchangeId: "y" }), "g\nx")
}

for (const [code, sentence] of [["exchange_unauthorized", "Sign in to this mailbox again"],
  ["exchange_timeout", "The mail server took too long to answer"],
  ["backend_needs_update", "Update the mail backend to use this mailbox"],
  ["never_heard_of_it", "The mail server could not complete this request"]]) {
  assert.strictEqual(exchange.errorText({ code: -32000, message: code }), sentence, code)
}
assert.ok(!/SECRET/.test(exchange.errorText({ message: "SECRET text" })), "an unknown code is never echoed")
assert.strictEqual(exchange.backendReady({ backend: { ready: true, apiVersion: 8 } }), true)
for (const service of [null, { backend: { ready: true, apiVersion: 7 } }, { backend: { ready: false, apiVersion: 8 } }])
  assert.strictEqual(exchange.backendReady(service), false, JSON.stringify(service))

// ---------------------------------------------------------------- sources

const summaries = [
  { id: "exchange:alice@example.org", email: "alice@example.org", label: "Work", provider: "exchange", signedIn: true },
  { id: "exchange:bob@example.org", email: "bob@example.org", provider: "exchange", signedIn: false },
  { id: "one@gmail.com", email: "one@gmail.com", provider: "gmail", signedIn: true }
]

{
  const [source] = sources.withExchangeAccounts(sources.emptyList(), summaries).sources
  assert.strictEqual(sources.withExchangeAccounts(sources.emptyList(), summaries).sources.length, 1, "signed in only")
  assert.strictEqual(source.id, SOURCE)
  assert.strictEqual(source.name, "alice@example.org")
  assert.strictEqual(source.readOnly, false)
  assert.strictEqual(source.remindersEnabled, false)
  assert.strictEqual(sources.writable(source), true)
  assert.strictEqual(sources.comesWithAccount(source), true)
  assert.strictEqual(sources.providerLabel("exchange"), "Exchange")
  // What the owner chose is kept; a read-only stamp a file carries is not inherited.
  const saved = { sources: [{ id: SOURCE, kind: "exchange", accountId: "exchange:alice@example.org",
    enabled: false, readOnly: true, preferred: true, colorKey: "red" }] }
  const again = sources.withExchangeAccounts(saved, summaries).sources[0]
  deepEqual([again.enabled, again.colorKey, again.readOnly, again.preferred], [false, "red", false, false])
  // It is saved and read back as what it is, never as a CalDAV calendar.
  const back = sources.load(sources.serialize({ version: 1, sources: [source] })).sources[0]
  deepEqual([back.kind, back.readOnly], ["exchange", false])
  // A file may say less than the provider can do, never more.
  assert.strictEqual(sources.makeSource({ kind: "exchange", id: "x", readOnly: true }).readOnly, true)
  assert.strictEqual(sources.makeSource({ kind: "hey", id: "h", readOnly: false }).readOnly, true)
  assert.strictEqual(sources.validate({ kind: "exchange", accountId: "" }).ok, false)
  const all = sources.withAccounts(sources.emptyList(), summaries)
  deepEqual(all.sources.map(s => s.id), ["google:one@gmail.com", SOURCE])
  deepEqual(sources.forAccount(all, "exchange:alice@example.org").sources.map(s => s.id), [SOURCE])
  assert.strictEqual(sources.orphaned(source, summaries.slice(2)), true, "a removed mailbox leaves it to be tidied away")
}

assert.strictEqual(accounts.calendarProvider({ provider: "exchange", email: "ada@example.org" }), "exchange")
assert.strictEqual(accounts.calendarProvider({ provider: "jmap", email: "ada@example.org" }), "")

// ---------------------------------------------------------------- what may be written

const [source] = sources.withExchangeAccounts(sources.emptyList(), summaries).sources
for (const [code, sentence] of [["meeting", "Meeting with other people: change it in Outlook"],
  ["recurring", "Repeating event: change it in Outlook"], ["cancelled", "Cancelled meeting: change it in Outlook"],
  ["foreign", "Somebody else's invitation: change it in Outlook"],
  ["private", "Private event, shown without its details: change it in Outlook"],
  ["unknown", "This kind of event can only be changed in Outlook"], ["SECRET-WORD", "This kind of event can only be changed in Outlook"]]) {
  const [event] = drawn([timed({ editable: false, lock: code })])
  assert.strictEqual(event.lockReason, sentence, code)
  for (const operation of [undefined, "delete", "reschedule"])
    assert.strictEqual(calendar.writeRefusal(source, event, operation), sentence, code + " " + operation)
}
{
  // Nothing is writable unless the backend said so and gave the version to name.
  const old = timed()
  delete old.editable
  assert.notStrictEqual(drawn([old])[0].lockReason, "")
  const keyless = drawn([timed()])[0]
  keyless.exchangeKey = ""
  assert.strictEqual(calendar.writeRefusal(source, keyless), "Refresh this event before changing it")
  const plain = drawn([timed()])[0]
  for (const operation of [undefined, "delete", "reschedule"])
    assert.strictEqual(calendar.writeRefusal(source, plain, operation), "", "a plain appointment: " + operation)
  assert.strictEqual(calendar.writeRefusal(sources.makeSource({ kind: "exchange", id: "x", readOnly: true }), plain),
    "This calendar is read-only")
  assert.strictEqual(calendar.deleteRequest(plain, source, false).message, "This appointment moves to Deleted Items. Nobody is told.")
}

// ---------------------------------------------------------------- what a write sends

const day = (y, m, d) => new Date(y, m, d).getTime()
{
  const built = calendar.createEvent({ title: " Dentist ", location: "Room 4", description: "Bring the card",
    startMs: Date.UTC(2026, 9, 5, 7), endMs: Date.UTC(2026, 9, 5, 7, 30) }, 1)
  deepEqual(exchange.createParams("exchange:alice@example.org", built), { allDay: false,
    startMs: Date.UTC(2026, 9, 5, 7), endMs: Date.UTC(2026, 9, 5, 7, 30), accountId: "exchange:alice@example.org",
    title: "Dentist", location: "Room 4", notes: "Bring the card" })
  assert.ok(!("notes" in exchange.createParams("a", calendar.createEvent({ title: "x", startMs: 1000, endMs: 2000 }, 1))))
}
// An all-day appointment goes as its days, whatever the zone of the screen.
for (const zone of ["UTC", "Europe/Vienna", "America/New_York", "Pacific/Kiritimati"]) {
  withZone(zone, () => {
    const built = calendar.createEvent({ title: "Trip", startMs: day(2026, 9, 24), endMs: day(2026, 9, 28), allDay: true }, 1)
    const params = exchange.createParams("a", built)
    deepEqual([params.allDay, params.startDate, params.endDate, "startMs" in params], [true, "2026-10-24", "2026-10-28", false], zone)
  })
}
{
  const event = drawn([timed()])[0]
  const change = (fields) => exchange.updateParams("a", event, calendar.updateEvent(Object.assign({ title: "Standup",
    location: "Room 4", startMs: event.start.ms, endMs: event.end.ms, allDay: false }, fields), event, 1))
  // A title edit names neither the time nor the place: what the server holds is left alone.
  deepEqual(change({ title: "Renamed" }), { accountId: "a", id: "t1", changeKey: "key-1", title: "Renamed" })
  const moved = change({ startMs: event.start.ms + 1800000, endMs: event.end.ms + 1800000 })
  deepEqual([moved.allDay, moved.startMs, moved.endMs], [false, event.start.ms + 1800000, event.end.ms + 1800000])
  deepEqual(exchange.deleteParams("a", event), { accountId: "a", id: "t1", changeKey: "key-1" })
  // A drag of an appointment with no subject (drawn as a placeholder) and a tab in its place names the
  // time alone; an edit of the place leaves a title the form trimmed alone.
  const [bare] = drawn([timed({ title: "", location: "Room\t4" })])
  const dragged = exchange.updateParams("a", bare, calendar.updateEvent(calendar.rescheduleFields(bare,
    bare.start.ms + 1800000, bare.end.ms + 1800000), bare, 1))
  deepEqual(Object.keys(dragged).sort(), ["accountId", "allDay", "changeKey", "endMs", "id", "startMs"])
  const [spaced] = drawn([timed({ title: " Coaches Kalender " })])
  const placed = exchange.updateParams("a", spaced, calendar.updateEvent({ title: spaced.summary, location: "Room 5",
    startMs: spaced.start.ms, endMs: spaced.end.ms, allDay: false }, spaced, 1))
  deepEqual(placed, { accountId: "a", id: "t1", changeKey: "key-1", location: "Room 5" })
}
for (const [code, sentence] of [["exchange_calendar_conflict", "This event changed elsewhere. Refresh and try again."],
  ["exchange_calendar_locked", "This kind of event can only be changed in Outlook"],
  ["exchange_calendar_unconfirmed", "The server did not confirm the change. Look at your calendar before trying again"],
  ["exchange_message_not_found", "That event is no longer in your calendar. Refresh and look again"],
  ["Invalid params", "That event cannot be saved as it is. Check its title, dates and times"],
  ["exchange_timeout", "The mail server took too long to answer"]]) {
  assert.strictEqual(exchange.writeError({ code: -32000, message: code }), sentence, code)
}

console.log("calendar exchange: ok")
