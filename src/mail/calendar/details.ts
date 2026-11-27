// The diagnostics fields of omarchy/ui/diagnostics/Details.js that calendar
// errors carry: only known values pass, so a server cannot put text of its
// own into the line the user reads.

import type { CalendarErrorDetails } from "./types";

const FIELDS: Record<string, string[]> = {
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
};

export function clean(raw: unknown): CalendarErrorDetails {
  const result: CalendarErrorDetails = {};
  if (!raw || typeof raw !== "object") return result;
  const data = raw as { [key: string]: unknown };
  const strings = result as { [key: string]: string | number | undefined };
  for (const key in FIELDS) {
    const value = data[key];
    if (typeof value === "string" && FIELDS[key].indexOf(value) >= 0) strings[key] = value;
  }
  const status = data.httpStatus;
  if (typeof status === "number" && status >= 100 && status <= 599
      && Math.floor(status) === status) result.httpStatus = status;
  return result;
}

export function summary(data: unknown): string {
  const fields = clean(data);
  const parts: string[] = [];
  const providers: Record<string, string> = { google: "Google", microsoft: "Microsoft", caldav: "CalDAV", icloud: "iCloud" };
  if (fields.provider) parts.push(providers[fields.provider]);
  if (fields.operation) parts.push(fields.operation);
  if (fields.stage && fields.stage !== "request") parts.push(fields.stage);
  if (fields.httpStatus) parts.push("HTTP " + fields.httpStatus);
  if (fields.reason) parts.push(fields.reason);
  if (fields.field) parts.push(fields.field);
  return parts.join(" · ");
}
