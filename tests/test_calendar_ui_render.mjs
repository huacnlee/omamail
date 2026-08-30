import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCalendar } from "../app/ui/calendar.js";
const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, k) => String(k) }),
    spacing: { xs: 1, sm: 1, md: 1, lg: 1 },
    radius: { sm: 1 },
  }),
};
const find = (node, id) => {
  if (!node) return null;
  if (node.elementId === id) return node;
  for (const child of node.childNodes || []) {
    const match = find(child, id);
    if (match) return match;
  }
  return null;
};
const handlers = {
  onEvent() {},
  onNew() {},
  onEdit() {},
  onSave() {},
  onCancel() {},
  onPrevious() {},
  onNext() {},
  onToday() {},
  onMonth() {},
  onWeek() {},
  onSource() {},
};
const calendar = renderCalendar(
  {
    ...handlers,
    title: "Week",
    status: "2 events",
    readStatus: "2 events",
    writeStatus: "Saving…",
    view: "week",
    anchorMs: new Date(2026, 7, 29).getTime(),
    sourceLabel: "Work",
    hasSource: true,
    sources: [
      { id: "personal", name: "Personal", kind: "google" },
      { id: "work", name: "Work", kind: "caldav" },
    ],
    selectedSourceId: "work",
    pending: false,
    editing: { id: "", title: {}, start: {}, end: {} },
    selectedId: "two",
    selected: { id: "two", title: "Two", startMs: 1, endMs: 2 },
    grid: Array.from({ length: 7 }, (_, index) => ({
      label: index + 24,
      events: index === 2 ? [{ id: "two", title: "Two" }] : [],
    })),
    events: [{ id: "two", title: "Two" }],
  },
  cx,
);
assert.equal(calendar.elementId, "application-frame");
for (const id of [
  "application-top-bar",
  "application-bottom-bar",
  "calendar",
  "calendar-grid",
  "calendar-weekdays",
  "calendar-row-0",
  "calendar-day-2",
  "calendar-event-two",
  "calendar-source-personal",
  "calendar-source-work",
  "calendar-editor",
  "calendar-save",
  "calendar-previous",
  "calendar-today",
  "calendar-next",
])
  assert.ok(find(calendar, id), id);
const source = readFileSync(
  new URL("../app/ui/calendar.js", import.meta.url),
  "utf8",
);
assert.match(source, /`Previous \$\{period\}`/);
assert.match(source, /`Next \$\{period\}`/);
let selectedSource = "";
let edited = false;
const interactive = renderCalendar(
  {
    ...handlers,
    onSource(id) {
      selectedSource = id;
    },
    onEdit() {
      edited = true;
    },
    view: "month",
    anchorMs: Date.now(),
    hasSource: true,
    sources: [{ id: "work", name: "Work" }],
    selectedSourceId: "",
    selected: { id: "event" },
    selectedId: "event",
    grid: [],
  },
  cx,
);
find(interactive, "calendar-source-work").clickHandler({}, cx);
find(interactive, "calendar-edit").clickHandler({}, cx);
assert.equal(selectedSource, "work");
assert.equal(edited, true);
const contentStart = source.indexOf("const content = v_flex()");
const contentEnd = source.indexOf("if (!model.hasSource)", contentStart);
assert.doesNotMatch(source.slice(contentStart, contentEnd), /\.size_full\(\)/);
const failed = renderCalendar(
  {
    ...handlers,
    view: "month",
    hasSource: true,
    sources: [{ id: "work", name: "Work" }],
    selectedSourceId: "work",
    pending: false,
    writeStatus: "Couldn’t save the event.",
    editing: null,
    grid: [],
  },
  cx,
);
assert.equal(find(failed, "calendar-status").accessibilityRole, "alert");
const noSource = renderCalendar(
  {
    ...handlers,
    title: "Calendar",
    view: "month",
    hasSource: false,
    sources: [],
    selectedSourceId: "",
    pending: false,
    editing: null,
    events: [],
  },
  cx,
);
assert.equal(find(noSource, "calendar-new").isDisabled, true);
assert.equal(find(noSource, "calendar-grid").childNodes.length, 7);
console.log("calendar UI render tests passed");
