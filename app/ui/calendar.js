// @ts-check
import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import {
  appShell,
  bottomBar,
  brandLockup,
  button,
  field,
  kbd,
  muted,
  sectionLabel,
  statusLine,
  title,
  topBar,
} from "../lib/omarchy-ui/index.js";
import { renderRail } from "./rail.js";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** @param {Array<any>} cells @param {any} model @param {import("gpui").Context} cx */
function calendarGrid(cells, model, cx) {
  const rows = [];
  for (let offset = 0; offset < cells.length; offset += 7) {
    rows.push(
      h_flex()
        .id(`calendar-row-${offset / 7}`)
        .flex_1()
        .min_h_0()
        .children(
          cells.slice(offset, offset + 7).map((cell, index) =>
            v_flex()
              .id(`calendar-day-${offset + index}`)
              .flex_1()
              .min_w_0()
              .min_h_0()
              .gap(cx.theme().spacing.xs)
              .p(cx.theme().spacing.sm)
              .border(1)
              .border_color(cx.theme().colors.border)
              .bg(
                cell.today
                  ? cx.theme().colors.accent
                  : cx.theme().colors.background,
              )
              .text_color(
                cell.today
                  ? cx.theme().colors.accent_foreground
                  : cell.outside
                    ? cx.theme().colors.muted_foreground
                    : cx.theme().colors.foreground,
              )
              .child(String(cell.label ?? ""))
              .children(
                (cell.events || []).map((/** @type {any} */ event) =>
                  button(
                    `calendar-event-${event.id}`,
                    event.title || event.summary || "Untitled event",
                    (_click, eventCx) => model.onEvent(event, eventCx),
                    cx,
                    { selected: event.id === model.selectedId },
                  ),
                ),
              ),
          ),
        ),
    );
  }
  return v_flex()
    .id("calendar-grid")
    .flex_1()
    .min_h_0()
    .child(
      h_flex()
        .id("calendar-weekdays")
        .children(
          weekdays.map((day) =>
            div()
              .flex_1()
              .px(cx.theme().spacing.sm)
              .py(cx.theme().spacing.xs)
              .child(muted(day, cx)),
          ),
        ),
    )
    .children(rows);
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderCalendar(model, cx) {
  const anchor = new Date(Number(model.anchorMs || Date.now()));
  const heading = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const cells =
    Array.isArray(model.grid) && model.grid.length
      ? model.grid
      : Array.from({ length: model.view === "week" ? 7 : 42 }, (_, index) => ({
          label: index + 1,
          events: [],
        }));
  const period = model.view === "week" ? "week" : "month";
  const status =
    model.writeStatus || model.readStatus || model.status || "Ready";
  const statusState =
    model.statusState || model.pending || status === "Loading…"
      ? model.statusState || "loading"
      : !status ||
          status === "Ready" ||
          status === "Saved" ||
          /^\d+ events?$/.test(status)
        ? "ready"
        : "error";
  const toolbar = h_flex()
    .items_center()
    .gap(cx.theme().spacing.sm)
    .child(
      button("calendar-week", "Week", model.onWeek, cx, {
        selected: model.view === "week",
      }),
    )
    .child(
      button("calendar-month", "Month", model.onMonth, cx, {
        selected: model.view === "month",
      }),
    )
    .child(
      button(
        "calendar-previous",
        "‹",
        model.onPrevious,
        cx,
      ).accessibility_label(`Previous ${period}`),
    )
    .child(
      button("calendar-next", "›", model.onNext, cx).accessibility_label(
        `Next ${period}`,
      ),
    );
  const content = v_flex()
    .id("calendar")
    .flex_1()
    .min_w_0()
    .min_h_0()
    .p(cx.theme().spacing.lg)
    .gap(cx.theme().spacing.md)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .child(
          h_flex()
            .items_center()
            .gap(cx.theme().spacing.md)
            .child(title(heading, cx))
            .child(button("calendar-today", "Go to today", model.onToday, cx)),
        )
        .child(toolbar),
    )
    .when(Array.isArray(model.sources) && model.sources.length > 0, (view) =>
      view.child(
        h_flex()
          .id("calendar-sources")
          .items_center()
          .gap(cx.theme().spacing.xs)
          .child(sectionLabel("Calendar", cx))
          .children(
            model.sources.map((/** @type {any} */ source) =>
              button(
                `calendar-source-${source.id}`,
                source.name || source.id,
                (_event, eventCx) => model.onSource(source.id, eventCx),
                cx,
                { selected: source.id === model.selectedSourceId },
              ),
            ),
          ),
      ),
    )
    .child(calendarGrid(cells, model, cx));
  if (!model.hasSource)
    content.child(
      muted("Add a calendar source in Settings before creating events.", cx),
    );
  if (model.editing)
    content.child(
      v_flex()
        .id("calendar-editor")
        .gap(cx.theme().spacing.sm)
        .p(cx.theme().spacing.md)
        .border(1)
        .border_color(cx.theme().colors.border)
        .child(sectionLabel(model.editing.id ? "Edit event" : "New event", cx))
        .child(
          field(model.editing.title, cx).accessibility_label("Event title"),
        )
        .child(field(model.editing.start, cx).accessibility_label("Start time"))
        .child(field(model.editing.end, cx).accessibility_label("End time"))
        .child(
          h_flex()
            .gap(cx.theme().spacing.sm)
            .child(
              button(
                "calendar-save",
                model.pending ? "Saving…" : "Save",
                model.onSave,
                cx,
                {
                  variant: "primary",
                  disabled: model.pending || !model.hasSource,
                },
              ),
            )
            .child(
              button("calendar-cancel", "Cancel", model.onCancel, cx, {
                disabled: model.pending,
              }),
            ),
        ),
    );
  return appShell(
    {
      top: topBar(
        {
          brand: brandLockup(cx),
          actions: h_flex()
            .gap(cx.theme().spacing.sm)
            .when(Boolean(model.selected) && !model.editing, (actions) =>
              actions.child(
                button("calendar-edit", "Edit event…", model.onEdit, cx, {
                  disabled: model.pending,
                }),
              ),
            )
            .child(
              button("calendar-new", "+ Create event…", model.onNew, cx, {
                disabled: !model.hasSource || model.pending,
              }),
            ),
        },
        cx,
      ),
      content: h_flex()
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
            .gap(cx.theme().spacing.sm)
            .child(kbd("c", cx))
            .child(muted("create", cx))
            .child(kbd("j/k", cx))
            .child(muted("select", cx))
            .child(kbd("o", cx))
            .child(muted("open", cx)),
        },
        cx,
      ),
    },
    cx,
  );
}
