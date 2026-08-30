// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { eventsOnDay, two } from "../calendar/Calendar.js";
import { style } from "../lib/omarchy-ui/index.js";
import { CHIP_FILL, CHIP_SELECTED_FILL, calendarRoles, chipSurface } from "./calendar-palette.js";

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// The names the header and the event page spell out. Written here rather than
// taken from `toLocaleDateString`, because that answers in the host's own
// order — "August 30, 2026" on a US locale — and Qt's `dddd, d MMMM yyyy` is
// day-first whatever the locale's names are.
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const LONG_WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Three, because a fourth leaves the cell no room for the day number, and a
// count is a better answer than a chip nobody can read.
const MAX_CHIPS = 3;

/**
 * One event on a month cell: a rule in the calendar's colour, the start time
 * where the event has one, and the summary.
 * @param {string} id @param {any} event @param {any} model
 * @param {import("gpui").Context} cx
 */
function monthChip(id, event, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const surface = chipSurface(model, event, cx, {
    fill: CHIP_FILL,
    selectedFill: CHIP_SELECTED_FILL,
  });
  const startMs = Number(event?.start?.ms ?? event?.startMs);
  const timed = Boolean(event?.start) && event.start.allDay !== true;
  const start = new Date(startMs);
  const time =
    timed && Number.isFinite(startMs)
      ? `${two(start.getHours())}:${two(start.getMinutes())} `
      : "";
  return h_flex()
    .id(id)
    .flex_none()
    .items_center()
    .h(tokens.space(18))
    .overflow_hidden()
    .cursor_pointer()
    .bg(surface.fill)
    .border(surface.borderWidth)
    .border_color(surface.color)
    .on_click((_click, eventCx) => {
      // The cell underneath opens the composer; a chip must not do both.
      eventCx.stop_propagation?.();
      model.onEvent?.(event, eventCx);
    })
    .child(div().flex_none().w(tokens.space(3)).self_stretch().bg(surface.color))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .px(tokens.space(4))
        .text_size(tokens.font.caption)
        .text_color(roles.text)
        .truncate()
        .child(`${time}${String(event?.summary || event?.title || "Untitled event")}`),
    );
}

/**
 * One day of the month. Clicking the cell asks for an event at nine in the
 * morning — the hour a day is planned from, and the only one a cell that shows
 * no times can honestly pick.
 * @param {any} day @param {number} index @param {any} model
 * @param {import("gpui").Context} cx
 */
function dayCell(day, index, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const today = String(day.isoDate || "") === String(model.todayIso || "");
  const dayEvents = Array.isArray(day.events)
    ? day.events
    : eventsOnDay(model.events, day);
  const inMonth = day.inMonth !== false;
  return v_flex()
    .id(`calendar-day-${index}`)
    .flex_1()
    .min_w_0()
    .min_h_0()
    .overflow_hidden()
    .cursor_pointer()
    .border(roles.borderWidth)
    .border_color(roles.border)
    .when(today, (cell) => cell.bg(roles.today))
    .on_click((_click, eventCx) =>
      model.onCreateAt?.(Number(day.startMs) + 9 * 3600000, eventCx),
    )
    .child(
      div()
        .flex_none()
        // The QML anchors the number to the cell's top-left at `space(6)` and
        // starts the chips `space(4)` under it, so the air below the number is
        // narrower than the air above it. Padding all round would push the
        // first chip two pixels further down than the QML draws it.
        .pt(tokens.space(6))
        .pl(tokens.space(6))
        .pb(tokens.space(4))
        .text_size(tokens.font.caption)
        .text_color(inMonth ? roles.text : roles.dim)
        // Out-of-month days are dimmed twice: a lighter role and a lower
        // opacity, because the role alone is what a secondary label already
        // uses and these are not merely secondary — they belong to another
        // month.
        .when(!inMonth, (number) => number.opacity(0.55))
        .when(today, (number) => number.font_bold())
        .child(String(day.day ?? day.label ?? "")),
    )
    .child(
      v_flex()
        .flex_1()
        .min_h_0()
        .px(tokens.space(4))
        .gap(tokens.space(2))
        .children(
          dayEvents
            .slice(0, MAX_CHIPS)
            .map((/** @type {any} */ event, /** @type {number} */ position) =>
              monthChip(
                `calendar-event-${index}-${position}`,
                event,
                model,
                cx,
              ),
            ),
        )
        .when(dayEvents.length > MAX_CHIPS, (column) =>
          column.child(
            div()
              .flex_none()
              .text_size(tokens.font.caption)
              .text_color(roles.dim)
              .child(`+${dayEvents.length - MAX_CHIPS} more`),
          ),
        ),
    );
}

/**
 * The month: a weekday rule over six rows of seven, every cell the same size
 * whether or not the month reaches it.
 * @param {Array<any>} days @param {any} model @param {import("gpui").Context} cx
 */
export function renderMonthGrid(days, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const rows = [];
  for (let offset = 0; offset < days.length; offset += 7) {
    rows.push(
      h_flex()
        .id(`calendar-row-${offset / 7}`)
        // The cells are the row's height, not blocks floating in the middle of
        // it: `h_flex` centres on the cross axis unless told otherwise.
        .items_stretch()
        .flex_1()
        .min_h_0()
        .children(
          days
            .slice(offset, offset + 7)
            .map((day, column) => dayCell(day, offset + column, model, cx)),
        ),
    );
  }
  return v_flex()
    .id("calendar-grid")
    .flex_1()
    .min_w_0()
    .min_h_0()
    .child(
      h_flex()
        .id("calendar-weekdays")
        .flex_none()
        .h(tokens.space(24))
        .children(
          WEEKDAY_NAMES.map((name) =>
            h_flex()
              .flex_1()
              .min_w_0()
              .items_center()
              .pl(tokens.space(7))
              .text_size(tokens.font.caption)
              .text_color(roles.dim)
              .child(name),
          ),
        ),
    )
    .children(rows);
}
