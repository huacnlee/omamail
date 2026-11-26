.pragma library

// Defense in depth: only this small vocabulary can reach a label or stdin.
// scripts/diagnostics.py applies the same policy again before persistence.
var fields = {
  provider: ["google", "microsoft", "caldav", "icloud"],
  operation: ["list", "get", "lookup", "instances", "create", "update", "delete", "move", "import", "saveInvitation", "attendance"],
  stage: ["validation", "authentication", "request", "response"],
  field: ["start", "end", "start.dateTime", "end.dateTime", "start.timeZone", "end.timeZone", "recurrence", "iCalUID", "calendarId", "eventId", "timeMin", "timeMax"],
  reason: ["badRequest", "invalid", "invalidParameter", "required", "authError",
    "forbidden", "insufficientPermissions", "notFound", "duplicate", "conditionNotMet",
    "rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded",
    "usageLimits", "backendError", "internalError", "timeRangeEmpty", "updatedMinTooLongAgo",
    "fullSyncRequired", "forbiddenForNonOrganizer", "participantIsNeitherOrganizerNorAttendee", "accessNotConfigured",
    "ErrorInvalidRequest", "ErrorInvalidProperty", "ErrorInvalidIdMalformed",
    "ErrorAccessDenied", "InvalidAuthenticationToken", "ErrorItemNotFound",
    "ErrorIrresolvableConflict", "TooManyRequests", "ErrorQuotaExceeded",
    "ErrorInternalServerError", "ErrorServiceUnavailable"]
}

function clean(data) {
  var result = {}
  if (!data || typeof data !== "object") return result
  for (var key in fields) {
    if (typeof data[key] === "string" && fields[key].indexOf(data[key]) >= 0)
      result[key] = data[key]
  }
  if (typeof data.httpStatus === "number" && data.httpStatus >= 100 && data.httpStatus <= 599
      && Math.floor(data.httpStatus) === data.httpStatus) result.httpStatus = data.httpStatus
  return result
}

function calendarMethod(method) {
  return ["calendar.request", "calendar.saveInvitation", "calendar.attendance", "request.upload"].indexOf(method) >= 0
}

function summary(data) {
  data = clean(data)
  var parts = []
  if (data.provider) parts.push({google:"Google", microsoft:"Microsoft", caldav:"CalDAV", icloud:"iCloud"}[data.provider])
  if (data.operation) parts.push(data.operation)
  if (data.stage && data.stage !== "request") parts.push(data.stage)
  if (data.httpStatus) parts.push("HTTP " + data.httpStatus)
  if (data.reason) parts.push(data.reason)
  if (data.field) parts.push(data.field)
  return parts.join(" · ")
}
