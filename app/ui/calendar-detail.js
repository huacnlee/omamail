// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { two } from "../calendar/Calendar.js";
import {
  centeredWorkspace,
  iconTextButton,
  pageColumn,
  separator,
  style,
} from "../lib/omarchy-ui/index.js";
import { icon } from "./icons.js";
import { LONG_WEEKDAY_NAMES, MONTH_NAMES } from "./calendar-month.js";
import { calendarRoles, slotColor } from "./calendar-palette.js";

/**
 * A value is only an address when it is one this window may hand to a browser.
 * A location is prose far more often than it is a link, and a `href` a server
 * wrote is not automatically something to open.
 * @param {unknown} value
 */
function httpLink(value) {
  const candidate = String(value ?? "").trim();
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}

// Qt's `dddd, d MMMM yyyy` and `d MMMM yyyy`, spelled out rather than asked of
// `toLocaleDateString`: that answers in the host locale's own order, so a US
// default reads "Sunday, August 30, 2026" where the QML draws
// "Sunday, 30 August 2026" — the same day in a shape this window never used.

/** @param {Date} date */
const longDay = (date) =>
  `${LONG_WEEKDAY_NAMES[date.getDay()]}, ${shortDay(date)}`;

/** @param {Date} date */
const shortDay = (date) =>
  `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;

/** @param {Date} date */
const clock = (date) => `${two(date.getHours())}:${two(date.getMinutes())}`;

/**
 * When the event is, in one line. An all-day event is said as the days it
 * spans: its stored end is the exclusive midnight after the last of them, so
 * the last day shown is a millisecond before it.
 * @param {any} event
 */
export function dateSummary(event) {
  if (!event || !event.start) return "";
  const start = new Date(Number(event.start.ms || 0));
  const end = event.end
    ? new Date(Number(event.end.ms || event.start.ms || 0))
    : start;
  if (event.start.allDay) {
    const inclusiveEnd = new Date(
      Math.max(start.getTime(), end.getTime() - 1),
    );
    if (start.toDateString() === inclusiveEnd.toDateString())
      return `${longDay(start)} · All day`;
    return `${shortDay(start)} – ${shortDay(inclusiveEnd)} · All day`;
  }
  if (start.toDateString() === end.toDateString())
    return `${longDay(start)} · ${clock(start)}–${clock(end)}`;
  return `${longDay(start)} · ${clock(start)} – ${longDay(end)} · ${clock(end)}`;
}

/**
 * The page one event opens into.
 *
 * The button rule holds here: an operation that cannot really run is not drawn.
 * A read-only calendar draws neither Edit nor Delete, and whether this event
 * can be written at all is the controller's judgement — it is the same one that
 * decides whether a credential may be read for it.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderCalendarDetail(model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const detail = model.detail;
  const event = detail?.event || {};
  const source = detail?.source || null;
  // The page is about a calendar as much as about an event, so it is coloured
  // off the source the way `CalendarEventDetail.qml` is — and an event whose
  // calendar is not among the configured ones falls to the accent rather than
  // to a slot nobody chose.
  const own = source
    ? slotColor(model.palette, source.colorKey, cx)
    : roles.accent;
  const meetingLink = httpLink(event.meetLink);
  const locationLink = httpLink(event.location);
  const providerLink = httpLink(event.href);
  const canWrite = detail?.canWrite === true;
  const location = String(event.location || "");
  const description = String(event.description || "");

  return v_flex()
    .id("calendar-detail")
    .absolute()
    .inset_0()
    .bg(roles.background)
    .child(
      centeredWorkspace(
        "calendar-detail-page",
        pageColumn("calendar-detail-column", cx, {
          // The QML's `space(720)` is the column's own width, with the
          // flickable's `space(18)` margin outside it. `pageColumn` carries
          // that margin as padding and gpui counts padding inside a maximum
          // width, so the margin is added back to arrive at the same column.
          maxWidth: tokens.space(720) + tokens.spacing.panelPadding * 2,
        })
          .child(
            h_flex().child(
              // `BackBar.qml`: outlined, and quieter than the page it leaves.
              iconTextButton(
                "calendar-detail-back",
                "back",
                "Calendar",
                (_click, eventCx) => model.onCloseEvent?.(_click, eventCx),
                cx,
                { tooltip: "Calendar · Esc", color: roles.dim },
              ),
            ),
          )
          .child(div().flex_none().h(tokens.space(4)).rounded_full().bg(own))
          .child(
            div()
              .text_size(tokens.font.title)
              .text_color(roles.text)
              .font_bold()
              .child(String(event.summary || event.title || "Untitled event")),
          )
          .child(
            div()
              .text_size(tokens.font.body)
              .text_color(roles.text)
              .child(dateSummary(event)),
          )
          .child(
            h_flex()
              .items_center()
              .gap(tokens.space(8))
              .child(
                div()
                  .flex_none()
                  .size(tokens.space(10))
                  .rounded_full()
                  .bg(own),
              )
              .child(
                div()
                  .text_size(tokens.font.bodySmall)
                  .text_color(roles.dim)
                  .child(
                    source
                      ? String(source.name || source.id || "Calendar")
                      : "Calendar",
                  ),
              ),
          )
          .when(location !== "", (page) =>
            page.child(
              h_flex()
                .items_start()
                .gap(tokens.space(8))
                .child(
                  icon("pin", cx, { color: roles.dim }),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w_0()
                    .text_size(tokens.font.bodySmall)
                    .text_color(roles.text)
                    .child(location),
                ),
            ),
          )
          .when(
            canWrite ||
              meetingLink !== "" ||
              locationLink !== "" ||
              providerLink !== "",
            (page) =>
              page.child(
                h_flex()
                  .id("calendar-detail-actions")
                  .flex_wrap()
                  .gap(tokens.space(7))
                  .when(canWrite, (actions) =>
                    actions.child(
                      iconTextButton(
                        "calendar-detail-edit",
                        "compose",
                        "Edit...",
                        (_click, eventCx) => model.onEdit?.(_click, eventCx),
                        cx,
                      ),
                    ),
                  )
                  .when(canWrite, (actions) =>
                    actions.child(
                      iconTextButton(
                        "calendar-detail-delete",
                        "trash",
                        "Delete...",
                        (_click, eventCx) => model.onDelete?.(_click, eventCx),
                        cx,
                        { variant: "danger" },
                      ),
                    ),
                  )
                  .when(meetingLink !== "", (actions) =>
                    actions.child(
                      iconTextButton(
                        "calendar-detail-call",
                        "video",
                        "Join call",
                        (_click, eventCx) =>
                          model.onOpenUrl?.(meetingLink, eventCx),
                        cx,
                      ),
                    ),
                  )
                  .when(
                    locationLink !== "" && locationLink !== meetingLink,
                    (actions) =>
                      actions.child(
                        iconTextButton(
                          "calendar-detail-location",
                          "pin",
                          "Open location",
                          (_click, eventCx) =>
                            model.onOpenUrl?.(locationLink, eventCx),
                          cx,
                        ),
                      ),
                  )
                  .when(
                    providerLink !== "" &&
                      providerLink !== meetingLink &&
                      providerLink !== locationLink,
                    (actions) =>
                      actions.child(
                        iconTextButton(
                          "calendar-detail-provider",
                          "browser",
                          "Open in provider",
                          (_click, eventCx) =>
                            model.onOpenUrl?.(providerLink, eventCx),
                          cx,
                        ),
                      ),
                  ),
              ),
          )
          .when(description !== "", (page) => page.child(separator(cx)))
          .when(description !== "", (page) =>
            page.child(
              div()
                .text_size(tokens.font.body)
                .line_height(1.35)
                .text_color(roles.text)
                .child(description),
            ),
          ),
        cx,
      ),
    );
}
