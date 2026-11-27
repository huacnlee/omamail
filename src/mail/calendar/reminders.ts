// A line-for-line port of omarchy/ui/calendar/Reminders.js, typed with the
// shapes in types.ts; its behavior is unchanged from the Qt client's, and the
// tests next to it are the Qt tests ported.
import * as Sources from "./sources";
import type { CalendarEvent, CalendarSource, JsonObject, ReminderCandidate, SourceList } from "./types";
// Reminder eligibility is independent of whether a calendar is drawn. Inputs
// are normalized calendar resources, not mail's potentially stale invitation.
export function candidates(events?: CalendarEvent[] | null, sources?: SourceList | null): ReminderCandidate[] {
  var byId: { [id: string]: CalendarSource } = {}
  var values = sources && Array.isArray(sources.sources) ? sources.sources : []
  for (var i = 0; i < values.length; i++) byId[values[i].id] = values[i]
  var out: ReminderCandidate[] = [], seen: { [key: string]: boolean } = {}
  var items: CalendarEvent[] = Array.isArray(events) ? events : []
  for (var e = 0; e < items.length; e++) {
    var event = items[e], source = event && byId[String(event.sourceId)]
    if (!source || !Sources.nativeCalendarFeatures(source) || source.remindersEnabled !== true || !event.start || !event.end
        || event.status === "CANCELLED") continue
    var accountAddress = String(source.accountId || source.username || "").replace(/^[^:@]+:/, "").toLowerCase()
    if ((event.attendees || []).some(function(attendee) {
      var own = attendee.self === true || (accountAddress !== "" && String(attendee.email || "").toLowerCase() === accountAddress)
      return own && (attendee.responseStatus === "declined" || attendee.partstat === "DECLINED"
        || (attendee.status && attendee.status.response === "declined"))
    })) continue
    // The event's own reminder policy arrived from the server unchecked.
    var policy = (event.reminders || { useDefault: true }) as { useDefault?: unknown, overrides?: unknown }
    if (policy.useDefault === false && (!Array.isArray(policy.overrides) || policy.overrides.length === 0)) continue
    var reminders: unknown = policy.useDefault === true ? source.defaultReminders : policy.overrides
    if (Number(source.reminderMinutes) >= 0) reminders = [{method:"popup",minutes:Number(source.reminderMinutes)}]
    if (!Array.isArray(reminders)) continue
    var original = (event.originalStartTime || {}) as JsonObject
    var originalTime = original.dateTime ? Date.parse(String(original.dateTime)) : NaN
    var occurrence = String(event.uid || event.googleId || "") + "\n"
      + String(event.organizer && event.organizer.email || "").toLowerCase() + "\n"
      + String(isFinite(originalTime) ? originalTime : original.date || event.start.ms)
    for (var r = 0; r < reminders.length; r++) {
      var reminder = reminders[r] as JsonObject, minutes = Number(reminder.minutes)
      if (reminder.method !== "popup" || !isFinite(minutes) || minutes < 0 || minutes > 40320) continue
      var key = occurrence + "\n" + minutes
      if (seen[key]) continue
      seen[key] = true
      // A point in time (a pill to take, a deadline) ends where it starts;
      // the ledger wants an end after the start, or it refuses the whole poll.
      out.push({ key: key, occurrence: occurrence, due: Number(event.start.ms) - minutes * 60000,
        start: Number(event.start.ms), end: Math.max(Number(event.end.ms), Number(event.start.ms) + 60000), eventId: String(event.googleId || event.uid || ""),
        sourceId: String(source.id), title: String(event.summary || "Event"), accountId: String(source.accountId || "") })
    }
  }
  return out
}
