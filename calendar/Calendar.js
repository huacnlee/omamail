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
  var base = new Date(Number(event.start.ms))
  var cursor = new Date(base.getTime())
  var utc = !!(event.source && /Z\s*$/i.test(String(event.source.dtstart || "")))
  var out = []
  var count = 0
  var limit = Math.min(Number(rangeEnd) || base.getTime(),
    until > 0 ? until + 1 : Number(rangeEnd) || base.getTime())

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
    if (matches && cursor.getTime() >= base.getTime()) {
      count++
      if (countLimit > 0 && count > countLimit) break
      if (!until || cursor.getTime() <= until) out.push(cursor.getTime())
    }
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

function createEvent(fields, nowMs) {
  var value = fields || {}
  var title = String(value.title || "").trim()
  var start = Number(value.startMs)
  var end = Number(value.endMs)
  if (title === "") return { ok: false, error: "Add an event title" }
  if (!isFinite(start) || !isFinite(end)) return { ok: false, error: "Add valid start and end times" }
  if (end <= start) return { ok: false, error: "End time must be after start time" }
  var recurrence = recurrenceRule(value.recurrence)
  if (!recurrence.ok) return recurrence
  var uid = "omamail-" + Math.floor(Number(nowMs) || Date.now())
  var description = String(value.description || "")
  var location = String(value.location || "")
  var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Omamail//Calendar//EN",
    "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + icsUtc(nowMs || Date.now()),
    "DTSTART:" + icsUtc(start), "DTEND:" + icsUtc(end), "SUMMARY:" + icsText(title)]
  if (description !== "") lines.push("DESCRIPTION:" + icsText(description))
  if (location !== "") lines.push("LOCATION:" + icsText(location))
  if (recurrence.rule !== "") lines.push("RRULE:" + recurrence.rule)
  lines.push("END:VEVENT", "END:VCALENDAR", "")
  var result = {
    ok: true, uid: uid, ics: lines.join("\r\n"),
    google: {
      summary: title, description: description, location: location,
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() }
    }
  }
  if (recurrence.rule !== "") result.google.recurrence = ["RRULE:" + recurrence.rule]
  return result
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

function eventTop(event, day, firstHour, hourHeight) {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var minutes = (start - Number(day.startMs)) / 60000 - Number(firstHour) * 60
  return Math.max(0, minutes / 60 * Number(hourHeight))
}

function eventHeight(event, day, hourHeight) {
  if (!event || !event.start || event.start.allDay) return 0
  var start = Math.max(Number(event.start.ms), Number(day.startMs))
  var end = event.end ? Math.min(Number(event.end.ms), Number(day.endMs)) : start + 1800000
  return Math.max(Number(hourHeight) * 0.42, (end - start) / 3600000 * Number(hourHeight))
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
      var startMinutes = (segmentStart - Number(day.startMs)) / 60000
      var endMinutes = (segmentEnd - Number(day.startMs)) / 60000
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
  return Number(day.startMs) + minutes * 60000
}
