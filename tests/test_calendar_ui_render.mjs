import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCalendar } from "../app/ui/calendar.js";
import { createCalendarController } from "../app/calendar/controller.js";

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
const text = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number")
    out.push(String(node));
  if (!node || typeof node !== "object") return out;
  for (const child of node.childNodes || []) text(child, out);
  return out;
};
const handlers = {
  onEvent() {},
  onCreateAt() {},
  onNew() {},
  onEdit() {},
  onCloseEvent() {},
  onSave() {},
  onCancel() {},
  onPrevious() {},
  onNext() {},
  onToday() {},
  onMonth() {},
  onWeek() {},
  onRefresh() {},
  onSource() {},
};

// ---------------------------------------------------------------- the month
// The two calendars answer in the shapes their own protocols use: Google's
// event resource and a CalDAV multistatus document. Handing the controller a
// list of events instead would skip every rule that reads one out of an answer.
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => iso(ms).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const day = (ms) => stamp(ms).slice(0, 8);
const googleReply = (items) => ({ items });
const googleItem = (uid, summary, startMs, endMs) => ({
  id: uid,
  iCalUID: uid,
  summary,
  status: "confirmed",
  start: { dateTime: iso(startMs) },
  end: { dateTime: iso(endMs) },
});
const caldavEvent = (uid, summary, start, end) =>
  [
    `<d:response><d:href>/cal/${uid}.ics</d:href><d:propstat><d:prop>`,
    "<c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n",
    `UID:${uid}\r\nSUMMARY:${summary}\r\n${start}\r\n${end}\r\n`,
    "END:VEVENT\r\nEND:VCALENDAR</c:calendar-data>",
    "</d:prop></d:propstat></d:response>",
  ].join("");
const caldavReply = (events) => ({
  status: 207,
  body: [
    '<?xml version="1.0"?>',
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
    events.join(""),
    "</d:multistatus>",
  ].join(""),
});

const august = new Date(2026, 7, 30, 12, 4);
const at = (/** @type {Array<number>} */ ...parts) =>
  new Date(2026, 7, ...parts).getTime();
const calendar = createCalendarController({
  sources: [
    { id: "work", kind: "google", name: "Work", colorKey: "blue" },
    {
      id: "home",
      kind: "caldav",
      name: "Home",
      colorKey: "green",
      url: "https://calendar.example.test/home/",
    },
  ],
  now: () => august.getTime(),
  execute(effect, done) {
    done({
      ok: true,
      value:
        effect.source.id === "work"
          ? googleReply([
              googleItem("standup", "Standup", at(30, 9), at(30, 9, 15)),
              googleItem(
                "cutover",
                "Cutover go/no-go",
                at(30, 16),
                at(30, 17),
              ),
            ])
          : caldavReply([
              caldavEvent(
                "review",
                "Design review",
                `DTSTART:${stamp(at(30, 11))}`,
                `DTEND:${stamp(at(30, 12))}`,
              ),
              caldavEvent(
                "lunch",
                "Lunch with Priya",
                `DTSTART:${stamp(at(30, 13))}`,
                `DTEND:${stamp(at(30, 14))}`,
              ),
              caldavEvent(
                "leave",
                "Deniz on leave",
                `DTSTART;VALUE=DATE:${day(Date.UTC(2026, 7, 27))}`,
                `DTEND;VALUE=DATE:${day(Date.UTC(2026, 7, 28))}`,
              ),
            ]),
    });
  },
});
calendar.selectSource("work");
calendar.showMonth(august.getTime());

const month = renderCalendar({ ...handlers, ...calendar.snapshot() }, cx);
assert.equal(month.elementId, "application-frame");
for (const id of [
  "application-top-bar",
  "application-bottom-bar",
  "calendar",
  "calendar-header",
  "calendar-grid",
  "calendar-weekdays",
  "calendar-row-0",
  "calendar-row-5",
  "calendar-today",
  "calendar-week",
  "calendar-month",
  "calendar-previous",
  "calendar-next",
  "calendar-refresh",
  "calendar-new",
  "calendar-status",
  "calendar-status-hints",
])
  assert.ok(find(month, id), id);
assert.equal(find(month, "calendar-grid").childNodes.length, 7, "a rule and six rows");
const monthText = text(month);
assert.ok(monthText.includes("August 2026"), "the month names itself");
assert.ok(monthText.includes("Go to today"));
assert.ok(monthText.includes("Mon") && monthText.includes("Sun"));
assert.ok(
  monthText.includes("09:00 Standup"),
  "a timed chip leads with the time it starts",
);
assert.ok(
  monthText.includes("+1 more"),
  "a fourth event on a day is counted, not drawn",
);
assert.ok(
  monthText.includes("Deniz on leave"),
  "an all-day event is a chip with no time in front of it",
);
assert.equal(
  find(month, "calendar-error"),
  null,
  "no banner where nothing failed",
);

// Pressing a day asks for an event on it; pressing a chip opens that event.
let created = 0;
let opened = "";
let stopped = false;
const cell = find(month, "calendar-day-34");
cell.clickHandler(
  {},
  { ...cx, notify() {}, stop_propagation() {} },
);
const monthPresses = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    onCreateAt(startMs) {
      created = startMs;
    },
    onEvent(event) {
      opened = String(event.uid);
    },
  },
  cx,
);
find(monthPresses, "calendar-day-34").clickHandler({}, cx);
assert.equal(
  new Date(created).getHours(),
  9,
  "a day with no hours on it is planned from nine",
);
find(monthPresses, "calendar-event-34-0").clickHandler({}, {
  ...cx,
  stop_propagation() {
    stopped = true;
  },
});
assert.equal(opened, "standup");
assert.equal(stopped, true, "a chip press does not also propose a new event");

// ----------------------------------------------------------------- the week
calendar.showWeek(august.getTime());
const week = renderCalendar({ ...handlers, ...calendar.snapshot() }, cx);
for (const id of [
  "calendar-week-headers",
  "calendar-week-timeline",
  "calendar-week-day-6",
  "calendar-slot-6-0",
  "calendar-allday-lane",
  "calendar-allday-3",
  "calendar-allday-event-3-0",
])
  assert.ok(find(week, id), id);
const weekText = text(week);
assert.ok(weekText.includes("24–30 August 2026"), "the week names its span");
assert.ok(weekText.includes("Sun 30"));
assert.ok(weekText.includes("07:00") && weekText.includes("18:00"));
assert.ok(weekText.includes("all-day"));
assert.ok(
  find(week, "calendar-now-line"),
  "the line for now is drawn on the day it belongs to",
);
assert.ok(
  weekText.includes("12:04"),
  "and read off the rail, because the hour labels stop at the hour",
);
assert.equal(
  find(week, "calendar-grid"),
  null,
  "the month grid is not built while the week is on screen",
);
let slotStarted = 0;
renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    onCreateAt(startMs) {
      slotStarted = startMs;
    },
  },
  cx,
).childNodes.length;
find(
  renderCalendar(
    {
      ...handlers,
      ...calendar.snapshot(),
      onCreateAt(startMs) {
        slotStarted = startMs;
      },
    },
    cx,
  ),
  "calendar-slot-6-2",
).clickHandler({}, cx);
assert.equal(new Date(slotStarted).getHours(), 9, "the hour pressed is the hour");

// A week nobody is standing in draws no marker at all.
calendar.showWeek(new Date(2026, 9, 5).getTime());
const otherWeek = renderCalendar({ ...handlers, ...calendar.snapshot() }, cx);
assert.equal(find(otherWeek, "calendar-now-line"), null);
assert.equal(find(otherWeek, "calendar-now-label"), null);

// ---------------------------------------------------------------- the event
calendar.showMonth(august.getTime());
calendar.activate(
  calendar.snapshot().events.find((event) => event.uid === "review"),
);
let closed = false;
let editRequested = false;
let openedUrl = "";
const detail = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    detail: {
      ...calendar.snapshot().detail,
      canWrite: true,
      event: {
        ...calendar.snapshot().detail.event,
        location: "Sunfish Studio",
        meetLink: "https://meet.example.test/abc",
        description: "Bring the reader column mock.",
      },
    },
    onCloseEvent() {
      closed = true;
    },
    onEdit() {
      editRequested = true;
    },
    onOpenUrl(url) {
      openedUrl = url;
    },
  },
  cx,
);
for (const id of [
  "calendar-detail",
  "calendar-detail-back",
  "calendar-detail-actions",
  "calendar-detail-edit",
  "calendar-detail-delete",
  "calendar-detail-call",
])
  assert.ok(find(detail, id), id);
const detailText = text(detail);
assert.ok(detailText.includes("Design review"));
assert.ok(detailText.includes("Sunfish Studio"));
assert.ok(detailText.includes("Home"), "the calendar the event lives on is named");
assert.ok(detailText.some((value) => value.includes("11:00–12:00")));
assert.ok(detailText.includes("Bring the reader column mock."));
find(detail, "calendar-detail-back").clickHandler({}, cx);
find(detail, "calendar-detail-edit").clickHandler({}, cx);
find(detail, "calendar-detail-call").clickHandler({}, cx);
assert.equal(closed, true);
assert.equal(editRequested, true);
assert.equal(openedUrl, "https://meet.example.test/abc");

// A calendar that refuses writes draws neither button, and an event with no
// address to open draws no link button either.
const readOnlyDetail = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    detail: { ...calendar.snapshot().detail, canWrite: false },
  },
  cx,
);
assert.equal(find(readOnlyDetail, "calendar-detail-edit"), null);
assert.equal(find(readOnlyDetail, "calendar-detail-delete"), null);
assert.equal(find(readOnlyDetail, "calendar-detail-actions"), null);

// ------------------------------------------------------------- the composer
const state = (value) => ({ value: () => value });
calendar.beginCreate(new Date(2026, 8, 4, 9).getTime());
calendar.updateRecurrence({ enabled: true, frequency: "MONTHLY", interval: "2" });
const composerModel = {
  ...handlers,
  ...calendar.snapshot(),
  composer: {
    ...calendar.snapshot().composer,
    fields: {
      title: state("Planning"),
      date: state("2026-09-04"),
      start: state("09:00"),
      end: state("10:00"),
      location: state(""),
      notes: state(""),
      interval: state("2"),
      count: state(""),
    },
  },
};
const composer = renderCalendar(composerModel, cx);
for (const id of [
  "calendar-composer",
  "calendar-composer-back",
  "calendar-composer-when",
  "calendar-composer-recurring",
  "calendar-composer-recurrence",
  "calendar-composer-frequency-MONTHLY",
  "calendar-composer-source-work",
  "calendar-composer-source-home",
  "calendar-save",
  "calendar-cancel",
])
  assert.ok(find(composer, id), id);
const composerText = text(composer);
assert.ok(composerText.includes("Create event"));
assert.ok(composerText.includes("Make recurring"));
assert.ok(
  composerText.includes("months"),
  "the interval names its own unit, in the plural it earned",
);
assert.equal(
  find(composer, "calendar-detail"),
  null,
  "editing replaces the detail rather than stacking on it",
);
let saved = false;
find(composer, "calendar-save").clickHandler({}, cx);
find(
  renderCalendar(
    { ...composerModel, onSave: () => (saved = true) },
    cx,
  ),
  "calendar-save",
).clickHandler({}, cx);
assert.equal(saved, true);

// An edit leaves the calendar picker and the recurrence rule alone.
calendar.cancelEdit();
calendar.beginEdit(
  calendar.snapshot().events.find((event) => event.uid === "review"),
);
const editor = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    composer: {
      ...calendar.snapshot().composer,
      fields: { title: state("Design review") },
    },
  },
  cx,
);
assert.ok(text(editor).includes("Edit event"));
assert.equal(find(editor, "calendar-composer-source-work"), null);
assert.equal(find(editor, "calendar-composer-recurring"), null);
calendar.cancelEdit();

// ------------------------------------------------------- delete, and refusal
calendar.select(calendar.snapshot().events.find((e) => e.uid === "review"));
calendar.requestDelete();
let confirmed = false;
let cancelled = false;
const confirmation = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    onConfirmDelete() {
      confirmed = true;
    },
    onCancelDelete() {
      cancelled = true;
    },
  },
  cx,
);
assert.ok(find(confirmation, "calendar-confirm"));
assert.ok(
  text(confirmation).includes('Delete "Design review"?'),
  "the confirmation names what it is about to remove",
);
find(confirmation, "calendar-confirm-delete").clickHandler({}, cx);
find(confirmation, "calendar-confirm-cancel").clickHandler({}, cx);
assert.equal(confirmed, true);
assert.equal(cancelled, true);
calendar.cancelDelete();

// ------------------------------------------------------------- the failures
let copied = "";
let apiUrl = "";
const failed = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    lastError:
      "Work: The Google Calendar API is not enabled for this Google Cloud project",
    lastErrorKind: "googleApiDisabled",
    readStatus:
      "Work: The Google Calendar API is not enabled for this Google Cloud project",
    onCopy(value) {
      copied = value;
    },
    onOpenUrl(url) {
      apiUrl = url;
    },
  },
  cx,
);
assert.ok(find(failed, "calendar-error"));
assert.equal(find(failed, "calendar-status").accessibilityRole, "alert");
find(failed, "calendar-error-copy").clickHandler({}, cx);
find(failed, "calendar-error-enable-api").clickHandler({}, cx);
assert.match(copied, /Calendar API is not enabled/);
assert.equal(
  apiUrl,
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
);

const ordinaryFailure = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    lastError: "Home: Nothing there",
    lastErrorKind: "",
  },
  cx,
);
assert.ok(find(ordinaryFailure, "calendar-error"));
assert.equal(
  find(ordinaryFailure, "calendar-error-copy"),
  null,
  "only the failure a user can fix from here carries the buttons that fix it",
);

const loadingView = renderCalendar(
  { ...handlers, ...calendar.snapshot(), loading: true },
  cx,
);
assert.ok(
  find(loadingView, "calendar-loading"),
  "a read in flight is said where the reading is",
);
assert.equal(find(loadingView, "calendar-status").accessibilityRole, "status");
assert.equal(find(loadingView, "calendar-refresh").isDisabled, true);

const noSource = renderCalendar(
  {
    ...handlers,
    view: "month",
    anchorMs: august.getTime(),
    canCreate: false,
    events: [],
  },
  cx,
);
assert.equal(find(noSource, "calendar-new").isDisabled, true);
assert.ok(find(noSource, "calendar-no-source"));
assert.equal(
  find(month, "calendar-no-source"),
  null,
  "a window with calendars to write to says nothing about calendars",
);
assert.equal(find(month, "calendar-new").isDisabled, false);
assert.equal(
  find(noSource, "calendar-grid").childNodes.length,
  7,
  "a host that hands over no days still gets the month it anchored on",
);

// The rail is drawn beside the calendar when the host gives it one.
const withRail = renderCalendar(
  {
    ...handlers,
    ...calendar.snapshot(),
    navigation: {
      accounts: [
        { id: "a", label: "a@example.test", provider: "gmail", selected: true },
      ],
      mailboxes: [{ id: "inbox", label: "Inbox", count: 0, selected: false }],
      onAccount() {},
      onMailbox() {},
      onCalendar() {},
      calendarSelected: true,
    },
  },
  cx,
);
assert.ok(find(withRail, "navigation-calendar"));

// The three text states the first host built still make a working form: the
// composer normalises whatever shape it is handed rather than assuming one.
const legacy = renderCalendar(
  {
    ...handlers,
    view: "month",
    anchorMs: august.getTime(),
    hasSource: true,
    editing: { id: "", title: state("x"), start: state("y"), end: state("z") },
    selected: { uid: "one", summary: "One", start: { ms: august.getTime() } },
    selectedId: "one",
    events: [],
  },
  cx,
);
assert.ok(find(legacy, "calendar-composer"), "the legacy editor shape opens");
assert.ok(find(legacy, "calendar-save"));
assert.equal(
  find(legacy, "calendar-detail"),
  null,
  "and still covers the detail it replaced",
);

const source = readFileSync(
  new URL("../app/ui/calendar.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /#[0-9A-Fa-f]{3,8}\b/, "no literal colours");
assert.doesNotMatch(source, /\d+rem/, "no rem literals");
for (const file of [
  "calendar-month.js",
  "calendar-week.js",
  "calendar-detail.js",
  "calendar-composer.js",
  "calendar-palette.js",
]) {
  const body = readFileSync(new URL(`../app/ui/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(body, /#[0-9A-Fa-f]{3,8}\b/, `${file} names no colour`);
  assert.doesNotMatch(body, /\d+rem/, `${file} names no rem`);
}

console.log("calendar UI render tests passed");
