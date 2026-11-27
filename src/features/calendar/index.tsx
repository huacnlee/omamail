// Feature entry: the shell imports only what this file exports.
//
// `CalendarView` is the calendar page (CalendarView.qml): the toolbar, the
// error and reminder notices, one of the four views, and an event's detail
// beside it. `CalendarService` runs reminders, the editor and the delete
// confirmation without the page (mount it once app-wide, so a reminder or
// an invitation in mail works while mail is showing); the page mounts one
// itself, and nested runs share the same timers.
import { Clipboard, View, cleanup, createMotion, openUrl, signal, type JSX } from "nsh";
import { app } from "../../app/store";
import * as Keys from "../../keys/keymap";
import { externallyOpenableHttpUrl } from "../../mail/message/html";
import { Button, Dialog, EmptyPane, Notice, ToolButton, enterFade, cx, uiScale, scaled } from "../../ui";
import { AgendaView } from "./AgendaView";
import { EventComposerSurface } from "./EventComposer";
import { EventDetail } from "./EventDetail";
import { MonthView } from "./MonthView";
import { ReminderPanel } from "./ReminderPanel";
import { TimeGrid } from "./TimeGrid";
import { CalendarErrors, CalendarToolbar } from "./Toolbar";
import { controller, deletion, registerCalendarKeys, startCalendar, view } from "./service";

export { EventComposerSurface } from "./EventComposer";
/** Settings → Calendars; takes no props. */
export { CalendarSettings, type CalendarSettingsProps } from "./CalendarSettings";
/** Fixtures and previews only: calendars.json kept in memory. */
export { useMemoryCalendarConfig } from "./controller";
/** The Qt plugin's calendar settings, imported once by the settings store. */
export { importCalendarSettings } from "./settings";
/** The editor's state, for mail to open it filled from an invitation or a
 * suggestion (`calendarComposer.beginWith({...})`); nothing is saved until
 * the owner presses Save. */
export { composer as calendarComposer } from "./service";

// Mounted twice (app-wide and in the page), only the first draws the sheet
// and the dialog, so one editor answers the keys.
const surfaceOwners = signal<number[]>([]);
let nextOwner = 0;

export function CalendarService() {
  startCalendar();
  const id = ++nextOwner;
  surfaceOwners.update((owners) => [...owners, id]);
  cleanup(() => surfaceOwners.update((owners) => owners.filter((owner) => owner !== id)));
  return (
    <If when={surfaceOwners()[0] === id}>
      <EventComposerSurface />
      <DeleteEventDialog />
    </If>
  );
}

export function CalendarView() {
  startCalendar();
  registerCalendarKeys();
  return (
    <View testID="calendar-view" class="flex-1 bg-background">
      <CalendarToolbar />
      <CalendarErrors
        onCopy={(text) => { Clipboard.writeText(text).catch(() => undefined); }}
        onOpen={(url) => {
          const link = externallyOpenableHttpUrl(url);
          if (link) openUrl(link).catch(() => controller.reportError("Could not open the link"));
        }}
      />
      <If when={!view.detailOpen()}>
        <View class="px-3 pt-2">
          <ReminderPanel />
        </View>
      </If>
      <UndoNotice />
      <View class="flex-1 flex-row">
        <If when={controller.sourcesLoaded() && controller.noCalendars()} else={<CalendarBody />}>
          <EmptyPane
            testID="calendar-empty"
            icon="calendar"
            title="No calendars"
            description="Sign in to a Google or Microsoft account, or add a CalDAV calendar, to see events here."
            actions={<Button label="Calendar settings..." onPress={() => app.openPage("settings")} />}
          />
        </If>
      </View>
      <CalendarService />
    </View>
  );
}

function CalendarBody() {
  return (
    <>
      <View class={cx("flex-1", view.detailOpen() ? "hidden sm:flex" : "")}>
        <If when={view.viewMode() === "month"}><Fade><MonthView /></Fade></If>
        <If when={view.viewMode() === "week" || view.viewMode() === "day"}><Fade><TimeGrid /></Fade></If>
        <If when={view.viewMode() === "agenda"}><Fade><AgendaView /></Fade></If>
      </View>
      <If when={view.detailOpen()}>
        <View class={cx("w-full", uiScale() === 1 ? "sm:w-[380px]" : "sm:w-[" + scaled(380) + "px]")}>
          <EventDetail />
        </View>
      </If>
    </>
  );
}

/** A view arriving as the mode changes: a fade only, the frame stays put. */
function Fade(props: { children?: JSX.Element }) {
  const motion = createMotion({ enter: enterFade() });
  return <View style={motion.style} class="flex-1">{props.children}</View>;
}

/** The last move can be taken back with u for as long as nothing else was written. */
function UndoNotice() {
  return (
    <If when={controller.undoChange()}>
      <View class="px-3 pt-2">
        <Notice
          testID="calendar-undo"
          icon="undo"
          text={"Changed “" + String(controller.undoChange()?.title || "Untitled event") + "”."}
          action={{
            label: "Undo (" + Keys.displayFor(Keys.byId("calendarUndo")) + ")",
            busy: controller.eventWriting(),
            busyLabel: "Undoing",
            onPress: () => controller.undoLastChange(),
          }}
        />
      </View>
    </If>
  );
}

/** Deleting asks first; a recurring or shared event asks how. */
export function DeleteEventDialog() {
  const request = () => deletion.request();
  return (
    <Dialog
      title={"Delete “" + String(request()?.name || "Untitled event") + "”?"}
      description={String(request()?.message || "")}
      open={!!request()}
      onOpenChange={(e) => { if (!e.open) deletion.cancel(); }}
      footer={
        <View class="flex-row flex-wrap justify-end gap-1.5">
          <ToolButton label="Cancel" onPress={() => deletion.cancel()} />
          <Each of={(request()?.choices || []) as Array<{ value: string; label: string }>} key={(choice) => choice.value}>
            {(choice) => (
              <ToolButton testID={"event-delete-" + choice().value} label={choice().label} variant="danger"
                onPress={() => deletion.confirm(choice().value)} />
            )}
          </Each>
        </View>
      }
    />
  );
}
