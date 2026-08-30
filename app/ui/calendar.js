// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  googleCalendarApiUrl,
  isoDate,
  monthDays,
  weekDays,
  weekTitle,
} from "../calendar/Calendar.js";
import { hintsFor } from "../keys/keymap.js";
import {
  actionButton,
  alpha,
  appShell,
  bottomBar,
  brandLockup,
  button,
  iconTextButton,
  kbd,
  muted,
  statusLine,
  style,
  topBar,
} from "../lib/omarchy-ui/index.js";
import {
  renderCalendarComposer,
  renderDeleteConfirmation,
} from "./calendar-composer.js";
import { renderCalendarDetail } from "./calendar-detail.js";
import { MONTH_NAMES, renderMonthGrid } from "./calendar-month.js";
import { icon } from "./icons.js";
import { calendarRoles, color } from "./calendar-palette.js";
import { renderWeekGrid } from "./calendar-week.js";
import { renderRail } from "./rail.js";

/** A status that says the window is idle rather than that something went wrong. */
const SETTLED = /^(Ready|Saved|Deleted|\d+ events?)$/;

/**
 * The days on screen. The controller works these out, because which range is
 * loaded and which range is drawn have to be the same range; deriving them from
 * the anchor is what a host that has not been taught to pass them yet gets.
 * @param {any} model @param {number} anchorMs
 */
function daysOf(model, anchorMs) {
  const anchor = new Date(anchorMs);
  if (model.view === "week") {
    if (Array.isArray(model.weekDays) && model.weekDays.length === 7)
      return model.weekDays;
    if (Array.isArray(model.grid) && model.grid.length === 7) return model.grid;
    return weekDays(anchorMs, 1);
  }
  if (Array.isArray(model.days) && model.days.length === 42) return model.days;
  if (Array.isArray(model.grid) && model.grid.length === 42) return model.grid;
  return monthDays(anchor.getFullYear(), anchor.getMonth(), 1);
}

/**
 * What the calendar could not do, said where it happened rather than on the
 * window's status line. A Google project with the Calendar API switched off is
 * the one failure a user can fix from here, so that one — and only that one —
 * carries the two buttons that fix it.
 * @param {any} model @param {import("gpui").Context} cx
 */
function errorBanner(model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const apiDisabled = String(model.lastErrorKind || "") === "googleApiDisabled";
  return h_flex()
    .id("calendar-error")
    .flex_none()
    .items_center()
    .h(tokens.space(34))
    .px(tokens.space(10))
    .gap(tokens.space(4))
    .rounded(tokens.cornerRadius)
    .border(roles.borderWidth)
    .border_color(roles.urgent)
    .bg(color(alpha(roles.urgent, 0.12)))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .text_size(tokens.font.caption)
        .text_color(roles.text)
        .truncate()
        .child(String(model.lastError || "")),
    )
    .when(apiDisabled, (banner) =>
      banner.child(
        iconTextButton(
          "calendar-error-copy",
          "",
          "Copy",
          (_click, eventCx) =>
            model.onCopy?.(String(model.lastError || ""), eventCx),
          cx,
          { tooltip: "Copy this error" },
        ),
      ),
    )
    .when(apiDisabled, (banner) =>
      banner.child(
        iconTextButton(
          // No glyph on either: the banner is already the loudest thing on the
          // page, and the QML draws both of these as bare labels.
          "calendar-error-enable-api",
          "",
          "Enable API...",
          (_click, eventCx) =>
            model.onOpenUrl?.(googleCalendarApiUrl(), eventCx),
          cx,
          { tooltip: "Open Google Cloud Calendar API setup..." },
        ),
      ),
    );
}

/**
 * The header over the grid: where in time the view is, the way back to now, and
 * the two ways of looking at it.
 *
 * Every control on this row is an `IconTextButton` in the QML, which is pinned
 * to the theme's control height whatever type size it carries — so a caption on
 * one of them makes the label smaller and leaves the box the size of the fields
 * and buttons everywhere else in the window.
 * @param {any} model @param {string} caption @param {import("gpui").Context} cx
 */
function calendarHeader(model, caption, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const week = model.view === "week";
  /**
   * @param {string} id @param {string} text
   * @param {(event: any, cx: import("gpui").Context) => void} onClick
   * @param {any} options
   */
  const headerButton = (id, text, onClick, options) =>
    button(id, text, onClick, cx, {
      ...options,
      fontSize: tokens.font.caption,
    }).h(tokens.spacing.controlHeight);
  return h_flex()
    .id("calendar-header")
    .flex_none()
    .items_center()
    .justify_between()
    .h(tokens.space(34))
    .gap(tokens.space(10))
    .child(
      h_flex()
        .items_center()
        .min_w_0()
        .gap(tokens.space(10))
        .child(
          div()
            .text_size(tokens.font.heading)
            .text_color(roles.text)
            .font_bold()
            .truncate()
            .child(caption),
        )
        .child(
          // Borderless and in the accent: the way back to now is a link beside
          // the month's name rather than a third button competing with the two
          // on the right.
          headerButton(
            "calendar-today",
            "Go to today",
            (_click, eventCx) => model.onToday?.(_click, eventCx),
            { tooltip: "Show the current date", color: roles.accent },
          ),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .items_center()
        .gap(tokens.space(4))
        // A read in flight is said where the reading is, not on the window's
        // status line: the grid is what is about to change.
        .when(model.loading === true, (actions) =>
          actions.child(
            // A mark, not a control: the QML centres a plain spinning
            // `ActionIcon` in a `space(24)` slot, and a button here would offer
            // a press that does nothing.
            div()
              .id("calendar-loading")
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .size(tokens.space(24))
              .child(
                icon("refresh", cx, {
                  size: tokens.font.iconSmall,
                  color: roles.accent,
                }),
              ),
          ),
        )
        .child(
          headerButton(
            "calendar-week",
            "Week",
            (_click, eventCx) => model.onWeek?.(_click, eventCx),
            {
              selected: week,
              bordered: true,
              // The whole control takes its tone from the reading it stands
              // for, fill and border included: `Style.normalFillFor` is given
              // the same colour the label is drawn in.
              color: week ? roles.text : roles.dim,
            },
          ),
        )
        .child(
          headerButton(
            "calendar-month",
            "Month",
            (_click, eventCx) => model.onMonth?.(_click, eventCx),
            {
              selected: !week,
              bordered: true,
              color: week ? roles.dim : roles.text,
            },
          ),
        )
        .child(
          actionButton(
            "calendar-previous",
            "chevronLeft",
            week ? "Previous week" : "Previous month",
            (_click, eventCx) => model.onPrevious?.(_click, eventCx),
            cx,
            { color: roles.dim, hoverColor: roles.text },
          ),
        )
        .child(
          actionButton(
            "calendar-next",
            "chevronRight",
            week ? "Next week" : "Next month",
            (_click, eventCx) => model.onNext?.(_click, eventCx),
            cx,
            { color: roles.dim, hoverColor: roles.text },
          ),
        ),
    );
}

/**
 * The calendar.
 *
 * The month and the week are two readings of one range, and the range is the
 * controller's: this draws the days it is handed, colours each event with the
 * slot its calendar holds, and reports every press back. The detail page and
 * the composer cover the grid rather than sitting beside it, because both are
 * about one event and the grid behind them is about the month.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderCalendar(model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const anchorMs = Number(model.anchorMs) || Date.now();
  const nowMs = Number(model.nowMs) || Date.now();
  const days = daysOf(model, anchorMs);
  const anchor = new Date(anchorMs);
  const caption =
    model.view === "week"
      ? weekTitle(days)
      : `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;

  // Everything below reads one shape, whatever the host was able to hand over:
  // which day is today, when now is, and which event the keyboard is standing
  // on are all questions each grid asks and none of them should answer twice.
  const view = {
    ...model,
    nowMs,
    todayIso: String(model.todayIso || isoDate(new Date(nowMs))),
    events: Array.isArray(model.events) ? model.events : [],
    selectedEventId: String(
      model.selectedEventId ?? model.selected?.uid ?? model.selectedId ?? "",
    ),
    detail:
      model.detail !== undefined
        ? model.detail
        : model.selected
          ? { event: model.selected, source: model.source, canWrite: true }
          : null,
  };

  const status = String(
    model.writeStatus || model.readStatus || model.status || "",
  );
  const busy = model.loading === true || model.pending === true;
  /** @type {"ready"|"loading"|"error"} */
  const statusState = busy
    ? "loading"
    : status === "" || SETTLED.test(status)
      ? "ready"
      : "error";
  const hints = Array.isArray(model.hints) ? model.hints : hintsFor("calendar");
  // Whether there is anywhere to put an event. Which calendar it goes on is the
  // composer's question, not this one's, so a window with calendars it cannot
  // write to says so and a window with several says nothing.
  const canCreate =
    model.canCreate !== undefined
      ? model.canCreate === true
      : model.hasSource !== false;

  const composer = renderCalendarComposer(view, cx);
  const confirmation = renderDeleteConfirmation(view, cx);

  const content = v_flex()
    .id("calendar")
    .relative()
    .flex_1()
    .min_w_0()
    .min_h_0()
    .p(tokens.space(14))
    .gap(tokens.space(10))
    .child(calendarHeader(view, caption, cx))
    .when(Boolean(model.lastError), (page) => page.child(errorBanner(view, cx)))
    .when(!canCreate, (page) =>
      page.child(
        muted("Add a calendar source in Settings before creating events.", cx)
          .id("calendar-no-source")
          .flex_none()
          .text_size(tokens.font.caption),
      ),
    )
    .child(
      model.view === "week"
        ? renderWeekGrid(days, view, cx)
        : renderMonthGrid(days, view, cx),
    );

  // A page about one event covers the grid it came from. Editing replaces the
  // detail rather than stacking on it: the event the composer rewrites is not
  // the one those labels would go on showing.
  /** @type {import("gpui").Element[]} */
  const overlays = [];
  if (composer) overlays.push(composer);
  else if (view.detail) overlays.push(renderCalendarDetail(view, cx));
  if (confirmation) overlays.push(confirmation);
  content.children(overlays);

  return appShell(
    {
      top: topBar(
        {
          brand: brandLockup(cx),
          actions: h_flex()
            .flex_none()
            .items_center()
            .gap(tokens.space(4))
            .child(
              actionButton(
                "calendar-refresh",
                "refresh",
                model.loading === true
                  ? "Loading calendars"
                  : "Refresh calendars · F5",
                (_click, eventCx) => model.onRefresh?.(_click, eventCx),
                cx,
                { color: roles.dim, disabled: model.loading === true },
              ),
            )
            .child(
              iconTextButton(
                "calendar-new",
                "plus",
                "Create event...",
                (_click, eventCx) => model.onNew?.(_click, eventCx),
                cx,
                { disabled: !canCreate || model.pending === true },
              ),
            ),
        },
        cx,
      ),
      content: h_flex()
        .id("calendar-workspace")
        // The rail and the grid are columns filling the window, not items in a
        // row — `h_flex` would otherwise centre each on the cross axis.
        .items_stretch()
        .size_full()
        .min_w_0()
        .min_h_0()
        .when(Boolean(model.navigation), (workspace) =>
          workspace.child(renderRail(model.navigation, cx)),
        )
        .child(content),
      bottom: bottomBar(
        {
          status: statusLine(status, statusState, cx)
            .id("calendar-status")
            .role(statusState === "error" ? "alert" : "status"),
          hints: h_flex()
            .id("calendar-status-hints")
            .flex_none()
            .gap(tokens.spacing.controlGap)
            .children(
              hints.map((/** @type {{key:string,label:string}} */ hint) =>
                h_flex()
                  .items_center()
                  .gap(tokens.spacing.labelGap)
                  .child(kbd(hint.key, cx))
                  .child(
                    muted(hint.label, cx).text_size(tokens.font.caption),
                  ),
              ),
            ),
        },
        cx,
      ),
    },
    cx,
  );
}
