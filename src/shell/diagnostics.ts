// Backend errors kept for diagnosis. Port of omarchy/ui/diagnostics: only a
// small vocabulary of fields can reach a label or leave the app (defense in
// depth: a provider's error text is untrusted and may carry addresses or
// message content). The Qt plugin handed the queue to a Python helper that
// opened the system AI; here "Diagnose with AI..." is the assistant's command
// (`diagnoseError`), which reads `recentErrors()`.
import { signal } from "nsh";

const FIELDS: Record<string, readonly string[]> = {
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
    "ErrorInternalServerError", "ErrorServiceUnavailable"],
};

export interface ErrorDetails {
  provider?: string;
  operation?: string;
  stage?: string;
  field?: string;
  reason?: string;
  httpStatus?: number;
}

/** Only the known values of the known fields. */
export function clean(data: unknown): ErrorDetails {
  const result: Record<string, string | number> = {};
  if (!data || typeof data !== "object") return result;
  const source = data as Record<string, unknown>;
  for (const key of Object.keys(FIELDS)) {
    const value = source[key];
    if (typeof value === "string" && FIELDS[key].includes(value)) result[key] = value;
  }
  const status = source.httpStatus;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status;
  return result as ErrorDetails;
}

export function calendarMethod(method: string): boolean {
  return ["calendar.request", "calendar.saveInvitation", "calendar.attendance", "request.upload"].includes(method);
}

const PROVIDER_NAMES: Record<string, string> = { google: "Google", microsoft: "Microsoft", caldav: "CalDAV", icloud: "iCloud" };

/** One line for the status bar: "Google · create · HTTP 400 · invalid · start". */
export function summary(data: unknown): string {
  const d = clean(data);
  const parts: string[] = [];
  if (d.provider) parts.push(PROVIDER_NAMES[d.provider]);
  if (d.operation) parts.push(d.operation);
  if (d.stage && d.stage !== "request") parts.push(d.stage);
  if (d.httpStatus) parts.push("HTTP " + d.httpStatus);
  if (d.reason) parts.push(d.reason);
  if (d.field) parts.push(d.field);
  return parts.join(" · ");
}

export interface RecordedError {
  method: string;
  error: { code: number | null; message: string; data?: ErrorDetails };
}

const LIMIT = 32;
const REPEAT_MS = 10000;
const queue = signal<RecordedError[]>([]);
let previous = "";
let previousAt = 0;

/** Keeps a backend error: its method, code and a short message only. The
 * same error again within ten seconds is one error. */
export function record(method: string, error: unknown, now = Date.now()): void {
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const event: RecordedError = {
    method: String(method ?? "").slice(0, 80),
    error: {
      code: typeof e.code === "number" ? e.code : null,
      message: typeof e.message === "string" && e.message.length <= 128 ? e.message : "unknown_error",
    },
  };
  if (calendarMethod(event.method)) event.error.data = clean(e.data);
  const encoded = JSON.stringify(event);
  if (encoded === previous && now - previousAt < REPEAT_MS) return;
  previous = encoded;
  previousAt = now;
  queue.update((list) => [...list.slice(-(LIMIT - 1)), event]);
}

/** The kept errors, oldest first (reactive). */
export function recentErrors(): RecordedError[] {
  return queue();
}

export function clearErrors(): void {
  queue.set([]);
  previous = "";
  previousAt = 0;
}
