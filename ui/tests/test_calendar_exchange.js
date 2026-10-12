const assert = require("assert")
const { load, deepEqual } = require("./load")
const exchange = load("calendar/ExchangeEvents.js")
const sources = load("calendar/Sources.js")
const calendar = load("calendar/Calendar.js")
const accounts = load("account/Accounts.js")
const reminders = load("calendar/Reminders.js")

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
assert.strictEqual(exchange.backendReady({ backend: { ready: true, apiVersion: 9 } }), true)
for (const service of [null, { backend: { ready: true, apiVersion: 8 } }, { backend: { ready: false, apiVersion: 9 } }])
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
  assert.strictEqual(source.remindersEnabled, true, "the server's own reminders, until turned off")
  assert.strictEqual(sources.nativeCalendarFeatures(source), true)
  assert.strictEqual(sources.writable(source), true)
  assert.strictEqual(sources.comesWithAccount(source), true)
  assert.strictEqual(sources.providerLabel("exchange"), "Exchange")
  // What the owner chose is kept; a read-only stamp a file carries is not inherited.
  const saved = { sources: [{ id: SOURCE, kind: "exchange", accountId: "exchange:alice@example.org",
    enabled: false, readOnly: true, preferred: true, colorKey: "red" }] }
  const again = sources.withExchangeAccounts(saved, summaries).sources[0]
  deepEqual([again.enabled, again.colorKey, again.readOnly, again.preferred], [false, "red", false, false])
  // A source saved with its reminders off keeps them off.
  saved.sources[0].remindersEnabled = false
  assert.strictEqual(sources.withExchangeAccounts(saved, summaries).sources[0].remindersEnabled, false)
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
  // The calendar entry shows while a calendar is connected (#375): an Exchange mailbox alone brings one,
  // a signed-out one does not.
  assert.strictEqual(sources.hasNone(true, sources.withAccounts(sources.emptyList(), summaries.slice(0, 1))), false,
    "an Exchange mailbox alone keeps the calendar entry")
  assert.strictEqual(sources.hasNone(true, sources.withAccounts(sources.emptyList(), summaries.slice(1, 2))), true,
    "a signed-out Exchange mailbox brings no calendar")
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

// ---------------------------------------------------------------- reminders

{
  const [set, none, odd] = drawn([timed({ reminderMinutes: 15 }), timed({ id: "t2", reminderMinutes: null }),
    timed({ id: "t3", reminderMinutes: 1.5 })])
  deepEqual([set.reminderMinutes, set.reminders], [15, { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] }])
  deepEqual([none.reminderMinutes, none.reminders.overrides, odd.reminderMinutes], [-1, [], -1])
  // The desktop raises the server's own reminder, keyed by the item's uid and start (an answer gives it another
  // id), and none for an invitation the owner declined. An event that ends as it starts still ends after it.
  const list = { sources: [source] }
  const point = drawn([timed({ id: "p", uid: "u-p", reminderMinutes: 0, endMs: Date.UTC(2026, 9, 23, 7, 0) })])[0]
  const declined = drawn([timed({ id: "d", uid: "u-d", reminderMinutes: 5, response: "decline" })])[0]
  const found = reminders.candidates([set, none, point, declined], list)
  deepEqual(found.map(c => [c.eventId, c.due, c.end > c.start]), [["t1", set.start.ms - 15 * 60000, true],
    ["p", point.start.ms, true]])
  // The ledger skips a candidate whose end has passed: an at-start reminder of an event that ends as it
  // starts is still there for a poll half a minute late, as long as one on time may be.
  assert.strictEqual(found[1].end - found[1].due, 60000)
  const renamed = drawn([timed({ id: "t9", reminderMinutes: 15 })])
  assert.strictEqual(reminders.candidates(renamed, list)[0].occurrence, found[0].occurrence)
}
{
  const choice = (mode, minutes, editing) => exchange.reminderChoice({ reminderMode: mode, reminderMinutes: minutes }, editing)
  deepEqual([choice("custom", " 30 ", false), choice("custom", "40320", true)], [{ ok: true, minutes: 30 }, { ok: true, minutes: 40320 }])
  for (const bad of ["40321", "1e2", "0x10", "-5", "", "1.5"])
    assert.strictEqual(choice("custom", bad, false).ok, false, bad)
  deepEqual([choice("none", "", false).minutes, choice("default", "", false).minutes, choice("none", "", true).minutes,
    choice("preserve", "", true).minutes, choice("", "", true).minutes], [undefined, undefined, -1, undefined, undefined])
  deepEqual([0, 15, 60, 90, 1440, 2880, -1, null, "15"].map(exchange.reminderText),
    ["At the start", "15 minutes before", "1 hour before", "90 minutes before", "1 day before", "2 days before", "", "", ""])
  const built = calendar.createEvent({ title: "x", startMs: 1000, endMs: 2000 }, 1)
  built.reminderMinutes = 0
  assert.strictEqual(exchange.createParams("a", built).reminderMinutes, 0)
  const event = drawn([timed()])[0]
  const edit = calendar.updateEvent({ title: "Standup", location: "Room 4", startMs: event.start.ms, endMs: event.end.ms }, event, 1)
  assert.ok(!("reminderMinutes" in exchange.updateParams("a", event, edit)), "no choice leaves it")
  edit.reminderMinutes = -1
  assert.strictEqual(exchange.updateParams("a", event, edit).reminderMinutes, -1)
}

// ---------------------------------------------------------------- detail and answers

const invitation = () => drawn([timed({ id: "i1", uid: "u-i1", title: "Planning", location: "",
  editable: false, lock: "meeting", meeting: true, response: "none", kind: "single" })])[0]
const INVITED = "Only its organizer can change this meeting."
const detailOf = (extra) => Object.assign({ id: "i1", changeKey: "key-2", title: "Planning", location: "",
  allDay: false, startMs: Date.UTC(2026, 9, 23, 7, 0), endMs: Date.UTC(2026, 9, 23, 7, 30), notes: "Agenda",
  notesCut: true, organizer: { name: "Bob", email: "bob@example.org" }, response: "none", reminderMinutes: 10,
  attendees: [{ name: "Alice", email: "alice@example.org", kind: "required", response: "none", self: true },
    { name: "Cy", email: "cy@example.org", kind: "optional", response: "unknown", self: false },
    { name: "Room 4", email: "room@example.org", kind: "resource", response: "accept", self: false }],
  joinUrl: "https://meet.example.org/j/1", meeting: true, kind: "single", canRespond: true,
  editable: false, lock: "meeting" }, extra || {})
{
  const event = invitation()
  const merged = exchange.withDetail(event, detailOf())
  deepEqual([merged.description, merged.notesCut, merged.meetLink, merged.reminderMinutes, merged.myResponse],
    ["Agenda", true, "https://meet.example.org/j/1", 10, "none"])
  deepEqual(merged.organizer, { email: "bob@example.org", displayName: "Bob" })
  // The detail's own version is what the answer names; the list's stays what a write names.
  deepEqual([merged.canRespond, merged.answerKey, merged.exchangeKey, merged.stale], [true, "key-2", "key-1", undefined])
  deepEqual(calendar.attendeeRows(merged).map(r => [r.label, r.symbol, r.self, r.optional, r.resource]),
    [["Awaiting reply", "?", true, false, false], ["Invited", "·", false, true, false], ["Accepted", "✓", false, false, true]])
  assert.strictEqual(exchange.answerOf(merged.myResponse), "")
  assert.strictEqual(exchange.answerOf("tentative"), "tentative")
  // What changed since the list was drawn cannot be answered from it, and is said to be stale.
  for (const change of [{ title: "Moved" }, { location: "Room 9" }, { startMs: Date.UTC(2026, 9, 23, 8) },
    { endMs: Date.UTC(2026, 9, 23, 8) }, { allDay: true }]) {
    const stale = exchange.withDetail(event, detailOf(change))
    deepEqual([stale.stale, stale.canRespond], [true, false], JSON.stringify(change))
  }
  // A lock is the stricter of the two reads; a detail with no version cannot be answered.
  const plain = drawn([timed()])[0]
  assert.strictEqual(exchange.withDetail(plain, detailOf({ title: "Standup", location: "Room 4", canRespond: false,
    editable: false, lock: "meeting", meeting: false })).lockReason, "Meeting with other people: change it in Outlook")
  assert.strictEqual(exchange.withDetail(event, detailOf({ changeKey: "" })).canRespond, false)
  assert.strictEqual(exchange.withDetail(event, { title: 5 }), null)
  // An answer is sent with the detail's version, and only Yes and Maybe go without asking.
  deepEqual(exchange.respondParams("a", merged, "tentative"), { accountId: "a", id: "i1", changeKey: "key-2",
    response: "tentative", send: true })
  deepEqual([exchange.deleteKind(merged), exchange.deleteKind(plain), exchange.deleteKind(event)], ["decline", "appointment", ""])
  deepEqual(exchange.declineParams("a", merged), { accountId: "a", id: "i1", changeKey: "key-2", response: "decline",
    send: true, remove: true })
  const request = exchange.deleteRequest(merged)
  deepEqual([request.title, request.message, request.dismiss, request.focus, request.choices],
    ["Decline \"Planning\"?", "This tells the organizer you decline. The meeting is removed from your calendar.",
      "Keep meeting", "dismiss", [{ value: "all", label: "Decline and remove" }]])
  assert.strictEqual(exchange.deleteRequest(plain), null)
  // One event of a series is declined and stays where it is.
  const one = Object.assign({}, merged, { exchangeKind: "occurrence" })
  assert.ok(!("remove" in exchange.declineParams("a", one)))
  assert.strictEqual(exchange.deleteRequest(one).choices[0].label, "Decline")
  deepEqual([exchange.deleteRefusal(source, merged), exchange.deleteRefusal(source, plain),
    exchange.deleteRefusal(source, event), exchange.deleteRefusal(source, Object.assign({}, merged, { answerKey: "" }))],
    ["", "", INVITED, "Refresh this event before changing it"])
  assert.strictEqual(exchange.stableKey(merged), exchange.stableKey(Object.assign({}, merged, { exchangeId: "new" })))
  // An invitation with no subject is drawn as "Untitled event" and is still what the list drew.
  const untitled = drawn([timed({ id: "i2", title: "", location: "", editable: false, lock: "meeting" })])[0]
  const read = exchange.withDetail(untitled, detailOf({ id: "i2", title: "" }))
  deepEqual([untitled.summary, read.stale, read.canRespond], ["Untitled event", undefined, true])
  // A meeting its organizer cancelled says so; the organizer's own copy is not one somebody else cancelled.
  deepEqual([merged.cancelledByOrganizer, exchange.withDetail(event, detailOf({ cancelled: true, canRespond: false })).cancelledByOrganizer,
    exchange.withDetail(event, detailOf({ cancelled: true, response: "organizer" })).cancelledByOrganizer], [false, true, false])
  // A meeting somebody else sent says who may change it; the owner's own meeting and appointment keep their words.
  deepEqual([event.lockReason, merged.lockReason,
    drawn([timed({ editable: false, lock: "recurring", meeting: true, response: "accept" })])[0].lockReason,
    drawn([timed({ editable: false, lock: "meeting", meeting: true, response: "organizer" })])[0].lockReason,
    drawn([timed({ editable: false, lock: "recurring", meeting: false, response: "organizer" })])[0].lockReason],
    [INVITED, INVITED, INVITED, "Meeting with other people: change it in Outlook", "Repeating event: change it in Outlook"])
  // Cancelled: the owner's own answer is no longer shown, and the reminder only where it still comes (a meeting
  // the server flags cancelled is left out of the list the reminders are read from).
  const cancelled = exchange.withDetail(event, detailOf({ cancelled: true, canRespond: false,
    attendees: [{ name: "Alice", email: "alice@example.org", kind: "required", response: "accept", self: true },
      { name: "Room 4", email: "room@example.org", kind: "resource", response: "accept", self: false }] }))
  deepEqual(calendar.attendeeRows(cancelled).map(r => r.label), ["Invited", "Accepted"])
  deepEqual(calendar.attendeeRows(exchange.withDetail(event, detailOf({ attendees: [{ name: "Alice", email: "alice@example.org",
    kind: "required", response: "accept", self: true }] }))).map(r => r.label), ["Accepted"], "kept while it stands")
  deepEqual([cancelled.reminderMinutes, exchange.withDetail(event, detailOf({ cancelled: true, lock: "cancelled" })).reminderMinutes],
    [10, -1])
  // One event of the series was cancelled and this one does not say whether it is that one: a doubt, said as one.
  const doubt = exchange.withDetail(event, detailOf({ canRespond: false, unplacedCancellation: true }))
  deepEqual([doubt.cancelledByOrganizer, doubt.cancellationUnplaced, doubt.canRespond], [false, true, false])
  deepEqual(calendar.attendeeRows(doubt).map(r => r.label)[0], "Awaiting reply", "a doubt hides nothing")
  assert.strictEqual(exchange.withDetail(event, detailOf({ cancelled: true, unplacedCancellation: true })).cancellationUnplaced, false)
  // The organizer is named unless it would only name the owner, on an event nobody else is on.
  const own = exchange.withDetail(drawn([timed()])[0], detailOf({ title: "Standup", location: "Room 4", response: "organizer",
    meeting: false, attendees: [], organizer: { name: "Alice", email: "alice@example.org" }, editable: true, lock: "" }))
  const account = "exchange:alice@example.org"
  deepEqual([exchange.organizerShown(own, account), exchange.organizerShown(drawn([timed()])[0], account),
    exchange.organizerShown(Object.assign({}, own, { myResponse: "unknown" }), account),
    exchange.organizerShown(Object.assign({}, own, { myResponse: "unknown" }), "exchange:bob@example.org"),
    exchange.organizerShown(merged, account), exchange.organizerShown(event, account),
    exchange.organizerShown(Object.assign({}, own, { exchangeMeeting: true }), account)],
    [false, true, false, true, true, true, true])
}
for (const [code, sentence] of [["exchange_calendar_conflict", "This invitation changed. Refresh and answer again"],
  ["exchange_calendar_unconfirmed", "The server did not confirm your answer. Look at your calendar before answering again"],
  ["exchange_calendar_not_invitation", "That event is not an invitation you can answer here. Answer it in Outlook"],
  ["invalid_params", "That invitation cannot be answered as it is"],
  ["exchange_message_not_found", "That event is no longer in your calendar. Refresh and look again"]]) {
  assert.strictEqual(exchange.respondError({ code: -32000, message: code }), sentence, code)
}
assert.strictEqual(exchange.detailError({ code: -32601, message: "Method not found" }), "Update the mail backend to see this event's details")

console.log("calendar exchange: ok")
