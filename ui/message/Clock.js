.pragma library

// QLocale::ShortFormat is 1. Keep Qt's entire pattern: separators, spacing,
// hour cycle and translated day periods all belong to the system locale.
function time(date) {
  var locale = Qt.locale()
  return new Date(date.getTime()).toLocaleTimeString(locale, locale.timeFormat(1))
}

// Format wall components, not an instant. Unresolved invitation timezones use
// UTC accessors upstream; applying the local zone to that instant would lie.
function wallTime(hour, minute) {
  return time(new Date(2000, 0, 1, hour, minute))
}

function canonical(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase()
}

// HH:mm remains a portable entry form. Otherwise accept the actual localized
// short clock, rejecting Qt's lenient overflow/partial parses by round-tripping.
function parse(value) {
  var text = String(value).trim()
  var legacy = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (legacy) return {hour:Number(legacy[1]), minute:Number(legacy[2])}
  var locale = Qt.locale()
  var date = Date.fromLocaleTimeString(locale, text, locale.timeFormat(1))
  if (!isFinite(date.getTime()) || canonical(time(date)) !== canonical(text)) return null
  return {hour:date.getHours(), minute:date.getMinutes()}
}

// Only native/cached summary shapes are clocks. Unknown strings and relative
// labels stay verbatim, even when a timestamp is available. Never scan bodies
// or write back into the summary (also used to construct reply quotes).
function displayLabel(value, timestamp) {
  var text = String(value === undefined || value === null ? "" : value)
  var match = /^(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) )?([01]?\d|2[0-3]):([0-5]\d)(?: (AM|PM))?$/.exec(text)
  if (!match || match[0] !== text) return text
  if (match[1]) {
    var month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(match[1])
    var date = new Date(Number(match[3]), month, Number(match[2]), 12)
    if (date.getFullYear() !== Number(match[3]) || date.getMonth() !== month
        || date.getDate() !== Number(match[2])) return text
  }
  var hour = Number(match[4])
  if (match[6]) {
    if (hour < 1 || hour > 12) return text
    hour = hour % 12 + (match[6] === "PM" ? 12 : 0)
  }
  var at = timestamp === undefined || timestamp === null || timestamp === ""
    ? null : new Date(timestamp)
  var label = at && isFinite(at.getTime()) ? time(at) : wallTime(hour, Number(match[5]))
  return (match[1] ? match[1] + " " + match[2] + ", " + match[3] + " " : "") + label
}
