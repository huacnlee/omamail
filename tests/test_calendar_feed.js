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
assert.strictEqual(google[0].sourceId, "google:me")
assert.strictEqual(google[0].start.ms, Date.parse("2026-08-24T10:00:00+02:00"))
const googleUrl = feed.googleEventsUrl(Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1))
assert.ok(googleUrl.indexOf("https://www.googleapis.com/calendar/v3/calendars/primary/events?") === 0)

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
assert.ok(googleUrl.indexOf("singleEvents=true") > 0)
assert.ok(googleUrl.indexOf("orderBy=startTime") > 0)
assert.ok(googleUrl.indexOf("timeMin=2026-08-01T00%3A00%3A00.000Z") > 0)

console.log("test_calendar_feed.js ok")
