import assert from "node:assert/strict";

import { monthDays, weekDays } from "../app/calendar/Calendar.js";
import { renderCalendar } from "../app/ui/calendar.js";
import { dateSummary } from "../app/ui/calendar-detail.js";
import { renderSettings } from "../app/ui/settings.js";
import { applyOmarchyStyle, style } from "omarchy-ui";

// The calendar's grids and the settings page, held to the measurements the QML
// draws them at.
//
// `tests/test_calendar_ui_render.mjs` and `tests/test_settings_ui_render.mjs`
// say the right things are on screen and that pressing them does the right
// thing. This file is the other half: every number here is read off
// `components/CalendarView.qml`, `components/WeekCalendarView.qml`,
// `components/CalendarEventDetail.qml`, `components/CalendarEventComposer.qml`,
// `components/SettingsPage.qml` and `components/CalendarSettings.qml`, because
// a port that draws the right elements at the wrong sizes passes every test
// that only looks for ids.

applyOmarchyStyle("", { cornerRadius: 0, fontFamily: "monospace" });
const tokens = style();

const cx = {
  theme: () => ({
    colors: {
      background: "#000000",
      foreground: "#ffffff",
      surface: "#000000",
      muted: "#111111",
      muted_foreground: "#888888",
      primary: "#00ff00",
      primary_foreground: "#ffffff",
      accent: "#003300",
      accent_foreground: "#ffffff",
      destructive: "#ff0000",
      destructive_foreground: "#ffffff",
      border: "#333333",
      input: "#333333",
      ring: "#00ff00",
    },
    spacing: tokens.spacing,
    radius: { none: 0, sm: 0, md: 0, lg: 0, xl: 0, full: 9999 },
  }),
};

function walk(element, visit, seen = new Set()) {
  if (!element || typeof element !== "object" || seen.has(element)) return;
  seen.add(element);
  visit(element);
  for (const child of element.childNodes ?? []) walk(child, visit, seen);
}

function find(element, id) {
  let found = null;
  walk(element, (node) => {
    if (!found && node.elementId === id) found = node;
  });
  return found;
}

/**
 * The first argument the *last* call of a style method was given.
 *
 * The last one, because that is the one gpui paints with: a builder like
 * `pageColumn` sets a default and the caller overrides it on the way back, so
 * reading the first call would assert about a value nothing ever draws.
 */
function styleArg(node, name) {
  const calls = (node?.styleCalls ?? []).filter((entry) => entry.name === name);
  return calls.at(-1)?.args[0];
}

// ------------------------------------------------------------- the calendar

const now = new Date(2026, 7, 30, 12, 4);
const at = (...parts) => new Date(2026, 7, ...parts).getTime();
const timed = (uid, summary, startMs, endMs) => ({
  uid,
  summary,
  sourceId: "work",
  start: { ms: startMs, allDay: false },
  end: { ms: endMs, allDay: false },
});
const events = [
  timed("standup", "Standup", at(30, 9), at(30, 9, 15)),
  timed("review", "Design review", at(30, 11), at(30, 12)),
  timed("lunch", "Lunch with Priya", at(30, 13), at(30, 14)),
  timed("cutover", "Cutover go/no-go", at(30, 16), at(30, 17)),
  {
    uid: "leave",
    summary: "Deniz on leave",
    sourceId: "work",
    start: { ms: at(30, 0), allDay: true },
    end: { ms: at(31, 0), allDay: true },
  },
];

const handlers = {
  onEvent() {},
  onCreateAt() {},
  onNew() {},
  onEdit() {},
  onDelete() {},
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
  onOpenUrl() {},
};

const calendarModel = (overrides = {}) => ({
  ...handlers,
  anchorMs: now.getTime(),
  nowMs: now.getTime(),
  events,
  status: "Ready",
  hints: [],
  ...overrides,
});

const month = renderCalendar(
  calendarModel({ view: "month", days: monthDays(2026, 7, 1) }),
  cx,
);

// `Column { anchors.margins: Style.space(14); spacing: Style.space(10) }`.
const page = find(month, "calendar");
assert.equal(styleArg(page, "p"), tokens.space(14));
assert.equal(styleArg(page, "gap"), tokens.space(10));

// The header band, and the two readings standing in it. Every control on that
// row is an `IconTextButton`, which is the theme's control height whatever type
// size it carries — the QML asks for the caption size and keeps the box.
assert.equal(styleArg(find(month, "calendar-header"), "h"), tokens.space(34));
for (const id of ["calendar-today", "calendar-week", "calendar-month"]) {
  const control = find(month, id);
  assert.ok(control, id);
  assert.equal(styleArg(control, "h"), tokens.spacing.controlHeight, id);
  assert.equal(styleArg(control, "text_size"), tokens.font.caption, id);
}

// `Grid { Item { height: Style.space(24) } }`, its captions indented by 7.
const weekdays = find(month, "calendar-weekdays");
assert.equal(styleArg(weekdays, "h"), tokens.space(24));
assert.equal(styleArg(weekdays.childNodes[0], "pl"), tokens.space(7));

// The QML anchors a cell's number to its top-left at `space(6)` and starts the
// chips `space(4)` below it, so the air under the number is narrower than the
// air over it. Padding all round would move every chip down two pixels.
const cell = find(month, "calendar-day-34");
assert.ok(cell, "the month draws a cell per day");
assert.equal(styleArg(cell, "border"), tokens.state.normalBorderWidth);
const dayNumber = cell.childNodes[0];
assert.equal(styleArg(dayNumber, "pt"), tokens.space(6));
assert.equal(styleArg(dayNumber, "pl"), tokens.space(6));
assert.equal(styleArg(dayNumber, "pb"), tokens.space(4));
assert.equal(styleArg(dayNumber, "text_size"), tokens.font.caption);

// A chip is `Style.space(18)` tall with a `Style.space(3)` rule in its
// calendar's colour down the left.
const chip = find(month, "calendar-event-34-0");
assert.ok(chip, "an event on a day is a chip on its cell");
assert.equal(styleArg(chip, "h"), tokens.space(18));
assert.equal(styleArg(chip.childNodes[0], "w"), tokens.space(3));

// ----------------------------------------------------------------- the week

const week = renderCalendar(
  calendarModel({ view: "week", weekDays: weekDays(now.getTime(), 1) }),
  cx,
);

// `Row { height: Style.space(28) }` over a `Style.space(52)` time rail.
const headers = find(week, "calendar-week-headers");
assert.equal(styleArg(headers, "h"), tokens.space(28));
assert.equal(styleArg(headers.childNodes[0], "w"), tokens.space(52));

// `allDayCount > 0 ? Style.space(6 + allDayCount * 20) : 0` — one all-day event
// on the busiest day of this week, so one row of band.
const lane = find(week, "calendar-allday-lane");
assert.equal(styleArg(lane, "h"), tokens.space(6 + 1 * 20));
assert.equal(
  styleArg(find(week, "calendar-allday-event-6-0"), "h"),
  tokens.space(18),
);

// The line for now: `Math.max(calendarBorderWidth, 2)` thick, with a
// `Style.space(7)` bead on the rail end so it does not read as one more hour
// separator.
const line = find(week, "calendar-now-line");
assert.equal(styleArg(line, "h"), Math.max(tokens.state.normalBorderWidth, 2));
assert.equal(
  styleArg(find(week, "calendar-week-day-6").childNodes.at(-1), "size"),
  tokens.space(7),
);

// The grid stops shrinking at the QML's floor and scrolls below it:
// `hourHeight: Math.max(Style.space(28), height / hourCount)`.
const timeline = find(week, "calendar-week-timeline");
const scroller = timeline.childNodes[0];
assert.equal(styleArg(scroller, "min_h") % tokens.space(28), 0);
assert.ok(styleArg(scroller, "min_h") >= 12 * tokens.space(28));

// --------------------------------------------------------------- the event

// `Flickable { anchors.margins: Style.space(18) }` around a column of
// `Style.space(720)`. gpui counts padding inside a maximum width, so a column
// that carries the margin as padding has to add it back.
const detail = renderCalendar(
  calendarModel({
    view: "month",
    days: monthDays(2026, 7, 1),
    detail: {
      event: { ...events[1], location: "Sunfish Studio" },
      source: { id: "work", name: "Work" },
      canWrite: true,
    },
  }),
  cx,
);
const detailColumn = find(detail, "calendar-detail-column");
assert.equal(
  styleArg(detailColumn, "max_w"),
  tokens.space(720) + tokens.spacing.panelPadding * 2,
);
assert.equal(styleArg(detailColumn, "p"), tokens.spacing.panelPadding);
assert.equal(styleArg(detailColumn, "gap"), tokens.spacing.panelGap);
assert.equal(styleArg(find(detail, "calendar-detail-back"), "h"), tokens.spacing.controlHeight);
// `Qt.formatDate(start, "dddd, d MMMM yyyy")` is day-first whatever the
// locale's names are; `toLocaleDateString` is not, so the shape is written out
// rather than asked for.
assert.equal(
  dateSummary({
    start: { ms: at(30, 11), allDay: false },
    end: { ms: at(30, 12), allDay: false },
  }),
  "Sunday, 30 August 2026 · 11:00–12:00",
);
// The rule in the event's own colour over its title, and the dot beside the
// calendar that owns it.
assert.equal(styleArg(detailColumn.childNodes[1], "h"), tokens.space(4));
assert.equal(styleArg(find(detail, "calendar-detail-actions"), "gap"), tokens.space(7));

// ------------------------------------------------------------ the composer

const state = (value) => ({ value: () => value });
const composer = renderCalendar(
  calendarModel({
    view: "month",
    days: monthDays(2026, 7, 1),
    composer: {
      open: true,
      editing: false,
      fields: {
        title: state("Planning"),
        date: state("2026-09-04"),
        start: state("09:00"),
        end: state("10:00"),
      },
    },
  }),
  cx,
);
const form = find(composer, "calendar-composer-column");
assert.equal(
  styleArg(form, "max_w"),
  tokens.space(620) + tokens.spacing.panelPadding * 2,
);
assert.equal(styleArg(form, "gap"), tokens.space(10));
assert.equal(styleArg(find(composer, "calendar-composer-when"), "gap"), tokens.space(8));
assert.equal(styleArg(find(composer, "calendar-composer-actions"), "gap"), tokens.space(6));
assert.equal(styleArg(find(composer, "calendar-cancel"), "h"), tokens.spacing.controlHeight);

// `QQC.Popup { width: Math.min(Style.space(360), parent.width - Style.space(32));
// padding: Style.space(18) }`.
const confirm = renderCalendar(
  calendarModel({
    view: "month",
    days: monthDays(2026, 7, 1),
    confirm: { name: "Design review", message: "This cannot be undone." },
  }),
  cx,
);
const card = find(confirm, "calendar-confirm-card");
assert.equal(styleArg(card, "max_w"), tokens.space(360));
assert.equal(styleArg(card, "p"), tokens.space(18));
assert.equal(styleArg(card, "gap"), tokens.space(14));
assert.equal(styleArg(find(confirm, "calendar-confirm"), "p"), tokens.space(16));

// ------------------------------------------------------------ the settings

const settingsModel = {
  accounts: [
    {
      id: "one@example.test",
      email: "one@example.test",
      providerName: "Gmail",
      active: true,
      detail: "4 unread messages · showing now",
    },
    {
      id: "imap:two@example.test",
      email: "two@example.test",
      providerName: "IMAP",
      active: false,
      detail: "11 unread messages",
    },
  ],
  preferences: [
    {
      key: "remoteImages",
      section: "Reading",
      kind: "toggle",
      label: "Always show remote images",
      detail: "Loading an image tells its host that this address opened it",
      value: false,
      disabled: false,
    },
    {
      key: "undoSendSeconds",
      section: "Writing",
      kind: "number",
      label: "Undo send window",
      unit: "Seconds",
      detail: "Omamail waits before delivery.",
      value: 10,
      min: 0,
      max: 60,
      step: 1,
      disabled: false,
    },
  ],
  calendars: {
    detail: "Connect a CalDAV calendar here.",
    sources: [
      {
        id: "caldav:family",
        name: "Family",
        kind: "caldav",
        url: "https://example.test/dav/",
        removable: true,
        enabled: true,
        colorKey: "blue",
        colorKeys: ["accent", "red", "blue"],
      },
    ],
  },
  oauthClient: { present: true, description: "Omamail desktop client", detail: "" },
  pendingRemoval: null,
  busy: false,
  error: "",
  onBack() {},
  onAdd() {},
  onSwitch() {},
  onRemove() {},
  onPreference() {},
  onCalendarAdd() {},
  onCalendarRemove() {},
  onCalendarPassword() {},
};

const settings = renderSettings(settingsModel, cx);

// `App.qml` gives the settings flickable `Style.space(18)` of margin and the
// page inside it `Style.space(560)`; `SettingsPage.qml` is one column at
// `Style.space(16)`, captions included.
const settingsColumn = find(settings, "settings-column");
assert.equal(
  styleArg(settingsColumn, "max_w"),
  tokens.space(560) + tokens.spacing.panelPadding * 2,
);
assert.equal(styleArg(settingsColumn, "gap"), tokens.space(16));
assert.equal(styleArg(settingsColumn, "p"), tokens.spacing.panelPadding);
assert.equal(
  styleArg(find(settings, "settings-reading-group"), "gap"),
  tokens.space(16),
);

// The mailboxes are a list rather than a run of separate settings: the QML
// stacks them at `Style.space(2)` so they read as one block.
assert.equal(styleArg(find(settings, "settings-accounts"), "gap"), tokens.space(2));

// `CalendarSettings.qml` is a column of its own inside the page, tighter than
// the page around it.
assert.equal(
  styleArg(find(settings, "settings-calendars-group"), "gap"),
  tokens.space(8),
);

// A settings row is `Style.space(16)` taller than its contents, indented by
// `Style.spacing.rowPaddingX`.
const row = find(settings, "settings-remote-images");
assert.equal(styleArg(row, "px"), tokens.spacing.rowPaddingX);
assert.equal(styleArg(row, "py"), tokens.spacing.lg);
assert.equal(tokens.spacing.lg * 2, tokens.space(16));

// `ToggleSwitch.qml`'s own derivation, so the switch is the size the shell
// draws it at whatever control height the theme asked for.
const trackHeight = Math.max(22, Math.round(tokens.spacing.controlHeight * 0.55));
const track = find(settings, "settings-remote-images-toggle");
assert.equal(styleArg(track, "h"), trackHeight);
assert.equal(styleArg(track, "w"), Math.round(trackHeight * 1.9));

// `NumberField.qml`: a caption over a box `Style.spacing.numberFieldWidth`
// wide, at `Style.spacing.md` — which is wider than the gap a field and its
// label take elsewhere in the kit.
const number = find(settings, "settings-undo-send-seconds-number");
assert.equal(styleArg(number, "gap"), tokens.spacing.md);
const box = find(settings, "settings-undo-send-seconds-number-field");
assert.equal(styleArg(box, "w"), tokens.spacing.numberFieldWidth);
assert.equal(styleArg(box, "h"), tokens.spacing.controlHeight);

// `BackBar.qml` and the two "Add..." buttons are `IconTextButton`s, so they
// stand at the control height and are as wide as their labels rather than as
// wide as the column.
for (const id of ["settings-back", "settings-add-account", "settings-add-calendar"]) {
  const control = find(settings, id);
  assert.ok(control, id);
  assert.equal(styleArg(control, "h"), tokens.spacing.controlHeight, id);
}

console.log("calendar and settings chrome tests passed");
