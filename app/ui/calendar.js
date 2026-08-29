// @ts-check
import { div } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { button, field, muted, title } from "../lib/omarchy-ui/index.js";
/** @param {{title:string,status?:string,readStatus?:string,writeStatus?:string,view:"month"|"week",sourceLabel?:string,hasSource:boolean,sources:Array<{id:string,name?:string}>,selectedSourceId:string,pending:boolean,selected?:any,selectedId?:string|null,editing:null|{id:string,title:import("gpui-base").InputState,start:import("gpui-base").InputState,end:import("gpui-base").InputState},events:Array<{id:string,title?:string,summary?:string}>,onEvent:(event:any,cx:any)=>void,onNew:(event:any,cx:any)=>void,onEdit:(event:any,cx:any)=>void,onSave:(event:any,cx:any)=>void,onCancel:(event:any,cx:any)=>void,onPrevious:(event:any,cx:any)=>void,onNext:(event:any,cx:any)=>void,onToday:(event:any,cx:any)=>void,onMonth:(event:any,cx:any)=>void,onWeek:(event:any,cx:any)=>void,onSource:(sourceId:string,cx:any)=>void}} model @param {import("gpui").Context} cx */
export function renderCalendar(model, cx) {
  const view = v_flex()
    .id("calendar")
    .bg(cx.theme().colors.background)
    .gap(cx.theme().spacing.md)
    .p(cx.theme().spacing.lg)
    .child(title(model.title, cx))
    .child(
      h_flex()
        .gap(cx.theme().spacing.sm)
        .child(button("calendar-previous", "Previous", model.onPrevious, cx))
        .child(button("calendar-today", "Today", model.onToday, cx))
        .child(button("calendar-next", "Next", model.onNext, cx))
        .child(
          button("calendar-month", "Month", model.onMonth, cx, {
            selected: model.view === "month",
          }),
        )
        .child(
          button("calendar-week", "Week", model.onWeek, cx, {
            selected: model.view === "week",
          }),
        ),
    );
  view.child(muted("Calendar source", cx));
  view.child(
    h_flex()
      .gap(cx.theme().spacing.sm)
      .children(
        model.sources.map((source) =>
          button(
            `calendar-source-${source.id}`,
            source.name || source.id,
            (_event, eventCx) => model.onSource(source.id, eventCx),
            cx,
            { selected: source.id === model.selectedSourceId },
          ),
        ),
      ),
  );
  if (model.readStatus)
    view.child(
      div()
        .id("calendar-read-status")
        .role("label")
        .accessibility_label(model.readStatus)
        .text_sm()
        .text_color(cx.theme().colors.muted_foreground)
        .child(model.readStatus),
    );
  if (model.writeStatus)
    view.child(
      div()
        .id("calendar-write-status")
        .role("label")
        .accessibility_label(model.writeStatus)
        .text_sm()
        .text_color(cx.theme().colors.muted_foreground)
        .child(model.writeStatus),
    );
  if (!model.hasSource)
    view.child(
      muted("Add a calendar source in Settings before creating events.", cx),
    );
  view.children(
    model.events.map((event) =>
      button(
        `calendar-event-${event.id}`,
        event.title || event.summary || "Untitled event",
        (_click, eventCx) => model.onEvent(event, eventCx),
        cx,
        { selected: event.id === model.selectedId },
      ),
    ),
  );
  if (model.selectedId && !model.editing) {
    const selected = model.selected || {};
    view
      .child(
        v_flex()
          .id("calendar-event-detail")
          .gap(cx.theme().spacing.xs)
          .child(
            muted(selected.title || selected.summary || "Untitled event", cx),
          )
          .when(Boolean(selected.start?.ms ?? selected.startMs), (element) =>
            element.child(
              muted(
                `${new Date(selected.start?.ms ?? selected.startMs).toLocaleString()} – ${new Date(selected.end?.ms ?? selected.endMs).toLocaleString()}`,
                cx,
              ),
            ),
          ),
      )
      .child(button("calendar-edit", "Edit event…", model.onEdit, cx));
  }
  if (model.editing) {
    view
      .child(
        v_flex()
          .id("calendar-editor")
          .gap(cx.theme().spacing.sm)
          .child(muted("Title", cx))
          .child(
            field(model.editing.title, cx).accessibility_label("Event title"),
          )
          .child(muted("Start", cx))
          .child(
            field(model.editing.start, cx).accessibility_label("Start time"),
          )
          .child(muted("End", cx))
          .child(field(model.editing.end, cx).accessibility_label("End time"))
          .child(muted(`Calendar: ${model.sourceLabel || "Unavailable"}`, cx)),
      )
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
      );
  }
  return view.child(
    button("calendar-new", "New event…", model.onNew, cx, {
      disabled: !model.hasSource || model.pending,
    }),
  );
}
