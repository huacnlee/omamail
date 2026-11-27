// A synthetic calendar for previews and screenshots: one made-up Gmail
// account (jane@example.com) whose Google calendar answers with a fixed week
// of events. Installed before anything mounts, it keeps the page off this
// machine entirely: backend calls are answered here (usePreviewBackend),
// calendars.json and window.json live in memory. Nothing here is a real
// account, address or server.
import { prefs } from "../../../app/prefs";
import { usePreviewBackend } from "../../../backend/client";
import * as Sources from "../../../mail/calendar/sources";
import { useMemoryCalendarConfig } from "../controller";

function at(dayOffset: number, hour: number, minute = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute).toISOString();
}

function date(dayOffset: number): string {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  return day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
}

const base = { status: "confirmed", organizer: { email: "jane@example.com", self: true }, etag: "\"1\"" };

/** The week the fixture's calendar holds, in Google's shape. */
export const FIXTURE_EVENTS = [
  { ...base, id: "f1", summary: "Design review", location: "Room 4", description: "Bring the sketches",
    start: { dateTime: at(0, 10) }, end: { dateTime: at(0, 11) } },
  { ...base, id: "f2", summary: "Standup", start: { dateTime: at(0, 9) }, end: { dateTime: at(0, 9, 30) } },
  { ...base, id: "f3", summary: "Lunch with Ann", start: { dateTime: at(1, 12) }, end: { dateTime: at(1, 13) } },
  { ...base, id: "f4", summary: "Planning", start: { dateTime: at(-1, 14) }, end: { dateTime: at(-1, 15, 30) } },
  { ...base, id: "f5", summary: "Conference", start: { date: date(1) }, end: { date: date(3) } },
  { ...base, id: "f6", summary: "Overlap A", start: { dateTime: at(0, 14) }, end: { dateTime: at(0, 15) } },
  { ...base, id: "f7", summary: "Overlap B", start: { dateTime: at(0, 14, 30) }, end: { dateTime: at(0, 16) } },
  // A long Chinese title in a short slot: one line, elided, at base 14 and 16.
  { ...base, id: "f8", summary: "季度产品规划评审会议与跨部门协调（第二轮）", location: "三楼会议室",
    start: { dateTime: at(-1, 17) }, end: { dateTime: at(-1, 17, 30) } },
];

/** A calendars.json for the settings page: the mailbox's two Google
 * calendars and a hand-added CalDAV one, all made up. */
export const FIXTURE_CALENDARS = JSON.stringify({
  sources: ([
    { id: "google:jane@example.com:primary", kind: "google", accountId: "jane@example.com", calendarId: "primary", name: "jane@example.com", discovered: true,
      enabled: true, colorKey: "blue", accessRole: "owner", preferred: true, remindersEnabled: true, reminderMinutes: -1 },
    { id: "google:jane@example.com:team", kind: "google", accountId: "jane@example.com", calendarId: "team@group.example.com", name: "Team", discovered: true,
      enabled: false, colorKey: "green", accessRole: "writer", remindersEnabled: true, reminderMinutes: 10 },
    { kind: "caldav", name: "Home", url: "https://dav.example.com/calendars/jane/home/", username: "jane", enabled: true, colorKey: "magenta" },
  ] as Array<Record<string, unknown>>).map((source) => ({ ...source, id: source.id ?? Sources.sourceId(source) })),
});

/** Installs the fixture. Call before mounting. `calendars` is calendars.json
 * (null: none added, the mailbox's primary calendar only). */
export function useCalendarFixture(calendars: string | null = null): void {
  prefs.useMemory();
  useMemoryCalendarConfig(calendars);
  usePreviewBackend((method, params: { operation?: string; eventId?: string }) => {
    if (method === "calendar.request") {
      if (params.operation === "list") return { status: 200, body: JSON.stringify({ items: FIXTURE_EVENTS }) };
      const found = FIXTURE_EVENTS.find((event) => event.id === params.eventId) ?? FIXTURE_EVENTS[0];
      return { status: 200, body: JSON.stringify(found) };
    }
    if (method === "calendar.reminders") return { records: [], due: [] };
    if (method === "contacts.suggest") return [{ name: "Ann Lee", email: "ann@example.com" }];
    return null;
  });
}
