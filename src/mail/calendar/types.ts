// The shapes the calendar rules pass around. The rules were ported from the
// Qt client's untyped JavaScript; these name what its objects carried, so a
// caller reads a field the rules really set. Values a server sent stay
// `unknown` until a rule has checked them.

/** A JSON object as it arrived: every field still to be checked. */
export type JsonObject = { [key: string]: unknown };

/** A start or end: the moment, and whether it is a date (an all-day event). */
export interface CalendarMoment {
  ms: number;
  allDay: boolean;
  /** The TZID it was written in (iCalendar), "" for UTC or a floating time. */
  tzid?: string;
  /** The zone was known and the moment is exact. */
  resolved?: boolean;
}

/** A guest or the organizer, as the providers' readers leave them. */
export interface CalendarPerson {
  email: string;
  name?: string;
  displayName?: string;
  role?: string;
  partstat?: string;
  responseStatus?: string;
  rsvp?: boolean;
  /** Microsoft Graph: the guest's answer. */
  status?: { response?: string };
  /** Microsoft Graph: the guest's address, before graphPerson reads it. */
  emailAddress?: { address?: string; name?: string };
  /** Google: an optional guest. */
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  [key: string]: unknown;
}

/** The raw lines an iCalendar event arrived with, kept for a reply. */
export interface CalendarEventSource {
  dtstart?: string;
  dtend?: string;
  duration?: string;
  recurrenceId?: string;
  timezones?: string[];
}

/** One event (or one occurrence of a series) from any provider. */
export interface CalendarEvent {
  method?: string;
  uid?: string;
  sequence?: number;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  organizer?: CalendarPerson | null;
  attendees?: CalendarPerson[];
  start: CalendarMoment;
  end: CalendarMoment;
  /** A sentence for a series ("Weekly on Monday"), "" for a single event. */
  recurrence?: string;
  recurrenceRule?: string;
  recurrenceLines?: string[];
  recurrenceIdMs?: number;
  excludedMs?: number[];
  meetLink?: string;
  sourceId?: string;
  href?: string;
  /** CalDAV: the whole resource, rewritten in place on an update. */
  calendarData?: string;
  etag?: string;
  /** Google: the item's own id (an occurrence's instance id). */
  googleId?: string;
  recurringEventId?: string;
  originalStartTime?: unknown;
  timeZone?: string;
  reminders?: unknown;
  conferenceData?: unknown;
  eventType?: string;
  guestsCanModify?: boolean;
  transparency?: string;
  visibility?: string;
  /** Microsoft Graph: the item's own id. */
  graphId?: string;
  /** An occurrence expanded from a series: the series' start. */
  seriesStartMs?: number;
  occurrence?: boolean;
  source?: CalendarEventSource | null;
  [key: string]: unknown;
}

/** One calendar the user added or an account brought (calendars.json). */
export interface CalendarSource {
  id: string;
  kind: string;
  name: string;
  url: string;
  username: string;
  accountId: string;
  enabled: boolean;
  calendarId: string;
  readOnly: boolean;
  discovered: boolean;
  colorKey: string;
  accessRole: string;
  timeZone: string;
  canCreateMeet: boolean;
  defaultReminders: unknown[];
  remindersEnabled: boolean;
  /** -1: the calendar's own default. */
  reminderMinutes: number;
  preferred: boolean;
  [key: string]: unknown;
}

export interface SourceList {
  version: number;
  sources: CalendarSource[];
}

/** An account as the calendar sees it (the Qt client's `accountSummaries`). */
export interface AccountSummary {
  id: string;
  email?: string;
  provider?: string;
  calendarProvider?: string;
  label?: string;
  name?: string;
  signedIn?: boolean;
  imap?: { imapHost?: string };
  [key: string]: unknown;
}

/** A day of a month or week view. */
export interface CalendarDay {
  isoDate: string;
  day: number;
  month: number;
  year: number;
  startMs: number;
  endMs: number;
  inMonth: boolean;
}

/** What the event editor hands the writers. */
export interface EventFields {
  title?: string;
  startMs?: number;
  endMs?: number;
  description?: string;
  location?: string;
  allDay?: boolean;
  /** The editor's repeat settings; recurrenceRule turns them into an RRULE. */
  recurrence?: RecurrenceChoice;
  /** Google: the zone a timed event is written in. */
  timeZone?: string;
  /** Google: rewrite the series' RRULE from `recurrence`. */
  changeRecurrence?: boolean;
  /** Google: the guests, comma, semicolon or line separated; absent keeps them. */
  guestEmails?: string;
  transparency?: string;
  visibility?: string;
  /** Google: "default", "none" or "custom" (with reminderMinutes). */
  reminderMode?: string;
  reminderMinutes?: number | string;
  createMeet?: boolean;
  conferenceRequestId?: string;
  /** Google: whom a change is mailed to ("all" or "none"). */
  sendUpdates?: string;
  [key: string]: unknown;
}

/** A rule's yes or no, with the words for a no. */
export interface Verdict {
  ok: boolean;
  error: string;
}

/** The calendars of one account (or one owner), as the pickers group them. */
export interface CalendarGroup {
  id: string;
  providerLabel: string;
  accountLabel: string;
  calendars: CalendarSource[];
}

/** A source's validation: the normalized source, or the words for a no. */
export type SourceVerdict =
  | { ok: true; source: CalendarSource; error?: undefined }
  | { ok: false; error: string; source?: undefined };

/** The colors a theme gives the palette's slots, by slot name. */
export type PaletteColors = { [slot: string]: string };

/** One cached range. Read back from disk, its fields are still unchecked. */
export interface CalendarCacheRange {
  startMs?: unknown;
  endMs?: unknown;
  at?: unknown;
  events?: unknown;
  [key: string]: unknown;
}

/** The event cache: fetched ranges by scope and span. */
export interface CalendarCacheStore {
  version: number;
  ranges: { [key: string]: CalendarCacheRange };
}

/** A reminder the backend's ledger may raise. */
export interface ReminderCandidate {
  key: string;
  occurrence: string;
  due: number;
  start: number;
  end: number;
  eventId: string;
  sourceId: string;
  title: string;
  accountId: string;
}

/** A start or end as Google's import takes it. */
export interface InvitationTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** The event an invitation saves, in Google's shape. */
export interface InvitationEvent {
  summary: string;
  description: string;
  location: string;
  start: InvitationTime;
  end: InvitationTime;
  recurrence?: string[];
}

/** What saving or answering an invitation asks of the backend. */
export interface InvitationParams {
  source: CalendarSource;
  mailbox: string;
  uid: string;
  organizer: string;
  sequence: number;
  response: string;
  originalStart?: string;
  event?: InvitationEvent;
}

/** A backend error as an invitation save reports it; both fields unchecked. */
export interface InvitationError {
  message?: unknown;
  data?: unknown;
}

/** The diagnostics fields a calendar error carries once checked. */
export interface CalendarErrorDetails {
  provider?: string;
  operation?: string;
  stage?: string;
  field?: string;
  reason?: string;
  httpStatus?: number;
}

/** The repeat settings the event editor sends. */
export interface RecurrenceChoice {
  enabled?: boolean;
  frequency?: string;
  interval?: number | string;
  /** Blank for a series without an end. */
  count?: number | string;
}

/** An RRULE's parts by name (FREQ, INTERVAL, BYDAY...), values as written. */
export type RecurrenceParts = { [name: string]: string };

/** A rule's no, with the words for it. */
export interface Refusal {
  ok: false;
  error: string;
}

/** The RRULE value for the editor's settings, "" for a single event. */
export type RecurrenceRuleResult = Refusal | { ok: true; rule: string };

/** Event fields once validateEventFields has checked them. */
export interface CheckedEventFields {
  title: string;
  start: number;
  end: number;
  description?: string;
  location?: string;
}

export type ValidatedEventFields = Refusal | ({ ok: true } & CheckedEventFields);

/** The editor's dates and times read as a range. */
export type EditorDateRange = Refusal | { ok: true; error: ""; startMs: number; endMs: number };

/** A start or end as Google's write API takes it; null clears it in a PATCH. */
export interface GoogleEventTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

/** The body of a Google Calendar insert or patch. */
export interface GoogleEventBody {
  summary?: string;
  description?: string;
  location?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  recurrence?: string[];
  attendees?: CalendarPerson[];
  transparency?: string;
  visibility?: string;
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  conferenceData?: {
    createRequest: { requestId: string; conferenceSolutionKey: { type: string } };
  };
}

export type GoogleOptionsResult = Refusal | { ok: true; body: GoogleEventBody };

/** A start or end as Microsoft Graph takes it. */
export interface GraphEventTime {
  dateTime: string;
  timeZone: string;
}

/** The body of a Microsoft Graph event create or update. */
export interface GraphEventBody {
  subject: string;
  body: { contentType: string; content: string };
  location: { displayName: string };
  isAllDay: boolean;
  start: GraphEventTime;
  end: GraphEventTime;
}

/** A new or edited event, written for every provider at once. */
export type EventWriteResult = Refusal | {
  ok: true;
  uid: string;
  /** The iCalendar resource for CalDAV. */
  ics: string;
  google: GoogleEventBody;
  graph: GraphEventBody;
  /** createEvent only: the event repeats, which Graph is not sent. */
  recurring?: boolean;
};

/** One answer of a delete confirmation: `value` is "all", "none" or "series". */
export interface DeleteChoice {
  value: string;
  label: string;
}

/** What a delete confirmation asks; the last choice is the default. */
export interface DeleteRequest {
  kind: string;
  name: string;
  message: string;
  choices: DeleteChoice[];
}

/** A move or resize of an event on the grid, as its new start and end. */
export interface GestureRange {
  start: number;
  end: number;
}

/** The part of a day the layout rules read: its local midnight to the next. */
export interface DayBounds {
  startMs: number;
  endMs: number;
}

/** A timed event placed in a day column (timedLayout). */
export interface TimedLayoutRow {
  event: CalendarEvent;
  /** The part of the event inside the day. */
  start: number;
  end: number;
  column: number;
  columns: number;
}

/** An event placed in a day column: lane / lanes across, span / lanes wide. */
export interface DayLane {
  event: CalendarEvent;
  lane: number;
  lanes: number;
  span: number;
}

/** One week's piece of an event that spans days, in the month grid. */
export interface SpanSegment {
  event: CalendarEvent;
  week: number;
  startColumn: number;
  endColumn: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The span segments, and how many lanes each week needs. */
export interface SpanLayout {
  segments: SpanSegment[];
  laneCounts: number[];
}

/** A guest as the event details list them. */
export interface AttendeeRow {
  name: string;
  email: string;
  label: string;
  symbol: string;
  optional: boolean;
  self: boolean;
}

/** A calendar in the editor's picker, with its group's heading. */
export interface CalendarChoiceRow {
  source: CalendarSource;
  firstInGroup: boolean;
  groupLabel: string;
}

/** One resource of a CalDAV REPORT: its href and calendar data, decoded. */
export interface CaldavResponse {
  href: string;
  data: string;
}

/** The host and port of an HTTPS URL, the port spelled out. */
export interface UrlAuthority {
  host: string;
  port: string;
}

/** A Date field reader, local or UTC, as the recurrence walk names them. */
export type CalendarDateGetter =
  | "getFullYear" | "getUTCFullYear" | "getMonth" | "getUTCMonth"
  | "getDate" | "getUTCDate" | "getDay" | "getUTCDay";

/** A DTSTART line's wall-clock fields, as the iCalendar reader parses them. */
export interface CalendarWallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateOnly?: boolean;
  utc?: boolean;
}

/** One reason of a Google error answer: unchecked. */
export interface GoogleErrorReason {
  reason?: unknown;
  [key: string]: unknown;
}

/** A Google or Graph error answer as it arrived: nothing checked. */
export interface GoogleErrorPayload {
  error?: {
    message?: unknown;
    code?: unknown;
    errors?: unknown;
    details?: unknown;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** A start or end of a Google event item as the API sends it: unchecked. */
export interface GoogleWireTime {
  dateTime?: unknown;
  date?: unknown;
  timeZone?: unknown;
  [key: string]: unknown;
}

/** A Google Calendar event item as the API sends it: only its nesting is assumed. */
export interface GoogleEventItem {
  start?: GoogleWireTime | null;
  end?: GoogleWireTime | null;
  [key: string]: unknown;
}

/** A Microsoft Graph start or end as it arrived: unchecked. */
export interface GraphWireTime {
  dateTime?: unknown;
  timeZone?: unknown;
  [key: string]: unknown;
}

/** A Microsoft Graph email address as it arrived: unchecked. */
export interface GraphEmailAddress {
  address?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/** A Microsoft Graph organizer or attendee as it arrived. */
export interface GraphWirePerson {
  emailAddress?: GraphEmailAddress | null;
  [key: string]: unknown;
}

/** A Microsoft Graph event item as the API sends it: only its nesting is assumed. */
export interface GraphEventItem {
  start?: GraphWireTime | null;
  end?: GraphWireTime | null;
  location?: { displayName?: unknown; [key: string]: unknown } | null;
  onlineMeeting?: { joinUrl?: unknown; [key: string]: unknown } | null;
  organizer?: GraphWirePerson | null;
  [key: string]: unknown;
}
