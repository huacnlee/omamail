// @ts-check

import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { recurrenceIntervalUnit } from "../calendar/Calendar.js";
import {
  Button,
  CenteredWorkspace,
  PageColumn,
  PopupSurface,
  SectionLabel,
  TextField,
  roles,
  style,
} from "omarchy-ui";
import { iconTextButton } from "./controls.js";
import { calendarRoles, slotColor } from "./calendar-palette.js";

const FREQUENCIES = [
  { label: "Daily", value: "DAILY" },
  { label: "Weekly", value: "WEEKLY" },
  { label: "Monthly", value: "MONTHLY" },
  { label: "Yearly", value: "YEARLY" },
];

/**
 * The form's state, however the host spelled it.
 *
 * The composer needs nine text fields, and a text field is a live object the
 * host owns across renders rather than something this call can make. A host
 * that has only built the three the first draft of this view asked for still
 * gets a working form out of them, which is the whole reason the shape is
 * normalised here rather than assumed.
 * @param {any} model
 */
export function composerOf(model) {
  const composer = model.composer;
  if (composer) {
    if (composer.open === false) return null;
    return {
      editing: composer.editing === true,
      allDay: composer.allDay === true,
      busy: composer.busy === true,
      result: String(composer.result || ""),
      recurring: composer.recurring === true,
      frequency: String(composer.frequency || "WEEKLY"),
      selectedSourceId: String(composer.selectedSourceId || ""),
      sourceGroups: Array.isArray(composer.sourceGroups)
        ? composer.sourceGroups
        : [],
      fields: composer.fields || {},
    };
  }
  if (!model.editing) return null;
  return {
    editing: Boolean(model.editing.id),
    allDay: false,
    busy: model.pending === true,
    result: String(model.writeStatus || ""),
    recurring: false,
    frequency: "WEEKLY",
    selectedSourceId: String(model.selectedSourceId || ""),
    sourceGroups: [],
    fields: {
      title: model.editing.title,
      start: model.editing.start,
      end: model.editing.end,
    },
  };
}

/** @param {any} state */
const textOf = (state) =>
  state && typeof state.value === "function" ? String(state.value()) : "";

/**
 * The form a new event is written in, and the one an existing one is changed
 * in.
 *
 * The calendar picker and the recurrence section stand down while an event is
 * being edited: the event stays on the calendar that owns it, and the rule is
 * the server's to keep — a form that re-serialised it from these fields would
 * drop the exceptions it holds no model of.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderCalendarComposer(model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const composer = composerOf(model);
  if (!composer) return null;
  const fields = composer.fields;
  const heading = composer.allDay
    ? "Edit event · All day"
    : composer.editing
      ? "Edit event"
      : "Create event";
  const interval = textOf(fields.interval) || "1";

  const form = new PageColumn("calendar-composer-column")
    .maxWidth(tokens.space(620) + tokens.spacing.panelPadding * 2)
    .build(cx)
    .gap(tokens.space(10))
    .child(
      h_flex().child(
        iconTextButton("calendar-composer-back", "back", "Calendar")
          .tooltip("Calendar · Esc")
          .tone(roles.dim)
          .onClick((_click, eventCx) => model.onCancel?.(_click, eventCx))
          .build(cx),
      ),
    )
    .child(
      div()
        .text_size(tokens.font.heading)
        .text_color(roles.text)
        .font_bold()
        .child(heading),
    );

  // Which calendar a new event goes on is a question only creation asks, and
  // the answer is grouped by the account that serves it: one address can hold
  // several calendars and several accounts can hold one name.
  if (!composer.editing && composer.sourceGroups.length > 0) {
    form.child(new SectionLabel("CALENDAR").strong(false).build(cx));
    for (const [index, group] of composer.sourceGroups.entries()) {
      form.child(
        v_flex()
          .id(`calendar-composer-group-${index}`)
          .gap(tokens.space(4))
          .child(
            div()
              .text_size(tokens.font.caption)
              .text_color(roles.dim)
              .truncate()
              .child(
                `${String(group.providerLabel || "")} · ${String(group.accountLabel || "")}`,
              ),
          )
          .child(
            h_flex()
              .flex_wrap()
              .gap(tokens.space(5))
              .children(
                (Array.isArray(group.calendars) ? group.calendars : []).map(
                  (/** @type {any} */ calendar) =>
                    // Outlined in its own slot, so the picker says which colour
                    // the event will be drawn in before it exists.
                    iconTextButton(
                      `calendar-composer-source-${calendar.id}`,
                      "",
                      String(calendar.name || calendar.id || "Calendar"),
                    )
                      .selected(
                        composer.selectedSourceId === String(calendar.id),
                      )
                      .onClick((_click, eventCx) =>
                        model.onSource?.(String(calendar.id), eventCx),
                      )
                      .build(cx)
                      .border_color(
                        slotColor(model.palette, calendar.colorKey, cx),
                      ),
                ),
              ),
          ),
      );
    }
  }

  if (fields.title)
    form.child(
      new TextField()
        .state(fields.title)
        .build(cx)
        .accessibility_label("Event title"),
    );

  // An all-day event is edited as the days it spans; the time fields stand
  // down, because writing them back would turn it into a timed one.
  const dates = h_flex().id("calendar-composer-when").gap(tokens.space(8));
  if (fields.date)
    dates.child(
      new TextField()
        .state(fields.date)
        .build(cx)
        .flex_grow(2)
        .flex_basis(0)
        .min_w_0()
        .accessibility_label(composer.allDay ? "First day" : "Date"),
    );
  if (composer.allDay && fields.endDate)
    dates.child(
      new TextField()
        .state(fields.endDate)
        .build(cx)
        .flex_grow(2)
        .flex_basis(0)
        .min_w_0()
        .accessibility_label("Last day"),
    );
  if (!composer.allDay && fields.start)
    dates.child(
      new TextField()
        .state(fields.start)
        .build(cx)
        .flex_grow(1)
        .flex_basis(0)
        .min_w_0()
        .accessibility_label("Start time"),
    );
  if (!composer.allDay && fields.end)
    dates.child(
      new TextField()
        .state(fields.end)
        .build(cx)
        .flex_grow(1)
        .flex_basis(0)
        .min_w_0()
        .accessibility_label("End time"),
    );
  form.child(dates);

  if (fields.location)
    form.child(
      new TextField()
        .state(fields.location)
        .build(cx)
        .accessibility_label("Location or meeting link"),
    );
  if (fields.notes)
    form.child(
      new TextField()
        .state(fields.notes)
        .build(cx)
        .accessibility_label("Notes"),
    );

  if (!composer.editing) {
    form.child(
      iconTextButton(
        "calendar-composer-recurring",
        composer.recurring ? "check" : "",
        "Make recurring",
      )
        .selected(composer.recurring)
        .onClick((_click, eventCx) =>
          model.onToggleRecurring?.(_click, eventCx),
        )
        .build(cx)
        .text_color(composer.recurring ? roles.text : roles.dim),
    );
    if (composer.recurring)
      form.child(
        v_flex()
          .id("calendar-composer-recurrence")
          .gap(tokens.space(8))
          .child(new SectionLabel("REPEATS").strong(false).build(cx))
          .child(
            h_flex()
              .flex_wrap()
              .gap(tokens.space(5))
              .children(
                FREQUENCIES.map((entry) =>
                  iconTextButton(
                    `calendar-composer-frequency-${entry.value}`,
                    "",
                    entry.label,
                  )
                    .selected(composer.frequency === entry.value)
                    .onClick((_click, eventCx) =>
                      model.onFrequency?.(entry.value, eventCx),
                    )
                    .build(cx)
                    .text_color(
                      composer.frequency === entry.value
                        ? roles.text
                        : roles.dim,
                    ),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(tokens.space(8))
              .child(
                v_flex()
                  .flex_1()
                  .min_w_0()
                  .gap(tokens.space(4))
                  .child(
                    div()
                      .text_size(tokens.font.caption)
                      .text_color(roles.dim)
                      .child("Repeat every"),
                  )
                  .child(
                    h_flex()
                      .items_center()
                      .gap(tokens.space(8))
                      .when(Boolean(fields.interval), (row) =>
                        row.child(
                          new TextField()
                            .state(fields.interval)
                            .build(cx)
                            .max_w(tokens.space(96))
                            .accessibility_label("Repeat interval"),
                        ),
                      )
                      .child(
                        div()
                          .flex_none()
                          .text_size(tokens.font.body)
                          .text_color(roles.text)
                          .child(
                            recurrenceIntervalUnit(
                              composer.frequency,
                              interval,
                            ),
                          ),
                      ),
                  ),
              )
              .child(
                v_flex()
                  .flex_1()
                  .min_w_0()
                  .gap(tokens.space(4))
                  .child(
                    div()
                      .text_size(tokens.font.caption)
                      .text_color(roles.dim)
                      .child("End after (optional)"),
                  )
                  .when(Boolean(fields.count), (column) =>
                    column.child(
                      new TextField()
                        .state(fields.count)
                        .build(cx)
                        .accessibility_label("Occurrences"),
                    ),
                  ),
              ),
          ),
      );
  }

  form.child(
    h_flex()
      .id("calendar-composer-actions")
      .gap(tokens.space(6))
      .child(
        iconTextButton(
          "calendar-save",
          composer.editing ? "check" : "plus",
          composer.editing
            ? composer.busy
              ? "Saving"
              : "Save changes"
            : composer.busy
              ? "Creating"
              : "Create event",
        )
          .disabled(composer.busy)
          .onClick((_click, eventCx) => model.onSave?.(_click, eventCx))
          .build(cx),
      )
      .child(
        // Borderless and dim beside the write it stands next to, and the same
        // height as it: both are `IconTextButton`s in the QML, so a row of them
        // shares one baseline.
        new Button("calendar-cancel")
          .label("Cancel")
          .tone(roles.dim)
          .size("small")
          .onClick((_click, eventCx) => model.onCancel?.(_click, eventCx))
          .build(cx)
          .h(tokens.spacing.controlHeight),
      ),
  );

  if (composer.result !== "")
    form.child(
      div()
        .id("calendar-composer-result")
        .text_size(tokens.font.caption)
        .text_color(roles.accent)
        .child(composer.result),
    );

  return v_flex()
    .id("calendar-composer")
    .absolute()
    .inset_0()
    .bg(roles.background)
    .child(
      new CenteredWorkspace("calendar-composer-page").content(form).build(cx),
    );
}

/**
 * The one confirmation for destructive writes. A calendar event is gone for
 * good once the server says so, so it asks first, and it asks naming the
 * target: only the answer here reaches the controller.
 * @param {any} model @param {import("gpui").Context} cx
 */
export function renderDeleteConfirmation(model, cx) {
  const tokens = style();
  const roles = calendarRoles(cx);
  const request = model.confirm;
  if (!request) return null;
  return (
    h_flex()
      .id("calendar-confirm")
      .absolute()
      .inset_0()
      .items_center()
      .justify_center()
      // `min(space(360), parent.width - space(32))`, said as the room left
      // around the card rather than as a width subtracted from the window.
      .p(tokens.space(16))
      // The dim behind a modal is the window's own ground turned up, so the
      // dialog sits on the desktop's colours rather than on a grey nobody chose.
      .bg(cx.theme().colors.background)
      .child(
        new PopupSurface("calendar-confirm-card")
          .build(cx)
          .w_full()
          .max_w(tokens.space(360))
          .gap(tokens.space(14))
          .p(tokens.space(18))
          .child(
            div()
              .text_size(tokens.font.heading)
              .text_color(roles.text)
              .font_bold()
              .child(`Delete "${String(request.name || "")}"?`),
          )
          .child(
            div()
              .text_size(tokens.font.bodySmall)
              .text_color(roles.dim)
              .child(String(request.message || "")),
          )
          .child(
            h_flex()
              .justify_end()
              .gap(tokens.space(8))
              .child(
                new Button("calendar-confirm-cancel")
                  .label("Cancel")
                  .onClick((_click, eventCx) =>
                    model.onCancelDelete?.(_click, eventCx),
                  )
                  .build(cx),
              )
              .child(
                new Button("calendar-confirm-delete")
                  .label("Delete")
                  .danger()
                  .onClick((_click, eventCx) =>
                    model.onConfirmDelete?.(_click, eventCx),
                  )
                  .build(cx),
              ),
          ),
      )
  );
}
