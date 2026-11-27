// A line-for-line port of omarchy/ui/calendar/Calendar.js, typed with the
// shapes in types.ts; its behavior is unchanged from the Qt client's, and the
// tests next to it are the Qt tests ported. Server payloads stay unchecked
// until a rule here has read them.
import * as Ics from "../message/calendar";
import { formatDate, formatTime, type HourCycle } from "./format";
import type {
  AttendeeRow, CalendarDay, CaldavResponse, CalendarChoiceRow, CalendarDateGetter as DateGetter,
  CalendarEvent, CalendarEventSource, CalendarGroup, CalendarMoment, CalendarPerson,
  CalendarSource, CalendarWallTime, CheckedEventFields, DayBounds, DayLane, DeleteChoice,
  DeleteRequest, EditorDateRange, EventFields, EventWriteResult, GestureRange,
  GoogleErrorPayload, GoogleErrorReason, GoogleEventBody, GoogleEventItem, GoogleOptionsResult,
  GraphEmailAddress, GraphEventBody, GraphEventItem, GraphWirePerson, GraphWireTime,
  JsonObject, RecurrenceChoice, RecurrenceParts, RecurrenceRuleResult, SpanLayout,
  SpanSegment, TimedLayoutRow, UrlAuthority, ValidatedEventFields,
} from "./types";

// dayLanes' working row: a DayLane, with where it is drawn and the order it came in.
interface DayLaneItem extends DayLane {
  index: number;
  start: number;
  end: number;
}
export function googleResponseError(status: number, responseText?: string | null): string {
  var payload: GoogleErrorPayload | null = null
  try { payload = JSON.parse(String(responseText || "")) } catch (e) {}
  var error = payload && payload.error ? payload.error : null
  var detail = error ? String(error.message || "") : ""
  var reasons: GoogleErrorReason[] = error && Array.isArray(error.errors) ? error.errors : []
  var disabled = /Calendar API has not been used|Calendar API.*disabled/i.test(detail)
  var permissionMissing = /insufficient authentication scopes/i.test(detail)
  for (var i = 0; i < reasons.length; i++) {
    if (String(reasons[i].reason || "") === "accessNotConfigured") disabled = true
    if (String(reasons[i].reason || "") === "insufficientPermissions") permissionMissing = true
  }
  var details: GoogleErrorReason[] = error && Array.isArray(error.details) ? error.details : []
  for (var d = 0; d < details.length; d++) {
    if (String(details[d].reason || "") === "SERVICE_DISABLED") disabled = true
  }

  if (status === 401) return "Google rejected the calendar session. Sign in again"
  if (status === 403 && disabled)
    return "The Google Calendar API is not enabled for this Google Cloud project"
  if (status === 403 && permissionMissing)
    return "Google Calendar permission is missing. Sign out and sign in again"
  if (detail !== "") return detail
  return "Google Calendar returned HTTP " + status
}

export function isGoogleCalendarApiDisabledError(message?: string | null): boolean {
  return /Google Calendar API is not enabled/i.test(String(message || ""))
}

export function googleCalendarApiUrl(): string {
  return "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
}

export function two(value: number | string): string {
  var number = Math.floor(Number(value) || 0)
  return (number < 10 ? "0" : "") + number
}

export function utcStamp(ms: number): string {
  var date = new Date(Number(ms) || 0)
  return date.getUTCFullYear() + two(date.getUTCMonth() + 1) + two(date.getUTCDate())
    + "T" + two(date.getUTCHours()) + two(date.getUTCMinutes())
    + two(date.getUTCSeconds()) + "Z"
}

export function caldavReport(startMs: number, endMs: number): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + '<c:time-range start="' + utcStamp(startMs) + '" end="' + utcStamp(endMs) + '"/>'
    + '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
}

export function decodeXml(value?: string | null): string {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function(_whole, digits) {
      return String.fromCharCode(Number(digits))
    })
    .replace(/&#x([0-9a-f]+);/gi, function(_whole, digits) {
      return String.fromCharCode(parseInt(digits, 16))
    })
    .replace(/&amp;/g, "&")
}

// An element's text, with both of the encodings a server is allowed to use.
// RFC 4791 section 9.6 lets a calendar object arrive entity-escaped or inside a
// CDATA section, and servers send the second: DAViCal wraps every object, and
// this reached the project from an iCloud account whose calendars read empty.
// Unwrapped, the payload begins `<![CDATA[BEGIN:VCALENDAR`, which is not a
// property line, so the parse finds no VCALENDAR root and there are no events.
//
// The two encodings cannot be undone in one pass. A CDATA section's content is
// already literal — `&amp;` inside one is those five characters, and a summary
// of "Q&amp;A" would come out "Q&A" if the entity pass ran over it. So the
// markers are cut and the entity pass runs only on the text between sections,
// which is where the entities an escaping server wrote actually are.
export function decodeXmlText(value?: string | null): string {
  var text = String(value || "")
  var out = ""
  var index = 0
  while (true) {
    // Case-sensitive: `<![cdata[` is ordinary text in XML, not a section.
    var start = text.indexOf("<![CDATA[", index)
    if (start < 0) break
    var end = text.indexOf("]]>", start + 9)
    if (end < 0) break
    out += decodeXml(text.substring(index, start)) + text.substring(start + 9, end)
    index = end + 3
  }
  return out + decodeXml(text.substring(index))
}

export function tagText(block: string | null | undefined, localName: string): string {
  var name = String(localName || "").replace(/[^A-Za-z0-9_-]/g, "")
  if (name === "") return ""
  var pattern = new RegExp("<(?:[A-Za-z0-9_-]+:)?" + name
    + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?" + name + ">", "i")
  var match = pattern.exec(String(block || ""))
  return match ? decodeXmlText(match[1]) : ""
}

export function caldavResponses(xml?: string | null): CaldavResponse[] {
  var input = String(xml || "")
  var pattern = /<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/gi
  var out: CaldavResponse[] = []
  var match
  while ((match = pattern.exec(input)) !== null) {
    var data = tagText(match[1], "calendar-data")
    if (data !== "") out.push({ href: tagText(match[1], "href"), data: data })
  }
  return out
}

export function recurrenceParts(value?: string | null): RecurrenceParts {
  var out: RecurrenceParts = {}
  var pieces = String(value || "").split(";")
  for (var i = 0; i < pieces.length; i++) {
    var equals = pieces[i].indexOf("=")
    if (equals < 0) continue
    out[pieces[i].substring(0, equals).toUpperCase().trim()] =
      pieces[i].substring(equals + 1).trim()
  }
  return out
}

export var RECURRENCE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

export function datePart(date: Date, localName: DateGetter, utcName: DateGetter, utc: boolean): number {
  return utc ? date[utcName]() : date[localName]()
}

export function calendarDayNumber(date: Date, utc: boolean): number {
  return Math.floor(Date.UTC(
    datePart(date, "getFullYear", "getUTCFullYear", utc),
    datePart(date, "getMonth", "getUTCMonth", utc),
    datePart(date, "getDate", "getUTCDate", utc)) / 86400000)
}

export function weekNumber(date: Date, utc: boolean): number {
  var day = calendarDayNumber(date, utc)
  var weekday = datePart(date, "getDay", "getUTCDay", utc)
  return Math.floor((day - ((weekday + 6) % 7)) / 7)
}

export function nthWeekday(date: Date, utc: boolean): number {
  return Math.floor((datePart(date, "getDate", "getUTCDate", utc) - 1) / 7) + 1
}

export function lastWeekday(date: Date, utc: boolean): number {
  var year = datePart(date, "getFullYear", "getUTCFullYear", utc)
  var month = datePart(date, "getMonth", "getUTCMonth", utc)
  var last = utc ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    : new Date(year, month + 1, 0).getDate()
  return -Math.floor((last - datePart(date, "getDate", "getUTCDate", utc)) / 7) - 1
}

export function matchesByDay(date: Date, raw: string, utc: boolean): boolean {
  var values = String(raw || "").split(",")
  for (var i = 0; i < values.length; i++) {
    var match = values[i].trim().toUpperCase().match(/^([+-]?\d+)?([A-Z]{2})$/)
    if (!match || RECURRENCE_DAYS[datePart(date, "getDay", "getUTCDay", utc)] !== match[2])
      continue
    if (!match[1]) return true
    var ordinal = Number(match[1])
    if (ordinal > 0 && nthWeekday(date, utc) === ordinal) return true
    if (ordinal < 0 && lastWeekday(date, utc) === ordinal) return true
  }
  return false
}

export function matchesNumberList(value: number, raw: string): boolean {
  var values = String(raw || "").split(",")
  for (var i = 0; i < values.length; i++) {
    if (Number(values[i]) === Number(value)) return true
  }
  return false
}

export function recurrenceUntil(value?: string | null): number {
  var text = String(value || "").trim()
  var match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!match) return 0
  if (match[7]) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0))
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)).getTime()
}

export function recurrenceStarts(event: CalendarEvent | null | undefined, rangeStart?: number, rangeEnd?: number): number[] {
  if (!event || !event.start || !event.recurrenceRule) return []
  var parts = recurrenceParts(event.recurrenceRule)
  var frequency = String(parts.FREQ || "").toUpperCase()
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(frequency) < 0) return []
  var interval = Math.max(1, Math.floor(Number(parts.INTERVAL) || 1))
  var countLimit = Math.max(0, Math.floor(Number(parts.COUNT) || 0))
  var until = recurrenceUntil(parts.UNTIL)
  var tzid = String(event.start.tzid || "")
  var source: CalendarEventSource = event.source || {}
  var wallFields: CalendarWallTime | null = tzid !== "" ? Ics.dateFieldsFromLine(source.dtstart) : null
  var zoned = !!wallFields && !wallFields.dateOnly
  var base = zoned
    ? new Date(Date.UTC(wallFields!.year, wallFields!.month - 1, wallFields!.day,
        wallFields!.hour, wallFields!.minute, wallFields!.second))
    : new Date(Number(event.start.ms))
  var cursor = new Date(base.getTime())
  var utc = zoned
    || !!(event.source && /Z\s*$/i.test(String(event.source.dtstart || "")))
  var out: number[] = []
  var count = 0
  var rangeLimit = Number(rangeEnd) || base.getTime()
  var limit = zoned ? rangeLimit + 86400000
    : Math.min(rangeLimit, until > 0 ? until + 1 : rangeLimit)

  // Every test below is a delta from `base`, so the walk can begin on any day
  // and still match the same ones. Begin it two days short of the range rather
  // than at DTSTART: the two days cover the zone offset a zoned cursor carries
  // (no zone sits more than 14 hours from UTC), and a rule from years back no longer pays for every day since it started
  // on each refresh — nor runs into the ceiling below before reaching the
  // range at all. COUNT is the one rule that counts from the start, so it is
  // still walked from there.
  var from = Number(rangeStart) || 0
  if (countLimit === 0 && from > 0) {
    var skipped = Math.floor((from - 2 * 86400000 - base.getTime()) / 86400000)
    if (skipped > 0) {
      if (utc) cursor.setUTCDate(cursor.getUTCDate() + skipped)
      else cursor.setDate(cursor.getDate() + skipped)
    }
  }

  for (var scanned = 0; scanned < 10000 && cursor.getTime() < limit; scanned++) {
    var cursorYear = datePart(cursor, "getFullYear", "getUTCFullYear", utc)
    var baseYear = datePart(base, "getFullYear", "getUTCFullYear", utc)
    var cursorMonth = datePart(cursor, "getMonth", "getUTCMonth", utc)
    var baseMonth = datePart(base, "getMonth", "getUTCMonth", utc)
    var cursorDate = datePart(cursor, "getDate", "getUTCDate", utc)
    var baseDate = datePart(base, "getDate", "getUTCDate", utc)
    var dayDelta = calendarDayNumber(cursor, utc) - calendarDayNumber(base, utc)
    var monthDelta = (cursorYear - baseYear) * 12 + cursorMonth - baseMonth
    var yearDelta = cursorYear - baseYear
    var matches = false
    if (frequency === "DAILY") {
      matches = dayDelta >= 0 && dayDelta % interval === 0
    } else if (frequency === "WEEKLY") {
      var weekdayMatch = parts.BYDAY
        ? matchesByDay(cursor, parts.BYDAY, utc)
        : datePart(cursor, "getDay", "getUTCDay", utc)
          === datePart(base, "getDay", "getUTCDay", utc)
      matches = weekdayMatch && (weekNumber(cursor, utc) - weekNumber(base, utc)) % interval === 0
    } else if (frequency === "MONTHLY") {
      var monthDayMatch = parts.BYMONTHDAY
        ? matchesNumberList(cursorDate, parts.BYMONTHDAY)
        : (parts.BYDAY ? matchesByDay(cursor, parts.BYDAY, utc)
          : cursorDate === baseDate)
      matches = monthDelta >= 0 && monthDelta % interval === 0 && monthDayMatch
    } else if (frequency === "YEARLY") {
      var monthMatch = parts.BYMONTH
        ? matchesNumberList(cursorMonth + 1, parts.BYMONTH)
        : cursorMonth === baseMonth
      var yearDayMatch = parts.BYMONTHDAY
        ? matchesNumberList(cursorDate, parts.BYMONTHDAY)
        : (parts.BYDAY ? matchesByDay(cursor, parts.BYDAY, utc)
          : cursorDate === baseDate)
      matches = yearDelta >= 0 && yearDelta % interval === 0 && monthMatch && yearDayMatch
    }
    var occurrenceMs = cursor.getTime()
    if (zoned) {
      occurrenceMs = Ics.timeInZone({
        year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(), hour: cursor.getUTCHours(),
        minute: cursor.getUTCMinutes(), second: cursor.getUTCSeconds()
      }, tzid, source.timezones).ms
    }
    if (matches && occurrenceMs >= Number(event.start.ms)) {
      count++
      if (countLimit > 0 && count > countLimit) break
      if (!until || occurrenceMs <= until) out.push(occurrenceMs)
    }
    if (until && occurrenceMs > until) break
    if (utc) cursor.setUTCDate(cursor.getUTCDate() + 1)
    else cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

export function eventInRange(event: CalendarEvent | null | undefined, startMs: number, endMs: number): boolean {
  if (!event || !event.start) return false
  var start = Number(event.start.ms)
  var end = event.end ? Number(event.end.ms) : start + 1
  return start < Number(endMs) && end > Number(startMs)
}

export function occurrenceOf(event: CalendarEvent, startMs: number): CalendarEvent {
  var copy = {} as CalendarEvent
  for (var key in event) copy[key] = event[key]
  var delta = Number(startMs) - Number(event.start.ms)
  copy.start = { ms: Number(startMs), allDay: event.start.allDay,
    tzid: event.start.tzid, resolved: event.start.resolved }
  copy.end = (event.end ? { ms: Number(event.end.ms) + delta, allDay: event.end.allDay,
    tzid: event.end.tzid, resolved: event.end.resolved } : null) as CalendarMoment
  copy.recurrenceIdMs = Number(startMs)
  return copy
}

export function expandRecurringEvents(events: CalendarEvent[] | null | undefined, startMs: number, endMs: number): CalendarEvent[] {
  var values = Array.isArray(events) ? events : []
  var masters: CalendarEvent[] = []
  var overrides: { [key: string]: CalendarEvent } = {}
  var standalone: CalendarEvent[] = []
  for (var i = 0; i < values.length; i++) {
    var item = values[i]
    if (!item) continue
    if (item.recurrenceIdMs) {
      overrides[String(item.uid) + "\n" + Number(item.recurrenceIdMs)] = item
    } else if (item.recurrenceRule) masters.push(item)
    else standalone.push(item)
  }
  var out: CalendarEvent[] = []
  var usedOverrides: { [key: string]: boolean } = {}
  for (var s = 0; s < standalone.length; s++) {
    if (standalone[s].status !== "CANCELLED" && eventInRange(standalone[s], startMs, endMs))
      out.push(standalone[s])
  }
  for (var m = 0; m < masters.length; m++) {
    var master = masters[m]
    var excluded: { [ms: number]: boolean } = {}
    var exclusions = Array.isArray(master.excludedMs) ? master.excludedMs : []
    for (var x = 0; x < exclusions.length; x++) excluded[Number(exclusions[x])] = true
    var starts = recurrenceStarts(master, startMs, endMs)
    for (var o = 0; o < starts.length; o++) {
      var key = String(master.uid) + "\n" + Number(starts[o])
      var replacement = overrides[key]
      if (replacement) {
        usedOverrides[key] = true
        if (replacement.status !== "CANCELLED" && eventInRange(replacement, startMs, endMs))
          out.push(replacement)
      } else if (!excluded[Number(starts[o])]) {
        var occurrence = occurrenceOf(master, starts[o])
        if (eventInRange(occurrence, startMs, endMs)) out.push(occurrence)
      }
    }
  }
  for (var overrideKey in overrides) {
    var detached = overrides[overrideKey]
    if (!usedOverrides[overrideKey] && detached.status !== "CANCELLED"
        && eventInRange(detached, startMs, endMs)) out.push(detached)
  }
  out.sort(compareEvents)
  return out
}

export function eventsFromCaldav(xml: string | null | undefined, sourceId?: string | null, rangeStart?: number, rangeEnd?: number): CalendarEvent[] {
  var responses = caldavResponses(xml)
  var out: CalendarEvent[] = []
  for (var i = 0; i < responses.length; i++) {
    var events: CalendarEvent[] = Ics.eventsFrom(responses[i].data)
    for (var j = 0; j < events.length; j++) {
      events[j].sourceId = String(sourceId || "")
      events[j].href = responses[i].href
      // A CalDAV update replaces this entire resource. Keep the source so the
      // writer can change the fields it owns without dropping everything it
      // does not model, such as alarms, attendees and server extensions.
      events[j].calendarData = responses[i].data
      out.push(events[j])
    }
  }
  if (Number(rangeStart) && Number(rangeEnd))
    return expandRecurringEvents(out, Number(rangeStart), Number(rangeEnd))
  out = out.filter(function(event) { return event.status !== "CANCELLED" })
  out.sort(compareEvents)
  return out
}

export function googleMoment(value: unknown, dateOnly: boolean): CalendarMoment | null {
  var text = String(value || "")
  if (text === "") return null
  var ms = dateOnly
    ? new Date(Number(text.substring(0, 4)), Number(text.substring(5, 7)) - 1,
        Number(text.substring(8, 10))).getTime()
    : Date.parse(text)
  if (!isFinite(ms)) return null
  return { ms: ms, allDay: dateOnly, tzid: "", resolved: true }
}

export function eventsFromGoogle(payload: JsonObject | null | undefined, sourceId?: string | null): CalendarEvent[] {
  var items: GoogleEventItem[] = payload && Array.isArray(payload.items) ? payload.items : []
  var out: CalendarEvent[] = []
  for (var i = 0; i < items.length; i++) {
    var item: GoogleEventItem = items[i] || {}
    if (String(item.status || "").toLowerCase() === "cancelled") continue
    var start = googleMoment(item.start && (item.start.dateTime || item.start.date),
      !!(item.start && item.start.date && !item.start.dateTime))
    if (!start) continue
    var end = googleMoment(item.end && (item.end.dateTime || item.end.date),
      !!(item.end && item.end.date && !item.end.dateTime))
    out.push({
      method: "", uid: String(item.iCalUID || item.id || ""),
      // The write URL needs the item's own id, not the iCalUID: with
      // singleEvents=true an expanded occurrence carries an instance id, and
      // patching or deleting it does exactly what Google Calendar does to one
      // occurrence of a series.
      googleId: String(item.id || ""),
      etag: String(item.etag || ""),
      recurringEventId: String(item.recurringEventId || ""),
      originalStartTime: item.originalStartTime || null,
      timeZone: String(item.start && item.start.timeZone || payload!.timeZone || ""),
      reminders: item.reminders || { useDefault: true },
      conferenceData: item.conferenceData || null,
      eventType: String(item.eventType || "default"),
      guestsCanModify: item.guestsCanModify === true,
      transparency: String(item.transparency || "opaque"),
      visibility: String(item.visibility || "default"),
      sequence: Math.max(0, Math.floor(Number(item.sequence) || 0)),
      summary: String(item.summary || "Untitled event"),
      description: String(item.description || ""), location: String(item.location || ""),
      status: String(item.status || "").toUpperCase(), organizer: (item.organizer || null) as CalendarPerson | null,
      attendees: Array.isArray(item.attendees) ? item.attendees : [],
      recurrenceLines: Array.isArray(item.recurrence) ? item.recurrence.slice() : [],
      start: start, end: end as CalendarMoment, recurrence: Array.isArray(item.recurrence)
        ? item.recurrence.join("; ") : "", meetLink: String(item.hangoutLink || ""),
      sourceId: String(sourceId || ""), href: String(item.htmlLink || ""), source: null
    })
  }
  out.sort(compareEvents)
  return out
}

export function eventKey(event: Partial<CalendarEvent> | null | undefined): string {
  if (!event) return ""
  return String(event.sourceId || "") + "\n" + String(event.googleId || event.graphId
    || String(event.uid || "") + "\n" + String(event.recurrenceIdMs || event.start && event.start.ms || ""))
}

// ------------------------------------------------------------- Microsoft
//
// Graph's calendar view: the primary calendar's events between two moments,
// occurrences of a series already expanded, asked for in UTC so a moment
// parses without a timezone table. Written the way Google's is read: the
// same event shape out, the same fields in.

export var GRAPH_ROOT = "https://graph.microsoft.com/v1.0"

export function graphEventsUrl(startMs: number, endMs: number): string {
  return GRAPH_ROOT + "/me/calendarView?startDateTime="
    + encodeURIComponent(new Date(Number(startMs) || 0).toISOString())
    + "&endDateTime=" + encodeURIComponent(new Date(Number(endMs) || 0).toISOString())
    + "&$top=500&$orderby=start/dateTime"
    + "&$select=id,iCalUId,subject,bodyPreview,location,isAllDay,isCancelled,start,end,organizer,attendees,onlineMeeting,webLink,seriesMasterId,type"
}

export function graphEventUrl(eventId?: string | null): string {
  return GRAPH_ROOT + "/me/events/" + encodeURIComponent(String(eventId || ""))
}

export function graphEventsCreateUrl(): string {
  return GRAPH_ROOT + "/me/events"
}

// A Graph moment arrives as "2026-09-07T15:00:00.0000000" in the timezone
// the request preferred, UTC here; an all-day one as midnight of its day.
export function graphMoment(value: GraphWireTime | null | undefined, allDay: boolean): CalendarMoment | null {
  var text = String(value && value.dateTime || "")
  if (text === "") return null
  var ms
  if (allDay) {
    ms = new Date(Number(text.substring(0, 4)), Number(text.substring(5, 7)) - 1,
      Number(text.substring(8, 10))).getTime()
  } else {
    ms = Date.parse(text.replace(/(\.\d+)?$/, "") + "Z")
  }
  if (!isFinite(ms)) return null
  return { ms: ms, allDay: !!allDay, tzid: "", resolved: true }
}

export function graphPerson(value: GraphWirePerson | null | undefined): CalendarPerson {
  var address: GraphEmailAddress = value && value.emailAddress ? value.emailAddress : {}
  return { email: String(address.address || ""), displayName: String(address.name || "") }
}

export function eventsFromGraph(payload: JsonObject | null | undefined, sourceId?: string | null): CalendarEvent[] {
  var items: GraphEventItem[] = payload && Array.isArray(payload.value) ? payload.value : []
  var out: CalendarEvent[] = []
  for (var i = 0; i < items.length; i++) {
    var item: GraphEventItem = items[i] || {}
    if (item.isCancelled === true) continue
    var allDay = item.isAllDay === true
    var start = graphMoment(item.start, allDay)
    if (!start) continue
    var attendees: GraphWirePerson[] = Array.isArray(item.attendees) ? item.attendees : []
    var people: CalendarPerson[] = []
    for (var a = 0; a < attendees.length; a++) people.push(graphPerson(attendees[a]))
    out.push({
      method: "", uid: String(item.iCalUId || item.id || ""),
      // The write URL needs Graph's own id; an occurrence of a series carries
      // an id of its own, and writing to it changes that occurrence alone.
      graphId: String(item.id || ""),
      sequence: 0,
      summary: String(item.subject || "Untitled event"),
      description: String(item.bodyPreview || ""),
      location: String(item.location && item.location.displayName || ""),
      status: "CONFIRMED", organizer: item.organizer ? graphPerson(item.organizer) : null,
      attendees: people,
      start: start, end: graphMoment(item.end, allDay) as CalendarMoment,
      recurrence: "", meetLink: String(item.onlineMeeting && item.onlineMeeting.joinUrl || ""),
      sourceId: String(sourceId || ""), href: String(item.webLink || ""), source: null
    })
  }
  out.sort(compareEvents)
  return out
}

// What Graph is sent for a new or edited event. A timed event is a UTC
// moment written without its Z and named as UTC beside it, which is how
// Graph spells one; an all-day event is midnight to the next midnight.
export function graphStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "")
}

export function graphEventBody(fields: CheckedEventFields, allDay: boolean): GraphEventBody {
  var body = {
    subject: fields.title,
    body: { contentType: "text", content: String(fields.description || "") },
    location: { displayName: String(fields.location || "") },
    isAllDay: allDay === true
  } as GraphEventBody
  if (allDay === true) {
    body.start = { dateTime: isoDate(new Date(fields.start)) + "T00:00:00", timeZone: "UTC" }
    body.end = { dateTime: isoDate(new Date(fields.end)) + "T00:00:00", timeZone: "UTC" }
  } else {
    body.start = { dateTime: graphStamp(fields.start), timeZone: "UTC" }
    body.end = { dateTime: graphStamp(fields.end), timeZone: "UTC" }
  }
  return body
}

export function graphResponseError(status: number, responseText?: string | null): string {
  var payload: GoogleErrorPayload | null = null
  try { payload = JSON.parse(String(responseText || "")) } catch (e) {}
  var detail = payload && payload.error ? String(payload.error.message || payload.error.code || "") : ""
  if (status === 401 || status === 403) return "Microsoft refused the calendar request. Sign in again"
  return detail !== "" ? "Microsoft Graph answered: " + detail : "Microsoft Graph answered " + status
}

export var M365_SIGN_IN_AGAIN = ["auth_signed_out", "calendar_auth_refused", "auth_client_missing",
  "auth_client_invalid", "auth_refresh_failed", "auth_secret_invalid"]

export var M365_CONSENT = "Microsoft calendar request failed. An administrator has to approve this app for your "
  + "organization. Then sign in to this mailbox again"

// Keep native backend diagnostics private while giving each provider an
// actionable recovery path. This deliberately does not depend on backend
// error-message semantics, so it remains compatible with the pinned API.
export function nativeRequestError(kind: string, accountId?: string | null, error?: unknown): string {
  // A Microsoft 365 mailbox has one sign-in for mail and calendar: nothing to
  // check in Settings, and no second permission to grant. A sign-in that is
  // missing, refused, unreadable or made for an app ID that is gone is one to
  // sign in again for, as on the mail side; this API knows its codes. Consent is
  // an administrator's to give, in words of the calendar's own: the mail side's
  // advice about the page a code is entered on is no use to a refresh.
  if (kind === "microsoft" && String(accountId || "").indexOf("m365:") === 0) {
    var code = error && typeof error === "object" ? String((error as JsonObject).message || "") : ""
    if (code === "auth_consent_required") return M365_CONSENT
    return M365_SIGN_IN_AGAIN.indexOf(code) >= 0
      ? "Microsoft calendar request failed. Sign in to this mailbox again"
      : "Microsoft calendar request failed. Try again in a moment"
  }
  if (kind === "microsoft")
    return "Microsoft calendar request failed. Check Graph permissions in Settings, then sign in again"
  if (kind === "google")
    return "Google could not complete this calendar request. Refresh the event and try again"
  if (kind === "caldav")
    return "CalDAV calendar request failed. Check its server address and password in Settings"
  // An iCloud calendar signs in with the mailbox's app-specific password, so
  // that is what a refusal points at; there is no separate calendar password.
  if (kind === "icloud")
    return "iCloud calendar request failed. Check the mailbox's app-specific password in Settings"
  return "The calendar request failed"
}

export function googleEventsUrl(startMs: number, endMs: number): string {
  return "https://www.googleapis.com/calendar/v3/calendars/primary/events?"
    + "singleEvents=true&orderBy=startTime&maxResults=2500"
    + "&timeMin=" + encodeURIComponent(new Date(Number(startMs) || 0).toISOString())
    + "&timeMax=" + encodeURIComponent(new Date(Number(endMs) || 0).toISOString())
}

export function icsText(value?: string | null): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;")
}

export function icsUtc(ms: number): string {
  return new Date(Number(ms)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

// A date-only stamp is the local calendar day: the ms of an all-day boundary
// is local midnight, so the fields are read back off the local clock and no
// timezone can move the written date.
export function icsDate(ms: number): string {
  var date = new Date(Number(ms))
  return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate())
}

export function recurrenceRule(raw?: RecurrenceChoice | null): RecurrenceRuleResult {
  var value: RecurrenceChoice = raw || {}
  if (value.enabled !== true) return { ok: true, rule: "" }
  var frequency = String(value.frequency || "").toUpperCase()
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(frequency) < 0)
    return { ok: false, error: "Choose how often the event repeats" }
  var interval = Math.floor(Number(value.interval))
  if (!isFinite(interval) || interval < 1)
    return { ok: false, error: "Repeat interval must be at least 1" }
  var countText = String(value.count === undefined ? "" : value.count).trim()
  var count = countText === "" ? 0 : Math.floor(Number(countText))
  if (countText !== "" && (!isFinite(count) || count < 1))
    return { ok: false, error: "Occurrence count must be at least 1" }
  var rule = "FREQ=" + frequency + ";INTERVAL=" + interval
  if (count > 0) rule += ";COUNT=" + count
  return { ok: true, rule: rule }
}

export function recurrenceIntervalUnit(frequency: string, interval: number | string): string {
  var units: { [frequency: string]: string } = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }
  var unit = units[String(frequency || "").toUpperCase()] || "interval"
  return Number(interval) === 1 ? unit : unit + "s"
}

export function editorDateTime(dateText: string, timeText: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeText)) return null
  var value = new Date(dateText + "T" + timeText + ":00")
  if (!isFinite(value.getTime()) || isoDate(value) !== dateText
      || two(value.getHours()) + ":" + two(value.getMinutes()) !== timeText) return null
  return value
}

export function editorDateRange(firstDate: string, firstTime: string, lastDate: string, lastTime: string, allDay: boolean): EditorDateRange {
  var start = editorDateTime(String(firstDate), allDay ? "00:00" : String(firstTime))
  var end = editorDateTime(String(lastDate), allDay ? "00:00" : String(lastTime))
  if (!start || !end) return {ok:false,error:allDay ? "Enter valid dates (YYYY-MM-DD)" : "Enter valid dates (YYYY-MM-DD) and times (HH:mm)"}
  if (allDay) end.setDate(end.getDate() + 1)
  if (end.getTime() <= start.getTime()) return {ok:false,error:allDay
    ? "Last day must be on or after the first day" : "End date and time must be after the start"}
  return {ok:true,error:"",startMs:start.getTime(),endMs:end.getTime()}
}

export function validateEventFields(fields: EventFields | null | undefined): ValidatedEventFields {
  var value: EventFields = fields || {}
  var title = String(value.title || "").trim()
  var start = Number(value.startMs)
  var end = Number(value.endMs)
  if (title === "") return { ok: false, error: "Add an event title" }
  if (!isFinite(start) || !isFinite(end)) return { ok: false, error: "Add valid start and end times" }
  if (end <= start) return { ok: false, error: "End time must be after start time" }
  return { ok: true, title: title, start: start, end: end,
    description: String(value.description || ""), location: String(value.location || "") }
}

export function veventLines(uid: string, sequence: number, stampMs: number, fields: CheckedEventFields, rule: string, allDay: boolean): string[] {
  var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Omamail//Calendar//EN",
    "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + icsUtc(stampMs)]
  if (sequence > 0) lines.push("SEQUENCE:" + sequence)
  // An all-day event is dates with an exclusive end, never midnight times.
  if (allDay === true)
    lines.push("DTSTART;VALUE=DATE:" + icsDate(fields.start),
      "DTEND;VALUE=DATE:" + icsDate(fields.end))
  else
    lines.push("DTSTART:" + icsUtc(fields.start), "DTEND:" + icsUtc(fields.end))
  lines.push("SUMMARY:" + icsText(fields.title))
  if (fields.description !== "") lines.push("DESCRIPTION:" + icsText(fields.description))
  if (fields.location !== "") lines.push("LOCATION:" + icsText(fields.location))
  if (rule !== "") lines.push("RRULE:" + rule)
  lines.push("END:VEVENT", "END:VCALENDAR", "")
  return lines
}

export function editableEventLines(sequence: number, stampMs: number, fields: CheckedEventFields, allDay: boolean): string[] {
  var lines = ["DTSTAMP:" + icsUtc(stampMs), "SEQUENCE:" + sequence]
  if (allDay === true)
    lines.push("DTSTART;VALUE=DATE:" + icsDate(fields.start),
      "DTEND;VALUE=DATE:" + icsDate(fields.end))
  else
    lines.push("DTSTART:" + icsUtc(fields.start), "DTEND:" + icsUtc(fields.end))
  lines.push("SUMMARY:" + icsText(fields.title))
  if (fields.description !== "") lines.push("DESCRIPTION:" + icsText(fields.description))
  if (fields.location !== "") lines.push("LOCATION:" + icsText(fields.location))
  return lines
}

export function googleEventBody(fields: CheckedEventFields, allDay: boolean): GoogleEventBody {
  var body = {
    summary: fields.title, description: fields.description, location: fields.location
  } as GoogleEventBody
  // Google keeps the same distinction: an all-day event is start.date to the
  // exclusive end date, a timed one is dateTime.
  if (allDay === true) {
    body.start = { date: isoDate(new Date(fields.start)) }
    body.end = { date: isoDate(new Date(fields.end)) }
  } else {
    body.start = { dateTime: new Date(fields.start).toISOString() }
    body.end = { dateTime: new Date(fields.end).toISOString() }
  }
  return body
}

export function googleEventPatch(fields: CheckedEventFields, allDay: boolean, existingAllDay?: boolean): GoogleEventBody {
  var body = googleEventBody(fields, allDay)
  if (existingAllDay === allDay) return body
  // PATCH preserves omitted nested fields. Explicitly remove the other time
  // representation so a conversion cannot leave both date and dateTime set.
  if (allDay) {
    body.start.dateTime = null
    body.end.dateTime = null
    body.start.timeZone = null
    body.end.timeZone = null
  } else {
    body.start.date = null
    body.end.date = null
  }
  return body
}

export function googleOptions(body: GoogleEventBody, fields: EventFields, source?: Partial<CalendarSource> | null, existing?: Partial<CalendarEvent> | null): GoogleOptionsResult {
  var next: GoogleEventBody = JSON.parse(JSON.stringify(body))
  if (existing && fields.changeRecurrence === true) {
    if (existing.recurringEventId) return { ok: false, error: "Open the entire series to change repetition" }
    var recurrence = recurrenceRule(fields.recurrence)
    if (!recurrence.ok) return recurrence
    var lines = (existing.recurrenceLines || []).filter(function(line) { return String(line).indexOf("RRULE:") !== 0 })
    if (recurrence.rule !== "") lines.unshift("RRULE:" + recurrence.rule)
    next.recurrence = lines
  }
  var zone = String(fields.timeZone || existing && existing.timeZone || source && source.timeZone || "")
  if (zone !== "" && next.start && next.start.dateTime) {
    next.start.timeZone = zone
    next.end.timeZone = zone
  }
  if (fields.guestEmails !== undefined) {
    var emails = String(fields.guestEmails).split(/[,;\n]/).map(function(email) { return email.trim() }).filter(function(email) { return email !== "" })
    if (emails.length > 200 || emails.some(function(email) { return !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) }))
      return { ok: false, error: "Enter valid guest email addresses separated by commas" }
    var seen: { [email: string]: boolean } = {}, previous = existing && Array.isArray(existing.attendees) ? existing.attendees : []
    next.attendees = []
    for (var i = 0; i < emails.length; i++) {
      var email = emails[i].toLowerCase()
      if (seen[email]) continue
      seen[email] = true
      var matched = previous.filter(function(attendee) { return String(attendee.email || "").toLowerCase() === email })
      next.attendees.push(matched.length ? matched[0] : { email: emails[i] })
    }
  }
  if (fields.transparency === "opaque" || fields.transparency === "transparent") next.transparency = fields.transparency
  if (["default", "public", "private"].indexOf(fields.visibility as string) >= 0) next.visibility = fields.visibility
  if (fields.reminderMode === "default") next.reminders = { useDefault: true }
  else if (fields.reminderMode === "none") next.reminders = { useDefault: false, overrides: [] }
  else if (fields.reminderMode === "custom") {
    var minutes = Number(fields.reminderMinutes)
    if (!isFinite(minutes) || minutes < 0 || minutes > 40320 || Math.floor(minutes) !== minutes)
      return { ok: false, error: "Reminder minutes must be a whole number from 0 to 40320" }
    next.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: minutes }] }
  }
  if (fields.createMeet === true) {
    if (!source || source.canCreateMeet !== true)
      return { ok: false, error: "This calendar cannot create Google Meet meetings" }
    if (!(existing && existing.conferenceData)) {
      next.conferenceData = { createRequest: {
        requestId: String(fields.conferenceRequestId || ""),
        conferenceSolutionKey: { type: "hangoutsMeet" }
      } }
      if (next.conferenceData.createRequest.requestId === "")
        return { ok: false, error: "The meeting request has no identity" }
    }
  }
  return { ok: true, body: next }
}

export function transferRefusal(source: Partial<CalendarSource> | null | undefined, destination: Partial<CalendarSource> | null | undefined, event: Partial<CalendarEvent> | null | undefined, allowSeriesChoice?: boolean): string {
  if (!source || !destination || source.kind !== "google" || destination.kind !== "google")
    return "Calendar transfers are not available for this provider"
  if (source.accountId !== destination.accountId) return "Choose a calendar in the same account"
  if (source.readOnly) return "The original calendar is read-only"
  if (destination.readOnly) return "The destination calendar is read-only"
  if (!event || event.eventType !== "default" || !event.organizer || event.organizer.self !== true)
    return "Only ordinary events you organize can change calendars"
  if (event.recurringEventId && !allowSeriesChoice) return "Open the entire series before changing its calendar"
  return ""
}

export function rescheduleFields(event: Partial<CalendarEvent>, startMs: number, endMs: number): EventFields {
  return { title: String(event.summary || ""), description: String(event.description || ""),
    location: String(event.location || ""), startMs: Number(startMs), endMs: Number(endMs),
    allDay: !!(event.start && event.start.allDay), timeZone: String(event.timeZone || ""), sendUpdates: "none" }
}

export function gestureRange(event: CalendarEvent | null | undefined, dayOffset: number, minuteOffset: number, edge: string): GestureRange | null {
  if (!event || !event.start || !event.end) return null
  var start = Number(event.start.ms), end = Number(event.end.ms)
  var minutes = Math.round(Number(minuteOffset) / 15) * 15
  if (edge === "start") start = Math.min(end - 900000, Math.round((start + Number(minuteOffset) * 60000) / 900000) * 900000)
  else if (edge === "end") end = Math.max(start + 900000, Math.round((end + Number(minuteOffset) * 60000) / 900000) * 900000)
  else {
    var date = new Date(start)
    date.setDate(date.getDate() + Number(dayOffset))
    if (!event.start.allDay) date.setMinutes(date.getMinutes() + minutes)
    var duration = end - start
    start = date.getTime()
    if (event.start.allDay) {
      // All-day duration counts local dates, including 23/25-hour DST days.
      var endDate = new Date(end)
      endDate.setDate(endDate.getDate() + Number(dayOffset))
      end = endDate.getTime()
    } else end = start + duration
  }
  return isFinite(start) && isFinite(end) && end > start ? { start: start, end: end } : null
}

// Interval partitioning: every connected overlap group shares its lane count.
// Equal end/start boundaries do not overlap. Long meetings retain their lane
// while shorter neighbours come and go, so cards never cover each other.
export function timedLayout(events: CalendarEvent[] | null | undefined, day: DayBounds): TimedLayoutRow[] {
  var rows = (events || []).filter(function(event) { return event && event.start && !displayInAllDayLane(event) }).map(function(event) {
    return { event: event, start: Math.max(Number(event.start.ms), day.startMs),
      end: Math.min(Number(event.end && event.end.ms || event.start.ms + 900000), day.endMs), column: 0, columns: 1 }
  }).filter(function(row) { return row.end > row.start })
  rows.sort(function(a, b) { return a.start - b.start || b.end - a.end || eventKey(a.event).localeCompare(eventKey(b.event)) })
  var group: TimedLayoutRow[] = [], ends: number[] = [], groupEnd = 0
  function finish() {
    for (var j = 0; j < group.length; j++) group[j].columns = ends.length
    group = []; ends = []; groupEnd = 0
  }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (group.length && row.start >= groupEnd) finish()
    var lane = 0
    while (lane < ends.length && ends[lane] > row.start) lane++
    ends[lane] = row.end
    row.column = lane
    group.push(row)
    groupEnd = Math.max(groupEnd, row.end)
  }
  finish()
  return rows
}

export function attendeeRows(event: Partial<CalendarEvent> | null | undefined): AttendeeRow[] {
  return (event && Array.isArray(event.attendees) ? event.attendees : []).map(function(attendee) {
    var status = String(attendee.responseStatus || attendee.partstat || attendee.status && attendee.status.response || "needsAction").toLowerCase()
    var label = status === "accepted" ? "Accepted" : status === "declined" ? "Declined"
      : status === "tentative" || status === "tentativelyaccepted" ? "Maybe" : "Awaiting reply"
    var email = String(attendee.email || attendee.emailAddress && attendee.emailAddress.address || "")
    var name = String(attendee.displayName || attendee.name || attendee.emailAddress && attendee.emailAddress.name || email || "Guest")
    return { name: name, email: email, label: label,
      symbol: label === "Accepted" ? "✓" : label === "Declined" ? "×" : "?",
      optional: attendee.optional === true, self: attendee.self === true }
  })
}

export function agendaEvents(events: CalendarEvent[] | null | undefined, nowMs: number): CalendarEvent[] {
  return (events || []).filter(function(event) {
    if (!event || !event.start) return false
    var end = event.end ? Number(event.end.ms) : Number(event.start.ms)
    return end > Number(nowMs)
  }).sort(compareEvents)
}

export function calendarChoiceRows(groups: CalendarGroup[] | null | undefined, editingSource: Partial<CalendarSource> | null | undefined, event?: Partial<CalendarEvent> | null): CalendarChoiceRow[] {
  var rows: CalendarChoiceRow[] = []
  for (var i = 0; i < (groups || []).length; i++) {
    var group = groups![i]
    var first = true
    for (var j = 0; j < (group.calendars || []).length; j++) {
      var source = group.calendars[j]
      if (event && (!editingSource || String(source.id) !== String(editingSource.id))
          && transferRefusal(editingSource, source, event, true) !== "") continue
      rows.push({ source: source, firstInGroup: first,
        groupLabel: String(group.providerLabel || "") + " · " + String(group.accountLabel || "") })
      first = false
    }
  }
  return rows
}

export function repeatChoice(event: Partial<CalendarEvent> | null | undefined): string {
  var rules = (event && event.recurrenceLines || []).filter(function(line) { return String(line).indexOf("RRULE:") === 0 })
  if (!rules.length) return "none"
  if (rules.length !== 1 || !/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL|COUNT)=\d+)*$/.test(rules[0])) return "custom"
  return /FREQ=([A-Z]+)/.exec(rules[0])![1]
}

export function createEvent(fields: EventFields, nowMs: number): EventWriteResult {
  var checked = validateEventFields(fields)
  if (!checked.ok) return checked
  var recurrence = recurrenceRule((fields || {}).recurrence)
  if (!recurrence.ok) return recurrence
  var uid = "omamail-" + Math.floor(Number(nowMs) || Date.now())
  var result = {
    ok: true as const, uid: uid,
    ics: veventLines(uid, 0, Number(nowMs) || Date.now(), checked, recurrence.rule, fields.allDay === true).join("\r\n"),
    google: googleEventBody(checked, fields.allDay === true),
    graph: graphEventBody(checked, fields.allDay === true),
    // Graph spells a series as a structured rule of its own rather than an
    // RRULE; one is refused there rather than sent wrong.
    recurring: recurrence.rule !== ""
  }
  if (recurrence.rule !== "") result.google.recurrence = ["RRULE:" + recurrence.rule]
  return result
}

// Whether a write can run against this source at all. A read-only calendar
// refuses every write. A recurring CalDAV event is one ICS holding a rule,
// its exceptions and its exclusions; rewriting that file from the fields the
// composer edits would drop the parts it keeps no model of, so the operation
// is refused before anything is written — the same judgement the button rule
// makes upstream. A modified occurrence carries no RRULE of its own, only a
// RECURRENCE-ID, but its href is still the series' shared file, so it answers
// the same way. Creation asks with no event: only the source's own rules
// apply.
// The confirmation a delete asks for: which event, what goes with it, and
// the answers that differ in consequence. Each choice is one button in the
// dialog, so a guest notification or a whole series is chosen there rather
// than on a row of destructive buttons beside the event. The last choice is
// the default. `value` is the event's `deleteSendUpdates`, or "series".
export function deleteRequest(event: Partial<CalendarEvent> | null | undefined, source: Partial<CalendarSource> | null | undefined, canReadSeries?: boolean): DeleteRequest {
  var value = event || {}
  var google = !!source && source.kind === "google"
  var notifies = google && !!value.organizer && value.organizer.self === true
    && (value.attendees || []).some(function(attendee) { return attendee.self !== true })
  var occurrence = String(value.recurringEventId || "") !== ""
  var series = Array.isArray(value.recurrence) && value.recurrence.length > 0
  var choices: DeleteChoice[] = []
  var message = "This event will be permanently deleted."
  if (occurrence) {
    var offerSeries = google && canReadSeries === true
    message = offerSeries ? "Delete this occurrence, or every occurrence in the series."
      : "This occurrence will be deleted. The rest of the series stays."
    if (offerSeries) choices.push({ value: "series", label: "Delete series" })
    if (notifies) {
      choices.push({ value: "none", label: "Delete occurrence without email" })
      choices.push({ value: "all", label: "Delete occurrence and notify guests" })
    } else choices.push({ value: "all", label: "Delete occurrence" })
  } else if (notifies) {
    message = (series ? "Every occurrence of this series will be deleted. " : "")
      + "Guests get a cancellation email unless you delete without one."
    choices.push({ value: "none", label: "Delete without email" })
    choices.push({ value: "all", label: "Delete and notify guests" })
  } else {
    if (series) message = "Every occurrence of this series will be deleted."
    choices.push({ value: "all", label: "Delete" })
  }
  return { kind: "event", name: String(value.summary || "Untitled event"), message: message, choices: choices }
}

export function writeRefusal(source: Partial<CalendarSource> | null | undefined, event?: Partial<CalendarEvent> | null, operation?: string): string {
  if (!source) return "Choose a calendar"
  if (source.readOnly === true) return "This calendar is read-only"
  if (operation === "reschedule" && source.kind !== "google")
    return "Open the event editor to change its time"
  if (source.kind === "google" && event && event.eventType === "fromGmail" && operation !== "delete")
    return "Google does not allow changing the time or details of events created from Gmail"
  if (source.kind === "google" && event && event.organizer && event.organizer.self === false
      && event.guestsCanModify !== true && operation !== "delete")
    return "Only the organizer can change this event"
  if (source.kind !== "caldav" && source.kind !== "icloud") return ""
  // A RECURRENCE-ID too malformed to parse leaves recurrenceIdMs at 0, but
  // the event's href still names the series' shared file — the raw line the
  // parser kept answers for it.
  var rawRecurrenceId = event && event.source
    ? String(event.source.recurrenceId || "") : ""
  if (String(event && event.recurrenceRule || "") !== ""
      || Number(event && event.recurrenceIdMs) > 0 || rawRecurrenceId !== "")
    return "Recurring CalDAV events can only be changed in a full calendar client"
  return ""
}

// An edit rewrites the event on its own identity: the UID names it, and the
// bumped SEQUENCE tells every copy of it which write is newer. Recurrence is
// not editable here — the Google patch omits the key so the server keeps the
// rule, and a recurring CalDAV event is refused by writeRefusal before this
// runs. An explicit allDay field can change its shape; otherwise preserve the
// original shape so a title-only change cannot turn one into the other.
export function updateEvent(fields: EventFields, existing: Partial<CalendarEvent> | null | undefined, nowMs: number): EventWriteResult {
  var event = existing || {}
  var uid = String(event.uid || "")
  if (uid === "") return { ok: false, error: "The event has no identity to update" }
  var checked = validateEventFields(fields)
  if (!checked.ok) return checked
  var sequence = Math.max(0, Math.floor(Number(event.sequence) || 0)) + 1
   var allDay = fields.allDay === undefined ? !!(event.start && event.start.allDay) : fields.allDay === true
  var stampMs = Number(nowMs) || Date.now()
  var original = String(event.calendarData || "")
  var rewritten = original === "" ? "" : Ics.rewriteEvent(original, uid,
    editableEventLines(sequence, stampMs, checked, allDay),
    ["DTSTAMP", "SEQUENCE", "DTSTART", "DTEND", "DURATION", "SUMMARY",
      "DESCRIPTION", "LOCATION"])
  return {
    ok: true, uid: uid,
    ics: rewritten !== "" ? rewritten
      : veventLines(uid, sequence, stampMs, checked, "", allDay).join("\r\n"),
    google: googleEventPatch(checked, allDay, !!(event.start && event.start.allDay)),
    graph: graphEventBody(checked, allDay)
  }
}

export function googleEventUrl(eventId?: string | null): string {
  return "https://www.googleapis.com/calendar/v3/calendars/primary/events/"
    + encodeURIComponent(String(eventId || ""))
}

// The scheme and authority of an HTTPS URL. Anything else — http, a bare
// path, junk — has no authority here, because a write address is HTTPS or
// nothing.
export function httpsAuthority(url?: string | null): UrlAuthority | null {
  var text = String(url || "")
  if (text === "" || /\s/.test(text)) return null
  var match = /^(https):\/\/([^\/?#]+)/i.exec(text)
  if (!match) return null
  var authority = match[2]
  var at = authority.lastIndexOf("@")
  if (at >= 0) authority = authority.substring(at + 1)
  var host = ""
  var port = ""
  if (authority.charAt(0) === "[") {
    var close = authority.indexOf("]")
    if (close < 0) return null
    host = authority.substring(0, close + 1).toLowerCase()
    var rest = authority.substring(close + 1)
    if (rest !== "" && rest.charAt(0) !== ":") return null
    port = rest === "" ? "" : rest.substring(1)
  } else {
    var colon = authority.lastIndexOf(":")
    if (colon >= 0) {
      host = authority.substring(0, colon).toLowerCase()
      port = authority.substring(colon + 1)
    } else {
      host = authority.toLowerCase()
    }
  }
  if (host === "" || host === "[]") return null
  if (port !== "" && !/^[0-9]{1,5}$/.test(port)) return null
  if (port !== "" && (Number(port) < 1 || Number(port) > 65535)) return null
  return { host: host, port: port === "" ? "443" : String(Number(port)) }
}

export function urlAuthority(url?: string | null): string {
  var parts = httpsAuthority(url)
  if (!parts) return ""
  return parts.port === "443"
    ? "https://" + parts.host
    : "https://" + parts.host + ":" + parts.port
}

// scheme://host:port with the port made explicit and the case-insensitive
// parts folded, so two spellings of the same origin compare equal.
export function urlOrigin(url?: string | null): string {
  var parts = httpsAuthority(url)
  return parts ? "https://" + parts.host + ":" + parts.port : ""
}

// A REPORT answers with the event's own href, which the server may write as a
// full URL or as a path against the host the collection lives on. An absolute
// href is accepted only on the collection's own origin: anything else would
// send this calendar's credentials to a server that merely named an address
// in an answer. Raw whitespace is refused outright — a URL's spaces arrive
// percent-encoded, and the resolved address becomes one quoted line of the
// transport's curl config, where a line break would write more options.
export function caldavEventUrl(sourceUrl: string | null | undefined, event: Partial<CalendarEvent> | null | undefined): string {
  var base = String(sourceUrl || "")
  var origin = urlOrigin(base)
  if (origin === "") return ""
  var href = String(event && event.href || "")
  if (/\s/.test(href)) return ""
  var resolved = ""
  if (/^https:\/\//i.test(href) || href.substring(0, 2) === "//") {
    var candidate = href.substring(0, 2) === "//" ? "https:" + href : href
    resolved = candidate.replace(/^(https:\/\/)[^\/?#]*@/i, "$1")
  } else if (href.charAt(0) === "/") {
    resolved = urlAuthority(base) + href
  } else if (href !== "") {
    var collection = base.charAt(base.length - 1) === "/" ? base : base + "/"
    resolved = collection + href
  } else {
    var uid = String(event && event.uid || "")
    if (uid === "") return ""
    var root = base.charAt(base.length - 1) === "/" ? base : base + "/"
    resolved = root + encodeURIComponent(uid) + ".ics"
  }
  return urlOrigin(resolved) === origin ? resolved : ""
}

// Whether two event lists would draw the same. A refresh that brings back what
// is already shown must not hand the views a new array: every Repeater and
// ListView bound to one rebuilds its delegates and loses its scroll position.
export function sameEvents(left: CalendarEvent[] | null | undefined, right: CalendarEvent[] | null | undefined): boolean {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

export function compareEvents(left: CalendarEvent | null | undefined, right: CalendarEvent | null | undefined): number {
  var leftMs = left && left.start ? left.start.ms : 0
  var rightMs = right && right.start ? right.start.ms : 0
  if (leftMs !== rightMs) return leftMs - rightMs
  return String(left && left.summary || "").localeCompare(String(right && right.summary || ""))
}

export function isoDate(date: Date): string {
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate())
}

export function monthDays(year: number, monthIndex: number, weekStart: number): CalendarDay[] {
  var first = new Date(Number(year), Number(monthIndex), 1)
  var startDay = Math.floor(Number(weekStart))
  if (!isFinite(startDay) || startDay < 0 || startDay > 6) startDay = 1
  var offset = (first.getDay() - startDay + 7) % 7
  var cursor = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  var out: CalendarDay[] = []
  for (var i = 0; i < 42; i++) {
    var day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i)
    out.push({
      isoDate: isoDate(day), day: day.getDate(), month: day.getMonth(), year: day.getFullYear(),
      startMs: day.getTime(), endMs: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
      inMonth: day.getMonth() === first.getMonth()
    })
  }
  return out
}

export function monthGridDays(year: number, monthIndex: number, weekStart: number): CalendarDay[] {
  var days = monthDays(year, monthIndex, weekStart)
  return days.slice(0, days.slice(35).some(function(day) { return day.inMonth }) ? 42 : 35)
}

export function monthEventLimit(availableHeight: number, rowHeight: number, spacing: number, overflowHeight: number, eventCount: number): number {
  var capacity = Math.max(0, Math.floor((availableHeight + spacing) / (rowHeight + spacing)))
  if (eventCount <= capacity) return capacity
  return Math.max(0, Math.floor((availableHeight - overflowHeight) / (rowHeight + spacing)))
}

export function spansMultipleDays(event: CalendarEvent | null | undefined): boolean {
  if (!event || !event.start || !event.end) return false
  var start = Number(event.start.ms), end = Number(event.end.ms)
  return isFinite(start) && isFinite(end) && end > start
    && isoDate(new Date(start)) !== isoDate(new Date(end - 1))
}

// Each original event gets one segment per intersected week. Endpoints are
// exclusive, including midnight and all-day ends; titles never identify events.
export function monthSpanLayout(events: CalendarEvent[] | null | undefined, days: DayBounds[]): SpanLayout {
  return spanLayout((events || []).filter(spansMultipleDays), days)
}

export function spanLayout(events: CalendarEvent[] | null | undefined, days: DayBounds[]): SpanLayout {
  var segments: SpanSegment[] = [], laneCounts: number[] = []
  var values = (events || []).filter(function(event) {
    return event && event.start && event.end && Number(event.end.ms) > Number(event.start.ms)
  }).slice().sort(function(a, b) {
    return Number(a.start.ms) - Number(b.start.ms)
      || Number(b.end.ms) - Number(a.end.ms) || compareEvents(a, b)
  })
  for (var week = 0; week < Math.ceil(days.length / 7); week++) {
    var first = week * 7, last = Math.min(first + 6, days.length - 1), laneEnds: number[] = []
    for (var i = 0; i < values.length; i++) {
      var event = values[i], start = Number(event.start.ms), end = Number(event.end.ms)
      if (start >= days[last].endMs || end <= days[first].startMs) continue
      var left = 0, right = last - first
      while (left < last - first && start >= days[first + left].endMs) left++
      while (right > left && end <= days[first + right].startMs) right--
      var lane = 0
      while (lane < laneEnds.length && laneEnds[lane] >= left) lane++
      laneEnds[lane] = right
      segments.push({event:event, week:week, startColumn:left, endColumn:right, lane:lane,
        continuesBefore:start < days[first].startMs, continuesAfter:end > days[last].endMs})
    }
    laneCounts.push(laneEnds.length)
  }
  return {segments:segments, laneCounts:laneCounts}
}

export function weekDays(anchorMs: number, weekStart: number): CalendarDay[] {
  var anchor = new Date(Number(anchorMs) || Date.now())
  var startDay = Math.floor(Number(weekStart))
  if (!isFinite(startDay) || startDay < 0 || startDay > 6) startDay = 1
  var offset = (anchor.getDay() - startDay + 7) % 7
  var start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset)
  var out: CalendarDay[] = []
  for (var i = 0; i < 7; i++) {
    var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    out.push({
      isoDate: isoDate(day), day: day.getDate(), month: day.getMonth(), year: day.getFullYear(),
      startMs: day.getTime(), endMs: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
      inMonth: true
    })
  }
  return out
}

export function weekTitle(days: CalendarDay[] | null | undefined): string {
  var values = Array.isArray(days) ? days : []
  if (values.length < 7) return ""
  var months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"]
  var first = values[0]
  var last = values[6]
  if (first.year === last.year && first.month === last.month)
    return first.day + "–" + last.day + " " + months[first.month] + " " + first.year
  if (first.year === last.year)
    return first.day + " " + months[first.month] + "–" + last.day + " "
      + months[last.month] + " " + first.year
  return first.day + " " + months[first.month] + " " + first.year + "–"
    + last.day + " " + months[last.month] + " " + last.year
}

// Minutes on the labeled local-time grid. Subtracting from midnight measures
// elapsed time instead, which is an hour short or long after a DST transition.
export function dayMinutes(timeMs: number, day: DayBounds): number {
  var value = Number(timeMs)
  if (value <= Number(day.startMs)) return 0
  if (value >= Number(day.endMs)) return 1440
  var local = new Date(value)
  return local.getHours() * 60 + local.getMinutes()
    + local.getSeconds() / 60 + local.getMilliseconds() / 60000
}

// How tall one hour is in the day and week views. By default a window shows a
// waking day, without hours growing past their usual height or shrinking past
// what a short event can be read at. The zoom keys save a height of their own
// in unscaled pixels, which can go on down until the whole day fits, for someone
// whose day has no quiet hours; 0, or anything unusable, means automatic.
export var HOUR_HEIGHT_AUTOMATIC = 0
export var HOUR_HEIGHT_USUAL = 60
export var HOUR_HEIGHT_READABLE = 25
export var HOUR_HEIGHT_MIN = 10
export var HOUR_HEIGHT_MAX = 120
export var HOUR_HEIGHT_STEP = 5
export var HOURS_TO_SHOW = 16

export function automaticHourHeight(viewport: number, usual: number, readable: number): number {
  return Math.max(readable, Math.min(usual, Number(viewport) / HOURS_TO_SHOW || 0))
}

export function normalizeHourHeight(value: unknown): number {
  var usable = typeof value === "number" || (typeof value === "string" && value.trim() !== "")
  var height = usable ? Math.floor(Number(value)) : NaN
  if (!isFinite(height) || height <= 0) return HOUR_HEIGHT_AUTOMATIC
  return Math.max(HOUR_HEIGHT_MIN, Math.min(HOUR_HEIGHT_MAX, height))
}

// One press of a zoom key: +1 or -1 steps from the height on screen, 0 returns
// to automatic. `filled` is the height the timeline already stretches to in this
// window. A press that could not show changes nothing, so it saves nothing.
export function zoomedHourHeight(saved: unknown, shown: number, direction: number, filled?: number): number {
  if (!direction) return HOUR_HEIGHT_AUTOMATIC
  var fill = Number(filled) || 0
  var from = Math.max(Number(shown) || HOUR_HEIGHT_USUAL, fill)
  var limit = direction < 0 ? Math.max(HOUR_HEIGHT_MIN, fill) : HOUR_HEIGHT_MAX
  if (direction < 0 ? from <= limit : from >= limit) return normalizeHourHeight(saved)
  var next = Math.max(HOUR_HEIGHT_MIN, Math.min(HOUR_HEIGHT_MAX, Math.round(from) + direction * HOUR_HEIGHT_STEP))
  // Rounded down, so that the window takes over and the whole day fits exactly.
  return next < fill ? Math.max(HOUR_HEIGHT_MIN, Math.floor(fill)) : next
}

export function eventTop(event: CalendarEvent | null | undefined, day: DayBounds, firstHour: number, hourHeight: number): number {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var minutes = dayMinutes(start, day) - Number(firstHour) * 60
  return Math.max(0, minutes / 60 * Number(hourHeight))
}

export function eventHeight(event: CalendarEvent | null | undefined, day: DayBounds, hourHeight: number): number {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var end = event.end ? Math.min(Number(event.end.ms), Number(day.endMs)) : start + 1800000
  return Math.max(2,
    (dayMinutes(end, day) - dayMinutes(start, day)) / 60 * Number(hourHeight))
}

// Where "now" sits in a day column, or -1 when it does not belong on the grid:
// another day, or an hour outside the range the week view drew. The caller
// draws nothing on -1 rather than clamping to an edge, because a line pinned to
// the top of the grid states a time that is not the time.
export function nowOffset(day: DayBounds | null | undefined, firstHour: number, lastHour: number, hourHeight: number, nowMs: number): number {
  if (!day) return -1
  var now = Number(nowMs)
  if (!isFinite(now)) return -1
  if (now < Number(day.startMs) || now >= Number(day.endMs)) return -1
  var minutes = dayMinutes(now, day)
  var first = Number(firstHour) * 60
  var last = Number(lastHour) * 60
  if (minutes < first || minutes > last) return -1
  return (minutes - first) / 60 * Number(hourHeight)
}

// The clock is the system's hour cycle (format.ts); a caller may pass one.
export function timeLabel(timeMs: number, hourCycle?: HourCycle | string): string {
  var time = new Date(Number(timeMs))
  if (!isFinite(time.getTime())) return ""
  return formatTime(time, hourCycle)
}

export function timeRangeLabel(startMs: number, endMs: number, localeFormat?: HourCycle | string, separator?: string): string {
  return timeLabel(startMs, localeFormat) + (separator === undefined ? "–" : separator)
    + timeLabel(endMs, localeFormat)
}

export function dateTimeLabel(timeMs: number, dateFormat: string, localeFormat?: HourCycle | string, separator?: string): string {
  return formatDate(new Date(Number(timeMs)), dateFormat)
    + (separator === undefined ? " " : separator) + timeLabel(timeMs, localeFormat)
}

// The same offset for the week as a whole, so the time rail can label the line
// without the view having to work out which of the seven columns is today.
// Returns -1 when today is not in view at all, which is every week but this one.
export function weekNowOffset(days: DayBounds[] | null | undefined, firstHour: number, lastHour: number, hourHeight: number, nowMs: number): number {
  var values = Array.isArray(days) ? days : []
  for (var i = 0; i < values.length; i++) {
    var offset = nowOffset(values[i], firstHour, lastHour, hourHeight, nowMs)
    if (offset >= 0) return offset
  }
  return -1
}

// Side-by-side lanes for one day's timed events. Events that overlap, even
// through a third one, form a cluster; each event takes the leftmost lane
// free at its start, and every event in a cluster is drawn at the width of
// the cluster's lane count - so three meetings at nine sit in three thirds
// instead of on top of each other, and a lone meeting keeps the whole
// column. An event then stretches over the lanes to its right that stay free
// for its whole length, which is what keeps a short clash from narrowing a
// long meeting beside it for the rest of the day.
//
// Answers [{event, lane, lanes, span}] in the order the events came; a caller
// places an event at lane / lanes of the column, span / lanes wide.
export function dayLanes(events: CalendarEvent[] | null | undefined, day: DayBounds, hourHeight?: number): DayLane[] {
  var height = Math.max(1, Number(hourHeight) || 60)
  var values = Array.isArray(events) ? events : []
  var items: DayLaneItem[] = []
  for (var i = 0; i < values.length; i++) {
    var event = values[i]
    if (!event || !event.start || displayInAllDayLane(event)) continue
    // Use the actual grid scale: even a zero-length event occupies the
    // two-pixel minimum, and repeated local hours share drawn coordinates.
    var start = eventTop(event, day, 0, height)
    var end = start + eventHeight(event, day, height)
    items.push({ event: event, index: i, start: start, end: end, lane: 0, lanes: 1, span: 1 })
  }
  items.sort(function(a, b) { return a.start - b.start || b.end - a.end || a.index - b.index })
  var out: DayLaneItem[] = []
  var cluster: DayLaneItem[] = []
  var laneEnds: number[] = []
  var clusterEnd = -Infinity
  function close() {
    // Each lane is sorted and non-overlapping. Find the first interval ending
    // after this block starts instead of rescanning the entire cluster.
    var laneItems: DayLaneItem[][] = []
    for (var l = 0; l < laneEnds.length; l++) laneItems.push([])
    for (var n = 0; n < cluster.length; n++) laneItems[cluster[n].lane].push(cluster[n])
    for (var c = 0; c < cluster.length; c++) {
      var item = cluster[c]
      item.lanes = laneEnds.length
      var span = 1
      for (var next = item.lane + 1; next < laneEnds.length; next++) {
        var candidates = laneItems[next]
        var low = 0
        var high = candidates.length
        while (low < high) {
          var middle = Math.floor((low + high) / 2)
          if (candidates[middle].end <= item.start) low = middle + 1
          else high = middle
        }
        if (low < candidates.length && candidates[low].start < item.end) break
        span++
      }
      item.span = span
      out.push(item)
    }
    cluster = []
    laneEnds = []
    clusterEnd = -Infinity
  }
  for (var k = 0; k < items.length; k++) {
    var current = items[k]
    if (current.start >= clusterEnd) close()
    var lane = 0
    while (lane < laneEnds.length && laneEnds[lane] > current.start) lane++
    current.lane = lane
    laneEnds[lane] = current.end
    cluster.push(current)
    clusterEnd = Math.max(clusterEnd, current.end)
  }
  close()
  out.sort(function(a, b) { return a.index - b.index })
  return out.map(function(item) {
    return { event: item.event, lane: item.lane, lanes: item.lanes, span: item.span }
  })
}

export function eventsOnDay(events: CalendarEvent[] | null | undefined, day: DayBounds): CalendarEvent[] {
  var values = Array.isArray(events) ? events : []
  var out: CalendarEvent[] = []
  for (var i = 0; i < values.length; i++) {
    var event = values[i] || {}
    if (!event.start) continue
    var end = event.end ? event.end.ms : event.start.ms + 1
    if (event.start.ms < day.endMs && end > day.startMs) out.push(event)
  }
  out.sort(compareEvents)
  return out
}

// Presentation only: retain timed endpoints for details, editing and writes.
// Compare local calendar days rather than 24 hours across daylight-saving changes.
export function displayInAllDayLane(event: CalendarEvent | null | undefined): boolean {
  if (!event || !event.start) return false
  if (event.start.allDay) return true
  if (!event.end) return false
  var start = new Date(Number(event.start.ms))
  var nextDay = new Date(start.getTime())
  nextDay.setDate(nextDay.getDate() + 1)
  return Number(event.end.ms) >= nextDay.getTime()
}

export function allDayEventsOnDay(events: CalendarEvent[] | null | undefined, day: DayBounds): CalendarEvent[] {
  var values = eventsOnDay(events, day)
  var out: CalendarEvent[] = []
  for (var i = 0; i < values.length; i++) {
    if (displayInAllDayLane(values[i])) out.push(values[i])
  }
  return out
}

export function maxAllDayEvents(events: CalendarEvent[] | null | undefined, days: DayBounds[] | null | undefined): number {
  var values = Array.isArray(days) ? days : []
  var maximum = 0
  for (var i = 0; i < values.length; i++)
    maximum = Math.max(maximum, allDayEventsOnDay(events, values[i]).length)
  return maximum
}

// The hour to open these days at: their first timed event's, or `usual` when
// they have none.
export function weekOpeningHour(events: CalendarEvent[] | null | undefined, days: DayBounds[] | null | undefined, usual: number): number {
  var first = 24
  var values = Array.isArray(events) ? events : []
  var week = Array.isArray(days) ? days : []
  if (week.length === 0) return usual
  var rangeStart = Number(week[0].startMs)
  var rangeEnd = Number(week[week.length - 1].endMs)
  for (var i = 0; i < values.length; i++) {
    var event = values[i] || {}
    if (!event.start || displayInAllDayLane(event)) continue
    var startMs = Number(event.start.ms)
    var endMs = event.end ? Number(event.end.ms) : startMs + 1800000
    if (startMs >= rangeEnd || endMs <= rangeStart) continue
    for (var d = 0; d < week.length; d++) {
      var day = week[d]
      var segmentStart = Math.max(startMs, Number(day.startMs))
      var segmentEnd = Math.min(endMs, Number(day.endMs))
      if (segmentEnd <= segmentStart) continue
      first = Math.min(first, Math.floor(dayMinutes(segmentStart, day) / 60))
    }
  }
  return first < 24 ? first : usual
}

export function slotStart(day: DayBounds, y: number, firstHour: number, hourHeight: number, minuteStep?: number): number {
  var height = Math.max(1, Number(hourHeight) || 1)
  var step = Math.max(1, Math.floor(Number(minuteStep) || 30))
  var minutes = Number(firstHour) * 60 + Math.max(0, Number(y)) / height * 60
  minutes = Math.floor(minutes / step) * step
  var localDay = new Date(Number(day.startMs))
  return new Date(localDay.getFullYear(), localDay.getMonth(), localDay.getDate(),
    Math.floor(minutes / 60), minutes % 60).getTime()
}
