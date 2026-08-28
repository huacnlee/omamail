const assert = require("assert")
const { load } = require("./load")
const feed = load("calendar/Calendar.js")

assert.strictEqual(feed.googleResponseError(403, JSON.stringify({
  error: {
    code: 403,
    message: "Google Calendar API has not been used in project 42 before or it is disabled.",
    errors: [{ reason: "accessNotConfigured" }],
    details: [{ reason: "SERVICE_DISABLED", metadata: {
      service: "calendar-json.googleapis.com"
    } }]
  }
})), "The Google Calendar API is not enabled for this Google Cloud project")
assert.strictEqual(feed.isGoogleCalendarApiDisabledError(
  "Google: The Google Calendar API is not enabled for this Google Cloud project"), true)
assert.strictEqual(feed.isGoogleCalendarApiDisabledError("Google: Network request failed"), false)
assert.strictEqual(feed.googleCalendarApiUrl(),
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com")
assert.strictEqual(feed.googleResponseError(401, ""),
  "Google rejected the calendar session. Sign in again")
assert.strictEqual(feed.googleResponseError(403, JSON.stringify({
  error: {
    message: "Request had insufficient authentication scopes.",
    errors: [{ reason: "insufficientPermissions" }]
  }
})), "Google Calendar permission is missing. Sign out and sign in again")
assert.strictEqual(feed.googleResponseError(500, "not json"),
  "Google Calendar returned HTTP 500")

const week = feed.weekDays(new Date(2026, 7, 23).getTime(), 1)
assert.strictEqual(week.length, 7)
assert.strictEqual(week[0].isoDate, "2026-08-17")
assert.strictEqual(week[6].isoDate, "2026-08-23")
assert.strictEqual(feed.weekTitle(week), "17–23 August 2026")

const splitWeek = feed.weekDays(new Date(2026, 7, 31).getTime(), 1)
assert.strictEqual(feed.weekTitle(splitWeek), "31 August–6 September 2026")
const timed = { start: { ms: new Date(2026, 7, 18, 9, 30).getTime() },
  end: { ms: new Date(2026, 7, 18, 11, 0).getTime() } }
assert.strictEqual(feed.eventTop(timed, week[1], 7, 64), 160)
assert.strictEqual(feed.eventHeight(timed, week[1], 64), 96)
assert.strictEqual(feed.eventTop({ start: { ms: week[1].startMs, allDay: true } },
  week[1], 7, 64), 0)

const quietRange = feed.weekHourRange([], week, 7, 19)
assert.deepStrictEqual(JSON.parse(JSON.stringify(quietRange)), { first: 7, last: 19 })
const earlyLateRange = feed.weekHourRange([
  { start: { ms: new Date(2026, 7, 17, 5, 30).getTime(), allDay: false },
    end: { ms: new Date(2026, 7, 17, 6, 15).getTime() } },
  { start: { ms: new Date(2026, 7, 18, 20, 0).getTime(), allDay: false },
    end: { ms: new Date(2026, 7, 18, 22, 30).getTime() } },
  { start: { ms: week[2].startMs, allDay: true }, end: { ms: week[2].endMs } }
], week, 7, 19)
assert.deepStrictEqual(JSON.parse(JSON.stringify(earlyLateRange)), { first: 5, last: 23 })
const overnightRange = feed.weekHourRange([{
  start: { ms: new Date(2026, 7, 17, 22, 0).getTime(), allDay: false },
  end: { ms: new Date(2026, 7, 18, 2, 0).getTime() }
}], week, 7, 19)
assert.deepStrictEqual(JSON.parse(JSON.stringify(overnightRange)), { first: 0, last: 24 },
  "an overnight event remains visible on both days")

const allDayEvents = [
  { uid: "a", start: { ms: week[0].startMs, allDay: true }, end: { ms: week[1].endMs } },
  { uid: "b", start: { ms: week[0].startMs, allDay: true }, end: { ms: week[0].endMs } },
  timed
]
assert.strictEqual(feed.allDayEventsOnDay(allDayEvents, week[0]).length, 2)
assert.strictEqual(feed.allDayEventsOnDay(allDayEvents, week[1]).length, 1)
assert.strictEqual(feed.maxAllDayEvents(allDayEvents, week), 2)
assert.strictEqual(feed.slotStart(week[1], 93, 7, 60, 30),
  new Date(2026, 7, 18, 8, 30).getTime(), "empty slots snap to half hours")

// The now line. Same geometry as eventTop, so 9:30 on a 7:00 grid at 64px an
// hour lands at 160 — but bounded at both ends and to the one day it belongs
// to, because the alternative is a line claiming a time it is not at.
const halfNine = new Date(2026, 7, 18, 9, 30).getTime()
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64, halfNine), 160)
assert.strictEqual(feed.nowOffset(week[2], 7, 19, 64, halfNine), -1,
  "the line belongs to one column, not to the week")
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64,
  new Date(2026, 7, 18, 6, 0).getTime()), -1, "before the first drawn hour")
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64,
  new Date(2026, 7, 18, 21, 0).getTime()), -1, "after the last drawn hour")
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64,
  new Date(2026, 7, 18, 7, 0).getTime()), 0, "the first hour itself is on the grid")
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64,
  new Date(2026, 7, 18, 19, 0).getTime()), 768, "and so is the last")
assert.strictEqual(feed.nowOffset(week[1], 7, 19, 64, NaN), -1)
assert.strictEqual(feed.nowOffset(null, 7, 19, 64, halfNine), -1)

// A day whose range weekHourRange widened to the whole day still places it.
assert.strictEqual(feed.nowOffset(week[1], 0, 24, 64,
  new Date(2026, 7, 18, 0, 30).getTime()), 32)

assert.strictEqual(feed.weekNowOffset(week, 7, 19, 64, halfNine), 160,
  "the rail finds today without being told which column it is")
assert.strictEqual(feed.weekNowOffset(splitWeek, 7, 19, 64, halfNine), -1,
  "another week on screen gets no line")
assert.strictEqual(feed.weekNowOffset([], 7, 19, 64, halfNine), -1)

// The grid names wall-clock hours, not elapsed hours since midnight. On a DST
// transition those differ by one, so the marker must still sit beside the time
// its label names.
const previousTimezone = process.env.TZ
process.env.TZ = "America/New_York"
const springDay = feed.weekDays(new Date(2026, 2, 8, 12).getTime(), 0)[0]
const springHalfThree = new Date(2026, 2, 8, 3, 30).getTime()
assert.strictEqual(feed.nowOffset(springDay, 0, 24, 60, springHalfThree), 210,
  "spring-forward now follows the wall-clock hour")
assert.strictEqual(feed.timeLabel(springHalfThree), "03:30",
  "the tested marker position and its label use the same local time")
const springEvent = {
  start: { ms: springHalfThree, allDay: false },
  end: { ms: new Date(2026, 2, 8, 4, 30).getTime(), allDay: false }
}
assert.strictEqual(feed.eventTop(springEvent, springDay, 0, 60), 210,
  "an event and now share the wall-clock grid")
assert.strictEqual(feed.eventHeight(springEvent, springDay, 60), 60,
  "event height follows the labeled wall-clock interval")
assert.strictEqual(feed.slotStart(springDay, 210, 0, 60, 30), springHalfThree,
  "clicking the 03:30 row creates an event at 03:30")
const springRange = feed.weekHourRange([springEvent], [springDay], 7, 19)
assert.strictEqual(springRange.first, 3,
  "a DST-day event widens the labeled hours it occupies")
assert.strictEqual(springRange.last, 19)
const autumnDay = feed.weekDays(new Date(2026, 10, 1, 12).getTime(), 0)[0]
assert.strictEqual(feed.nowOffset(autumnDay, 0, 24, 60,
  new Date(2026, 10, 1, 3, 30).getTime()), 210,
  "fall-back now follows the wall-clock hour")
if (previousTimezone === undefined) delete process.env.TZ
else process.env.TZ = previousTimezone

const report = feed.caldavReport(
  Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1))
assert.ok(report.indexOf('start="20260801T000000Z"') >= 0)
assert.ok(report.indexOf('end="20260901T000000Z"') >= 0)
assert.ok(report.indexOf("<c:calendar-data") >= 0)

const xml = [
  '<?xml version="1.0"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
  '<d:response><d:href>/cal/a.ics</d:href><d:propstat><d:prop>',
  '<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:A &amp; B\r\nDTSTART:20260824T080000Z\r\nDTEND:20260824T083000Z\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>',
  '</d:prop></d:propstat></d:response>',
  '<d:response><d:href>/cal/b.ics</d:href><d:propstat><d:prop>',
  '<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:All day\r\nDTSTART;VALUE=DATE:20260825\r\nDTEND;VALUE=DATE:20260826\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>',
  '</d:prop></d:propstat></d:response>',
  '</d:multistatus>'
].join("")

const parsed = feed.eventsFromCaldav(xml, "work")
assert.strictEqual(parsed.length, 2)
assert.strictEqual(parsed[0].summary, "A & B")
assert.strictEqual(parsed[0].sourceId, "work")
assert.strictEqual(parsed[0].href, "/cal/a.ics")
assert.strictEqual(parsed[1].start.allDay, true)

const recurringXml = [
  '<?xml version="1.0"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
  '<d:response><d:href>/cal/standup.ics</d:href><d:propstat><d:prop>',
  '<c:calendar-data>BEGIN:VCALENDAR\r\n',
  'BEGIN:VTIMEZONE\r\nTZID:Test/PlusTwo\r\n',
  'BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0200\r\n',
  'TZOFFSETTO:+0200\r\nEND:STANDARD\r\n',
  'END:VTIMEZONE\r\n',
  'BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Standup\r\n',
  'DTSTART;TZID=Test/PlusTwo:20240208T140000\r\n',
  'DTEND;TZID=Test/PlusTwo:20240208T150000\r\n',
  'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH\r\n',
  'EXDATE;TZID=Test/PlusTwo:20260903T140000\r\nEND:VEVENT\r\n',
  'BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Moved standup\r\n',
  'RECURRENCE-ID;TZID=Test/PlusTwo:20260917T140000\r\n',
  'DTSTART;TZID=Test/PlusTwo:20260918T140000\r\n',
  'DTEND;TZID=Test/PlusTwo:20260918T150000\r\n',
  'END:VEVENT\r\nEND:VCALENDAR</c:calendar-data>',
  '</d:prop></d:propstat></d:response></d:multistatus>'
].join("")
const recurringEvents = feed.eventsFromCaldav(recurringXml, "work",
  Date.UTC(2026, 7, 23), Date.UTC(2026, 8, 24))
assert.strictEqual(recurringEvents.length, 1)
assert.strictEqual(recurringEvents[0].summary, "Moved standup")
assert.strictEqual(recurringEvents[0].start.ms, Date.UTC(2026, 8, 18, 12, 0))
assert.strictEqual(recurringEvents[0].sourceId, "work")
assert.strictEqual(recurringEvents[0].href, "/cal/standup.ics")

const unresolvedRecurringXml = recurringXml
  .replace([
    "BEGIN:VTIMEZONE\r\nTZID:Test/PlusTwo\r\n",
    "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0200\r\n",
    "TZOFFSETTO:+0200\r\nEND:STANDARD\r\n",
    "END:VTIMEZONE\r\n"
  ].join(""), "")
  .replace(/Test\/PlusTwo/g, "Europe/Stockholm")
const unresolvedRecurringEvents = feed.eventsFromCaldav(unresolvedRecurringXml, "work",
  Date.UTC(2026, 7, 23), Date.UTC(2026, 8, 24))
assert.strictEqual(unresolvedRecurringEvents.length, 1)
assert.strictEqual(unresolvedRecurringEvents[0].start.ms, Date.UTC(2026, 8, 18, 14, 0),
  "an unresolved TZID uses the same placeholder on every machine")
assert.strictEqual(unresolvedRecurringEvents[0].start.resolved, false)

const utcRecurringXml = recurringXml
  .replace(/;TZID=Test\/PlusTwo/g, "")
  .replace(/20240208T140000/g, "20240208T130000Z")
  .replace(/20240208T150000/g, "20240208T140000Z")
  .replace(/20260903T140000/g, "20260903T130000Z")
  .replace(/20260917T140000/g, "20260917T130000Z")
  .replace(/20260918T140000/g, "20260918T120000Z")
  .replace(/20260918T150000/g, "20260918T130000Z")
const utcRecurringEvents = feed.eventsFromCaldav(utcRecurringXml, "work",
  Date.UTC(2026, 7, 23), Date.UTC(2026, 8, 24))
assert.strictEqual(utcRecurringEvents.length, 1)
assert.strictEqual(utcRecurringEvents[0].start.ms, Date.UTC(2026, 8, 18, 12, 0))

const days = feed.monthDays(2026, 7, 1)
assert.strictEqual(days.length, 42)
assert.strictEqual(days[0].isoDate, "2026-07-27")
assert.strictEqual(days[5].isoDate, "2026-08-01")
assert.strictEqual(days[41].isoDate, "2026-09-06")
assert.strictEqual(days[5].inMonth, true)
assert.strictEqual(days[0].inMonth, false)

const google = feed.eventsFromGoogle({ items: [{
  id: "g1",
  summary: "Google event",
  description: "Details",
  location: "Room 2",
  htmlLink: "https://calendar.google.com/event?eid=x",
  start: { dateTime: "2026-08-24T10:00:00+02:00" },
  end: { dateTime: "2026-08-24T11:00:00+02:00" },
  status: "confirmed"
}] }, "google:me")
assert.strictEqual(google.length, 1)
assert.strictEqual(google[0].uid, "g1")
assert.strictEqual(google[0].googleId, "g1",
  "the write URL needs the item id, separate from the iCalUID")
assert.strictEqual(google[0].sourceId, "google:me")
assert.strictEqual(google[0].start.ms, Date.parse("2026-08-24T10:00:00+02:00"))
const googleUrl = feed.googleEventsUrl(Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1))
assert.ok(googleUrl.indexOf("https://www.googleapis.com/calendar/v3/calendars/primary/events?") === 0)
assert.strictEqual(feed.googleEventUrl("g1_20260824T080000Z"),
  "https://www.googleapis.com/calendar/v3/calendars/primary/events/g1_20260824T080000Z")

const created = feed.createEvent({
  title: "Planning", startMs: Date.UTC(2026, 7, 24, 8, 0),
  endMs: Date.UTC(2026, 7, 24, 9, 0), location: "https://meet.example/room",
  description: "Weekly plan"
}, 1234)
assert.strictEqual(created.ok, true)
assert.strictEqual(created.uid, "omamail-1234")
assert.ok(created.ics.indexOf("SUMMARY:Planning") > 0)
assert.ok(created.ics.indexOf("DTSTART:20260824T080000Z") > 0)
assert.ok(created.ics.indexOf("LOCATION:https://meet.example/room") > 0)
assert.deepStrictEqual(JSON.parse(JSON.stringify(created.google)), {
  summary: "Planning", description: "Weekly plan", location: "https://meet.example/room",
  start: { dateTime: "2026-08-24T08:00:00.000Z" },
  end: { dateTime: "2026-08-24T09:00:00.000Z" }
})

const recurring = feed.createEvent({
  title: "Planning", startMs: Date.UTC(2026, 7, 24, 8, 0),
  endMs: Date.UTC(2026, 7, 24, 9, 0),
  recurrence: { enabled: true, frequency: "WEEKLY", interval: 2, count: 8 }
}, 1234)
assert.strictEqual(recurring.ok, true)
assert.ok(recurring.ics.indexOf("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8") > 0)
assert.strictEqual(JSON.stringify(recurring.google.recurrence),
  JSON.stringify(["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8"]))
assert.strictEqual(feed.createEvent({
  title: "Planning", startMs: 1, endMs: 2,
  recurrence: { enabled: true, frequency: "FORTNIGHTLY", interval: 1 }
}, 1).error, "Choose how often the event repeats")
assert.strictEqual(feed.createEvent({
  title: "Planning", startMs: 1, endMs: 2,
  recurrence: { enabled: true, frequency: "DAILY", interval: 0 }
}, 1).error, "Repeat interval must be at least 1")
assert.strictEqual(feed.recurrenceIntervalUnit("DAILY", 1), "day")
assert.strictEqual(feed.recurrenceIntervalUnit("WEEKLY", 2), "weeks")
assert.strictEqual(feed.recurrenceIntervalUnit("MONTHLY", "1"), "month")
assert.strictEqual(feed.recurrenceIntervalUnit("YEARLY", ""), "years")
assert.strictEqual(feed.createEvent({ title: "", startMs: 1, endMs: 2 }, 1).error,
  "Add an event title")
assert.strictEqual(feed.createEvent({ title: "x", startMs: 2, endMs: 1 }, 1).error,
  "End time must be after start time")

// An edit keeps the event's identity and tells every copy which write is new.
const updated = feed.updateEvent({
  title: "Planning, moved", startMs: Date.UTC(2026, 7, 24, 10, 0),
  endMs: Date.UTC(2026, 7, 24, 11, 0), location: "", description: "Weekly plan"
}, { uid: "omamail-1234", sequence: 0 }, 5678)
assert.strictEqual(updated.ok, true)
assert.strictEqual(updated.uid, "omamail-1234")
assert.ok(updated.ics.indexOf("UID:omamail-1234") > 0)
assert.ok(updated.ics.indexOf("SEQUENCE:1") > 0,
  "a rewrite bumps the sequence so older copies yield")
assert.ok(updated.ics.indexOf("DTSTART:20260824T100000Z") > 0)
assert.ok(updated.ics.indexOf("SUMMARY:Planning\\, moved") > 0,
  "ical text escapes what the field carries")
assert.ok(updated.ics.indexOf("RRULE") < 0,
  "recurrence is not editable here, so none is written")
assert.ok(updated.ics.indexOf("LOCATION") < 0, "a cleared field leaves the ICS")
assert.deepStrictEqual(JSON.parse(JSON.stringify(updated.google)), {
  summary: "Planning, moved", description: "Weekly plan", location: "",
  start: { dateTime: "2026-08-24T10:00:00.000Z" },
  end: { dateTime: "2026-08-24T11:00:00.000Z" }
})
assert.ok(!("recurrence" in updated.google),
  "omitting recurrence from the patch is what keeps the server's rule")
const bumpedAgain = feed.updateEvent({
  title: "x", startMs: 1, endMs: 2
}, { uid: "u", sequence: 4 }, 1)
assert.ok(bumpedAgain.ics.indexOf("SEQUENCE:5") > 0)
assert.strictEqual(feed.updateEvent({ title: "x", startMs: 1, endMs: 2 }, {}, 1).error,
  "The event has no identity to update")
assert.strictEqual(feed.updateEvent({ title: "", startMs: 1, endMs: 2 },
  { uid: "u" }, 1).error, "Add an event title")

// A CalDAV update replaces the whole resource, so fields this editor does not
// draw must survive a change to the ones it does. In particular, editing the
// title must not remove the organiser, attendees, alarms, timezone rules or a
// server extension from the VEVENT it puts back.
const preservedXml = [
  '<?xml version="1.0"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
  '<d:response><d:href>/cal/preserved.ics</d:href><d:propstat><d:prop>',
  '<c:calendar-data>BEGIN:VCALENDAR\r\nVERSION:2.0\r\n',
  'BEGIN:VTIMEZONE\r\nTZID:Custom/Office\r\nEND:VTIMEZONE\r\n',
  'BEGIN:VEVENT\r\nUID:preserved\r\nDTSTART:20260824T080000Z\r\n',
  'DTEND:20260824T090000Z\r\nSUMMARY:Before\r\n',
  'ORGANIZER:mailto:owner@example.com\r\nATTENDEE:mailto:guest@example.com\r\n',
  'X-SERVER-FIELD:keep-me\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\n',
  'TRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR',
  '</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>'
].join("")
const preservedEvent = feed.eventsFromCaldav(preservedXml, "work")[0]
const preservedUpdate = feed.updateEvent({
  title: "After", startMs: Date.UTC(2026, 7, 24, 8, 0),
  endMs: Date.UTC(2026, 7, 24, 9, 0), location: "", description: ""
}, preservedEvent, 5678)
assert.ok(preservedUpdate.ics.indexOf("SUMMARY:After") > 0)
assert.ok(preservedUpdate.ics.indexOf("SUMMARY:Before") < 0)
assert.ok(preservedUpdate.ics.indexOf("ORGANIZER:mailto:owner@example.com") > 0)
assert.ok(preservedUpdate.ics.indexOf("ATTENDEE:mailto:guest@example.com") > 0)
assert.ok(preservedUpdate.ics.indexOf("BEGIN:VALARM") > 0)
assert.ok(preservedUpdate.ics.indexOf("X-SERVER-FIELD:keep-me") > 0)
assert.ok(preservedUpdate.ics.indexOf("BEGIN:VTIMEZONE") > 0)

// A write is refused where it cannot really run: no source, a read-only
// calendar of any kind, or a recurring CalDAV event whose ICS state this
// client does not re-serialize. A recurring Google event edits fine — the
// server keeps the rule and one occurrence is patched.
assert.strictEqual(feed.writeRefusal(null, null), "Choose a calendar")
assert.strictEqual(feed.writeRefusal({ kind: "caldav", readOnly: true }, null),
  "This calendar is read-only")
assert.strictEqual(feed.writeRefusal({ kind: "google", readOnly: true }, null),
  "This calendar is read-only")
assert.strictEqual(feed.writeRefusal({ kind: "caldav" },
  { recurrenceRule: "FREQ=WEEKLY" }),
  "Recurring CalDAV events can only be changed in a full calendar client")
// A modified occurrence carries a RECURRENCE-ID but no RRULE — and its href
// is the series' shared file, so writing it would rewrite the whole series.
assert.strictEqual(feed.writeRefusal({ kind: "caldav" },
  { recurrenceIdMs: new Date(2026, 7, 24).getTime() }),
  "Recurring CalDAV events can only be changed in a full calendar client")
// A RECURRENCE-ID too malformed to parse leaves recurrenceIdMs at 0; the raw
// line still answers for it, because the href names the series' shared file.
assert.strictEqual(feed.writeRefusal({ kind: "caldav" },
  { recurrenceIdMs: 0, source: { recurrenceId: "RECURRENCE-ID:not-a-date" } }),
  "Recurring CalDAV events can only be changed in a full calendar client")
assert.strictEqual(feed.writeRefusal({ kind: "caldav" }, null), "")
assert.strictEqual(feed.writeRefusal({ kind: "google" }, null), "")
assert.strictEqual(feed.writeRefusal({ kind: "google" },
  { recurrenceRule: "FREQ=WEEKLY" }), "")

// An all-day event is edited as the dates it spans: the ICS keeps VALUE=DATE
// with an exclusive end, the Google body carries date and never dateTime, and
// a title-only change cannot turn it into midnight-to-midnight times.
const allDayUpdate = feed.updateEvent({
  title: "Conference, day one moved", startMs: new Date(2026, 7, 24).getTime(),
  endMs: new Date(2026, 7, 26).getTime()
}, { uid: "conf-1", sequence: 1,
  start: { ms: new Date(2026, 7, 24).getTime(), allDay: true } }, 0)
assert.ok(allDayUpdate.ok)
assert.ok(allDayUpdate.ics.indexOf("DTSTART;VALUE=DATE:20260824") > 0)
assert.ok(allDayUpdate.ics.indexOf("DTEND;VALUE=DATE:20260826") > 0,
  "the exclusive end stays the day after the last one shown")
assert.ok(allDayUpdate.ics.indexOf("SEQUENCE:2") > 0)
assert.ok(allDayUpdate.ics.indexOf("DTSTART:") < 0,
  "no date-time is written for an all-day event")
assert.deepStrictEqual(JSON.parse(JSON.stringify(allDayUpdate.google)), {
  summary: "Conference, day one moved", description: "", location: "",
  start: { date: "2026-08-24" }, end: { date: "2026-08-26" }
})

// The CalDAV write address is the event's own href, resolved the way the
// server wrote it: absolute, absolute-path, or relative to the collection.
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "https://dav.example/cal/me/a.ics" }),
  "https://dav.example/cal/me/a.ics")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "/cal/me/a.ics" }), "https://dav.example/cal/me/a.ics")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "a.ics" }), "https://dav.example/cal/me/a.ics")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me",
  { href: "", uid: "omamail-1" }), "https://dav.example/cal/me/omamail-1.ics")
assert.strictEqual(feed.caldavEventUrl("http://dav.example/cal/me/",
  { href: "/cal/me/a.ics" }), "", "CalDAV writes stay on HTTPS")
assert.strictEqual(feed.caldavEventUrl("", { href: "", uid: "" }), "")

// An absolute href is accepted only on the collection's own origin: anything
// else would send this calendar's credentials to a server that merely named
// an address in an answer.
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "https://other.example/cal/me/a.ics" }), "",
  "a cross-origin href is refused before credentials go anywhere")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "https://dav.example.evil.com/a.ics" }), "",
  "a host that merely starts with the source's is another origin")
assert.strictEqual(feed.caldavEventUrl("https://dav.example:8443/cal/me/",
  { href: "https://dav.example/cal/me/a.ics" }), "",
  "a different port is a different origin")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "https://dav.example:443/cal/me/a.ics" }),
  "https://dav.example:443/cal/me/a.ics",
  "the default port spelled out is still the same origin")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "//other.example/a.ics" }), "",
  "a scheme-relative href still names its own host")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "//dav.example/cal/me/a.ics" }),
  "https://dav.example/cal/me/a.ics",
  "a scheme-relative href on the same host resolves")

// Raw whitespace is refused: a URL's spaces arrive percent-encoded, and the
// resolved address becomes one quoted line of the transport's curl config,
// where a line break would write more options.
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "https://dav.example/cal/me/a.ics\noutput = elsewhere" }), "",
  "a line break in an absolute href is refused")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "/cal/me/a.ics\r\nnext" }), "", "same for a path href")
assert.strictEqual(feed.caldavEventUrl("https://dav.example/cal/me/",
  { href: "a b.ics" }), "", "a raw space is not a URL")
assert.ok(googleUrl.indexOf("singleEvents=true") > 0)
assert.ok(googleUrl.indexOf("orderBy=startTime") > 0)
assert.ok(googleUrl.indexOf("timeMin=2026-08-01T00%3A00%3A00.000Z") > 0)

console.log("test_calendar_feed.js ok")
