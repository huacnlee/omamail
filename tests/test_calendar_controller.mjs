import assert from "node:assert/strict";
import { createCalendarController } from "../app/calendar/controller.js";

// What Google answers a range with. Not a list of events: the reply is its own
// event resource, and reading one is what `eventsFromGoogle` is for.
const googleReply = (items) => ({ items });
/** One Google event, as the API writes it. */
const googleEvent = (id, summary, startMs) => ({
  id,
  iCalUID: `${id}@google.com`,
  summary,
  status: "confirmed",
  start: { dateTime: new Date(startMs).toISOString() },
  end: { dateTime: new Date(startMs + 3600000).toISOString() },
});

const effects = [];
const completions = [];
const calendar = createCalendarController({
  source: { id: "google:calendar", kind: "google", name: "Work" },
  execute(effect, done) {
    effects.push(effect);
    completions.push(done);
    return { cancel() {} };
  },
});
calendar.showWeek(Date.UTC(2026, 7, 20));
assert.equal(calendar.snapshot().view, "week");
assert.equal(calendar.snapshot().loading, true);
assert.equal(
  calendar.snapshot().range.endMs - calendar.snapshot().range.startMs,
  7 * 24 * 60 * 60 * 1000,
);
assert.equal(calendar.snapshot().weekDays.length, 7);
assert.equal(calendar.snapshot().days.length, 0, "only the range on screen is built");
const staleRead = completions.shift();
calendar.showMonth(Date.UTC(2026, 8, 1));
assert.equal(
  calendar.snapshot().range.endMs > calendar.snapshot().range.startMs,
  true,
);
assert.equal(calendar.snapshot().days.length, 42);
const currentRead = completions.shift();
staleRead({
  ok: true,
  value: googleReply([googleEvent("stale", "Stale", Date.UTC(2026, 7, 20, 9))]),
});
assert.deepEqual(calendar.snapshot().events, []);
currentRead({
  ok: true,
  value: googleReply([
    googleEvent("current", "Current", Date.UTC(2026, 8, 4, 9)),
  ]),
});
assert.deepEqual(
  calendar.snapshot().events.map((event) => event.googleId),
  ["current"],
);
assert.equal(
  calendar.snapshot().events[0].summary,
  "Current",
  "the answer is parsed rather than taken as a list of events",
);
assert.equal(calendar.snapshot().loading, false);
assert.equal(
  calendar.snapshot().events[0].sourceId,
  "google:calendar",
  "an event carries the calendar that answered for it",
);
const septemberAnchor = calendar.snapshot().anchorMs;
calendar.previous();
assert.equal(calendar.snapshot().anchorMs < septemberAnchor, true);
completions.shift()({ ok: true, value: googleReply([]) });
calendar.next();
assert.equal(calendar.snapshot().anchorMs, septemberAnchor);
completions.shift()({
  ok: true,
  value: googleReply([
    googleEvent("current", "Current", Date.UTC(2026, 8, 4, 9)),
  ]),
});

// The cursor and the open event are two different things.
calendar.select(calendar.snapshot().events[0]);
assert.equal(calendar.snapshot().selected.googleId, "current");
assert.equal(calendar.snapshot().selectedEventId, "current@google.com");
assert.equal(calendar.snapshot().detail, null, "moving the cursor opens nothing");
calendar.activate(calendar.snapshot().selected);
assert.equal(calendar.snapshot().detail.event.googleId, "current");
assert.equal(
  calendar.snapshot().detail.canWrite,
  true,
  "a Google event carries the item id a write aims at",
);
calendar.closeDetail();
assert.equal(calendar.snapshot().detail, null);

calendar.beginEdit(calendar.snapshot().selected);
assert.equal(calendar.snapshot().editing.id, "current");
assert.equal(calendar.snapshot().composer.editing, true);
assert.equal(
  calendar.snapshot().composer.recurring,
  false,
  "recurrence is offered on creation only",
);
calendar.updateDraft({ title: "Changed" });
assert.equal(calendar.snapshot().editing.fields.title, "Changed");
calendar.cancelEdit();
assert.equal(calendar.snapshot().editing, null);
assert.equal(calendar.snapshot().composer, null);

// A delete asks first, naming the target, and only the answer reaches the host.
calendar.select({ id: "delete-me", googleId: "delete-me", title: "Delete me" });
calendar.requestDelete();
assert.equal(calendar.snapshot().confirm.name, "Delete me");
assert.equal(effects.at(-1).type, "calendar.list", "asking writes nothing");
calendar.cancelDelete();
assert.equal(calendar.snapshot().confirm, null);
calendar.requestDelete();
calendar.confirmDelete();
assert.equal(calendar.snapshot().pending, true);
assert.equal(calendar.snapshot().confirm, null);
assert.equal(effects.at(-1).type, "calendar.google.delete");
assert.equal(effects.at(-1).eventId, "delete-me");
completions.shift()({ ok: true, value: null });
assert.equal(calendar.snapshot().selected, null);
assert.equal(calendar.snapshot().writeStatus, "Deleted");

calendar.beginCreate();
assert.equal(calendar.snapshot().composer.editing, false);
calendar.updateDraft({ title: "", startMs: 10, endMs: 20 });
calendar.save();
assert.equal(calendar.snapshot().status, "Add an event title");
assert.equal(
  calendar.snapshot().composer.result,
  "Add an event title",
  "a refusal is reported under the form it refused",
);
calendar.updateDraft({ title: "Planning", startMs: 10, endMs: 20 });
calendar.save();
assert.equal(calendar.snapshot().pending, true);
assert.equal(calendar.snapshot().composer.result, "", "progress is not a refusal");
assert.equal(effects.at(-1).source.id, "google:calendar");
completions.shift()({ ok: false, error: "Calendar write failed" });
assert.equal(calendar.snapshot().pending, false);
assert.equal(calendar.snapshot().status, "Calendar write failed");

// A slot pressed on the grid is the slot the composer opens at.
calendar.beginCreate(Date.UTC(2026, 8, 4, 9));
assert.equal(calendar.snapshot().editing.fields.startMs, Date.UTC(2026, 8, 4, 9));
assert.equal(
  calendar.snapshot().editing.fields.endMs,
  Date.UTC(2026, 8, 4, 10),
  "an event proposed from the grid is an hour long",
);
calendar.updateRecurrence({ enabled: true, frequency: "MONTHLY", interval: "2" });
assert.equal(calendar.snapshot().composer.recurring, true);
assert.equal(calendar.snapshot().composer.frequency, "MONTHLY");
calendar.cancelEdit();

const source = { id: "google:calendar", kind: "google" };
const fields = {
  title: "Event",
  startMs: Date.UTC(2026, 8, 1, 9),
  endMs: Date.UTC(2026, 8, 1, 10),
  description: "",
  location: "",
};
calendar.write({
  id: "first",
  uid: "first",
  source,
  fields,
  start: { allDay: false },
});
calendar.write({
  id: "second",
  uid: "second",
  source,
  fields,
  start: { allDay: false },
});
// The calendar a write is aimed at is copied into the effect, not referred to:
// the caller's object can change under a request that is already in flight.
const capturedSource = effects.at(-1).source;
source.id = "mutated";
assert.equal(capturedSource.id, "google:calendar");
assert.equal(Object.isFrozen(capturedSource), true);
const oldWrite = completions.shift();
const newWrite = completions.shift();
effects.length = 0;
newWrite({ ok: true, value: { id: "second-saved" } });
assert.equal(
  effects.filter((effect) => effect.type === "calendar.list").length,
  1,
  "a write that landed reads the range back, so the event is on the grid",
);
oldWrite({ ok: true, value: { id: "first-saved" } });
assert.equal(
  effects.filter((effect) => effect.type === "calendar.list").length,
  1,
  "an older write's answer is not this form's, and reloads nothing",
);
completions.length = 0;
effects.length = 0;
calendar.write({
  source: { kind: "caldav", url: "https://calendar.example.test/a" },
  href: "https://evil.example.test/x",
});
assert.equal(
  effects.length,
  0,
  "cross-origin CalDAV writes are refused before effects",
);

const unavailable = createCalendarController({});
unavailable.beginCreate();
unavailable.updateDraft({ title: "No source", startMs: 10, endMs: 20 });
unavailable.save();
assert.equal(unavailable.snapshot().status, "Add a calendar source first.");

// Every enabled calendar is read at once: that is what makes colouring an event
// by its calendar mean anything, and a switched-off one is not read at all.
const sourceEffects = [];
const sourceCompletions = [];
const multiple = createCalendarController({
  sources: [
    { id: "personal", kind: "google", name: "Personal", colorKey: "cyan" },
    { id: "work", kind: "google", name: "Work", colorKey: "magenta" },
    { id: "muted", kind: "google", name: "Muted", enabled: false },
  ],
  accountSummaries: [
    { id: "a@example.test", email: "a@example.test", provider: "gmail" },
  ],
  palette: 'color5 = "#aa00aa"\ncolor6 = "#00aaaa"\n',
  now: () => Date.UTC(2026, 7, 30, 12),
  execute(effect, done) {
    sourceEffects.push(effect);
    sourceCompletions.push(done);
  },
});
assert.equal(
  multiple.snapshot().source,
  null,
  "which calendar a write goes on is never guessed",
);
multiple.beginCreate();
assert.equal(
  multiple.snapshot().selectedSourceId,
  "google:a@example.test",
  "the composer opens on the first calendar a write can land on",
);
assert.equal(multiple.snapshot().editing.id, "");
multiple.cancelEdit();
// A signed-in Gmail account is a calendar. Nothing is written down for it: the
// account already says it exists, and until this was derived here a user who
// had signed in had no calendars at all.
assert.deepEqual(
  multiple.snapshot().sources.map((source) => source.id),
  ["personal", "work", "muted", "google:a@example.test"],
);
multiple.showMonth(Date.UTC(2026, 7, 1));
assert.deepEqual(
  sourceEffects.map((effect) => effect.source.id),
  ["personal", "work", "google:a@example.test"],
  "a disabled calendar is not read",
);
multiple.selectSource("work");
assert.equal(multiple.snapshot().source.id, "work");
assert.equal(multiple.snapshot().canCreate, true);
assert.equal(
  sourceEffects.length,
  3,
  "choosing where a write goes reloads nothing",
);
assert.equal(multiple.snapshot().palette.magenta, "#aa00aa");
assert.equal(multiple.snapshot().colorKeyFor("personal"), "cyan");
assert.equal(
  multiple.snapshot().colorKeyFor("gone"),
  multiple.snapshot().colorKeyFor("gone"),
  "a calendar nobody configured still answers the same slot every time",
);
assert.equal(multiple.snapshot().todayIso, "2026-08-30");

const kept = googleEvent("kept", "Kept", Date.UTC(2026, 7, 12, 9));
sourceCompletions.shift()({ ok: true, value: googleReply([kept]) });
assert.equal(
  multiple.snapshot().loading,
  true,
  "one calendar of three has answered",
);
sourceCompletions.shift()({ ok: false, error: "Nothing there" });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
assert.equal(multiple.snapshot().loading, false);
assert.equal(multiple.snapshot().lastError, "Work: Nothing there");
assert.equal(multiple.snapshot().lastErrorKind, "");
assert.deepEqual(
  multiple.snapshot().events.map((event) => event.sourceId),
  ["personal"],
  "one calendar failing takes nothing off the grid but its own",
);

// The same range again: what the last read left is on screen before the
// network is asked, and the calendar that fails this time keeps its events.
multiple.showMonth(Date.UTC(2026, 7, 1));
assert.deepEqual(
  multiple.snapshot().events.map((event) => event.googleId),
  ["kept"],
  "a range already read is drawn from the cache while it reloads",
);
sourceCompletions.shift()({ ok: false, error: "Nothing there either" });
sourceCompletions.shift()({
  ok: false,
  error: "The Google Calendar API is not enabled for this Google Cloud project",
});
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
assert.equal(
  multiple.snapshot().lastErrorKind,
  "googleApiDisabled",
  "the one failure a user can fix from the banner is named",
);
assert.deepEqual(
  multiple.snapshot().events.map((event) => event.googleId),
  ["kept"],
  "a failed refresh keeps the answer the calendar last gave",
);
// An unreadable answer is a failure of that calendar, not events it did not
// send: a reply that is not Google's event resource parses to nothing.
multiple.refresh();
sourceCompletions.shift()({ ok: true, value: [{ id: "not-a-reply" }] });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
assert.equal(
  multiple.snapshot().lastError,
  "Personal: Google Calendar returned an unreadable response",
);

multiple.showMonth(new Date(2026, 0, 31, 12).getTime());
assert.equal(new Date(multiple.snapshot().anchorMs).getMonth(), 0);
sourceCompletions.shift()({
  ok: true,
  value: googleReply([googleEvent("kept", "Fresh", Date.UTC(2026, 0, 12, 9))]),
});
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
multiple.select(multiple.snapshot().events[0]);
assert.equal(multiple.snapshot().selected.summary, "Fresh");
multiple.next();
assert.equal(new Date(multiple.snapshot().anchorMs).getMonth(), 1);
assert.equal(new Date(multiple.snapshot().anchorMs).getDate(), 28);
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
sourceCompletions.shift()({ ok: true, value: googleReply([]) });
assert.equal(
  multiple.snapshot().selected,
  null,
  "range loads reconcile selection",
);

// The picker offers the calendars a write can really land on, grouped by the
// account that serves them.
const groups = multiple.snapshot().sourceGroups;
assert.equal(groups.length > 0, true);
assert.deepEqual(
  groups.flatMap((group) => group.calendars.map((entry) => entry.id)).sort(),
  ["google:a@example.test", "muted", "personal", "work"],
);

const readOnly = createCalendarController({
  sources: [
    {
      id: "shared",
      kind: "caldav",
      name: "Shared",
      url: "https://calendar.example.test/shared/",
      readOnly: true,
    },
  ],
  execute() {},
});
readOnly.activate({
  uid: "one",
  sourceId: "shared",
  href: "https://calendar.example.test/shared/one.ics",
});
assert.equal(
  readOnly.snapshot().detail.canWrite,
  false,
  "a read-only calendar draws neither button",
);
assert.deepEqual(
  readOnly.snapshot().sourceGroups,
  [],
  "a read-only calendar is not offered as somewhere to put an event",
);
assert.equal(readOnly.snapshot().canCreate, false);
readOnly.beginCreate();
assert.equal(readOnly.snapshot().editing, null);
assert.equal(
  readOnly.snapshot().writeStatus,
  "No calendar here accepts new events.",
);

const writable = createCalendarController({
  sources: [
    {
      id: "mine",
      kind: "caldav",
      name: "Mine",
      url: "https://calendar.example.test/mine/",
    },
  ],
  execute() {},
});
writable.activate({
  uid: "one",
  sourceId: "mine",
  href: "https://calendar.example.test/mine/one.ics",
});
assert.equal(writable.snapshot().detail.canWrite, true);
writable.activate({
  uid: "two",
  sourceId: "mine",
  href: "https://calendar.example.test/mine/two.ics",
  recurrenceRule: "FREQ=WEEKLY",
});
assert.equal(
  writable.snapshot().detail.canWrite,
  false,
  "a recurring CalDAV event is one ICS this form re-serialises no model of",
);
writable.activate({
  uid: "three",
  sourceId: "mine",
  href: "https://evil.example.test/three.ics",
});
assert.equal(
  writable.snapshot().detail.canWrite,
  false,
  "an href outside the calendar's own origin is refused",
);

const writeCompletions = [];
const navigatingWrite = createCalendarController({
  source: { id: "work", kind: "google" },
  execute(_effect, done) {
    writeCompletions.push(done);
  },
});
navigatingWrite.beginCreate();
navigatingWrite.updateDraft({ title: "Planning", startMs: 10, endMs: 20 });
navigatingWrite.save();
navigatingWrite.next();
assert.equal(navigatingWrite.snapshot().pending, true);
writeCompletions[0]({ ok: true, value: { id: "saved" } });
assert.equal(navigatingWrite.snapshot().pending, false);
assert.equal(navigatingWrite.snapshot().writeStatus, "Saved");
navigatingWrite.select(null);
navigatingWrite.beginEdit(null);
assert.equal(
  navigatingWrite.snapshot().editing,
  null,
  "open without selection is inert",
);

// A CalDAV calendar answers with a multistatus document, and a recurring event
// in it is one master the range expands. None of that ran while the reply was
// read as a list of events.
const caldavReply = (body) => ({ status: 207, body });
const caldavXml = [
  '<?xml version="1.0"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
  "<d:response><d:href>/cal/standup.ics</d:href><d:propstat><d:prop>",
  "<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:standup\r\n",
  "SUMMARY:Standup\r\nDTSTART:20260901T080000Z\r\nDTEND:20260901T083000Z\r\n",
  "RRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>",
  "</d:prop></d:propstat></d:response>",
  "<d:response><d:href>/cal/lunch.ics</d:href><d:propstat><d:prop>",
  "<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:lunch\r\n",
  "SUMMARY:Lunch\r\nDTSTART;VALUE=DATE:20260903\r\nDTEND;VALUE=DATE:20260905\r\n",
  "END:VEVENT\r\nEND:VCALENDAR</c:calendar-data>",
  "</d:prop></d:propstat></d:response>",
  "<d:response><d:href>/cal/review.ics</d:href><d:propstat><d:prop>",
  "<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:review\r\n",
  "SUMMARY:Review\r\nDESCRIPTION:What we said last week\r\n",
  "DTSTART:20260907T080000Z\r\nDTEND:20260907T090000Z\r\n",
  "END:VEVENT\r\nEND:VCALENDAR</c:calendar-data>",
  "</d:prop></d:propstat></d:response></d:multistatus>",
].join("");

const caldavEffects = [];
const caldavCompletions = [];
const caldavStorage = new Map();
const caldav = createCalendarController({
  sources: [
    {
      id: "work",
      kind: "caldav",
      name: "Work",
      url: "https://calendar.example.test/users/me/",
      username: "me",
    },
  ],
  now: () => Date.UTC(2026, 8, 2, 12),
  storage: {
    getItem: (key) => caldavStorage.get(key) ?? null,
    setItem: (key, value) => caldavStorage.set(key, value),
  },
  execute(effect, done) {
    caldavEffects.push(effect);
    caldavCompletions.push(done);
  },
});
caldav.showMonth(Date.UTC(2026, 8, 1));
caldavCompletions.shift()({ ok: true, value: caldavReply(caldavXml) });
assert.deepEqual(
  caldav.snapshot().events.map((event) => event.summary),
  ["Standup", "Lunch", "Review", "Standup", "Standup"],
  "a series is expanded across the range and an all-day event is read",
);
assert.equal(
  caldav.snapshot().events[1].start.allDay,
  true,
  "an all-day event keeps the shape the composer edits it in",
);
assert.equal(
  caldav.snapshot().events[0].calendarData.includes("RRULE"),
  true,
  "the original resource is kept, so a write does not drop what it holds",
);
caldavCompletions.length = 0;
caldav.refresh();
assert.equal(
  caldav.snapshot().events.length,
  5,
  "a reload draws the cached range before the server answers",
);
caldavCompletions.shift()({ ok: false, error: "Server said no" });
assert.equal(caldav.snapshot().lastError, "Work: Server said no");
assert.equal(
  caldav.snapshot().events.length,
  5,
  "a failed read keeps the events the calendar last gave",
);
assert.equal(
  typeof caldavStorage.get("omamail.calendarCache"),
  "string",
  "the range is kept for the next run",
);

// A CalDAV create names the resource it is creating: the collection plus the
// UID the draft was just built with. Asking for the address before the ICS
// existed meant asking for one from an event with no UID, which is how a
// create came to return early having sent nothing at all.
caldavEffects.length = 0;
caldav.beginCreate(Date.UTC(2026, 8, 4, 9));
caldav.updateDraft({ title: "Planning" });
caldav.save();
assert.equal(caldavEffects.length, 1);
assert.equal(caldavEffects[0].type, "calendar.caldav.write");
assert.equal(
  caldavEffects[0].url,
  `https://calendar.example.test/users/me/omamail-${Date.UTC(2026, 8, 2, 12)}.ics`,
);
assert.equal(caldavEffects[0].payload.includes("SUMMARY:Planning"), true);
assert.equal(
  caldavEffects[0].payload.includes(`DTSTART:20260904T090000Z`),
  true,
  "the slot pressed is the day written, not the month the grid is anchored on",
);
caldavCompletions.pop()({ ok: true, value: null });

// The composer's own spelling of its boxes. The notes box is the event's
// DESCRIPTION and the two repeat boxes belong inside the rule: a box nothing
// reads is worse than a missing one, because the form says it saved.
caldavEffects.length = 0;
caldav.beginCreate(Date.UTC(2026, 8, 4, 9));
caldav.updateDraft({ title: "Retro", notes: "Bring the board", location: "Room 2" });
caldav.updateRecurrence({ toggle: true });
assert.equal(
  caldav.snapshot().composer.recurring,
  true,
  "the toggle turns the rule on rather than adding a key beside it",
);
caldav.updateRecurrence({ frequency: "DAILY" });
caldav.updateDraft({ interval: "3", count: "4" });
caldav.save();
const created = caldavEffects.at(-1).payload;
assert.equal(created.includes("DESCRIPTION:Bring the board"), true, created);
assert.equal(created.includes("LOCATION:Room 2"), true);
assert.equal(
  created.includes("RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4"),
  true,
  "the repeat boxes reach the rule",
);
caldavCompletions.pop()({ ok: true, value: null });
caldav.updateRecurrence({ toggle: true });

// An all-day event is edited as the days it spans, and the days are what the
// write carries: the form used to move them and re-write the original times.
caldavEffects.length = 0;
const allDayEvent = caldav
  .snapshot()
  .events.find((event) => event.summary === "Lunch");
caldav.beginEdit(allDayEvent);
assert.equal(caldav.snapshot().editing.fields.date, "2026-09-03");
assert.equal(
  caldav.snapshot().editing.fields.endDate,
  "2026-09-04",
  "the last day shown is a millisecond before the exclusive end",
);
caldav.updateDraft({ date: "2026-09-10", endDate: "2026-09-11" });
caldav.save();
const moved = caldavEffects.at(-1).payload;
assert.equal(moved.includes("DTSTART;VALUE=DATE:20260910"), true, moved);
assert.equal(
  moved.includes("DTEND;VALUE=DATE:20260912"),
  true,
  "the written end is the midnight after the last day",
);
assert.equal(
  moved.includes("DESCRIPTION"),
  false,
  "an event with no notes writes no DESCRIPTION line",
);
caldavCompletions.pop()({ ok: true, value: null });

// An edit that never touches the notes box keeps the server's own
// DESCRIPTION: the rewrite strips the line before re-inserting it, so a form
// that read the notes under a name nothing wrote took the description off
// every event it saved.
caldavEffects.length = 0;
const described = caldav
  .snapshot()
  .events.find((event) => event.summary === "Review");
caldav.beginEdit(described);
assert.equal(
  caldav.snapshot().editing.fields.description,
  "What we said last week",
);
caldav.updateDraft({ title: "Standup " });
caldav.save();
assert.equal(
  caldavEffects.at(-1).payload.includes("DESCRIPTION:What we said last week"),
  true,
  caldavEffects.at(-1).payload,
);
caldavCompletions.pop()({ ok: true, value: null });

// A recurring CalDAV event is one file holding a rule, its exceptions and its
// exclusions, and the occurrence on the grid is reached through that same file.
// Nothing here re-serialises it, so the write is refused rather than made.
caldavEffects.length = 0;
caldav.beginEdit(
  caldav.snapshot().events.find((event) => event.summary === "Standup"),
);
caldav.save();
assert.equal(caldavEffects.length, 0);
assert.equal(
  caldav.snapshot().writeStatus,
  "Recurring CalDAV events can only be changed in a full calendar client",
);
caldav.cancelEdit();

// A timed event's day box moves both ends of it and keeps its length.
caldavEffects.length = 0;
caldav.beginCreate(Date.UTC(2026, 8, 4, 9));
caldav.updateDraft({ title: "Timed", date: "2026-09-20" });
const timed = caldav.snapshot().editing.fields;
assert.equal(new Date(timed.startMs).getDate(), 20);
assert.equal(
  timed.endMs - timed.startMs,
  60 * 60 * 1000,
  "moving the day does not change how long the event is",
);
caldav.cancelEdit();

// A cross-origin href is refused with a reason rather than in silence: a save
// that answers nothing leaves the form open with no idea why.
const refusing = createCalendarController({
  sources: [
    {
      id: "work",
      kind: "caldav",
      name: "Work",
      url: "https://calendar.example.test/users/me/",
    },
  ],
  execute() {
    throw new Error("nothing may be sent");
  },
});
refusing.write({
  id: "one",
  uid: "one",
  source: {
    kind: "caldav",
    id: "work",
    url: "https://calendar.example.test/users/me/",
  },
  href: "https://evil.example.test/one.ics",
  fields: {
    title: "Event",
    startMs: Date.UTC(2026, 8, 1, 9),
    endMs: Date.UTC(2026, 8, 1, 10),
  },
  start: { allDay: false },
});
assert.equal(
  refusing.snapshot().writeStatus,
  "The event's address is outside this calendar's server",
);

console.log("calendar controller tests passed");
