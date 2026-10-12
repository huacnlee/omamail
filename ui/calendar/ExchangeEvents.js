.pragma library

.import "../providers/ExchangeProtocol.js" as Protocol
.import "Calendar.js" as Calendar

// The Exchange calendar as the views draw it and as a write names it. Rust (`exchange.calendarEvents`)
// has already read the server, expanded each series, dropped what was cancelled and masked what is
// private; what is left here is what only this side can do: say where on the screen an event is.
//
// A timed event arrives as two UTC instants and is drawn from them. An all-day event arrives as the
// calendar days it covers (`YYYY-MM-DD`, the end day exclusive) because its creator's zone chose them,
// and it becomes midnight of those days *here*, as every other source gives the views, so it stays on
// its day however far from that zone the screen is.
//
// Writing is personal appointments only (a single item nobody else is on), and the backend says per
// event whether this is one: `editable` and `lock`. A locked event carries the reason as `lockReason`,
// which is also what a refused write says; an event with no word from the backend, or no change key
// to name, is treated as locked.

var DAY = /^(\d{4})-(\d{2})-(\d{2})$/

// Whether the connected backend has the calendar methods, which arrived with Exchange mail (API 8).
function backendReady(service) {
  return !!service && Protocol.backendProblem(service.backend) === ""
}

function localMidnight(text) {
  var parts = DAY.exec(String(text || ""))
  if (!parts) return NaN
  var year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  var date = new Date(year, month - 1, day)
  // `Date` rolls February 30th over to March; a day that is not a day is refused.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return NaN
  return date.getTime()
}

var LOCKS = {
  meeting: "Meeting with other people: change it in Outlook",
  recurring: "Repeating event: change it in Outlook",
  cancelled: "Cancelled meeting: change it in Outlook",
  foreign: "Somebody else's invitation: change it in Outlook",
  "private": "Private event, shown without its details: change it in Outlook",
  unknown: "This kind of event can only be changed in Outlook"
}

// "" for an appointment that may be changed here, else why not.
function lockReason(item) {
  if (item.editable === true && String(item.changeKey || "") !== "") return ""
  var code = String(item.lock || "")
  return LOCKS.hasOwnProperty(code) ? LOCKS[code] : LOCKS.unknown
}

function moment(ms, allDay) {
  return { ms: ms, allDay: allDay, tzid: "", resolved: true }
}

function eventsFromExchange(payload, sourceId) {
  var items = payload && Array.isArray(payload.events) ? payload.events : []
  var out = []
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
    // A missing or textual instant is not zero: Number(null) would make an event of 1970.
    var start = typeof item.startMs === "number" ? item.startMs : NaN
    var end = typeof item.endMs === "number" ? item.endMs : NaN
    var allDay = item.allDay === true
    var firstDay = localMidnight(item.startDate)
    var lastDay = localMidnight(item.endDate)
    if (allDay && (!isFinite(firstDay) || !isFinite(lastDay) || lastDay <= firstDay)) allDay = false
    if (allDay) { start = firstDay; end = lastDay }
    if (!isFinite(start) || !isFinite(end)) continue
    var organizer = String(item.organizer || "")
    out.push({
      method: "", uid: String(item.uid || item.id || ""),
      // The server's identity of this item, as Google's and Graph's are kept: an occurrence has one
      // of its own, which the series' shared uid cannot tell apart.
      exchangeId: String(item.id || ""),
      // The version it was drawn from, which a write names so that a change made elsewhere since is
      // refused and not overwritten.
      exchangeKey: String(item.changeKey || ""),
      lockReason: lockReason(item),
      sequence: 0, summary: String(item.title || "Untitled event"),
      description: "", location: String(item.location || ""),
      status: "CONFIRMED", isPrivate: item.private === true,
      transparency: item.busy === "free" ? "transparent" : "opaque",
      organizer: organizer === "" ? null : { email: "", displayName: organizer },
      attendees: [], start: moment(start, allDay), end: moment(end, allDay),
      recurrence: "", meetLink: "", sourceId: String(sourceId || ""), href: "", source: null
    })
  }
  out.sort(function(left, right) {
    return left.start.ms !== right.start.ms ? left.start.ms - right.start.ms
      : left.summary.localeCompare(right.summary)
  })
  return out
}

function two(value) { return value < 10 ? "0" + value : String(value) }

// The local calendar day of a moment, as the backend takes a day.
function dayText(ms) {
  var date = new Date(ms)
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate())
}

// A time as the backend takes it: two instants, or for an all-day event the first day and the day
// after the last (the views draw that as midnight to midnight, so the end is the next midnight).
function timeFields(start, end, allDay) {
  if (allDay === true) return { allDay: true, startDate: dayText(start), endDate: dayText(end) }
  return { allDay: false, startMs: Math.floor(start), endMs: Math.floor(end) }
}

// `built` is what `Calendar.createEvent` or `Calendar.updateEvent` made of the form. Notes go with a
// new appointment only: an existing one's notes are not read, so an edit neither shows nor writes them.
function createParams(accountId, built) {
  var fields = built.fields
  var params = timeFields(fields.start, fields.end, built.allDay)
  params.accountId = String(accountId || "")
  params.title = fields.title
  params.location = fields.location
  if (fields.description !== "") params.notes = fields.description
  return params
}

// The title, the place and the time are named only when the form changed them, so what the screen
// drew is never written back: a drag names the time alone, and neither the placeholder of an empty
// subject nor a title the form trimmed is sent.
function updateParams(accountId, event, built) {
  var fields = built.fields
  var params = { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.exchangeKey || "") }
  if (fields.title !== String(event.summary || "").trim()) params.title = fields.title
  if (fields.location !== String(event.location || "")) params.location = fields.location
  var before = event.start || { ms: 0, allDay: false }
  var beforeEnd = event.end ? event.end.ms : before.ms
  if (built.allDay !== (before.allDay === true) || fields.start !== before.ms || fields.end !== beforeEnd) {
    var when = timeFields(fields.start, fields.end, built.allDay)
    for (var key in when) params[key] = when[key]
  }
  return params
}

function deleteParams(accountId, event) {
  return { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.exchangeKey || "") }
}

// What a failed write says: the calendar's own sentences for its codes, the mailbox's for the rest.
function writeError(error) {
  var code = Protocol.errorCode(error)
  if (code === "exchange_calendar_conflict") return Calendar.CONFLICT
  if (code === "exchange_calendar_locked") return LOCKS.unknown
  if (code === "exchange_calendar_unconfirmed")
    return "The server did not confirm the change. Look at your calendar before trying again"
  if (code === "exchange_message_not_found") return "That event is no longer in your calendar. Refresh and look again"
  if (code === "Invalid params" || code === "invalid_params")
    return "That event cannot be saved as it is. Check its title, dates and times"
  return Protocol.sentence(error, false)
}

// What a failed read says, in the sentences the mailbox itself uses for the same codes.
function errorText(error) {
  return Protocol.sentence(error, false)
}

// Said beside the events that were read when the range held more than one read may carry: the
// calendar shows what it has and not that it is whole.
var TRUNCATED = "Only part of this range could be read, so some events are not shown"
