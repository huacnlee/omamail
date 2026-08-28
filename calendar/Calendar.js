.pragma library

.import "../message/Calendar.js" as Ics

function googleResponseError(status, responseText) {
  var payload = null
  try { payload = JSON.parse(String(responseText || "")) } catch (e) {}
  var error = payload && payload.error ? payload.error : null
  var detail = error ? String(error.message || "") : ""
  var reasons = error && Array.isArray(error.errors) ? error.errors : []
  var disabled = /Calendar API has not been used|Calendar API.*disabled/i.test(detail)
  var permissionMissing = /insufficient authentication scopes/i.test(detail)
  for (var i = 0; i < reasons.length; i++) {
    if (String(reasons[i].reason || "") === "accessNotConfigured") disabled = true
    if (String(reasons[i].reason || "") === "insufficientPermissions") permissionMissing = true
  }
  var details = error && Array.isArray(error.details) ? error.details : []
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

function isGoogleCalendarApiDisabledError(message) {
  return /Google Calendar API is not enabled/i.test(String(message || ""))
}

function googleCalendarApiUrl() {
  return "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
}

function two(value) {
  var number = Math.floor(Number(value) || 0)
  return (number < 10 ? "0" : "") + number
}

function utcStamp(ms) {
  var date = new Date(Number(ms) || 0)
  return date.getUTCFullYear() + two(date.getUTCMonth() + 1) + two(date.getUTCDate())
    + "T" + two(date.getUTCHours()) + two(date.getUTCMinutes())
    + two(date.getUTCSeconds()) + "Z"
}

function caldavReport(startMs, endMs) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + '<c:time-range start="' + utcStamp(startMs) + '" end="' + utcStamp(endMs) + '"/>'
    + '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
}

function decodeXml(value) {
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

function tagText(block, localName) {
  var name = String(localName || "").replace(/[^A-Za-z0-9_-]/g, "")
  if (name === "") return ""
  var pattern = new RegExp("<(?:[A-Za-z0-9_-]+:)?" + name
    + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?" + name + ">", "i")
  var match = pattern.exec(String(block || ""))
  return match ? decodeXml(match[1]) : ""
}

function caldavResponses(xml) {
  var input = String(xml || "")
  var pattern = /<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/gi
  var out = []
  var match
  while ((match = pattern.exec(input)) !== null) {
    var data = tagText(match[1], "calendar-data")
    if (data !== "") out.push({ href: tagText(match[1], "href"), data: data })
  }
  return out
}

function recurrenceParts(value) {
  var out = {}
  var pieces = String(value || "").split(";")
  for (var i = 0; i < pieces.length; i++) {
    var equals = pieces[i].indexOf("=")
    if (equals < 0) continue
    out[pieces[i].substring(0, equals).toUpperCase().trim()] =
      pieces[i].substring(equals + 1).trim()
  }
  return out
}

var RECURRENCE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

function datePart(date, localName, utcName, utc) {
  return utc ? date[utcName]() : date[localName]()
}

function calendarDayNumber(date, utc) {
  return Math.floor(Date.UTC(
    datePart(date, "getFullYear", "getUTCFullYear", utc),
    datePart(date, "getMonth", "getUTCMonth", utc),
    datePart(date, "getDate", "getUTCDate", utc)) / 86400000)
}

function weekNumber(date, utc) {
  var day = calendarDayNumber(date, utc)
  var weekday = datePart(date, "getDay", "getUTCDay", utc)
  return Math.floor((day - ((weekday + 6) % 7)) / 7)
}

function nthWeekday(date, utc) {
  return Math.floor((datePart(date, "getDate", "getUTCDate", utc) - 1) / 7) + 1
}

function lastWeekday(date, utc) {
  var year = datePart(date, "getFullYear", "getUTCFullYear", utc)
  var month = datePart(date, "getMonth", "getUTCMonth", utc)
  var last = utc ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    : new Date(year, month + 1, 0).getDate()
  return -Math.floor((last - datePart(date, "getDate", "getUTCDate", utc)) / 7) - 1
}

function matchesByDay(date, raw, utc) {
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

function matchesNumberList(value, raw) {
  var values = String(raw || "").split(",")
  for (var i = 0; i < values.length; i++) {
    if (Number(values[i]) === Number(value)) return true
  }
  return false
}

function recurrenceUntil(value) {
  var text = String(value || "").trim()
  var match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!match) return 0
  if (match[7]) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0))
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)).getTime()
}

function recurrenceStarts(event, rangeEnd) {
  if (!event || !event.start || !event.recurrenceRule) return []
  var parts = recurrenceParts(event.recurrenceRule)
  var frequency = String(parts.FREQ || "").toUpperCase()
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(frequency) < 0) return []
  var interval = Math.max(1, Math.floor(Number(parts.INTERVAL) || 1))
  var countLimit = Math.max(0, Math.floor(Number(parts.COUNT) || 0))
  var until = recurrenceUntil(parts.UNTIL)
  var tzid = String(event.start.tzid || "")
  var source = event.source || {}
  var wallFields = tzid !== "" ? Ics.dateFieldsFromLine(source.dtstart) : null
  var zoned = !!wallFields && !wallFields.dateOnly
  var base = zoned
    ? new Date(Date.UTC(wallFields.year, wallFields.month - 1, wallFields.day,
        wallFields.hour, wallFields.minute, wallFields.second))
    : new Date(Number(event.start.ms))
  var cursor = new Date(base.getTime())
  var utc = zoned
    || !!(event.source && /Z\s*$/i.test(String(event.source.dtstart || "")))
  var out = []
  var count = 0
  var rangeLimit = Number(rangeEnd) || base.getTime()
  var limit = zoned ? rangeLimit + 86400000
    : Math.min(rangeLimit, until > 0 ? until + 1 : rangeLimit)

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

function eventInRange(event, startMs, endMs) {
  if (!event || !event.start) return false
  var start = Number(event.start.ms)
  var end = event.end ? Number(event.end.ms) : start + 1
  return start < Number(endMs) && end > Number(startMs)
}

function occurrenceOf(event, startMs) {
  var copy = {}
  for (var key in event) copy[key] = event[key]
  var delta = Number(startMs) - Number(event.start.ms)
  copy.start = { ms: Number(startMs), allDay: event.start.allDay,
    tzid: event.start.tzid, resolved: event.start.resolved }
  copy.end = event.end ? { ms: Number(event.end.ms) + delta, allDay: event.end.allDay,
    tzid: event.end.tzid, resolved: event.end.resolved } : null
  copy.recurrenceIdMs = Number(startMs)
  return copy
}

function expandRecurringEvents(events, startMs, endMs) {
  var values = Array.isArray(events) ? events : []
  var masters = []
  var overrides = {}
  var standalone = []
  for (var i = 0; i < values.length; i++) {
    var item = values[i]
    if (!item) continue
    if (item.recurrenceIdMs) {
      overrides[String(item.uid) + "\n" + Number(item.recurrenceIdMs)] = item
    } else if (item.recurrenceRule) masters.push(item)
    else standalone.push(item)
  }
  var out = []
  var usedOverrides = {}
  for (var s = 0; s < standalone.length; s++) {
    if (standalone[s].status !== "CANCELLED" && eventInRange(standalone[s], startMs, endMs))
      out.push(standalone[s])
  }
  for (var m = 0; m < masters.length; m++) {
    var master = masters[m]
    var excluded = {}
    var exclusions = Array.isArray(master.excludedMs) ? master.excludedMs : []
    for (var x = 0; x < exclusions.length; x++) excluded[Number(exclusions[x])] = true
    var starts = recurrenceStarts(master, endMs)
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

function eventsFromCaldav(xml, sourceId, rangeStart, rangeEnd) {
  var responses = caldavResponses(xml)
  var out = []
  for (var i = 0; i < responses.length; i++) {
    var events = Ics.eventsFrom(responses[i].data)
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

function googleMoment(value, dateOnly) {
  var text = String(value || "")
  if (text === "") return null
  var ms = dateOnly
    ? new Date(Number(text.substring(0, 4)), Number(text.substring(5, 7)) - 1,
        Number(text.substring(8, 10))).getTime()
    : Date.parse(text)
  if (!isFinite(ms)) return null
  return { ms: ms, allDay: dateOnly, tzid: "", resolved: true }
}

function eventsFromGoogle(payload, sourceId) {
  var items = payload && Array.isArray(payload.items) ? payload.items : []
  var out = []
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
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
      sequence: Math.max(0, Math.floor(Number(item.sequence) || 0)),
      summary: String(item.summary || "Untitled event"),
      description: String(item.description || ""), location: String(item.location || ""),
      status: String(item.status || "").toUpperCase(), organizer: item.organizer || null,
      attendees: Array.isArray(item.attendees) ? item.attendees : [],
      start: start, end: end, recurrence: Array.isArray(item.recurrence)
        ? item.recurrence.join("; ") : "", meetLink: String(item.hangoutLink || ""),
      sourceId: String(sourceId || ""), href: String(item.htmlLink || ""), source: null
    })
  }
  out.sort(compareEvents)
  return out
}

function googleEventsUrl(startMs, endMs) {
  return "https://www.googleapis.com/calendar/v3/calendars/primary/events?"
    + "singleEvents=true&orderBy=startTime&maxResults=2500"
    + "&timeMin=" + encodeURIComponent(new Date(Number(startMs) || 0).toISOString())
    + "&timeMax=" + encodeURIComponent(new Date(Number(endMs) || 0).toISOString())
}

function icsText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;")
}

function icsUtc(ms) {
  return new Date(Number(ms)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

// A date-only stamp is the local calendar day: the ms of an all-day boundary
// is local midnight, so the fields are read back off the local clock and no
// timezone can move the written date.
function icsDate(ms) {
  var date = new Date(Number(ms))
  return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate())
}

function recurrenceRule(raw) {
  var value = raw || {}
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

function recurrenceIntervalUnit(frequency, interval) {
  var units = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }
  var unit = units[String(frequency || "").toUpperCase()] || "interval"
  return Number(interval) === 1 ? unit : unit + "s"
}

function validateEventFields(fields) {
  var value = fields || {}
  var title = String(value.title || "").trim()
  var start = Number(value.startMs)
  var end = Number(value.endMs)
  if (title === "") return { ok: false, error: "Add an event title" }
  if (!isFinite(start) || !isFinite(end)) return { ok: false, error: "Add valid start and end times" }
  if (end <= start) return { ok: false, error: "End time must be after start time" }
  return { ok: true, title: title, start: start, end: end,
    description: String(value.description || ""), location: String(value.location || "") }
}

function veventLines(uid, sequence, stampMs, fields, rule, allDay) {
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

function editableEventLines(sequence, stampMs, fields, allDay) {
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

function googleEventBody(fields, allDay) {
  var body = {
    summary: fields.title, description: fields.description, location: fields.location
  }
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

function createEvent(fields, nowMs) {
  var checked = validateEventFields(fields)
  if (!checked.ok) return checked
  var recurrence = recurrenceRule((fields || {}).recurrence)
  if (!recurrence.ok) return recurrence
  var uid = "omamail-" + Math.floor(Number(nowMs) || Date.now())
  var result = {
    ok: true, uid: uid,
    ics: veventLines(uid, 0, Number(nowMs) || Date.now(), checked, recurrence.rule).join("\r\n"),
    google: googleEventBody(checked)
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
function writeRefusal(source, event) {
  if (!source) return "Choose a calendar"
  if (source.readOnly === true) return "This calendar is read-only"
  if (source.kind !== "caldav") return ""
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
// runs. Which shape the event has is likewise not a question an edit answers:
// an all-day event stays VALUE=DATE and a Google date, a timed one stays a
// date-time, so a title-only change cannot turn one into the other.
function updateEvent(fields, existing, nowMs) {
  var event = existing || {}
  var uid = String(event.uid || "")
  if (uid === "") return { ok: false, error: "The event has no identity to update" }
  var checked = validateEventFields(fields)
  if (!checked.ok) return checked
  var sequence = Math.max(0, Math.floor(Number(event.sequence) || 0)) + 1
  var allDay = !!(event.start && event.start.allDay)
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
    google: googleEventBody(checked, allDay)
  }
}

function googleEventUrl(eventId) {
  return "https://www.googleapis.com/calendar/v3/calendars/primary/events/"
    + encodeURIComponent(String(eventId || ""))
}

// The scheme and authority of an HTTPS URL. Anything else — http, a bare
// path, junk — has no authority here, because a write address is HTTPS or
// nothing.
function urlAuthority(url) {
  var match = /^(https):\/\/([^\/?#]+)/i.exec(String(url || ""))
  return match ? match[1].toLowerCase() + "://" + match[2] : ""
}

// scheme://host:port with the port made explicit and the case-insensitive
// parts folded, so two spellings of the same origin compare equal.
function urlOrigin(url) {
  var match = /^(https):\/\/([^\/?#:]+)(?::(\d+))?/i.exec(String(url || ""))
  if (!match) return ""
  return match[1].toLowerCase() + "://" + match[2].toLowerCase() + ":"
    + (match[3] ? String(Number(match[3])) : "443")
}

// A REPORT answers with the event's own href, which the server may write as a
// full URL or as a path against the host the collection lives on. An absolute
// href is accepted only on the collection's own origin: anything else would
// send this calendar's credentials to a server that merely named an address
// in an answer. Raw whitespace is refused outright — a URL's spaces arrive
// percent-encoded, and the resolved address becomes one quoted line of the
// transport's curl config, where a line break would write more options.
function caldavEventUrl(sourceUrl, event) {
  var base = String(sourceUrl || "")
  var origin = urlOrigin(base)
  if (origin === "") return ""
  var href = String(event && event.href || "")
  if (/\s/.test(href)) return ""
  if (/^https:\/\//i.test(href) || href.substring(0, 2) === "//") {
    var candidate = href.substring(0, 2) === "//" ? "https:" + href : href
    return urlOrigin(candidate) === origin ? candidate : ""
  }
  if (href.charAt(0) === "/") return urlAuthority(base) + href
  if (href !== "") {
    var collection = base.charAt(base.length - 1) === "/" ? base : base + "/"
    return collection + href
  }
  var uid = String(event && event.uid || "")
  if (uid === "") return ""
  var root = base.charAt(base.length - 1) === "/" ? base : base + "/"
  return root + encodeURIComponent(uid) + ".ics"
}

function compareEvents(left, right) {
  var leftMs = left && left.start ? left.start.ms : 0
  var rightMs = right && right.start ? right.start.ms : 0
  if (leftMs !== rightMs) return leftMs - rightMs
  return String(left && left.summary || "").localeCompare(String(right && right.summary || ""))
}

function isoDate(date) {
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate())
}

function monthDays(year, monthIndex, weekStart) {
  var first = new Date(Number(year), Number(monthIndex), 1)
  var startDay = Math.floor(Number(weekStart))
  if (!isFinite(startDay) || startDay < 0 || startDay > 6) startDay = 1
  var offset = (first.getDay() - startDay + 7) % 7
  var cursor = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  var out = []
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

function weekDays(anchorMs, weekStart) {
  var anchor = new Date(Number(anchorMs) || Date.now())
  var startDay = Math.floor(Number(weekStart))
  if (!isFinite(startDay) || startDay < 0 || startDay > 6) startDay = 1
  var offset = (anchor.getDay() - startDay + 7) % 7
  var start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset)
  var out = []
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

function weekTitle(days) {
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
function dayMinutes(timeMs, day) {
  var value = Number(timeMs)
  if (value <= Number(day.startMs)) return 0
  if (value >= Number(day.endMs)) return 1440
  var local = new Date(value)
  return local.getHours() * 60 + local.getMinutes()
    + local.getSeconds() / 60 + local.getMilliseconds() / 60000
}

function eventTop(event, day, firstHour, hourHeight) {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var minutes = dayMinutes(start, day) - Number(firstHour) * 60
  return Math.max(0, minutes / 60 * Number(hourHeight))
}

function eventHeight(event, day, hourHeight) {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var end = event.end ? Math.min(Number(event.end.ms), Number(day.endMs)) : start + 1800000
  return Math.max(Number(hourHeight) * 0.42,
    (dayMinutes(end, day) - dayMinutes(start, day)) / 60 * Number(hourHeight))
}

// Where "now" sits in a day column, or -1 when it does not belong on the grid:
// another day, or an hour outside the range the week view drew. The caller
// draws nothing on -1 rather than clamping to an edge, because a line pinned to
// the top of the grid states a time that is not the time — and the range here
// is elastic, since weekHourRange widens it to whatever the week's events need.
function nowOffset(day, firstHour, lastHour, hourHeight, nowMs) {
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

function timeLabel(timeMs) {
  var time = new Date(Number(timeMs))
  if (!isFinite(time.getTime())) return ""
  return two(time.getHours()) + ":" + two(time.getMinutes())
}

// The same offset for the week as a whole, so the time rail can label the line
// without the view having to work out which of the seven columns is today.
// Returns -1 when today is not in view at all, which is every week but this one.
function weekNowOffset(days, firstHour, lastHour, hourHeight, nowMs) {
  var values = Array.isArray(days) ? days : []
  for (var i = 0; i < values.length; i++) {
    var offset = nowOffset(values[i], firstHour, lastHour, hourHeight, nowMs)
    if (offset >= 0) return offset
  }
  return -1
}

function eventsOnDay(events, day) {
  var values = Array.isArray(events) ? events : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var event = values[i] || {}
    if (!event.start) continue
    var end = event.end ? event.end.ms : event.start.ms + 1
    if (event.start.ms < day.endMs && end > day.startMs) out.push(event)
  }
  out.sort(compareEvents)
  return out
}

function allDayEventsOnDay(events, day) {
  var values = eventsOnDay(events, day)
  var out = []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].start && values[i].start.allDay) out.push(values[i])
  }
  return out
}

function maxAllDayEvents(events, days) {
  var values = Array.isArray(days) ? days : []
  var maximum = 0
  for (var i = 0; i < values.length; i++)
    maximum = Math.max(maximum, allDayEventsOnDay(events, values[i]).length)
  return maximum
}

function weekHourRange(events, days, defaultFirst, defaultLast) {
  var first = Math.max(0, Math.min(23, Math.floor(Number(defaultFirst) || 0)))
  var last = Math.max(first + 1, Math.min(24, Math.ceil(Number(defaultLast) || 24)))
  var values = Array.isArray(events) ? events : []
  var week = Array.isArray(days) ? days : []
  if (week.length === 0) return { first: first, last: last }
  var rangeStart = Number(week[0].startMs)
  var rangeEnd = Number(week[week.length - 1].endMs)
  for (var i = 0; i < values.length; i++) {
    var event = values[i] || {}
    if (!event.start || event.start.allDay) continue
    var startMs = Number(event.start.ms)
    var endMs = event.end ? Number(event.end.ms) : startMs + 1800000
    if (startMs >= rangeEnd || endMs <= rangeStart) continue
    for (var d = 0; d < week.length; d++) {
      var day = week[d]
      var segmentStart = Math.max(startMs, Number(day.startMs))
      var segmentEnd = Math.min(endMs, Number(day.endMs))
      if (segmentEnd <= segmentStart) continue
      var startMinutes = dayMinutes(segmentStart, day)
      var endMinutes = dayMinutes(segmentEnd, day)
      first = Math.min(first, Math.floor(startMinutes / 60))
      last = Math.max(last, Math.min(24, Math.ceil(endMinutes / 60)))
    }
  }
  return { first: first, last: last }
}

function slotStart(day, y, firstHour, hourHeight, minuteStep) {
  var height = Math.max(1, Number(hourHeight) || 1)
  var step = Math.max(1, Math.floor(Number(minuteStep) || 30))
  var minutes = Number(firstHour) * 60 + Math.max(0, Number(y)) / height * 60
  minutes = Math.floor(minutes / step) * step
  var localDay = new Date(Number(day.startMs))
  return new Date(localDay.getFullYear(), localDay.getMonth(), localDay.getDate(),
    Math.floor(minutes / 60), minutes % 60).getTime()
}
