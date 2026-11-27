// The calendar page on a stand-in backend: one Gmail account's Google
// calendar with one event today. What it asks the backend, what it shows,
// and that nothing is written before the owner says so.
import { expect, test } from "nsh/test";

import { EVENT, TOMORROW, openCalendar, today, writes } from "./testing/stub";

test("the week lists the Google calendar's range and shows its event", async () => {
  const { app, log } = await openCalendar();
  await app.waitFor("text:Design review");
  const list = log.find((r) => r.method === "calendar.request" && r.params.operation === "list")!;
  expect(list.params.source?.kind).toBe("google");
  expect(typeof list.params.start).toBe("string");
  expect(writes(log)).toEqual([]);
});

test("an event opens its detail, and deleting asks before anything is written", async () => {
  const { app, log } = await openCalendar();
  await app.press("text:Design review");
  await app.waitFor("id:calendar-event-detail");
  await app.waitFor("text:Bring the sketches");
  expect(app.shows("text:Room 4")).toBe(true);
  await app.press("id:event-delete");
  await app.waitFor("text:This event will be permanently deleted.");
  expect(writes(log)).toEqual([]);
  await app.press("id:event-delete-all");
  await app.waitUntil(() => writes(log).some((r) => r.params.operation === "delete"));
});

test("the views switch, and the agenda says when the range is empty", async () => {
  const { app } = await openCalendar([]);
  await app.press("text:Month");
  await app.waitFor("id:calendar-month");
  await app.press("text:Day");
  await app.waitFor("id:calendar-week");
  await app.press("text:Agenda");
  await app.waitFor("text:No upcoming events in this date range.");
});

test("c opens the editor, and only Create event writes", async () => {
  const { app, log } = await openCalendar();
  await app.waitFor("text:Design review");
  await app.keyboard.press("c");
  await app.waitFor("id:event-composer");
  await app.type("id:event-title-field", "Planning");
  expect(writes(log)).toEqual([]);
  await app.press("id:event-save-button");
  await app.waitUntil(() => writes(log).some((r) => r.params.operation === "create"));
  const created = writes(log).find((r) => r.params.operation === "create")!;
  expect(JSON.stringify(created.params)).toContain("Planning");
});

test("an event dragged down is written at its new time only on release", async () => {
  const { app, log } = await openCalendar();
  await app.waitFor("text:Design review");
  await app.dragAndHold("text:Design review", { y: 120 });
  expect(writes(log)).toEqual([]);
  await app.drop();
  await app.waitUntil(() => writes(log).some((r) => r.params.operation === "update"));
  const update = writes(log).find((r) => r.params.operation === "update")!;
  const body = JSON.parse(String(update.params.body));
  expect(new Date(body.start.dateTime).getTime()).toBeGreaterThan(today(10).getTime());
});

test("a month event carried to the next day is written there only on release", async () => {
  const { app, log } = await openCalendar();
  await app.press("text:Month");
  await app.waitFor("id:calendar-month");
  const cell = app.layout("id:calendar-day-" + isoDay(today(0)))!;
  const chip = "text:" + app.texts().find((t) => t.endsWith("Design review"))!;
  await app.dragAndHold(chip, { x: cell.width, y: 0 });
  expect(writes(log)).toEqual([]);
  await app.drop();
  await app.waitUntil(() => writes(log).some((r) => r.params.operation === "update"));
  const body = JSON.parse(String(writes(log).find((r) => r.params.operation === "update")!.params.body));
  const moved = new Date(body.start.dateTime);
  expect(isoDay(moved)).toBe(isoDay(new Date(today(10).getTime() + 86400000)));
  expect(moved.getHours()).toBe(10);
});

function isoDay(date: Date): string {
  const two = (n: number) => (n < 10 ? "0" : "") + n;
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate());
}

test("guest suggestions come from contacts and fill the address only", async () => {
  const { app, log } = await openCalendar();
  await app.press("id:calendar-new-event");
  await app.waitFor("id:event-composer");
  await app.type("id:event-guests-field", "an");
  await app.waitFor("id:event-guest-suggestions");
  await app.press("text:Ann Lee");
  await app.waitUntil(() => (app.value("id:event-guests-field") ?? "").includes("ann@example.com"));
  expect(app.value("id:event-guests-field")).not.toContain("Ann Lee");
  expect(writes(log)).toEqual([]);
});

test("Escape leaves the detail for the view it came from", async () => {
  const { app } = await openCalendar();
  await app.press("text:Design review");
  await app.waitFor("id:calendar-event-detail");
  await app.keyboard.press("escape");
  await app.waitFor("id:calendar-event-detail", { state: "gone" });
  expect(app.shows("id:calendar-week")).toBe(true);
});

test("the keyboard reaches an event and opens it with Return or Space", async () => {
  // Week: the event card is the page's last Tab stop, so Shift+Tab lands on it.
  const { app, log } = await openCalendar([EVENT, TOMORROW], "macos");
  await app.waitFor("text:Design review");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("enter");
  await app.waitFor("id:calendar-event-detail");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:calendar-event-detail"));
  // Agenda: a row opens with Space as well.
  await app.press("text:Agenda");
  await app.waitFor("text:Planning");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("space");
  await app.waitFor("id:calendar-event-detail");
  // Opening by keyboard moves nothing.
  expect(writes(log)).toEqual([]);
});
