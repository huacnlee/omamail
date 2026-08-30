import assert from "node:assert/strict";
import { createCalendarController } from "../app/calendar/controller.js";

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
assert.equal(
  calendar.snapshot().range.endMs - calendar.snapshot().range.startMs,
  7 * 24 * 60 * 60 * 1000,
);
const staleRead = completions.shift();
calendar.showMonth(Date.UTC(2026, 8, 1));
assert.equal(
  calendar.snapshot().range.endMs > calendar.snapshot().range.startMs,
  true,
);
const currentRead = completions.shift();
staleRead({ ok: true, value: [{ id: "stale" }] });
assert.deepEqual(calendar.snapshot().events, []);
currentRead({ ok: true, value: [{ id: "current", title: "Current" }] });
assert.deepEqual(
  calendar.snapshot().events.map((event) => event.id),
  ["current"],
);
const septemberAnchor = calendar.snapshot().anchorMs;
calendar.previous();
assert.equal(calendar.snapshot().anchorMs < septemberAnchor, true);
completions.shift()({ ok: true, value: [] });
calendar.next();
assert.equal(calendar.snapshot().anchorMs, septemberAnchor);
completions.shift()({ ok: true, value: [{ id: "current", title: "Current" }] });
calendar.select({ id: "current", title: "Current" });
assert.equal(calendar.snapshot().selected.id, "current");
calendar.beginEdit(calendar.snapshot().selected);
assert.equal(calendar.snapshot().editing.id, "current");
calendar.updateDraft({ title: "Changed" });
assert.equal(calendar.snapshot().editing.fields.title, "Changed");
calendar.cancelEdit();
assert.equal(calendar.snapshot().editing, null);

calendar.select({ id: "delete-me", googleId: "delete-me", title: "Delete me" });
calendar.deleteSelected();
assert.equal(calendar.snapshot().pending, true);
assert.equal(effects.at(-1).type, "calendar.google.delete");
assert.equal(effects.at(-1).eventId, "delete-me");
completions.shift()({ ok: true, value: null });
assert.equal(calendar.snapshot().selected, null);
assert.equal(calendar.snapshot().writeStatus, "Deleted");

calendar.beginCreate();
calendar.updateDraft({ title: "", startMs: 10, endMs: 20 });
calendar.save();
assert.equal(calendar.snapshot().status, "Add an event title");
calendar.updateDraft({ title: "Planning", startMs: 10, endMs: 20 });
calendar.save();
assert.equal(calendar.snapshot().pending, true);
assert.equal(effects.at(-1).source.id, "google:calendar");
completions.shift()({ ok: false, error: "Calendar write failed" });
assert.equal(calendar.snapshot().pending, false);
assert.equal(calendar.snapshot().status, "Calendar write failed");

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
const oldWrite = completions.shift();
const newWrite = completions.shift();
newWrite({ ok: true, value: { id: "second-saved" } });
oldWrite({ ok: true, value: { id: "first-saved" } });
assert.equal(calendar.snapshot().selected.id, "second-saved");
const capturedSource = effects.at(-1).source;
source.id = "mutated";
assert.equal(capturedSource.id, "google:calendar");
assert.equal(Object.isFrozen(capturedSource), true);
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
console.log("calendar controller tests passed");

const unavailable = createCalendarController({});
unavailable.beginCreate();
unavailable.updateDraft({ title: "No source", startMs: 10, endMs: 20 });
unavailable.save();
assert.equal(unavailable.snapshot().status, "Add a calendar source first.");

const sourceEffects = [];
const sourceCompletions = [];
const multiple = createCalendarController({
  sources: [
    { id: "personal", kind: "google", name: "Personal" },
    { id: "work", kind: "google", name: "Work" },
  ],
  execute(effect, done) {
    sourceEffects.push(effect);
    sourceCompletions.push(done);
  },
});
assert.equal(
  multiple.snapshot().source,
  null,
  "multiple sources are never guessed",
);
multiple.beginCreate();
assert.equal(multiple.snapshot().editing, null);
assert.equal(multiple.snapshot().writeStatus, "Choose a calendar source.");
multiple.selectSource("work");
assert.equal(multiple.snapshot().source.id, "work");
assert.equal(sourceEffects.at(-1).source.id, "work");
sourceCompletions.shift()({ ok: true, value: [{ id: "kept", title: "Kept" }] });
multiple.select({ id: "kept", title: "Old" });
multiple.showMonth(new Date(2026, 0, 31, 12).getTime());
assert.equal(new Date(multiple.snapshot().anchorMs).getMonth(), 0);
sourceCompletions.shift()({
  ok: true,
  value: [{ id: "kept", title: "Fresh" }],
});
assert.equal(multiple.snapshot().selected.title, "Fresh");
multiple.next();
assert.equal(new Date(multiple.snapshot().anchorMs).getMonth(), 1);
assert.equal(new Date(multiple.snapshot().anchorMs).getDate(), 28);
sourceCompletions.shift()({ ok: true, value: [] });
assert.equal(
  multiple.snapshot().selected,
  null,
  "range loads reconcile selection",
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
