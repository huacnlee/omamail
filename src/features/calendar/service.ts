// The calendar's one instance: its controller, the view's state, the event
// editor, desktop reminders and the delete confirmation, made once and shared
// by every calendar surface (the view, the editor over the mail, reminders
// that run with the window). `startCalendar()` runs the timers and listeners
// for as long as the component that calls it is mounted; nested callers
// share one run.
import { cleanup, effect, signal, untracked } from "nsh";
import { app } from "../../app/store";
import { registerCommand, registerEscape, reportKeyState } from "../../keys/commands";
import * as Calendar from "../../mail/calendar/calendar";
import { createComposer } from "./composer";
import { createCalendarController, type CalendarEvent, type EventDeleteRequest } from "./controller";
import { createReminders } from "./reminders";
import { loadSettings } from "./settings";
import { createCalendarView } from "./view";


export const controller = createCalendarController();
export const composer = createComposer(controller);
export const view = createCalendarView(controller, {
  createAt: (startMs) => composer.beginAt(startMs),
  compose: (request) => composer.beginWith(request),
});
export const reminders = createReminders(controller, (request) => {
  // A reminder names the event: the calendar opens on it, in its mailbox.
  if (request.accountId && app.accounts().some((account) => account.id === request.accountId)) {
    app.openAccount(request.accountId);
  }
  app.openPage("calendar");
  view.showEvent(request.eventId, request.eventStart);
});

/** The delete confirmation: the request as Calendar.deleteRequest names it. */
const deleteRequestSignal = signal<EventDeleteRequest | null>(null);
export const deletion = {
  request: () => deleteRequestSignal(),
  ask(sourceId: string, event: CalendarEvent) {
    if (event) deleteRequestSignal.set(controller.deleteRequest(sourceId, event));
  },
  cancel: () => deleteRequestSignal.set(null),
  confirm(choice: string) {
    const request = untracked(deleteRequestSignal);
    deleteRequestSignal.set(null);
    if (!request || request.kind !== "event" || !request.event) return;
    controller.confirmDelete({ ...request, choice });
    view.closeDetail();
  },
};

let runs = 0;
let stopRun: (() => void) | null = null;

function run(): () => void {
  loadSettings();
  controller.start();
  const stops: Array<() => void> = [];
  stops.push(controller.runClock());
  stops.push(view.bind());
  stops.push(composer.bind());
  stops.push(reminders.start());
  // The reminders follow the view's calendar list as it is saved or reloaded.
  let firstList = true;
  effect(() => {
    controller.sourceList();
    if (firstList) { firstList = false; return; }
    untracked(() => reminders.followSources());
  });
  // Back left the editor: close it without asking the stack again.
  effect(() => {
    const top = app.navOverlay()?.kind;
    if (top !== "eventComposer" && untracked(composer.opened)) untracked(() => composer.close(true));
  });
  // A minute's tick refreshes the range on screen while the calendar shows.
  const tick = setInterval(() => {
    if (app.calendarVisible() && untracked(controller.sourcesLoaded) && !untracked(controller.loading)) view.refresh();
  }, 60000);
  stops.push(() => clearInterval(tick));
  return () => { for (const stop of stops) stop(); };
}

/** Runs the calendar while the calling component is mounted. */
export function startCalendar(): void {
  runs++;
  if (runs === 1) stopRun = run();
  cleanup(() => {
    runs--;
    if (runs === 0 && stopRun) { stopRun(); stopRun = null; }
  });
}

/** The keyboard: the calendar's binding ids while its surfaces are mounted
 * (docs/KEYS.md, calendar and eventCompose contexts). */
export function registerCalendarKeys(): void {
  registerCommand("createEvent", () => composer.begin());
  registerCommand("calendarNext", () => view.moveSelection(1));
  registerCommand("calendarPrevious", () => view.moveSelection(-1));
  registerCommand("openCalendarEvent", () => view.activateSelection());
  registerCommand("calendarPreviousPeriod", () => view.movePeriod(-1));
  registerCommand("calendarNextPeriod", () => view.movePeriod(1));
  registerCommand("calendarToday", () => view.goToday());
  registerCommand("calendarZoomIn", () => view.zoomHours(1));
  registerCommand("calendarZoomOut", () => view.zoomHours(-1));
  registerCommand("calendarZoomReset", () => view.zoomHours(0));
  registerCommand("calendarWeek", () => view.setView("week"));
  registerCommand("calendarDay", () => view.setView("day"));
  registerCommand("calendarAgenda", () => view.setView("agenda"));
  registerCommand("calendarMonth", () => view.setView("month"));
  registerCommand("calendarUndo", () => controller.undoLastChange());
  registerCommand("leave:calendarDetail", () => view.closeDetail());
  // Escape cancels a held month drag before it leaves anything.
  registerEscape(() => view.cancelMonthDrag());
  reportKeyState(() => ({ calendarAvailable: !controller.noCalendars() }));
}

/** The editor's keys while it is open. */
export function registerComposerKeys(): void {
  registerCommand("saveEvent", () => composer.submit("all"));
  registerCommand("guestNext", () => composer.moveGuestSuggestion(1));
  registerCommand("guestPrevious", () => composer.moveGuestSuggestion(-1));
  registerCommand("guestChoose", () => composer.chooseGuestSuggestion());
  registerCommand("leave:eventComposer", () => composer.close());
  registerEscape(() => {
    if (!composer.guestSuggestionsOpen()) return false;
    composer.dismissGuestSuggestions();
    return true;
  });
  reportKeyState(() => ({
    eventComposing: composer.opened(),
    guestSuggestions: composer.guestSuggestionsOpen(),
    eventDescriptionFocused: composer.descriptionFocused(),
  }));
}

/** An event's key, as the views compare them. */
export function eventKey(event: CalendarEvent | null | undefined): string {
  return event ? String(Calendar.eventKey(event)) : "";
}

