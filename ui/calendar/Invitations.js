.pragma library

.import "../message/Calendar.js" as Calendar
.import "../diagnostics/Details.js" as Details

function destination(settings, mailbox) {
  var targets = settings && settings.invitationCalendars || {}
  var source = targets[mailbox]
  if (!source || source.readOnly === true) return null
  if (source.kind === "google") return source.accountId ? source : null
  return source.kind === "caldav" || source.kind === "icloud" ? source : null
}

// The backend API that first saved to this kind of calendar.
function minimumApi(source) {
  return source && source.kind !== "google" ? 10 : 9
}

function supported(backend, source) {
  return !!backend && backend.ready === true && backend.apiVersion >= minimumApi(source)
}

// Property lines a CalDAV copy may keep from the sender's time zones. The
// backend refuses anything else, so unknown extensions are dropped here.
var ZONE_LINES = /^(BEGIN|END|TZID|LAST-MODIFIED|X-LIC-LOCATION|DTSTART|TZOFFSETFROM|TZOFFSETTO|RRULE|RDATE|TZNAME|COMMENT)[;:]/i

function zoneLines(block) {
  return String(block || "").split(/\r?\n/).filter(function(line) {
    return line !== "" && ZONE_LINES.test(line)
      && !/^(BEGIN|END):(?!VTIMEZONE$|STANDARD$|DAYLIGHT$)/i.test(line)
  })
}

// The invitation's own event for a CalDAV copy: the organiser's time lines
// and zones verbatim, with no ORGANIZER or ATTENDEE, so the server has no
// one to notify.
function copyCalendar(invite, nowMs) {
  var original = invite.source || {}
  if (!original.dtstart) return ""
  var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Omamail//Invitation copy//EN"]
  var zones = Array.isArray(original.timezones) ? original.timezones : []
  for (var z = 0; z < zones.length; z++) lines = lines.concat(zoneLines(zones[z]))
  lines.push("BEGIN:VEVENT", "UID:" + Calendar.escapeText(invite.uid),
    "SEQUENCE:" + (Number(invite.sequence) || 0), "DTSTAMP:" + Calendar.icsTimestamp(nowMs === undefined ? Date.now() : nowMs))
  if (original.recurrenceId) lines.push(original.recurrenceId)
  lines.push(original.dtstart)
  if (original.dtend) lines.push(original.dtend)
  else if (original.duration) lines.push(original.duration)
  var description = String(invite.description || "")
  if (invite.meetLink && description.indexOf(invite.meetLink) < 0)
    description += (description !== "" ? "\n" : "") + invite.meetLink
  if (invite.summary) lines.push("SUMMARY:" + Calendar.escapeText(invite.summary))
  if (description !== "") lines.push("DESCRIPTION:" + Calendar.escapeText(description))
  if (invite.location) lines.push("LOCATION:" + Calendar.escapeText(invite.location))
  if (invite.recurrenceRule && !original.recurrenceId) {
    lines.push("RRULE:" + invite.recurrenceRule)
    // Older cached invitations kept only the excluded instants.
    if (Array.isArray(original.exdates)) lines = lines.concat(original.exdates)
    else (invite.excludedMs || []).forEach(function(ms) {
      lines.push(invite.start && invite.start.allDay
        ? "EXDATE;VALUE=DATE:" + Calendar.icsTimestamp(ms).substring(0, 8)
        : "EXDATE:" + Calendar.icsTimestamp(ms))
    })
  }
  lines.push("END:VEVENT", "END:VCALENDAR")
  return lines.filter(function(line) { return String(line || "") !== "" })
    .map(Calendar.foldIcsLine).join("\r\n") + "\r\n"
}

function params(source, mailbox, invite, response) {
  if (!source || !invite || !invite.uid) return null
  var organizer = Calendar.replyRecipient(invite)
  if (!organizer) return null
  var result = { source: source, mailbox: mailbox, uid: invite.uid, organizer: organizer,
    sequence: Number(invite.sequence) || 0, response: response }
  if (source.kind !== "google") {
    if (invite.recurrenceIdMs) result.originalStart = new Date(invite.recurrenceIdMs).toISOString()
    var removal = response === "cancelled" || response === "declined"
    var text = copyCalendar(invite)
    // A whole series is removed by UID; an occurrence and a save need the event.
    if (text === "") return removal && !invite.recurrenceIdMs ? result : null
    result.calendar = text
    return result
  }
  if (invite.recurrenceIdMs) {
    result.originalStart = new Date(invite.recurrenceIdMs).toISOString()
    var day = /VALUE=DATE:(\d{4})(\d{2})(\d{2})$/.exec(String(invite.source && invite.source.recurrenceId || ""))
    if (day) result.originalStart = day[1] + "-" + day[2] + "-" + day[3]
  }
  if (response === "cancelled" || response === "declined") return result
  if (!invite.start || !invite.end || invite.start.resolved === false || invite.end.resolved === false
      || !(invite.end.ms > invite.start.ms)) return null
  var recurringSeries = !!invite.recurrenceRule && !invite.recurrenceIdMs
  function time(value, raw) {
    if (value.allDay) {
      var date = /:(\d{4})(\d{2})(\d{2})$/.exec(String(raw || ""))
      // DATE values are local calendar dates, never UTC conversions.
      var d = new Date(value.ms)
      return {date: date ? date[1] + "-" + date[2] + "-" + date[3]
        : d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2)}
    }
    var result = {dateTime: new Date(value.ms).toISOString()}
    // Resolved one-off times already include the exact UTC instant. An ICS
    // TZID can be a Windows/custom VTIMEZONE name that Google does not support.
    // Only a recurring series needs the named zone for future DST transitions.
    if (recurringSeries && value.tzid) result.timeZone = value.tzid
    return result
  }
  var original = invite.source || {}
  result.event = {summary: String(invite.summary || ""), description: String(invite.description || ""),
    location: String(invite.location || ""), start: time(invite.start, original.dtstart), end: time(invite.end, original.dtend)}
  if (invite.meetLink && result.event.description.indexOf(invite.meetLink) < 0)
    result.event.description += "\n" + invite.meetLink
  if (recurringSeries) {
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

function failure(error, apiVersion) {
  var code = error && error.message || ""
  var data = Details.clean(apiVersion >= 10 && error ? error.data : null)
  var status = data.httpStatus || 0
  var reason = data.reason || ""
  var advice = "The calendar request failed. See the diagnostic report for details."
  if (status === 429 || ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "usageLimits", "TooManyRequests", "ErrorQuotaExceeded"].indexOf(reason) >= 0)
    advice = "The calendar service is limiting requests. Wait before retrying."
  else if (status >= 500)
    advice = "The calendar service is temporarily unavailable. Try again later."
  else if (status === 401 || code === "calendar_auth_required" || code === "gmail_unauthorized" || code === "auth_signed_out")
    advice = "Sign in to the destination calendar account again, then retry."
  else if (status === 403 || code === "calendar_auth_refused")
    advice = "The calendar service refused access. Check account permissions and the selected calendar."
  else if (reason === "participantIsNeitherOrganizerNorAttendee")
    advice = "The imported event is missing the destination calendar owner. Update Omamail before retrying."
  else if ((status === 400 || status === 422) && (data.field === "start.timeZone" || data.field === "end.timeZone"))
    advice = "The calendar service rejected the invitation's time zone. Check its time zone before retrying."
  else if (status === 400 || status === 422 || code === "calendar_invalid_input" || code === "Invalid params")
    advice = "The calendar request is invalid. Check the error details before retrying."
  else if (status === 409 || status === 412 || code === "calendar_conflict")
    advice = "The calendar event changed or conflicts with an existing event. Refresh the calendar, then retry."
  else if (status === 404 || status === 410 || code === "calendar_not_found")
    advice = "The calendar or event is no longer available. Check the destination and refresh."
  else if (code === "calendar_timeout" || code === "request_timed_out")
    advice = "The calendar request timed out; the save could not be confirmed. Refresh before retrying."
  else if (code === "calendar_network_failed")
    advice = "The calendar connection failed; the save could not be confirmed. Check the connection and refresh before retrying."
  else if (code === "gmail_http_failed" || data.stage === "authentication")
    advice = "Could not authenticate with the calendar account. Check the sign-in failure in the diagnostic report."
  else if (code === "calendar_invitation_series_required")
    advice = "Save the original series invitation before updating this occurrence."
  else if (code === "calendar_organizer_mismatch" || code === "calendar_ambiguous_invitation")
    advice = "The invitation could not be matched safely. Check the existing event in your calendar."
  var detail = Details.summary(data)
  var uncertain = status >= 500 || code === "calendar_timeout" || code === "request_timed_out" || code === "calendar_network_failed"
  return (uncertain ? "Calendar save not confirmed. " : "Not saved to calendar. ") + advice + " Retrying will not resend your reply."
    + (detail ? "\n" + detail : "")
}
