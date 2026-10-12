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
//
// What the list cannot hold (the notes, the people and how each answered, the join link, whether the
// owner may answer) is read when an event is opened (`exchange.calendarEvent`) and laid over it by
// `withDetail`, in the shapes the Google detail already draws. Yes and Maybe answer an invitation at
// once; No is the delete's confirmation (`deleteKind`), because it also takes the meeting off the
// calendar. The minutes of an event's reminder are `reminders`, which the desktop reminders read.
//
// A meeting with other people is the one thing here that reaches somebody who has not asked to be told,
// so nothing below builds such a request without the caller's `confirmedSend` and the words that tell the
// person who will be reached (`reachRequest`, `deleteRequest`); the backend refuses without its own
// confirming member as well, and this is the second place that says no. The owner creates, changes and
// cancels a meeting they organise (`exchangeMeeting` with no lock) and takes a meeting its organizer cancelled,
// or one they declined, off the calendar (`deleteKind` says which).

var DAY = /^(\d{4})-(\d{2})-(\d{2})$/

// Whether the connected backend has the calendar methods, which arrive with Exchange mail (API 9).
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
  meeting: "This meeting can only be changed in Outlook",
  // The owner's own meeting, which the backend locks for what it carries: a room, or people not all read.
  room: "A meeting with a room: change it in Outlook",
  guests: "Not every guest's address could be read: change it in Outlook",
  recurring: "Repeating event: change it in Outlook",
  cancelled: "Cancelled meeting: change it in Outlook",
  foreign: "Somebody else's invitation: change it in Outlook",
  "private": "Private event, shown without its details: change it in Outlook",
  unknown: "This kind of event can only be changed in Outlook"
}

// A meeting somebody else sent the owner is theirs to change, in Outlook or anywhere.
var INVITED = "Only its organizer can change this meeting."

// Whether the owner was sent this meeting by somebody else: the owner's answer is an attendee's.
function invited(item) {
  return item.meeting === true && ["none", "accept", "tentative", "decline"].indexOf(String(item.response || "")) >= 0
}

// "" for an appointment that may be changed here, else why not.
function lockReason(item) {
  if (item.editable === true && String(item.changeKey || "") !== "") return ""
  var code = String(item.lock || "")
  if ((code === "meeting" || code === "recurring") && invited(item)) return INVITED
  return LOCKS.hasOwnProperty(code) ? LOCKS[code] : LOCKS.unknown
}

// The reminder machinery reads an event's own reminders as a policy: minutes before the start, or none.
function reminderPolicy(minutes) {
  return { useDefault: false, overrides: minutes >= 0 ? [{ method: "popup", minutes: minutes }] : [] }
}

// Minutes before the start, or -1 for none: a figure that is not a whole number from 0 up is none.
function reminderOf(item) {
  var minutes = item && item.reminderMinutes
  return typeof minutes === "number" && minutes >= 0 && Math.floor(minutes) === minutes ? minutes : -1
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
    var reminder = reminderOf(item)
    out.push({
      method: "", uid: String(item.uid || item.id || ""),
      // The server's identity of this item, as Google's and Graph's are kept: an occurrence has one
      // of its own, which the series' shared uid cannot tell apart.
      exchangeId: String(item.id || ""),
      // The version it was drawn from, which a write names so that a change made elsewhere since is
      // refused and not overwritten.
      exchangeKey: String(item.changeKey || ""), exchangeKind: String(item.kind || ""),
      exchangeMeeting: item.meeting === true, lockReason: lockReason(item),
      sequence: 0, summary: String(item.title || "Untitled event"),
      // The title as the server gave it, which a detail is compared with: an empty one is drawn as above.
      exchangeTitle: String(item.title || ""),
      description: "", location: String(item.location || ""),
      status: "CONFIRMED", isPrivate: item.private === true,
      transparency: item.busy === "free" ? "transparent" : "opaque",
      organizer: organizer === "" ? null : { email: "", displayName: organizer },
      attendees: [], start: moment(start, allDay), end: moment(end, allDay),
      // For the desktop reminders (an invitation the owner declined raises none) and the detail.
      reminderMinutes: reminder, reminders: reminderPolicy(reminder), myResponse: String(item.response || ""),
      canRespond: false, notesCut: false, canRemove: false,
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
  if (built.reminderMinutes >= 0) params.reminderMinutes = built.reminderMinutes
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
  // -1 is no reminder; no number at all leaves the reminder as the server has it.
  if (typeof built.reminderMinutes === "number") params.reminderMinutes = built.reminderMinutes
  return params
}

function deleteParams(accountId, event) {
  return { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.exchangeKey || "") }
}

// What the form's reminder buttons mean for a new appointment (`editing` false: "none", and the calendar
// default an Exchange calendar has not got, are no reminder) or an edit (`none` removes it, `preserve` and
// no choice at all leave it). `minutes` is a number to send, or undefined to say nothing.
function reminderChoice(fields, editing) {
  var mode = String(fields && fields.reminderMode || "")
  if (mode === "custom") {
    // Digits only: "1e2" and "0x10" are numbers to JavaScript and nothing a person meant.
    var text = String(fields.reminderMinutes).trim()
    var minutes = /^\d{1,5}$/.test(text) ? Number(text) : -1
    if (minutes < 0 || minutes > 40320)
      return { ok: false, error: "Reminder minutes must be a whole number from 0 to 40320" }
    return { ok: true, minutes: minutes }
  }
  // An edit that names no choice (a drag) leaves the reminder alone, as `preserve` does.
  return { ok: true, minutes: editing && mode === "none" ? -1 : undefined }
}

// "15 minutes before", the way the detail says it.
function reminderText(minutes) {
  // Only a number is minutes: Number(null) is 0, which would say "at the start" of no reminder.
  var value = typeof minutes === "number" ? minutes : -1
  if (!(value >= 0)) return ""
  if (value === 0) return "At the start"
  function plural(count, unit) { return count + " " + unit + (count === 1 ? "" : "s") + " before" }
  if (value % 1440 === 0) return plural(value / 1440, "day")
  if (value % 60 === 0) return plural(value / 60, "hour")
  return plural(value, "minute")
}

// ------------------------------------------------------------------ detail and answers

// How the owner's own answer and a person's read in the attendee rows (`Calendar.attendeeRows`).
var STATUS = { accept: "accepted", tentative: "tentative", decline: "declined", none: "needsAction",
  organizer: "organizer", unknown: "unknown" }

// The three answers the mail card offers, and the words the backend takes for them.
var ANSWERS = { accepted: "accept", tentative: "tentative", declined: "decline" }

// The answer the owner's response word stands for, in the mail card's words ("" when none was given).
function answerOf(response) {
  for (var answer in ANSWERS) if (ANSWERS[answer] === String(response || "")) return answer
  return ""
}

// Whether what the detail read is what the list drew: its title, place and time. Version keys are not
// compared, because the key a calendar view lists for an occurrence of a series is its series' and a read of
// the item may give its own; what a person would notice is what is compared.
function sameAsDrawn(event, detail) {
  var start = event.start || {}
  var drawn = event.exchangeTitle === undefined ? event.summary : event.exchangeTitle
  if (String(detail.title) !== String(drawn) || String(detail.location || "") !== String(event.location || ""))
    return false
  if ((detail.allDay === true) !== (start.allDay === true)) return false
  // An all-day event's days are not its instants here, so only a timed event's time is compared.
  return start.allDay === true || (detail.startMs === start.ms && detail.endMs === (event.end || {}).ms)
}

// The event with the detail laid over it, or null for something that is no detail. `stale` says the item is
// not what the list drew: a write to it still names the version drawn (and is refused as a conflict, never made
// over the newer one) and it cannot be answered from that screen. `answerKey` is the detail's own version, which
// an answer names. The lock is the stricter of the two reads: the fresh one can see people the list could not.
function withDetail(event, detail) {
  if (!event || !detail || typeof detail !== "object" || typeof detail.title !== "string") return null
  var people = Array.isArray(detail.attendees) ? detail.attendees : []
  var attendees = []
  for (var i = 0; i < people.length; i++) {
    var who = people[i] || {}
    attendees.push({
      email: String(who.email || ""), displayName: String(who.name || ""),
      responseStatus: STATUS.hasOwnProperty(who.response) ? STATUS[who.response] : "unknown",
      optional: who.kind === "optional", resource: who.kind === "resource", self: who.self === true
    })
  }
  var stale = !sameAsDrawn(event, detail)
  // A meeting the server itself flags cancelled is left out of the list the reminders are read from, so
  // none will come: it shows none.
  var minutes = detail.lock === "cancelled" ? -1 : reminderOf(detail)
  var merged = {}
  for (var key in event) merged[key] = event[key]
  merged.description = String(detail.notes || "")
  merged.notesCut = detail.notesCut === true
  merged.organizer = detail.organizer && typeof detail.organizer === "object"
    ? { email: String(detail.organizer.email || ""), displayName: String(detail.organizer.name || "") }
    : event.organizer
  merged.attendees = attendees
  merged.exchangeMeeting = detail.meeting === true
  merged.meetLink = String(detail.joinUrl || "")
  merged.reminderMinutes = minutes
  merged.reminders = reminderPolicy(minutes)
  merged.myResponse = String(detail.response || "")
  merged.answerKey = String(detail.changeKey || "")
  merged.canRespond = detail.canRespond === true && !stale && merged.answerKey !== ""
  // An invitation whose organizer cancelled it (the server's flag, or a cancellation in the Inbox): said, since
  // it can no longer be answered, and the owner's answer to it is no longer anything to show.
  var received = detail.meeting === true && String(detail.response || "") !== "organizer"
  merged.cancelledByOrganizer = received && detail.cancelled === true
  if (merged.cancelledByOrganizer)
    for (var j = 0; j < attendees.length; j++) if (attendees[j].self) attendees[j].responseStatus = STATUS.unknown
  // Another event of its series was cancelled and this one does not say whether it is that one: a doubt, said
  // as one, and not answered from here.
  merged.cancellationUnplaced = received && !merged.cancelledByOrganizer && detail.unplacedCancellation === true
  merged.canRemove = detail.canRemove === true && !stale && merged.answerKey !== ""
  var locked = lockReason(detail)
  if (locked !== "") merged.lockReason = locked
  if (stale) merged.stale = true
  return merged
}

// Whether the detail names the organizer: not on the owner's own event that nobody else is on, where it
// would only name the owner. `accountId` is the mailbox's (`exchange:<address>`).
function organizerShown(event, accountId) {
  var organizer = event && event.organizer
  if (!organizer) return false
  var people = event.attendees || []
  for (var i = 0; i < people.length; i++) if (people[i] && people[i].self !== true) return true
  if (event.exchangeMeeting === true) return true
  var owner = String(accountId || "").replace(/^exchange:/, "").toLowerCase()
  var email = String(organizer.email || "").toLowerCase()
  return !(String(event.myResponse || "") === "organizer" || (owner !== "" && email === owner))
}

// What names an event across the new id an answer gives it: its identity and its start.
function stableKey(event) {
  return String(event && event.sourceId || "") + "\n" + String(event && event.uid || "") + "\n"
    + String(event && event.start && event.start.ms || "")
}

// An answer as it is sent: `send` is always true from here, the organizer is told, as the mail card does.
function respondParams(accountId, event, answer) {
  return { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.answerKey || ""), response: ANSWERS[answer] || "", send: true }
}

// A decline is the answer, sent, and the meeting leaving the calendar, as Outlook does; one event of a series
// stays on it, declined (the backend takes a single meeting off and nothing else).
function declineParams(accountId, event) {
  var params = respondParams(accountId, event, "declined")
  if (String(event.exchangeKind || "") === "single") params.remove = true
  return params
}

// What deleting this event is: "" when it may not be, `appointment` (a personal one, nobody told), `remove`
// (the organizer cancelled it, or the owner declined it: nobody told), `decline` (an invitation: the organizer
// is told, and it leaves the calendar) or `cancel` (a meeting the owner organises: everybody on it is told). A
// meeting whose people were not read is not cancelled from here: the question could not say who.
function deleteKind(event) {
  if (!event || String(event.exchangeId || "") === "") return ""
  if (event.canRemove === true) return "remove"
  if (event.canRespond === true) return "decline"
  if (String(event.lockReason || "") !== "") return ""
  if (event.exchangeMeeting === true) return peopleOf(event).length > 0 ? "cancel" : ""
  return "appointment"
}

// Why a delete is refused, or "".
function deleteRefusal(source, event) {
  if (!source) return "Choose a calendar"
  if (source.readOnly === true) return "This calendar is read-only"
  var kind = deleteKind(event)
  if (kind === "") return String(event && event.lockReason || "") || LOCKS.unknown
  var key = kind === "decline" || kind === "remove" ? event.answerKey : event.exchangeKey
  return String(key || "") === "" ? "Refresh this event before changing it" : ""
}

// The confirmation of a decline, which reaches the organizer: what happens in plain words, a button that says
// it again, and the way out with the focus, so a second Enter sends nothing. null for an appointment, whose own
// words (`Calendar.deleteRequest`) stand.
function deleteRequest(event) {
  var kind = deleteKind(event)
  var name = String(event && event.summary || "Untitled event")
  if (kind === "cancel") {
    var emails = peopleOf(event).map(function(who) { return String(who.email) })
    var count = peopleText(emails.length)
    return confirmation(name, "Cancel \"" + name + "\"?", "This cancels the meeting for " + count + ": "
      + whoText(emails) + ". " + (emails.length === 1 ? "They are" : "Each of them is") + " sent a cancellation.",
      "Cancel meeting for " + count)
  }
  if (kind === "remove")
    return confirmation(name, "Remove \"" + name + "\" from your calendar?", event.cancelledByOrganizer === true
      ? "The organizer cancelled this meeting. Nobody is told." : "You declined this meeting. Nobody is told.",
      "Remove from calendar")
  if (kind !== "decline") return null
  var single = String(event.exchangeKind || "") === "single"
  return confirmation(name, "Decline \"" + name + "\"?",
    single ? "This tells the organizer you decline. The meeting is removed from your calendar."
      : "This tells the organizer you decline this event. It stays on your calendar, declined.",
    single ? "Decline and remove" : "Decline")
}

// A question that reaches people, or takes something off the calendar: its title, the sentence that names who is
// reached, one button that says it again, and the way out with the focus, so a second Enter sends nothing.
function confirmation(name, title, message, label, dismiss) {
  return { kind: "event", name: name, title: title, message: message, dismiss: dismiss || "Keep meeting",
    focus: "dismiss", choices: [{ value: "all", label: label }] }
}

// What a failed answer says. It never says "try again" for an unconfirmed one: the organizer may have been told.
function respondError(error) {
  var code = Protocol.errorCode(error)
  if (code === "exchange_calendar_conflict") return "This invitation changed. Refresh and answer again"
  if (code === "exchange_calendar_unconfirmed")
    return "The server did not confirm your answer. Look at your calendar before answering again"
  if (code === "exchange_calendar_not_invitation") return "That event is not an invitation you can answer here. Answer it in Outlook"
  if (code === "Invalid params" || code === "invalid_params") return "That invitation cannot be answered as it is"
  return writeError(error)
}

// What a failed detail read says, while the event is still drawn from the list.
function detailError(error) {
  var code = Protocol.errorCode(error)
  if (code === "Method not found" || code === "method_not_found")
    return "Update the mail backend to see this event's details"
  if (code === "exchange_message_not_found") return "That event is no longer in your calendar. Refresh and look again"
  return Protocol.sentence(error, false)
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

// ------------------------------------------------------------------ meetings with other people

// What a guest address may be: the backend's own rule (`guests.rs`), so a typo is caught in the form's words
// and not as a refused request. One @, printable ASCII, dots only between the characters of a name, a domain
// of at least two labels of letters, digits and hyphens.
var ADDRESS = /^[A-Za-z0-9!#$%&'*+\/=?^_\x60{|}~-]+(\.[A-Za-z0-9!#$%&'*+\/=?^_\x60{|}~-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

var GUEST_WORDS = "Enter valid guest email addresses separated by commas"
var OWN_ADDRESS = "Leave your own address out of the guests: you are already on the meeting"
var NO_GUESTS = "A meeting needs at least one guest. To end it, cancel it"
var UNCONFIRMED_SEND = "Confirm what is sent to the guests first"
var PEOPLE_UNKNOWN = "Open the meeting again to see who is on it"

// The mailbox's own address, from the account id (`exchange:alice@example.org`).
function ownAddress(accountId) {
  return String(accountId || "").replace(/^exchange:/, "").toLowerCase()
}

// The people typed into a guest field: `{ ok, emails }`, each address once in the order typed, or the
// sentence for a field that is not a list of addresses. The mailbox's own address is refused, as the backend
// refuses it: an invitation to oneself is nobody's intention.
function guestList(text, accountId) {
  var typed = Calendar.guestList(text)
  if (!typed.ok) return typed
  var own = ownAddress(accountId)
  for (var i = 0; i < typed.emails.length; i++) {
    var email = typed.emails[i]
    var local = email.substring(0, email.lastIndexOf("@"))
    if (email.length > 254 || local.length > 64 || !ADDRESS.test(email)) return { ok: false, error: GUEST_WORDS }
    if (email.toLowerCase() === own) return { ok: false, error: OWN_ADDRESS }
  }
  return typed
}

// The people on a meeting other than the owner and any room, as its detail read them: who a question names
// when it says who will be told. An event whose detail was not read has none. The list is walked by its
// length, so it reads the same after crossing a signal, where Qt 6.12 hands it over as a sequence.
function peopleOf(event) {
  var all = event && event.attendees, out = []
  var count = all && typeof all.length === "number" ? all.length : 0
  for (var i = 0; i < count; i++) {
    var who = all[i] || {}
    if (who.self !== true && who.resource !== true && String(who.email || "") !== "") out.push(who)
  }
  return out
}

// What the guest field holds for a meeting being changed: everybody but the owner, who cannot name themselves.
function guestText(event) {
  return peopleOf(event).map(function(who) { return String(who.email) }).join(", ")
}

// The people as the typed list makes them: whoever was optional stays optional, everybody else is required.
function meetingPeople(event, emails) {
  var optional = {}
  peopleOf(event).forEach(function(who) { if (who.optional === true) optional[String(who.email).toLowerCase()] = true })
  var required = [], extra = []
  emails.forEach(function(email) { (optional[email.toLowerCase()] === true ? extra : required).push(email) })
  return { required: required, optional: extra }
}

// A new meeting: the appointment's own fields, who is invited, and the word that the invitations are sent.
function meetingCreateParams(accountId, built, emails) {
  var params = createParams(accountId, built)
  params.requiredAttendees = emails
  params.sendInvitations = true
  return params
}

// A change of a meeting the owner organises, the people named only when the field changed (`emails` null
// leaves them), and the word that the update is sent to everybody on it.
function meetingUpdateParams(accountId, event, built, emails) {
  var params = updateParams(accountId, event, built)
  params.sendUpdates = true
  if (emails) {
    var people = meetingPeople(event, emails)
    params.requiredAttendees = people.required
    params.optionalAttendees = people.optional
  }
  return params
}

function cancelParams(accountId, event) {
  return { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.exchangeKey || ""), sendCancellations: true }
}

// Taking a cancelled or declined meeting off the calendar names the detail's own version.
function removeParams(accountId, event) {
  return { accountId: String(accountId || ""), id: String(event.exchangeId || ""),
    changeKey: String(event.answerKey || "") }
}

function peopleText(count) { return count === 1 ? "1 person" : count + " people" }

// "ada@example.org, bob@example.org and 3 more": the first few, so a long list is still named.
function whoText(emails) {
  var shown = emails.slice(0, 3).join(", ")
  return emails.length > 3 ? shown + " and " + (emails.length - 3) + " more" : shown
}

// Whether a change of a meeting tells its people: anything it names but the owner's own reminder, which the
// backend writes telling nobody.
function meetingMails(params) {
  for (var key in params)
    if (["accountId", "id", "changeKey", "sendUpdates", "reminderMinutes"].indexOf(key) < 0) return true
  return false
}

// The guests a field names, or null when they are the people already on the meeting, in any order or case: the
// backend compares the same way and writes nothing for them, so nothing is asked about and nothing named.
function changedGuests(event, emails) {
  if (!emails) return null
  function key(list) { return list.map(function(email) { return String(email).toLowerCase() }).sort().join("\n") }
  return key(peopleOf(event).map(function(who) { return who.email })) === key(emails) ? null : emails
}

// What saving a form tells people, as the question the owner answers first, or null when it tells nobody (an
// appointment, a change of the owner's reminder alone) or the write will refuse it and say why (an address that
// is not one, a meeting left with nobody, a repeating new event). `event` is the meeting being changed, null for a
// new event; `fields` is what the composer holds (`guestEmails` undefined for a guest field nobody changed).
function reachRequest(accountId, event, fields) {
  var name = String(fields && fields.title || event && event.summary || "Untitled event")
  var typed = fields && fields.guestEmails !== undefined ? guestList(fields.guestEmails, accountId) : null
  if (typed && (!typed.ok || typed.emails.length === 0)) return null
  if (!event) {
    if (!typed || fields.recurrence && fields.recurrence.enabled === true) return null
    var count = peopleText(typed.emails.length)
    return confirmation(name, "Invite " + count + " to \"" + name + "\"?",
      "This sends an invitation to " + count + ": " + whoText(typed.emails) + ".", "Send invitation to " + count,
      "Keep editing")
  }
  if (event.exchangeMeeting !== true) return null
  var built = Calendar.updateEvent(fields, event, Date.now())
  var guests = typed ? changedGuests(event, typed.emails) : null
  if (!built.ok || !meetingMails(meetingUpdateParams(accountId, event, built, guests))) return null
  var told = peopleOf(event).map(function(who) { return String(who.email) })
  var wanted = guests || told
  var kept = wanted.map(function(email) { return email.toLowerCase() })
  var removed = told.filter(function(email) { return kept.indexOf(email.toLowerCase()) < 0 })
  var message = "This tells " + peopleText(wanted.length) + " the meeting changed: " + whoText(wanted) + "."
  if (removed.length > 0) message += " It tells " + whoText(removed) + " they were removed."
  var label = removed.length > 0 ? "Send to " + peopleText(wanted.length + removed.length)
    : "Send update to " + peopleText(wanted.length)
  return confirmation(name, "Update \"" + name + "\"?", message, label, "Keep editing")
}

// What a failed meeting write says. One that is not confirmed never says "try again": the people may have been
// told, and a second would tell them again.
function meetingError(error) {
  var code = Protocol.errorCode(error)
  if (code === "exchange_calendar_unconfirmed")
    return "The server did not confirm it, and the guests may have been told. Look at your calendar and Sent Items before trying again"
  if (code === "exchange_calendar_locked") return "Only a meeting you organise can be changed here: change it in Outlook"
  if (code === "exchange_calendar_not_removable")
    return "That meeting is neither cancelled nor declined, so it is not removed from here. Decline it to remove it"
  if (code === "Invalid params" || code === "invalid_params")
    return "That meeting cannot be sent as it is. Check its title, dates, times and guest addresses"
  return writeError(error)
}
