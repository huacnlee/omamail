.pragma library

.import "Message.js" as Mail

// A meeting invitation, out of the message that carried it.
//
// Google Calendar does not send a special kind of mail. It sends an ordinary
// one with a `text/calendar` part beside the HTML, and every calendar that
// speaks RFC 5545 does the same — which is why this reads the part rather than
// the sender, and works for Outlook, Fastmail and a self-hosted CalDAV server
// without knowing that any of them exist.
//
// Answering one is a mail too: an RFC 5546 REPLY, addressed to the organiser,
// carrying the same UID with this account's ATTENDEE line rewritten. That is
// the whole protocol, and it is why RSVP needs no calendar API, no second
// OAuth scope, and works the same on IMAP as on Gmail.

var MAX_ICS_BYTES = 512 * 1024
var MAX_COMPONENT_DEPTH = 8

// --------------------------------------------------------------- unfolding

// A long property is split across lines with a leading space or tab, and the
// break can fall anywhere — including between the two halves of a UTF-8
// character or in the middle of an escape. Rejoining before anything else
// looks at the text is what keeps every parse below reading whole values.
function unfoldLines(text) {
  var joined = String(text || "").replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "")
  var lines = joined.split(/\r\n|\n|\r/)
  var out = []
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] !== "") out.push(lines[i])
  }
  return out
}

// ------------------------------------------------------------------ values

function unescapeText(value) {
  var input = String(value === undefined || value === null ? "" : value)
  var out = ""
  for (var i = 0; i < input.length; i++) {
    var character = input.charAt(i)
    if (character !== "\\") {
      out += character
      continue
    }
    var next = input.charAt(i + 1)
    if (next === "n" || next === "N") out += "\n"
    else if (next === "\\" || next === ";" || next === "," || next === ":") out += next
    else if (next === "") out += character
    else out += next
    i++
  }
  return out
}

function escapeText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n")
}

// ------------------------------------------------------------- one property
//
// The colon that ends the name and its parameters is not the first colon in
// the line: a parameter value may be quoted and hold one, and every value that
// names a person holds "mailto:". So the head is scanned rather than split.

function parseProperty(line) {
  var text = String(line || "")
  var quoted = false
  var cut = -1
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i)
    if (character === "\"") quoted = !quoted
    else if (character === ":" && !quoted) { cut = i; break }
  }
  if (cut < 0) return null

  var head = text.substring(0, cut)
  var value = text.substring(cut + 1)

  var pieces = splitOutsideQuotes(head, ";")
  var name = String(pieces.length > 0 ? pieces[0] : "").toUpperCase().trim()
  if (name === "") return null

  var params = {}
  for (var j = 1; j < pieces.length; j++) {
    var equals = pieces[j].indexOf("=")
    if (equals < 0) continue
    var key = pieces[j].substring(0, equals).toUpperCase().trim()
    var raw = pieces[j].substring(equals + 1).trim()
    if (key !== "") params[key] = stripQuotes(raw)
  }

  return { name: name, params: params, value: value, raw: text }
}

function splitOutsideQuotes(text, separator) {
  var input = String(text || "")
  var out = []
  var current = ""
  var quoted = false
  for (var i = 0; i < input.length; i++) {
    var character = input.charAt(i)
    if (character === "\"") {
      quoted = !quoted
      current += character
      continue
    }
    if (character === separator && !quoted) {
      out.push(current)
      current = ""
      continue
    }
    current += character
  }
  out.push(current)
  return out
}

function stripQuotes(value) {
  var text = String(value || "").trim()
  if (text.length >= 2 && text.charAt(0) === "\"" && text.charAt(text.length - 1) === "\"")
    return text.substring(1, text.length - 1)
  return text
}

// ------------------------------------------------------------- the document
//
// A component keeps its own source lines as well as its parsed properties. A
// REPLY has to hand the organiser's server back a DTSTART it recognises, and
// the faithful one is the line that arrived rather than one rebuilt out of a
// time this parser may have had to guess at.

function parse(text) {
  var source = String(text || "")
  if (source.length > MAX_ICS_BYTES) return null
  var lines = unfoldLines(source)
  var root = null
  var stack = []

  for (var i = 0; i < lines.length; i++) {
    var property = parseProperty(lines[i])
    if (!property) continue
    var open = stack.length > 0 ? stack[stack.length - 1] : null

    if (property.name === "BEGIN") {
      if (stack.length >= MAX_COMPONENT_DEPTH) continue
      var child = {
        name: String(property.value || "").toUpperCase().trim(),
        properties: [],
        children: [],
        lines: []
      }
      if (open) {
        open.children.push(child)
      } else if (root === null) {
        root = child
      } else {
        continue
      }
      stack.push(child)
      continue
    }

    if (property.name === "END") {
      if (stack.length === 0) continue
      var closing = stack.pop()
      var parent = stack.length > 0 ? stack[stack.length - 1] : null
      // The whole of the child, not the line that closed it. A component's
      // `lines` has to be its complete source or the VTIMEZONE a reply carries
      // back is a header with its rules missing — which is a reply the
      // organiser's server cannot place in time.
      if (parent) {
        parent.lines = parent.lines
          .concat(["BEGIN:" + closing.name], closing.lines, ["END:" + closing.name])
      }
      if (closing !== root && stack.length === 0) break
      continue
    }

    if (!open) continue
    open.properties.push(property)
    open.lines.push(lines[i])
  }

  return root
}

function childNamed(component, name) {
  var children = component && Array.isArray(component.children) ? component.children : []
  var wanted = String(name || "").toUpperCase()
  for (var i = 0; i < children.length; i++) {
    if (children[i].name === wanted) return children[i]
  }
  return null
}

function childrenNamed(component, name) {
  var children = component && Array.isArray(component.children) ? component.children : []
  var wanted = String(name || "").toUpperCase()
  var out = []
  for (var i = 0; i < children.length; i++) {
    if (children[i].name === wanted) out.push(children[i])
  }
  return out
}

function property(component, name) {
  var list = component && Array.isArray(component.properties) ? component.properties : []
  var wanted = String(name || "").toUpperCase()
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === wanted) return list[i]
  }
  return null
}

function properties(component, name) {
  var list = component && Array.isArray(component.properties) ? component.properties : []
  var wanted = String(name || "").toUpperCase()
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === wanted) out.push(list[i])
  }
  return out
}

function textOf(component, name) {
  var found = property(component, name)
  return found ? unescapeText(found.value).trim() : ""
}

// ------------------------------------------------------------------- times

function twoDigits(value) {
  var number = Math.floor(Number(value) || 0)
  return (number < 10 ? "0" : "") + number
}

// "20260821", "20260821T140000" or "20260821T140000Z". Anything else is not a
// date this can be sure about, and a wrong meeting time is worse than none.
function parseDateValue(value) {
  var text = String(value || "").trim()
  var match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!match) return null
  var fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
    utc: match[7] === "Z",
    dateOnly: match[4] === undefined
  }
  if (fields.month < 1 || fields.month > 12 || fields.day < 1 || fields.day > 31) return null
  if (fields.hour > 23 || fields.minute > 59 || fields.second > 60) return null
  return fields
}

function parseOffsetMinutes(value) {
  var match = String(value || "").trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/)
  if (!match) return null
  var minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === "-" ? -minutes : minutes
}

// The naive local time as a number that sorts: comparing two of these compares
// the wall clocks they read, which is the only comparison a timezone rule is
// written in terms of.
function naiveKey(fields) {
  return Date.UTC(fields.year, fields.month - 1, fields.day,
    fields.hour, fields.minute, fields.second)
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// "the second Sunday in March", "the last Sunday in October". Ordinal 0 means
// the caller had a BYDAY with no number, which for a timezone rule is always
// the first one.
function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  var total = daysInMonth(year, month)
  if (ordinal < 0) {
    for (var back = total; back >= 1; back--) {
      if (new Date(Date.UTC(year, month - 1, back)).getUTCDay() === weekday) {
        var skipped = -ordinal - 1
        var day = back - skipped * 7
        return day >= 1 ? day : 0
      }
    }
    return 0
  }
  var wanted = ordinal < 1 ? 1 : ordinal
  var seen = 0
  for (var forward = 1; forward <= total; forward++) {
    if (new Date(Date.UTC(year, month - 1, forward)).getUTCDay() !== weekday) continue
    seen++
    if (seen === wanted) return forward
  }
  return 0
}

var WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

function weekdayIndex(code) {
  return WEEKDAY_CODES.indexOf(String(code || "").toUpperCase())
}

function parseRuleParts(value) {
  var parts = {}
  var pieces = String(value || "").split(";")
  for (var i = 0; i < pieces.length; i++) {
    var equals = pieces[i].indexOf("=")
    if (equals < 0) continue
    parts[pieces[i].substring(0, equals).toUpperCase().trim()] =
      pieces[i].substring(equals + 1).trim()
  }
  return parts
}

// When one of a VTIMEZONE's rules takes effect, in the year asked about. The
// rules that matter are the ones real zones are written with: a yearly BYMONTH
// with an ordinal BYDAY, a yearly BYMONTH with a BYMONTHDAY, or no rule at all
// — a single dated transition, which is what a fixed-offset zone has.
function transitionIn(rule, year) {
  var start = parseDateValue(textOf(rule.component, "DTSTART"))
  if (!start) return null
  var recurrence = property(rule.component, "RRULE")
  if (!recurrence) {
    return start.year === year ? naiveKey(start) : null
  }

  var parts = parseRuleParts(recurrence.value)
  if (String(parts.FREQ || "").toUpperCase() !== "YEARLY") return null
  var month = Math.floor(Number(parts.BYMONTH) || start.month)
  if (month < 1 || month > 12) return null

  var day = 0
  if (parts.BYDAY) {
    var match = String(parts.BYDAY).split(",")[0].match(/^([+-]?\d+)?([A-Za-z]{2})$/)
    if (!match) return null
    var index = weekdayIndex(match[2])
    if (index < 0) return null
    day = nthWeekdayOfMonth(year, month, index, Number(match[1] || 0))
  } else if (parts.BYMONTHDAY) {
    day = Math.floor(Number(String(parts.BYMONTHDAY).split(",")[0]) || 0)
    if (day < 0) day = daysInMonth(year, month) + day + 1
  } else {
    day = start.day
  }
  if (day < 1 || day > daysInMonth(year, month)) return null

  return Date.UTC(year, month - 1, day, start.hour, start.minute, start.second)
}

// The offset a zone was on at a given wall-clock reading.
//
// This is not a timezone database and does not try to be one. It reads the
// VTIMEZONE the sender shipped in the same file, which is what the standard
// asks a sender to include for exactly this reason, and picks the rule whose
// most recent transition is behind the time being asked about. The hour a
// clock goes back is genuinely ambiguous and is resolved to the later offset;
// no reading of that hour is more correct than another.
function zoneOffsetMinutes(timezone, fields) {
  if (!timezone) return null
  var rules = []
  // STANDARD first, and that ordering is load-bearing: a zone whose rules this
  // cannot place — no RRULE and dates outside the years looked at, which is
  // what an RDATE-driven Exchange zone looks like from here — falls back to
  // rules[0], and being an hour behind in winter is a better wrong answer than
  // being an hour ahead all year.
  var kinds = ["STANDARD", "DAYLIGHT"]
  for (var k = 0; k < kinds.length; k++) {
    var found = childrenNamed(timezone, kinds[k])
    for (var i = 0; i < found.length; i++) {
      var offset = parseOffsetMinutes(textOf(found[i], "TZOFFSETTO"))
      if (offset === null) continue
      rules.push({ component: found[i], offset: offset })
    }
  }
  if (rules.length === 0) return null
  if (rules.length === 1) return rules[0].offset

  var wanted = naiveKey(fields)
  var best = null
  for (var year = fields.year - 1; year <= fields.year + 1; year++) {
    for (var r = 0; r < rules.length; r++) {
      var at = transitionIn(rules[r], year)
      if (at === null || at > wanted) continue
      if (best === null || at >= best.at) best = { at: at, offset: rules[r].offset }
    }
  }
  if (best) return best.offset

  // Before every transition this file describes. The offset in force then is
  // the one the earliest transition moved away from.
  var earliest = null
  for (var s = 0; s < rules.length; s++) {
    var opening = transitionIn(rules[s], fields.year - 1)
    if (opening === null) continue
    if (earliest === null || opening < earliest.at) {
      earliest = {
        at: opening,
        offset: parseOffsetMinutes(textOf(rules[s].component, "TZOFFSETFROM"))
      }
    }
  }
  return earliest && earliest.offset !== null ? earliest.offset : rules[0].offset
}

function timezoneFor(calendar, tzid) {
  var wanted = String(tzid || "").trim()
  if (wanted === "") return null
  var zones = childrenNamed(calendar, "VTIMEZONE")
  for (var i = 0; i < zones.length; i++) {
    if (textOf(zones[i], "TZID") === wanted) return zones[i]
  }
  return null
}

// A moment, and how sure this is of it. `resolved` false means the wall clock
// is right and the zone is a guess — which the card says out loud rather than
// showing a converted time it cannot stand behind.
function resolveTime(found, calendar) {
  if (!found) return null
  var fields = parseDateValue(found.value)
  if (!fields) return null
  var tzid = String(found.params && found.params.TZID ? found.params.TZID : "").trim()

  if (fields.dateOnly) {
    return {
      ms: new Date(fields.year, fields.month - 1, fields.day).getTime(),
      allDay: true, tzid: "", resolved: true
    }
  }
  if (fields.utc) {
    return { ms: naiveKey(fields), allDay: false, tzid: "", resolved: true }
  }
  if (tzid !== "") {
    if (/^(UTC|GMT|Z|Etc\/UTC|Etc\/GMT)$/i.test(tzid))
      return { ms: naiveKey(fields), allDay: false, tzid: "", resolved: true }
    var offset = zoneOffsetMinutes(timezoneFor(calendar, tzid), fields)
    if (offset !== null) {
      return { ms: naiveKey(fields) - offset * 60000, allDay: false, tzid: tzid, resolved: true }
    }
    // A named zone with no VTIMEZONE beside it. The wall clock is what the
    // organiser wrote; saying which clock it is beats converting it wrongly.
    return {
      ms: new Date(fields.year, fields.month - 1, fields.day,
        fields.hour, fields.minute, fields.second).getTime(),
      allDay: false, tzid: tzid, resolved: false
    }
  }
  // Floating: the standard says this is local time wherever it is read.
  return {
    ms: new Date(fields.year, fields.month - 1, fields.day,
      fields.hour, fields.minute, fields.second).getTime(),
    allDay: false, tzid: "", resolved: true
  }
}

// "PT1H30M", "P2D", "P1W". Returns milliseconds, or 0 for anything unreadable.
function parseDuration(value) {
  var text = String(value || "").trim().toUpperCase()
  var match = text.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!match) return 0
  var total = Number(match[2] || 0) * 604800000
    + Number(match[3] || 0) * 86400000
    + Number(match[4] || 0) * 3600000
    + Number(match[5] || 0) * 60000
    + Number(match[6] || 0) * 1000
  return match[1] === "-" ? -total : total
}

// -------------------------------------------------------------- recurrence

var WEEKDAY_NAMES = {
  SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat"
}

var FREQUENCY_NAMES = {
  DAILY: ["Daily", "days"],
  WEEKLY: ["Weekly", "weeks"],
  MONTHLY: ["Monthly", "months"],
  YEARLY: ["Yearly", "years"]
}

// A sentence for the card, not a full RRULE expansion. It covers what a person
// actually schedules — every week on two days, every other Tuesday, ten times,
// until a date — and says "Repeats" for anything more elaborate rather than
// describing it wrongly.
function describeRecurrence(value) {
  var text = String(value || "").trim()
  if (text === "") return ""
  var parts = parseRuleParts(text)
  var frequency = String(parts.FREQ || "").toUpperCase()
  var names = FREQUENCY_NAMES[frequency]
  if (!names) return "Repeats"

  var interval = Math.floor(Number(parts.INTERVAL) || 1)
  var sentence = interval > 1 ? "Every " + interval + " " + names[1] : names[0]

  if (parts.BYDAY && (frequency === "WEEKLY" || frequency === "MONTHLY")) {
    var codes = String(parts.BYDAY).split(",")
    var days = []
    for (var i = 0; i < codes.length; i++) {
      var match = codes[i].trim().match(/^([+-]?\d+)?([A-Za-z]{2})$/)
      if (!match) continue
      var name = WEEKDAY_NAMES[match[2].toUpperCase()]
      if (name) days.push(name)
    }
    if (days.length > 0) sentence += " on " + days.join(", ")
  }

  if (parts.COUNT) {
    var count = Math.floor(Number(parts.COUNT) || 0)
    if (count > 0) sentence += ", " + count + " times"
  } else if (parts.UNTIL) {
    var end = parseDateValue(parts.UNTIL)
    if (end) {
      sentence += ", until " + Mail.MONTHS[end.month - 1] + " " + end.day + ", " + end.year
    }
  }
  return sentence
}

// -------------------------------------------------------------- addressing

function calendarAddress(found) {
  if (!found) return null
  var params = found.params || {}
  var email = String(found.value || "").replace(/^mailto:/i, "").trim()
  var name = unescapeText(params.CN || "").trim()
  return {
    name: name !== "" ? name : email,
    email: email,
    partstat: String(params.PARTSTAT || "").toUpperCase(),
    role: String(params.ROLE || "").toUpperCase(),
    optional: String(params.ROLE || "").toUpperCase() === "OPT-PARTICIPANT",
    resource: String(params.CUTYPE || "").toUpperCase() === "RESOURCE"
  }
}

function sameAddress(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase()
}

// Which of the attendee lines is this account, and what it last said. An
// invitation forwarded to an alias has no line naming the reader at all, which
// is a real state and not an error: the card still shows the meeting, and
// answering it speaks for the address the mail is being read from.
function attendeeFor(invite, address) {
  var list = invite && Array.isArray(invite.attendees) ? invite.attendees : []
  for (var i = 0; i < list.length; i++) {
    if (sameAddress(list[i].email, address)) return list[i]
  }
  return null
}

function responseOf(invite, address) {
  var attendee = attendeeFor(invite, address)
  if (!attendee) return ""
  if (attendee.partstat === "ACCEPTED") return "accepted"
  if (attendee.partstat === "DECLINED") return "declined"
  if (attendee.partstat === "TENTATIVE") return "tentative"
  return ""
}

// ------------------------------------------------------------- conferencing

var MEET_URL = /https:\/\/meet\.google\.com\/[a-z0-9-]+/i
var CONFERENCE_URL = /https:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|whereby\.com|webex\.com|chime\.aws)\/[^\s<>"]+/i

// Google puts the Meet link in a property of its own; everyone else leaves it
// in the location or somewhere in the description. Looked for in that order,
// because the property is the only one of the three that cannot be a sentence
// about a link rather than the link itself.
function conferenceLink(event) {
  var declared = textOf(event, "X-GOOGLE-CONFERENCE")
  if (MEET_URL.test(declared)) return declared.match(MEET_URL)[0]

  var fields = [textOf(event, "LOCATION"), textOf(event, "DESCRIPTION")]
  for (var i = 0; i < fields.length; i++) {
    var meet = fields[i].match(MEET_URL)
    if (meet) return meet[0]
  }
  for (var j = 0; j < fields.length; j++) {
    var other = fields[j].match(CONFERENCE_URL)
    if (other) return other[0]
  }
  return ""
}

// ---------------------------------------------------------- the invitation

var METHODS = ["REQUEST", "REPLY", "CANCEL", "PUBLISH", "COUNTER", "REFRESH", "ADD", "DECLINECOUNTER"]

function normalizedMethod(value) {
  var text = String(value || "").toUpperCase().trim()
  return METHODS.indexOf(text) >= 0 ? text : ""
}

// The MIME part carrying the invitation, if the message has one.
//
// Preferred in the order that gets a usable one: a part that came with its own
// octets first, because the whole invitation is already here. A part that came
// as an id is the fallback, and not a rare one — Gmail withholds the octets of
// every part the sender named, and Google Calendar names both of the two it
// sends, so on Gmail this is how a Google invitation always arrives.
function calendarPart(payload) {
  var carried = null
  var promised = null

  function walk(part, depth) {
    if (!part || depth > 12) return
    var mimeType = String(part.mimeType || "").split(";")[0].trim().toLowerCase()
    var filename = String(part.filename || "")
    var isCalendar = mimeType === "text/calendar" || mimeType === "application/ics"
      || (mimeType === "application/octet-stream" && /\.ics$/i.test(filename))
    var data = part.body && part.body.data ? String(part.body.data) : ""
    var attachmentId = part.body && part.body.attachmentId
      ? String(part.body.attachmentId) : ""
    // Measured before it is decoded, not after. This runs on the thread that
    // draws the whole desktop, and a part that would be refused for its size
    // anyway should not be turned into five megabytes of string first.
    var size = Math.max(Math.floor(Number(part.body && part.body.size) || 0),
      Math.floor(data.length * 3 / 4))
    if (isCalendar && size <= MAX_ICS_BYTES) {
      if (data !== "") {
        if (carried === null) carried = part
      } else if (attachmentId !== "" && promised === null) promised = part
    }
    var children = Array.isArray(part.parts) ? part.parts : []
    for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
  }

  walk(payload, 0)
  return carried !== null ? carried : promised
}

// The Content-Type of the part states the method too, and it is the one a
// server that rewrote the body may have kept. The property inside the file
// wins, because it is the one the organiser's calendar wrote.
function partMethod(part) {
  if (!part) return ""
  var declared = Mail.contentTypeParam(String(part.mimeType || ""), "method")
  if (declared === "") {
    var headers = part && Array.isArray(part.headers) ? part.headers : []
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name || "").toLowerCase() !== "content-type") continue
      declared = Mail.contentTypeParam(headers[i].value, "method")
      if (declared !== "") break
    }
  }
  return normalizedMethod(declared)
}

// Everything the card draws and everything a reply needs, out of one parse.
function invitationFrom(text, fallbackMethod) {
  var calendar = parse(text)
  if (!calendar || calendar.name !== "VCALENDAR") return null
  var event = childNamed(calendar, "VEVENT")
  if (!event) return null

  var uid = textOf(event, "UID")
  if (uid === "") return null

  var start = resolveTime(property(event, "DTSTART"), calendar)
  var end = resolveTime(property(event, "DTEND"), calendar)
  if (!end && start) {
    var span = parseDuration(textOf(event, "DURATION"))
    if (span > 0) end = { ms: start.ms + span, allDay: start.allDay, tzid: start.tzid, resolved: start.resolved }
  }

  var attendees = []
  var lines = properties(event, "ATTENDEE")
  for (var i = 0; i < lines.length; i++) {
    var attendee = calendarAddress(lines[i])
    if (attendee && attendee.email !== "") attendees.push(attendee)
  }

  var recurrence = property(event, "RRULE")

  return {
    method: normalizedMethod(textOf(calendar, "METHOD")) || normalizedMethod(fallbackMethod),
    uid: uid,
    sequence: Math.max(0, Math.floor(Number(textOf(event, "SEQUENCE")) || 0)),
    summary: textOf(event, "SUMMARY"),
    description: textOf(event, "DESCRIPTION"),
    location: textOf(event, "LOCATION"),
    status: String(textOf(event, "STATUS")).toUpperCase(),
    organizer: calendarAddress(property(event, "ORGANIZER")),
    attendees: attendees,
    start: start,
    end: end,
    recurrence: recurrence ? describeRecurrence(recurrence.value) : "",
    meetLink: conferenceLink(event),
    // Kept verbatim for the reply. A DTSTART rebuilt out of the moment this
    // parser settled on would answer a question the organiser did not ask; the
    // line that arrived is the one their server matches against.
    source: {
      dtstart: rawLine(event, "DTSTART"),
      dtend: rawLine(event, "DTEND"),
      duration: rawLine(event, "DURATION"),
      recurrenceId: rawLine(event, "RECURRENCE-ID"),
      timezones: timezoneBlocks(calendar)
    }
  }
}

function rawLine(component, name) {
  var found = property(component, name)
  return found ? String(found.raw || "") : ""
}

function timezoneBlocks(calendar) {
  var zones = childrenNamed(calendar, "VTIMEZONE")
  var out = []
  for (var i = 0; i < zones.length; i++) {
    out.push(["BEGIN:VTIMEZONE"].concat(zones[i].lines, ["END:VTIMEZONE"]).join("\r\n"))
  }
  return out
}

// The first call the reader makes. Null when the message carried no
// invitation, which is almost every message — and null too when it carried one
// the server did not send the octets of, which `pendingPart` below is for.
function fromPayload(payload) {
  return fromPart(calendarPart(payload))
}

function fromPart(part) {
  if (!part) return null
  var text = Mail.decodePart(part)
  if (String(text || "").indexOf("BEGIN:VCALENDAR") < 0) return null
  return invitationFrom(text, partMethod(part))
}

// The part the reader has to ask for before there is anything to draw: a
// calendar part described but not sent. Null when the message either carried
// its invitation or carried none, so the second request is only ever made for
// a message that has an invitation in it.
function pendingPart(payload) {
  var part = calendarPart(payload)
  if (!part) return null
  return part.body && part.body.data ? null : part
}

// The same part, now that the octets it named have arrived. Read through the
// part rather than on its own so the charset the sender declared still decides
// how the file is read — an invitation whose SUMMARY is not ASCII is the
// ordinary case, not the exotic one.
function fromAttachment(part, data) {
  if (!part) return null
  return fromPart({
    mimeType: part.mimeType,
    filename: part.filename,
    headers: part.headers,
    body: { data: String(data || "") }
  })
}

// ------------------------------------------------------------- formatting

function clockOf(ms) {
  var at = new Date(ms)
  return twoDigits(at.getHours()) + ":" + twoDigits(at.getMinutes())
}

function dayOf(ms) {
  var at = new Date(ms)
  return Mail.WEEKDAYS[at.getDay()] + ", " + Mail.MONTHS[at.getMonth()] + " "
    + at.getDate() + ", " + at.getFullYear()
}

function sameDay(first, second) {
  var left = new Date(first)
  var right = new Date(second)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

// "Fri, Aug 21, 2026 · 14:00 – 15:00", and the honest variants of it: an
// all-day event has no clock to show, a meeting that runs past midnight names
// the second day, and one whose zone could not be resolved says which zone the
// clock belongs to instead of pretending it is this one.
function formatWhen(invite) {
  var start = invite && invite.start ? invite.start : null
  if (!start) return ""
  var end = invite && invite.end ? invite.end : null

  if (start.allDay) {
    // An all-day DTEND is the first day *after* the event, so a one-day
    // meeting shown from its raw end date reads as two.
    if (end && end.ms - start.ms > 86400000) {
      return dayOf(start.ms) + " – " + dayOf(end.ms - 86400000)
    }
    return dayOf(start.ms) + " · all day"
  }

  var text = dayOf(start.ms) + " · " + clockOf(start.ms)
  if (end && end.ms > start.ms) {
    text += sameDay(start.ms, end.ms)
      ? " – " + clockOf(end.ms)
      : " – " + dayOf(end.ms) + " " + clockOf(end.ms)
  }
  if (!start.resolved && start.tzid !== "") text += " (" + start.tzid + ")"
  return text
}

// How long it runs, for the line under the date. Left empty rather than shown
// as "0 minutes" when the invitation gave no end and no duration.
function formatDuration(invite) {
  var start = invite && invite.start ? invite.start : null
  var end = invite && invite.end ? invite.end : null
  if (!start || !end) return ""
  var minutes = Math.round((end.ms - start.ms) / 60000)
  if (minutes <= 0) return ""
  if (start.allDay) {
    var days = Math.round(minutes / 1440)
    return days <= 1 ? "" : days + " days"
  }
  if (minutes < 60) return minutes + " min"
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  var text = hours + (hours === 1 ? " hour" : " hours")
  return rest === 0 ? text : text + " " + rest + " min"
}

// Who is coming, as a count rather than a list the card has no room for.
function attendeeSummary(invite) {
  var list = invite && Array.isArray(invite.attendees) ? invite.attendees : []
  if (list.length === 0) return ""
  var yes = 0
  var no = 0
  var maybe = 0
  var awaiting = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].partstat === "ACCEPTED") yes++
    else if (list[i].partstat === "DECLINED") no++
    else if (list[i].partstat === "TENTATIVE") maybe++
    else awaiting++
  }
  var pieces = []
  if (yes > 0) pieces.push(yes + " yes")
  if (maybe > 0) pieces.push(maybe + " maybe")
  if (no > 0) pieces.push(no + " no")
  if (awaiting > 0) pieces.push(awaiting + " awaiting")
  var count = list.length + (list.length === 1 ? " guest" : " guests")
  return count + (pieces.length > 0 ? " · " + pieces.join(", ") : "")
}

// What this card is, in the two words above the meeting's name. A cancellation
// and an update are the two the reader most needs to be told apart from a
// first invitation, because both arrive looking exactly like one.
function headline(invite) {
  if (!invite) return ""
  if (invite.method === "CANCEL" || String(invite.status || "") === "CANCELLED")
    return "Cancelled event"
  if (invite.method === "REPLY") return "Reply to an invitation"
  if (invite.method === "COUNTER") return "Proposed new time"
  if (invite.method === "REQUEST")
    return invite.sequence > 0 ? "Updated invitation" : "Invitation"
  return "Event"
}

// One guest's answer, in the same word the buttons use. "Awaiting" rather than
// an empty cell: not having answered is a state, and a blank reads as missing
// data about them.
function partstatLabel(partstat) {
  var value = String(partstat || "").toUpperCase()
  if (value === "ACCEPTED") return "Yes"
  if (value === "DECLINED") return "No"
  if (value === "TENTATIVE") return "Maybe"
  if (value === "DELEGATED") return "Delegated"
  return "Awaiting"
}

// ------------------------------------------------------------------- reply

var PARTSTATS = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE"
}

var REPLY_WORDS = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative"
}

// The account being answered for, given either as its address or as the object
// the panel carries. Written out rather than folded into one expression: the
// obvious "me.email or me" shorthand is correct until me.email is the empty
// string — an account whose profile has not loaded — and then it is the object
// itself, which stringifies into the ATTENDEE line as "[object Object]".
function addressOf(me) {
  if (!me) return ""
  if (typeof me === "string") return me.trim()
  return String(me.email || "").trim()
}

function displayNameOf(me) {
  if (!me || typeof me === "string") return ""
  return String(me.name || "").trim()
}

function normalizedResponse(value) {
  var text = String(value || "").toLowerCase().trim()
  return PARTSTATS[text] ? text : ""
}

// RFC 5545 folds at 75 octets. Folded on characters here, at 72, which is
// short enough that the multi-byte ones this counts as single cannot push a
// line past the limit.
function foldIcsLine(line) {
  var text = String(line || "")
  if (text.length <= 72) return text
  var out = text.substring(0, 72)
  var rest = text.substring(72)
  while (rest.length > 71) {
    out += "\r\n " + rest.substring(0, 71)
    rest = rest.substring(71)
  }
  return rest === "" ? out : out + "\r\n " + rest
}

function icsTimestamp(ms) {
  var at = new Date(Number(ms) || 0)
  return String(at.getUTCFullYear())
    + twoDigits(at.getUTCMonth() + 1) + twoDigits(at.getUTCDate()) + "T"
    + twoDigits(at.getUTCHours()) + twoDigits(at.getUTCMinutes())
    + twoDigits(at.getUTCSeconds()) + "Z"
}

// The RFC 5546 answer to an invitation: the same UID and SEQUENCE, one
// ATTENDEE line — this account's — and nobody else's, because a reply speaks
// only for the person sending it.
function buildReply(invite, me, response, nowMs) {
  var answer = normalizedResponse(response)
  if (!invite || answer === "") return ""
  var address = addressOf(me)
  if (address === "") return ""
  var name = displayNameOf(me)

  var lines = ["BEGIN:VCALENDAR", "PRODID:-//Omamail//Omamail//EN", "VERSION:2.0", "METHOD:REPLY"]

  var zones = invite.source && Array.isArray(invite.source.timezones) ? invite.source.timezones : []
  for (var z = 0; z < zones.length; z++) lines = lines.concat(zones[z].split("\r\n"))

  lines.push("BEGIN:VEVENT")
  lines.push("UID:" + escapeText(invite.uid))
  lines.push("SEQUENCE:" + Math.max(0, Math.floor(Number(invite.sequence) || 0)))
  lines.push("DTSTAMP:" + icsTimestamp(nowMs === undefined ? Date.now() : nowMs))
  if (invite.organizer && invite.organizer.email !== "")
    lines.push("ORGANIZER:mailto:" + invite.organizer.email)
  lines.push("ATTENDEE;PARTSTAT=" + PARTSTATS[answer]
    + (name !== "" ? ";CN=" + quoteParam(name) : "")
    + ":mailto:" + address)
  if (invite.summary !== "") lines.push("SUMMARY:" + escapeText(invite.summary))

  var source = invite.source || {}
  if (source.recurrenceId) lines.push(source.recurrenceId)
  if (source.dtstart) lines.push(source.dtstart)
  if (source.dtend) lines.push(source.dtend)
  else if (source.duration) lines.push(source.duration)

  lines.push("REQUEST-STATUS:2.0;Success")
  lines.push("END:VEVENT")
  lines.push("END:VCALENDAR")

  var folded = []
  for (var i = 0; i < lines.length; i++) {
    if (String(lines[i] || "").trim() !== "") folded.push(foldIcsLine(lines[i]))
  }
  return folded.join("\r\n") + "\r\n"
}

// A parameter value may not carry a quote, a colon or a semicolon unquoted,
// and there is no escape for a quote inside one — so a display name holding
// one loses it rather than ending the value early.
function quoteParam(value) {
  return "\"" + String(value || "").replace(/["\r\n]/g, "") + "\""
}

// Who the answer goes to. The organiser, and nobody else: a reply copied to
// every attendee is how one accepted meeting becomes forty mails.
function replyRecipient(invite) {
  return invite && invite.organizer ? String(invite.organizer.email || "") : ""
}

function replySubject(invite, response) {
  var answer = normalizedResponse(response)
  if (answer === "") return ""
  var summary = String(invite && invite.summary ? invite.summary : "").trim()
  return REPLY_WORDS[answer] + ": " + (summary !== "" ? summary : "(no subject)")
}

// The text part beside the calendar one. A calendar reads the attachment; a
// person reading the reply in a client that does not gets a sentence.
function replyBody(invite, me, response) {
  var answer = normalizedResponse(response)
  if (answer === "") return ""
  var who = displayNameOf(me)
  if (who === "") who = addressOf(me)
  var word = answer === "accepted" ? "accepted" : (answer === "declined" ? "declined" : "tentatively accepted")
  return who + " has " + word + " this invitation."
}

// Everything `send` needs for one RSVP, or null when this invitation cannot be
// answered — no organiser to answer, or not a request in the first place.
function replyFields(invite, me, response, nowMs) {
  var answer = normalizedResponse(response)
  if (!invite || answer === "") return null
  var to = replyRecipient(invite)
  if (to === "") return null
  var calendar = buildReply(invite, me, answer, nowMs)
  if (calendar === "") return null
  return {
    to: to,
    subject: replySubject(invite, answer),
    body: replyBody(invite, me, answer),
    calendar: { method: "REPLY", text: calendar }
  }
}

// The same invitation with this account's answer written into it.
//
// Needed because the answer is not in the file: the `text/calendar` part is
// the organiser's document and an RSVP does not rewrite it, so a message
// reopened tomorrow would show its buttons unanswered — after the answer had
// been sent, and had worked. This is what goes back into the body cache.
//
// An address with no ATTENDEE line of its own gets one. That is the forwarded
// invitation, where a reply is still the right thing to have sent and the file
// is still the wrong place to learn it from.
function withResponse(invite, address, response) {
  var answer = normalizedResponse(response)
  if (!invite || answer === "") return invite
  var wanted = String(address || "").trim()
  if (wanted === "") return invite

  var list = Array.isArray(invite.attendees) ? invite.attendees : []
  var updated = []
  var found = false
  for (var i = 0; i < list.length; i++) {
    if (!sameAddress(list[i].email, wanted)) {
      updated.push(list[i])
      continue
    }
    found = true
    updated.push({
      name: list[i].name, email: list[i].email,
      partstat: PARTSTATS[answer], role: list[i].role,
      optional: list[i].optional, resource: list[i].resource
    })
  }
  if (!found) {
    updated.push({
      name: wanted, email: wanted, partstat: PARTSTATS[answer],
      role: "REQ-PARTICIPANT", optional: false, resource: false
    })
  }

  // A shallow copy with one field replaced. Rebuilt field by field rather than
  // mutated, because the object handed in is the one the card is bound to and
  // a QML binding does not notice a property of an object changing under it.
  var copy = {}
  for (var key in invite) copy[key] = invite[key]
  copy.attendees = updated
  return copy
}

// Whether the panel may draw the buttons at all. A cancellation and a reply
// somebody else sent are both invitations worth showing and neither is one to
// answer, and an organiser cannot RSVP to their own meeting.
function canRespond(invite, address) {
  if (!invite || invite.method !== "REQUEST") return false
  if (String(invite.status || "") === "CANCELLED") return false
  if (replyRecipient(invite) === "") return false
  return !sameAddress(replyRecipient(invite), address)
}
