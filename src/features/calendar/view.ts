// What the calendar shows and where: the period on screen, the view, the
// selected event, the open event's detail and a month drag. A port of the
// logic in omarchy/ui/components/CalendarView.qml; the components draw it.
//
// The open detail is a place on the history stack (`calendarDetail`), so
// Back closes it before it leaves the calendar: opening pushes the entry,
// and the stack losing it closes the detail.
import { batch, computed, effect, signal, untracked } from "nsh";
import { app } from "../../app/store";
import * as Calendar from "../../mail/calendar/calendar";
import type { CalendarDay } from "../../mail/calendar/types";
import { parseObject, type CalendarController, type CalendarEvent } from "./controller";


export type ViewMode = "day" | "week" | "month" | "agenda";
export const VIEW_MODES: readonly ViewMode[] = ["day", "week", "month", "agenda"];
/** Weeks start on Monday, as the Qt client's views did. */
export const WEEK_START = 1;

export interface MonthDrag {
  event: CalendarEvent;
  initial: { x: number; y: number };
  from: number;
  active: boolean;
  range: { start: number; end: number } | null;
}

/** What the composer is asked to open with (CalendarController.composeRequested). */
export interface ComposeRequest {
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  editingEvent?: CalendarEvent;
  sourceId?: string;
  [field: string]: unknown;
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function createCalendarView(controller: CalendarController, hooks: {
  /** Opens the composer at a time (a tap on an empty slot or day). */
  createAt: (startMs: number) => void;
  /** Opens the composer with a prefill (a dragged range, guests to confirm). */
  compose: (request: ComposeRequest) => void;
}) {
  const now = new Date();
  const viewMode = signal<ViewMode>("month");
  const visibleMonth = signal(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  const visibleWeek = signal(now.getTime());
  const selectedEventId = signal("");
  const monthDrag = signal<MonthDrag | null>(null);
  const pendingMonthMove = signal<MonthDrag | null>(null);
  const monthMoveSaved = signal(false);
  const detailEvent = signal<CalendarEvent | null>(null);
  const detailLoading = signal(false);
  const detailError = signal("");
  let detailReadSerial = 0;
  let requestedEventStart = 0;
  let waitingForEvent = false;
  /** The week view's zoom, registered while it is on screen. */
  let weekZoom: ((direction: number) => void) | null = null;

  const days = computed(() => {
    const month = new Date(visibleMonth());
    return Calendar.monthGridDays(month.getFullYear(), month.getMonth(), WEEK_START);
  });
  const weekDays = computed(() => Calendar.weekDays(visibleWeek(), WEEK_START));
  const displayDays = computed(() => viewMode() === "day"
    ? weekDays().filter((day) => day.isoDate === Calendar.isoDate(new Date(visibleWeek())))
    : weekDays());
  const todayIso = computed(() => Calendar.isoDate(new Date(controller.nowMs())) as string);
  const detailOpen = computed(() => detailEvent() !== null);
  const monthSpans = computed(() => Calendar.monthSpanLayout(controller.events(), days()));
  const monthMove = computed(() => pendingMonthMove() || (monthDrag()?.active ? monthDrag() : null));
  const monthMoveEvent = computed<CalendarEvent | null>(() => {
    const move = monthMove();
    if (!move || !move.range) return null;
    return { ...move.event, start: { ...move.event.start, ms: move.range.start }, end: { ...move.event.end, ms: move.range.end } };
  });

  function rangeDays(): CalendarDay[] {
    const mode = untracked(viewMode);
    return mode === "day" || mode === "week" ? untracked(displayDays) : untracked(days);
  }

  function visibleEventsFor(mode: ViewMode, range: CalendarDay[], events: CalendarEvent[], nowMs: number): CalendarEvent[] {
    let values = Array.isArray(events) ? events : [];
    if (mode === "agenda") values = Calendar.agendaEvents(values, nowMs);
    if (range.length === 0) return [];
    const start = range[0].startMs, end = range[range.length - 1].endMs;
    return values.filter((event) => {
      if (!event || !event.start) return false;
      const eventEnd = event.end ? Number(event.end.ms) : Number(event.start.ms) + 1;
      return Number(event.start.ms) < end && eventEnd > start;
    }).sort(Calendar.compareEvents);
  }

  function visibleEvents(): CalendarEvent[] {
    return visibleEventsFor(untracked(viewMode), rangeDays(), untracked(controller.events), untracked(controller.nowMs));
  }

  /** The agenda's rows: they change only when the list does, so the clock
   * ticking leaves the scroll where it was. */
  const agendaEvents = computed<CalendarEvent[]>((previous) => {
    const next = viewMode() === "agenda"
      ? visibleEventsFor("agenda", days(), controller.events(), controller.nowMs()) : [];
    return previous && Calendar.sameEvents(previous, next) ? previous : next;
  });

  function refresh() {
    const range = rangeDays();
    if (range.length === 0) return;
    controller.refresh(range[0].startMs, range[range.length - 1].endMs);
  }

  function cancelMonthDrag(): boolean {
    const active = untracked(monthDrag) !== null;
    monthDrag.set(null);
    return active;
  }

  function monthMoveRefusal(event: CalendarEvent): string {
    if (untracked(pendingMonthMove) || untracked(controller.eventWriting) || untracked(controller.creatingEvent))
      return "Another event change is still in progress";
    return controller.rescheduleRefusal(event);
  }

  function settleMonthMove() {
    if (untracked(monthMoveSaved) && !untracked(controller.loading) && !untracked(controller.pendingRangeStart)) {
      batch(() => { pendingMonthMove.set(null); monthMoveSaved.set(false); });
    }
  }

  function moveSelection(offset: number) {
    const values = visibleEvents();
    if (values.length === 0) { selectedEventId.set(""); return; }
    let index = values.findIndex((event) => Calendar.eventKey(event) === untracked(selectedEventId));
    if (index < 0) index = offset < 0 ? values.length : -1;
    index = Math.max(0, Math.min(values.length - 1, index + offset));
    selectedEventId.set(Calendar.eventKey(values[index]));
  }

  /** Opens an event's detail. A Google event is read again, for the fields
   * the range listing leaves out (guests, conference, reminders). */
  function activateEvent(event: CalendarEvent | null, alreadyDetailed = false) {
    if (!event) return;
    const value = { ...event };
    const serial = ++detailReadSerial;
    batch(() => {
      selectedEventId.set(Calendar.eventKey(value));
      detailEvent.set(value);
      detailLoading.set(false);
      detailError.set("");
    });
    if (app.navPage().kind !== "calendarDetail") app.push("calendarDetail");
    const source = controller.findSource(String(value.sourceId || ""));
    if (alreadyDetailed || !source || source.kind !== "google") return;
    detailLoading.set(true);
    controller.nativeRequest(source, "get", { eventId: value.googleId }, (result, error) => {
      const current = untracked(detailEvent);
      if (serial !== detailReadSerial || !current || Calendar.eventKey(current) !== Calendar.eventKey(value)) return;
      detailLoading.set(false);
      if (error) { detailError.set(error); return; }
      const resource = parseObject(result?.body);
      if (!resource) { detailError.set("Could not read the event details"); return; }
      const values = Calendar.eventsFromGoogle({ items: [resource] }, source.id);
      if (values.length === 1 && Calendar.eventKey(values[0]) === Calendar.eventKey(value)) detailEvent.set(values[0]);
      else detailError.set("This event is no longer available");
    });
  }

  /** Closes the detail; `fromNav` when the stack already lost its entry. */
  function closeDetail(fromNav = false) {
    detailReadSerial++;
    waitingForEvent = false;
    batch(() => {
      detailLoading.set(false);
      detailError.set("");
      detailEvent.set(null);
    });
    if (!fromNav && app.navPage().kind === "calendarDetail") app.back();
  }

  /** A drag's drop: written at once, or through the composer when guests
   * must be asked whether to send them an update. */
  function reschedule(event: CalendarEvent, startMs: number, endMs: number): boolean {
    if (!event || !event.start || !event.end) return false;
    const refusal = controller.rescheduleRefusal(event);
    if (refusal !== "") { controller.reportError(refusal); return false; }
    if ((event.attendees || []).some((attendee) => attendee.self !== true)) {
      hooks.compose({ editingEvent: event, startMs, endMs });
      return false;
    }
    return controller.updateEvent(String(event.sourceId || ""), event, Calendar.rescheduleFields(event, startMs, endMs));
  }

  function activateSelection() {
    const values = visibleEvents();
    const found = values.find((event) => Calendar.eventKey(event) === untracked(selectedEventId));
    if (found) activateEvent(found);
    else moveSelection(1);
  }

  function moveMonth(offset: number) {
    const month = new Date(untracked(visibleMonth));
    const nextMonth = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    const week = new Date(untracked(visibleWeek));
    const lastDay = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
    batch(() => {
      visibleMonth.set(nextMonth.getTime());
      visibleWeek.set(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), Math.min(week.getDate(), lastDay)).getTime());
    });
    refresh();
  }

  function goToday() {
    const today = new Date();
    batch(() => {
      visibleMonth.set(new Date(today.getFullYear(), today.getMonth(), 1).getTime());
      visibleWeek.set(today.getTime());
    });
    refresh();
  }

  function movePeriod(offset: number) {
    const mode = untracked(viewMode);
    if (mode === "day" || mode === "week") {
      const week = new Date(untracked(visibleWeek));
      const next = new Date(week.getFullYear(), week.getMonth(), week.getDate() + offset * (mode === "day" ? 1 : 7));
      batch(() => {
        visibleWeek.set(next.getTime());
        visibleMonth.set(startOfMonth(next.getTime()));
      });
      refresh();
    } else moveMonth(offset);
  }

  /** Shows the day `dateMs` falls on (the date picker). */
  function showDate(dateMs: number) {
    batch(() => {
      visibleWeek.set(dateMs);
      visibleMonth.set(startOfMonth(dateMs));
    });
    refresh();
  }

  function setView(mode: string) {
    const next = (VIEW_MODES as readonly string[]).indexOf(mode) >= 0 ? (mode as ViewMode) : "month";
    batch(() => {
      viewMode.set(next);
      monthDrag.set(null);
    });
    refresh();
  }

  function resolveRequestedEvent() {
    if (!waitingForEvent) return;
    const wanted = untracked(selectedEventId);
    const found = untracked(controller.events).filter((event) => Calendar.eventKey(event) === wanted
      || (String(event.uid || "") === wanted && event.start
        && (!requestedEventStart || Number(event.start.ms) === requestedEventStart)));
    if (found.length === 1) { waitingForEvent = false; activateEvent(found[0]); }
  }

  /** Opens an event named by a reminder or an invitation: by its key
   * (`sourceId\neventId`) or its UID, around `startMs`. */
  function showEvent(eventId: string, startMs: number) {
    const wanted = String(eventId || "");
    requestedEventStart = Number(startMs) || 0;
    waitingForEvent = wanted !== "";
    batch(() => {
      selectedEventId.set(wanted);
      viewMode.set("month");
      if (Number(startMs) > 0) {
        visibleMonth.set(startOfMonth(Number(startMs)));
        visibleWeek.set(Number(startMs));
      }
    });
    refresh();
    resolveRequestedEvent();
    if (!waitingForEvent) return;
    const separator = wanted.indexOf("\n");
    const source = separator >= 0 ? controller.findSource(wanted.substring(0, separator)) : null;
    if (!source || source.kind !== "google") return;
    controller.nativeRequest(source, "get", { eventId: wanted.substring(separator + 1) }, (result, error) => {
      if (!waitingForEvent || untracked(selectedEventId) !== wanted || error) return;
      const resource = parseObject(result?.body);
      if (!resource) return;
      const events = Calendar.eventsFromGoogle({ items: [resource] }, source.id);
      if (events.length === 1) { waitingForEvent = false; activateEvent(events[0], true); }
    });
  }

  // ------------------------------------------------------- month drag

  function beginMonthDrag(event: CalendarEvent, point: { x: number; y: number }, from: number) {
    monthDrag.set({ event: { ...event }, initial: point, from, active: false, range: null });
  }

  /** `to` is the day index under the pointer, -1 outside the grid. */
  function updateMonthDrag(point: { x: number; y: number }, to: number) {
    const drag = untracked(monthDrag);
    if (!drag) return;
    if (!drag.active && Math.abs(point.x - drag.initial.x) + Math.abs(point.y - drag.initial.y) < 6) return;
    const range = to < 0 || monthMoveRefusal(drag.event) !== "" ? null : Calendar.gestureRange(drag.event, to - drag.from, 0, "");
    monthDrag.set({ ...drag, active: true, range });
  }

  function finishMonthDrag(point: { x: number; y: number }, to: number) {
    if (!untracked(monthDrag)) return;
    updateMonthDrag(point, to);
    const drag = untracked(monthDrag)!;
    cancelMonthDrag();
    if (!drag.active) { activateEvent(drag.event); return; }
    if (!drag.range || drag.range.start === drag.event.start.ms) return;
    // The preview stays over the cell until the write and its refresh end;
    // the normal write path owns validation, guests and errors.
    batch(() => { pendingMonthMove.set(drag); monthMoveSaved.set(false); });
    if (!reschedule(drag.event, drag.range.start, drag.range.end)) pendingMonthMove.set(null);
  }

  /** How strongly a month event shows while it is dragged or saving. */
  function monthEventOpacity(event: CalendarEvent): number {
    const key = Calendar.eventKey(event);
    const pending = pendingMonthMove();
    if (pending && Calendar.eventKey(pending.event) === key) return 0;
    const drag = monthDrag();
    return drag && drag.active && Calendar.eventKey(drag.event) === key ? 0.35 : 1;
  }

  // --------------------------------------------------------- wiring

  /** Follows the controller while the view is mounted (CalendarView's Connections). */
  function bind() {
    const offs: Array<() => void> = [];
    offs.push(controller.signals.eventUpdated.on((ok) => {
      if (!untracked(pendingMonthMove)) return;
      if (!ok) pendingMonthMove.set(null);
      else { monthMoveSaved.set(true); queueMicrotask(settleMonthMove); }
    }));
    // A scope change drops what a drag or a pending move held.
    let firstScope = true;
    effect(() => {
      controller.calendarScope();
      controller.enabledSourceKey();
      if (firstScope) { firstScope = false; return; }
      untracked(() => batch(() => { monthDrag.set(null); pendingMonthMove.set(null); }));
    });
    // Calendars loaded: read the range on screen.
    effect(() => {
      if (controller.sourcesLoaded()) untracked(refresh);
    });
    // New events: a requested one may have arrived, the open one may have
    // changed or gone.
    effect(() => {
      const events = controller.events();
      untracked(() => {
        resolveRequestedEvent();
        const open = detailEvent();
        if (!open) return;
        const key = Calendar.eventKey(open);
        const matches = events.filter((event) => Calendar.eventKey(event) === key);
        if (matches.length === 1) {
          if (String(matches[0].etag || "") !== String(open.etag || "")) activateEvent(matches[0]);
        } else if (!controller.loading()) {
          const source = controller.findSource(String(open.sourceId || ""));
          if (!source || source.enabled !== false) closeDetail();
        }
      });
    });
    let wasLoading = false;
    effect(() => {
      const loading = controller.loading();
      untracked(() => {
        if (wasLoading === loading) return;
        wasLoading = loading;
        settleMonthMove();
        const open = detailEvent();
        if (loading || !open || controller.lastError() !== "") return;
        const source = controller.findSource(String(open.sourceId || ""));
        if (source && source.enabled === false) return;
        const key = Calendar.eventKey(open);
        if (!controller.events().some((event) => Calendar.eventKey(event) === key)) closeDetail();
      });
    });
    // Back left the detail: forget it.
    effect(() => {
      const kind = app.navPage().kind;
      if (kind !== "calendarDetail" && untracked(detailEvent)) untracked(() => closeDetail(true));
    });
    return () => { for (const off of offs) off(); };
  }

  return {
    // state
    viewMode: () => viewMode(),
    visibleMonth: () => visibleMonth(),
    visibleWeek: () => visibleWeek(),
    selectedEventId: () => selectedEventId(),
    select: (id: string) => selectedEventId.set(id),
    days,
    weekDays,
    displayDays,
    todayIso,
    monthSpans,
    monthDrag: () => monthDrag(),
    pendingMonthMove: () => pendingMonthMove(),
    monthMoveSaved: () => monthMoveSaved(),
    monthMove,
    monthMoveEvent,
    agendaEvents,
    detailEvent: () => detailEvent(),
    detailOpen,
    detailLoading: () => detailLoading(),
    detailError: () => detailError(),
    // actions
    bind,
    refresh,
    visibleEvents,
    moveSelection,
    activateEvent,
    activateSelection,
    closeDetail,
    reschedule,
    moveMonth,
    goToday,
    movePeriod,
    showDate,
    setView,
    showEvent,
    cancelMonthDrag,
    monthMoveRefusal,
    beginMonthDrag,
    updateMonthDrag,
    finishMonthDrag,
    monthEventOpacity,
    createAt: (startMs: number) => hooks.createAt(startMs),
    compose: (request: ComposeRequest) => hooks.compose(request),
    setWeekZoom(zoom: ((direction: number) => void) | null) { weekZoom = zoom; },
    zoomHours(direction: number) {
      const mode = untracked(viewMode);
      if ((mode === "day" || mode === "week") && !untracked(detailOpen) && weekZoom) weekZoom(direction);
    },
  };
}

export type CalendarViewState = ReturnType<typeof createCalendarView>;
