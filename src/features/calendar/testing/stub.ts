// A stand-in backend for the calendar's behaviour tests: one Gmail account's
// Google calendar, every call logged, nothing reaching this machine. Entry
// paths resolve from the test file, which lives in src/features/calendar/.
// Synthetic data only.
import { open } from "nsh/test";

export function today(hour: number, minute = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
}

export const EVENT = {
  id: "ev1",
  status: "confirmed",
  summary: "Design review",
  location: "Room 4",
  description: "Bring the sketches",
  htmlLink: "https://calendar.google.com/event?eid=ev1",
  start: { dateTime: today(10).toISOString() },
  end: { dateTime: today(11).toISOString() },
  organizer: { email: "jane@example.com", self: true },
  etag: "\"1\"",
};

/** Tomorrow's event, which the agenda lists as upcoming whatever the hour. */
export const TOMORROW = {
  ...EVENT,
  id: "ev3",
  summary: "Planning",
  htmlLink: "https://calendar.google.com/event?eid=ev3",
  start: { dateTime: new Date(today(10).getTime() + 86400000).toISOString() },
  end: { dateTime: new Date(today(11).getTime() + 86400000).toISOString() },
};

/** The request fields the tests read; the rest are left as sent. */
export type Params = { operation?: string; source?: { kind?: string }; start?: unknown; body?: unknown; [field: string]: unknown };
export type Call = { method: string; params: Params };

export function backend(log: Call[], events: unknown[]) {
  const files: Record<string, string> = {};
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: Params) => {
        log.push({ method, params });
        if (method === "calendar.request") {
          if (params.operation === "list") return { result: { status: 200, body: JSON.stringify({ items: events }) } };
          if (params.operation === "get") return { result: { status: 200, body: JSON.stringify(EVENT) } };
          return { result: { status: 200, body: JSON.stringify({ ...EVENT, id: "ev2" }) } };
        }
        if (method === "calendar.reminders") return { result: { records: [], due: [] } };
        if (method === "cache.calendarRead") return { result: null };
        if (method === "contacts.suggest") {
          return { result: [{ name: "Ann Lee", email: "ann@example.com" }, { name: "李安", email: "lian@example.com" }] };
        }
        return { result: null };
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": (name: string) => files[name] ?? null,
      "Backend.writeConfig": (name: string, text: string) => { files[name] = text; },
    },
  };
}

export async function openCalendar(events: unknown[] = [EVENT], platform?: "macos") {
  const log: Call[] = [];
  // macOS moves the keyboard focus between views with Tab.
  const app = await open("./testing/CalendarHarness.tsx", { modules: backend(log, events), width: 1100, height: 800, platform });
  await app.waitFor("id:calendar-view");
  await app.press("text:Week");
  await app.waitFor("id:calendar-week");
  return { app, log };
}

export const writes = (log: Call[]) => log.filter((r) => r.method === "calendar.request" && r.params.operation !== "list"
  && r.params.operation !== "get");

