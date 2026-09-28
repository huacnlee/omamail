.pragma library

.import "Sources.js" as Sources

// Reminder eligibility is independent of whether a calendar is drawn. Inputs
// are normalized calendar resources, not mail's potentially stale invitation.
function candidates(events, sources) {
  var byId = {}
  var values = sources && Array.isArray(sources.sources) ? sources.sources : []
  for (var i = 0; i < values.length; i++) byId[values[i].id] = values[i]
  var out = [], seen = {}
  var items = Array.isArray(events) ? events : []
  for (var e = 0; e < items.length; e++) {
    var event = items[e], source = event && byId[event.sourceId]
    if (!Sources.nativeCalendarFeatures(source) || source.remindersEnabled !== true || !event.start || !event.end
        || event.status === "CANCELLED") continue
    var accountAddress = String(source.accountId || source.username || "").replace(/^[^:@]+:/, "").toLowerCase()
    if ((event.attendees || []).some(function(attendee) {
      var own = attendee.self === true || (accountAddress !== "" && String(attendee.email || "").toLowerCase() === accountAddress)
      return own && (attendee.responseStatus === "declined" || attendee.partstat === "DECLINED"
        || (attendee.status && attendee.status.response === "declined"))
    })) continue
    var policy = event.reminders || { useDefault: true }
    if (policy.useDefault === false && (!Array.isArray(policy.overrides) || policy.overrides.length === 0)) continue
    var reminders = policy.useDefault === true ? source.defaultReminders : policy.overrides
    if (Number(source.reminderMinutes) >= 0) reminders = [{method:"popup",minutes:Number(source.reminderMinutes)}]
    if (!Array.isArray(reminders)) continue
    var original = event.originalStartTime || {}
    var originalTime = original.dateTime ? Date.parse(String(original.dateTime)) : NaN
    var occurrence = String(event.uid || event.googleId || "") + "\n"
      + String(event.organizer && event.organizer.email || "").toLowerCase() + "\n"
      + String(isFinite(originalTime) ? originalTime : original.date || event.start.ms)
    for (var r = 0; r < reminders.length; r++) {
      var reminder = reminders[r], minutes = Number(reminder.minutes)
      if (reminder.method !== "popup" || !isFinite(minutes) || minutes < 0 || minutes > 40320) continue
      var key = occurrence + "\n" + minutes
      if (seen[key]) continue
      seen[key] = true
      out.push({ key: key, occurrence: occurrence, due: Number(event.start.ms) - minutes * 60000,
        start: Number(event.start.ms), end: Number(event.end.ms), eventId: String(event.googleId || event.uid || ""),
        sourceId: String(source.id), title: String(event.summary || "Event"), accountId: String(source.accountId || "") })
    }
  }
  return out
}
