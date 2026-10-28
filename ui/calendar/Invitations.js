.pragma library

.import "../message/Calendar.js" as Calendar

function destination(settings, mailbox) {
  var targets = settings && settings.invitationCalendars || {}
  var source = targets[mailbox]
  return source && source.kind === "google" && source.accountId && source.readOnly !== true ? source : null
}

function params(source, mailbox, invite, response) {
  if (!source || !invite || !invite.uid) return null
  var organizer = Calendar.replyRecipient(invite)
  if (!organizer) return null
  var result = { source: source, mailbox: mailbox, uid: invite.uid, organizer: organizer,
    sequence: Number(invite.sequence) || 0, response: response }
  if (invite.recurrenceIdMs) {
    result.originalStart = new Date(invite.recurrenceIdMs).toISOString()
    var day = /VALUE=DATE:(\d{4})(\d{2})(\d{2})$/.exec(String(invite.source && invite.source.recurrenceId || ""))
    if (day) result.originalStart = day[1] + "-" + day[2] + "-" + day[3]
  }
  if (response === "cancelled" || response === "declined") return result
  if (!invite.start || !invite.end || invite.start.resolved === false || invite.end.resolved === false
      || !(invite.end.ms > invite.start.ms)) return null
  function time(value, raw) {
    if (value.allDay) {
      var date = /:(\d{4})(\d{2})(\d{2})$/.exec(String(raw || ""))
      // DATE values are local calendar dates, never UTC conversions.
      var d = new Date(value.ms)
      return {date: date ? date[1] + "-" + date[2] + "-" + date[3]
        : d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2)}
    }
    var result = {dateTime: new Date(value.ms).toISOString()}
    if (value.tzid) result.timeZone = value.tzid
    return result
  }
  var original = invite.source || {}
  result.event = {summary: String(invite.summary || ""), description: String(invite.description || ""),
    location: String(invite.location || ""), start: time(invite.start, original.dtstart), end: time(invite.end, original.dtend)}
  if (invite.meetLink && result.event.description.indexOf(invite.meetLink) < 0)
    result.event.description += "\n" + invite.meetLink
  if (invite.recurrenceRule && !invite.recurrenceIdMs) {
    // Google requires an explicit recurrence zone. UTC events keep UTC; local
    // floating recurrences need the organiser's zone before they can be saved.
    if (!invite.start.allDay && !result.event.start.timeZone) {
      if (!/Z$/.test(String(original.dtstart || ""))) return null
      result.event.start.timeZone = "UTC"
      result.event.end.timeZone = "UTC"
    }
    result.event.recurrence = ["RRULE:" + invite.recurrenceRule]
    var excluded = invite.excludedMs || []
    for (var i = 0; i < excluded.length; i++) {
      var excludedTime = time({ms:excluded[i],allDay:invite.start.allDay}, "")
      result.event.recurrence.push(invite.start.allDay ? "EXDATE;VALUE=DATE:" + excludedTime.date.replace(/-/g, "")
        : "EXDATE:" + excludedTime.dateTime.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"))
    }
  }
  return result
}

function outcome(status) {
  if (status === "existing") return "Already in this calendar; existing event kept"
  if (status === "newer") return "A newer invitation is already saved"
  if (status === "removed" || status === "absent") return "Removed from the saved calendar"
  return "Saved to calendar"
}
