// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  allDayEventsOnDay,
  eventHeight,
  eventTop,
  eventsOnDay,
  maxAllDayEvents,
  nowOffset,
  slotStart,
  timeLabel,
  two,
  weekHourRange,
  weekNowOffset,
} from "../calendar/Calendar.js";
import { roles, style } from "omarchy-ui";
import {
  ALL_DAY_FILL,
  BLOCK_FILL,
  BLOCK_SELECTED_FILL,
  calendarRoles,
  chipSurface,
} from "./calendar-palette.js";
import { WEEKDAY_NAMES } from "./calendar-month.js";

/**
 * The hour the grid's arithmetic is done in.
 *
 * The QML read a real hour height off a laid-out Flickable and placed every
 * block against it in pixels. Nothing here has been measured at the moment the
 * tree is built, so the grid is placed in **percentages of its own height**
 * instead: the ratios `Calendar.eventTop` and `eventHeight` return are the same
 * whatever unit they are asked in, so one nominal hour cancels out of every
 * one of them and the grid stretches to whatever room the window gives it —
 * which is what the Flickable did. The floor the QML clamped at survives as the
 * timeline's minimum height, below which it scrolls.
 */
const NOMINAL_HOUR = 100;

/** @param {number} offset @param {number} span */
const percent = (offset, span) =>
  /** @type {import("gpui").Length} */ (
    `${Math.round((offset / span) * 10000) / 100}%`
  );

/** @param {any} model */
function weekEvents(model) {
  return Array.isArray(model.events) ? model.events : [];
}

/** @param {any} model @param {any} day */
function isToday(model, day) {
  return String(day.isoDate || "") === String(model.todayIso || "");
}

/**
 * One timed event, placed against the hour rail by the same arithmetic the
 * month grid never needs: minutes on the labeled local-time grid, so a
 * daylight-saving boundary cannot slide a block by an hour.
 * @param {string} id @param {any} event @param {any} day @param {number} firstHour
 * @param {number} span @param {any} model @param {import("gpui").Context} cx
 */
function eventBlock(id, event, day, firstHour, span, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const surface = chipSurface(model, event, cx, {
    fill: BLOCK_FILL,
    selectedFill: BLOCK_SELECTED_FILL,
  });
  const start = new Date(Number(event?.start?.ms ?? event?.startMs));
  return h_flex()
    .id(id)
    .absolute()
    .top(percent(eventTop(event, day, firstHour, NOMINAL_HOUR), span))
    .left(tokens.space(3))
    .right(tokens.space(3))
    .h(percent(eventHeight(event, day, NOMINAL_HOUR), span))
    .overflow_hidden()
    .cursor_pointer()
    .rounded(tokens.cornerRadius)
    .bg(surface.fill)
    .border(surface.borderWidth)
    .border_color(surface.color)
    .on_click((_click, eventCx) => {
      // The hour underneath opens the composer at its own slot; pressing an
      // event must not also propose a new one there.
      eventCx.stop_propagation?.();
      model.onEvent?.(event, eventCx);
    })
    .child(
      div().flex_none().w(tokens.space(3)).self_stretch().bg(surface.color),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .p(tokens.space(5))
        .gap(tokens.space(1))
        .child(
          div()
            .text_size(tokens.font.caption)
            .text_color(roles.text)
            .font_bold()
            .truncate()
            .child(String(event?.summary || event?.title || "Untitled event")),
        )
        .child(
          div()
            .text_size(tokens.font.caption)
            .text_color(roles.dim)
            .child(`${two(start.getHours())}:${two(start.getMinutes())}`),
        ),
    );
}

/**
 * The line across today's column, and the bead on its rail end.
 *
 * Added after the events, so a meeting in progress is crossed by the line
 * rather than covering it. The dot is what survives a theme whose urgent colour
 * sits close to an event's border: a bare rule reads as one more hour
 * separator, a rule with a bead on it does not.
 * @param {number} offset @param {number} span @param {import("gpui").Context} cx
 */
function nowMarker(offset, span, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const thickness = Math.max(roles.borderWidth, 2);
  const dot = tokens.space(7);
  return [
    div()
      .id("calendar-now-line")
      .absolute()
      .top(percent(offset, span))
      .mt(-thickness / 2)
      .left(0)
      .right(0)
      .h(thickness)
      .bg(roles.urgent),
    div()
      .absolute()
      .top(percent(offset, span))
      .mt(-dot / 2)
      .left(0)
      .size(dot)
      .rounded_full()
      .bg(roles.urgent),
  ];
}

/**
 * One day column: the hours it can be planned into, the events on it, and the
 * line for now. Pressing an hour asks for an event in it — the QML read the
 * pointer's own y and snapped to the half hour, and a click here carries no
 * position, so the hour that was pressed is the hour it is drawn in.
 * @param {any} day @param {number} index @param {number} firstHour @param {number} lastHour
 * @param {number} hourCount @param {any} model @param {import("gpui").Context} cx
 */
function dayColumn(day, index, firstHour, lastHour, hourCount, model, cx) {
  const roles = calendarRoles(cx);
  const span = hourCount * NOMINAL_HOUR;
  const timed = eventsOnDay(weekEvents(model), day).filter(
    (/** @type {any} */ event) => event?.start && !event.start.allDay,
  );
  const offset = nowOffset(
    day,
    firstHour,
    lastHour,
    NOMINAL_HOUR,
    Number(model.nowMs) || 0,
  );
  const hours = [];
  for (let hour = 0; hour < hourCount; hour += 1) {
    const startMs = slotStart(
      day,
      hour * NOMINAL_HOUR,
      firstHour,
      NOMINAL_HOUR,
      30,
    );
    hours.push(
      div()
        .id(`calendar-slot-${index}-${hour}`)
        .flex_1()
        // A crosshair over an empty hour: the pointer is choosing a place on a
        // grid, not following a link, and the month's cells say the same thing
        // with a hand because there is only one place a day can be chosen at.
        .cursor_crosshair()
        .border_t(roles.borderWidth)
        .border_color(roles.border)
        .on_click((_click, eventCx) => model.onCreateAt?.(startMs, eventCx)),
    );
  }
  return div()
    .id(`calendar-week-day-${index}`)
    .relative()
    .flex_1()
    .min_w_0()
    .h_full()
    .overflow_hidden()
    .border(roles.borderWidth)
    .border_color(roles.border)
    .when(isToday(model, day), (column) => column.bg(roles.today))
    .child(v_flex().absolute().inset_0().children(hours))
    .children(
      timed.map((/** @type {any} */ event, /** @type {number} */ position) =>
        eventBlock(
          `calendar-week-event-${index}-${position}`,
          event,
          day,
          firstHour,
          span,
          model,
          cx,
        ),
      ),
    )
    .when(offset >= 0, (column) =>
      column.children(nowMarker(offset, span, cx)),
    );
}

/**
 * The band above the grid. An all-day event belongs to no hour, so it is drawn
 * out of the timeline rather than stretched down it; the band is only as tall
 * as the busiest day needs, and absent when no day needs one.
 * @param {Array<any>} days @param {number} count @param {number} railWidth
 * @param {any} model @param {import("gpui").Context} cx
 */
function allDayLane(days, count, railWidth, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  return h_flex()
    .id("calendar-allday-lane")
    .flex_none()
    .h(tokens.space(6 + count * 20))
    .overflow_hidden()
    .border(roles.borderWidth)
    .border_color(roles.border)
    .child(
      h_flex()
        .flex_none()
        .items_center()
        .w(railWidth)
        .px(tokens.space(4))
        .text_size(tokens.font.caption)
        .text_color(roles.dim)
        .child(div().truncate().child("all-day")),
    )
    .children(
      days.map((day, index) =>
        v_flex()
          .id(`calendar-allday-${index}`)
          .flex_1()
          .min_w_0()
          .h_full()
          .p(tokens.space(2))
          .gap(tokens.space(2))
          .border(roles.borderWidth)
          .border_color(roles.border)
          .when(isToday(model, day), (column) => column.bg(roles.today))
          .children(
            allDayEventsOnDay(weekEvents(model), day).map(
              (/** @type {any} */ event, /** @type {number} */ position) => {
                const surface = chipSurface(model, event, cx, {
                  fill: ALL_DAY_FILL,
                  selectedFill: BLOCK_SELECTED_FILL,
                });
                return h_flex()
                  .id(`calendar-allday-event-${index}-${position}`)
                  .flex_none()
                  .items_center()
                  .h(tokens.space(18))
                  .overflow_hidden()
                  .cursor_pointer()
                  .pl(tokens.space(4))
                  .pr(tokens.space(3))
                  .bg(surface.fill)
                  .border(surface.borderWidth)
                  .border_color(surface.color)
                  .text_size(tokens.font.caption)
                  .text_color(roles.text)
                  .on_click((_click, eventCx) =>
                    model.onEvent?.(event, eventCx),
                  )
                  .child(
                    div()
                      .truncate()
                      .child(String(event?.summary || "Untitled event")),
                  );
              },
            ),
          ),
      ),
    );
}

/**
 * The week: seven day headers, an all-day band when the week needs one, and a
 * scrolling hour grid under both.
 * @param {Array<any>} days @param {any} model @param {import("gpui").Context} cx
 */
export function renderWeekGrid(days, model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const railWidth = tokens.space(52);
  // The range is elastic: seven to seven is the working day, and an event
  // outside it widens the grid rather than being drawn off the end of it.
  const range = weekHourRange(weekEvents(model), days, 7, 19);
  const firstHour = range.first;
  const lastHour = range.last;
  const hourCount = Math.max(1, lastHour - firstHour);
  const span = hourCount * NOMINAL_HOUR;
  const allDayCount = maxAllDayEvents(weekEvents(model), days);
  const labelHeight = Math.round(tokens.font.caption * 1.35);
  const pillHeight = labelHeight + tokens.space(2);
  // The rail's pill is the week's answer rather than a column's: the same
  // helper the QML asks, so the label and the line across today cannot disagree
  // about where now is.
  const weekOffset = weekNowOffset(
    days,
    firstHour,
    lastHour,
    NOMINAL_HOUR,
    Number(model.nowMs) || 0,
  );

  const railLabels = [];
  for (let hour = 0; hour < hourCount; hour += 1) {
    railLabels.push(
      div()
        .absolute()
        .top(percent(hour * NOMINAL_HOUR, span))
        // Centred on its own rule, except the first: the rail has nothing above
        // the grid to overflow into, so the top label is nudged down instead of
        // half clipped.
        .mt(hour === 0 ? tokens.space(2) : -labelHeight / 2)
        .left(tokens.space(4))
        .text_size(tokens.font.caption)
        .text_color(roles.dim)
        .child(`${two(firstHour + hour)}:00`),
    );
  }

  return v_flex()
    .id("calendar-week")
    .flex_1()
    .min_w_0()
    .min_h_0()
    .child(
      h_flex()
        .id("calendar-week-headers")
        .flex_none()
        .h(tokens.space(28))
        .child(div().flex_none().w(railWidth))
        .children(
          days.map((day, index) =>
            h_flex()
              .flex_1()
              .min_w_0()
              .items_center()
              .justify_center()
              .text_size(tokens.font.caption)
              .text_color(isToday(model, day) ? roles.text : roles.dim)
              .when(isToday(model, day), (header) => header.font_bold())
              .child(`${WEEKDAY_NAMES[index]} ${day.day}`),
          ),
        ),
    )
    .when(allDayCount > 0, (week) =>
      week.child(allDayLane(days, allDayCount, railWidth, model, cx)),
    )
    .child(
      v_flex()
        .id("calendar-week-timeline")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .child(
          h_flex()
            .items_stretch()
            .flex_1()
            // The QML's floor, kept as the point the grid stops shrinking and
            // starts scrolling: below an hour of this height the labels run
            // into one another.
            .min_h(hourCount * tokens.space(28))
            .child(
              // Read off the rail rather than off the line: the hour labels
              // stop at the hour, so a line between two of them otherwise says
              // only "somewhere in here". The pill is absent when today is not
              // the week on screen.
              div()
                .relative()
                .flex_none()
                .w(railWidth)
                .h_full()
                .children(railLabels)
                .when(weekOffset >= 0, (rail) =>
                  rail.child(
                    h_flex()
                      .id("calendar-now-label")
                      .absolute()
                      .top(percent(weekOffset, span))
                      .mt(-pillHeight / 2)
                      .left(tokens.space(4))
                      .h(pillHeight)
                      .items_center()
                      .px(tokens.space(3))
                      .rounded(tokens.cornerRadius)
                      .bg(roles.urgent)
                      .text_size(tokens.font.caption)
                      .text_color(roles.background)
                      .font_bold()
                      .child(timeLabel(Number(model.nowMs) || 0)),
                  ),
                ),
            )
            .child(
              h_flex()
                .items_stretch()
                .flex_1()
                .min_w_0()
                .children(
                  days.map((day, index) =>
                    dayColumn(
                      day,
                      index,
                      firstHour,
                      lastHour,
                      hourCount,
                      model,
                      cx,
                    ),
                  ),
                ),
            ),
        ),
    );
}
