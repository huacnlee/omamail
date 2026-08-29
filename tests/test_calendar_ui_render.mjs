import assert from "node:assert/strict";
import { renderCalendar } from "../app/ui/calendar.js";
const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, k) => String(k) }),
    spacing: { md: 1, lg: 1 },
    radius: { sm: 1 },
  }),
};
const calendar = renderCalendar(
  {
    title: "Week",
    status: "2 events",
    readStatus: "2 events",
    writeStatus: "Saving…",
    view: "week",
    sourceLabel: "Work",
    hasSource: true,
    sources: [{ id: "work", name: "Work" }],
    selectedSourceId: "work",
    pending: false,
    editing: {
      id: "",
      title: {},
      start: {},
      end: {},
    },
    selectedId: "two",
    selected: { id: "two", title: "Two", startMs: 1, endMs: 2 },
    events: [
      { id: "one", title: "One" },
      { id: "two", title: "Two" },
    ],
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
  },
  cx,
);
assert.equal(calendar.elementId, "calendar");
assert.equal(
  ["calendar-previous", "calendar-today", "calendar-next"].every((id) =>
    calendar.childNodes.some((child) =>
      child?.childNodes?.some((nested) => nested?.elementId === id),
    ),
  ),
  true,
);
assert.equal(
  calendar.childNodes.some(
    (child) =>
      child?.elementId === "calendar-write-status" &&
      child.accessibilityRole === "label",
  ),
  true,
);
assert.equal(
  calendar.childNodes.some((child) => child?.elementId === "calendar-editor"),
  true,
);
assert.equal(
  calendar.childNodes.some((child) => child?.elementId === "calendar-save"),
  true,
);
assert.equal(
  calendar.childNodes.some(
    (child) =>
      child?.elementId === "calendar-event-two" &&
      child?.childNodes?.includes("Two"),
  ),
  true,
);
assert.equal(
  calendar.childNodes.some((child) => child?.childNodes?.includes("2 events")),
  true,
);
const noSource = renderCalendar(
  {
    title: "Calendar",
    view: "month",
    hasSource: false,
    sources: [],
    selectedSourceId: "",
    pending: false,
    editing: null,
    events: [],
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
  },
  cx,
);
assert.equal(
  noSource.childNodes.some(
    (child) => child?.elementId === "calendar-new" && child.isDisabled === true,
  ),
  true,
);
console.log("calendar UI render tests passed");
