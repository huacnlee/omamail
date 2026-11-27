// The day and week views (WeekCalendarView.qml): the day headers, a lane of
// all-day and multi-day events, and a scrolling timeline of hours with each
// day's timed events side by side where they overlap.
//
// On the timeline: a press on an empty slot opens the editor there, a drag
// down a column opens it with that range; an event drags to another time or
// day, or resizes by its top or bottom edge, with the new range shown as it
// moves. Ctrl and the wheel, like the zoom keys, change the hour height.
// The view opens at the week's first event, follows it while the week loads,
// and stops following once it is scrolled by hand.
import { Scroll, Text, View, cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, untracked } from "nsh";
import type { ScrollRef } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import { WEEKDAYS } from "../../mail/calendar/format";
import { CLASS, Icon, LINE, cx, TEXT, sizedBox, TYPE, scaled } from "../../ui";
import { eventLabel, eventTitle, eventTone, isAllDay, rangeLabel } from "./parts";
import { controller, eventKey, view } from "./service";
import { localeHourCycle } from "./time";
import type { CalendarEvent } from "./controller";
import type { SpanSegment } from "../../mail/calendar/types";

/** A timed span drawn as an event: the dashed preview of a drag. */
function previewEvent(startMs: number, endMs: number): CalendarEvent {
  return { start: { ms: startMs, allDay: false }, end: { ms: endMs, allDay: false } };
}


const RAIL = () => scaled(56);
/** The timeline's scrollbar floats over its right edge: the header, the
 * all-day row and the day columns all end this far before it, so the three
 * share their column spines and no event runs under the bar. */
const GUTTER = () => scaled(12);
const HEADER = () => scaled(44);
const ALL_DAY_ROW = () => scaled(24);
const CAPTION = () => scaled(11);
const HOURS = 24;
/** A dropped card that was not moved returns with a short settle. */
const SPRING = { stiffness: 420, damping: 34 };

interface Day { isoDate: string; day: number; month: number; year: number; startMs: number; endMs: number }
interface Gesture {
  event: CalendarEvent;
  edge: "" | "start" | "end";
  initial: { x: number; y: number };
  column: number;
  moved: boolean;
  proposed: { start: number; end: number } | null;
}
interface SlotDrag { column: number; fromY: number; toY: number; moved: boolean }

function weekday(day: Day): string {
  return WEEKDAYS[new Date(day.startMs).getDay()].substring(0, 3);
}

export function TimeGrid() {
  const viewport = signal({ width: 0, height: 0 });
  const days = () => view.displayDays() as Day[];
  const columns = () => Math.max(1, days().length);
  const columnWidth = () => Math.max(0, viewport().width - RAIL() - GUTTER()) / columns();

  // ---------------------------------------------------------- all-day lane
  const allDayLayout = computed(() => Calendar.spanLayout(
    controller.events().filter((event: CalendarEvent) => Calendar.displayInAllDayLane(event)), days()));
  const allDayLanes = () => allDayLayout().laneCounts[0] || 0;
  const allDayHeight = () => 8 + Math.max(1, allDayLanes()) * ALL_DAY_ROW();
  const allDayDrag = signal<{ from: number; to: number } | null>(null);

  // ---------------------------------------------------------- the hours
  const timelineHeight = () => Math.max(0, viewport().height - HEADER() - allDayHeight());
  const automatic = () => Calendar.automaticHourHeight(timelineHeight() + allDayHeight() - 32,
    scaled(Calendar.HOUR_HEIGHT_USUAL), Math.max(scaled(Calendar.HOUR_HEIGHT_READABLE), CAPTION() * 2.5)) as number;
  const hourHeight = computed(() => Math.max(timelineHeight() / HOURS,
    controller.hourHeight() > 0 ? controller.hourHeight() : automatic()));
  const hourLabelStep = () => hourHeight() < CAPTION() ? 2 : 1;
  const hourScale = () => Math.min(1, hourHeight() / 60);
  const resizeEdge = () => 9 * hourScale();
  const cardMargin = () => 5 * hourScale();

  // ---------------------------------------------------------- scrolling
  let scroller: ScrollRef | undefined;
  let topHour = 0;
  let placedY = 0;
  /** Where the timeline is scrolled to, for the hour labels at its top edge. */
  const scrolledTo = signal(0);
  let follows = true;
  let movedByHand = false;
  const openingHour = computed(() => Calendar.weekOpeningHour(controller.events(), days(), 7) as number);

  function placeTopHour() {
    const height = untracked(hourHeight);
    // A little above the hour, so its label is not cut by the lane above.
    const y = Math.max(0, Math.min(topHour * height - (topHour > 0 ? 10 : 0), height * HOURS - untracked(timelineHeight)));
    placedY = y;
    scrolledTo.set(y);
    scroller?.scrollTo({ y, animated: false });
  }
  function showOpeningHour() {
    topHour = untracked(openingHour);
    placeTopHour();
  }
  function resetTimeScroll() {
    movedByHand = false;
    follows = true;
    showOpeningHour();
  }
  function stopFollowing() {
    movedByHand = true;
    follows = false;
  }

  // ---------------------------------------------------------- gestures
  const gesture = signal<Gesture | null>(null);
  /** A move or resize being written: the card stays where it was dropped. */
  const pendingGesture = signal<{ key: string; start: number; end: number } | null>(null);
  const slotDrag = signal<SlotDrag | null>(null);
  const hovered = signal<{ key: string; edge: "" | "start" | "end" } | null>(null);

  function columnAt(x: number): number {
    return Math.max(0, Math.min(untracked(columns) - 1, Math.floor(x / Math.max(1, untracked(columnWidth)))));
  }

  function beginGesture(event: CalendarEvent, column: number, page: { x: number; y: number }, y: number, height: number) {
    if (untracked(pendingGesture) || controller.eventWriting()) return;
    const edge = y < untracked(resizeEdge) ? "start" : y > height - untracked(resizeEdge) ? "end" : "";
    gesture.set({ event: { ...event }, edge: isAllDay(event) ? "" : edge, initial: page, column, moved: false, proposed: null });
  }

  function moveGesture(page: { x: number; y: number }, x: number) {
    const current = untracked(gesture);
    if (!current) return;
    if (!current.moved && Math.abs(page.x - current.initial.x) + Math.abs(page.y - current.initial.y) < 6) return;
    if (!current.moved && controller.rescheduleRefusal(current.event) !== "") {
      // Moving is refused (read-only, a Gmail event...): say why, once.
      controller.reportError(controller.rescheduleRefusal(current.event));
      gesture.set(null);
      return;
    }
    if (!current.moved) stopFollowing();
    const column = current.edge === "" ? columnAt(x) : current.column;
    const proposed = Calendar.gestureRange(current.event, column - current.column,
      (page.y - current.initial.y) / untracked(hourHeight) * 60, current.edge);
    gesture.set({ ...current, moved: true, proposed });
  }

  // A drag ends up to three ways at once: the column's mouse release, the
  // card's pan end (touch, and the pointer too) and the card's press. The
  // first one finishes it; the others, within a moment, only learn whether
  // it was written.
  let finishedAt = 0;
  let lastCommitted = false;

  function commit(event: CalendarEvent, proposed: { start: number; end: number } | null): boolean {
    finishedAt = Date.now();
    lastCommitted = false;
    if (!proposed || (proposed.start === event.start.ms && proposed.end === event.end?.ms)) return false;
    lastCommitted = view.reschedule(event, proposed.start, proposed.end);
    if (lastCommitted && untracked(controller.eventWriting))
      pendingGesture.set({ key: eventKey(event), start: proposed.start, end: proposed.end });
    return lastCommitted;
  }

  function finishGesture() {
    const current = untracked(gesture);
    gesture.set(null);
    if (!current) return;
    if (!current.moved) { finishedAt = Date.now(); lastCommitted = false; view.activateEvent(current.event); return; }
    commit(current.event, current.proposed);
  }

  /** A card's pan ended: `translation` from where it went down. Answers
   * whether the event was written, so the card lands rather than springs back. */
  function finishPan(event: CalendarEvent, column: number, translation: { x: number; y: number }, cancelled: boolean): boolean {
    const current = untracked(gesture);
    gesture.set(null);
    slotDrag.set(null);
    if (Date.now() - finishedAt < 400) return lastCommitted;
    if (cancelled || Math.abs(translation.x) + Math.abs(translation.y) < 6) return false;
    const refusal = controller.rescheduleRefusal(event);
    if (refusal !== "") { finishedAt = Date.now(); lastCommitted = false; controller.reportError(refusal); return false; }
    const edge = current && eventKey(current.event) === eventKey(event) ? current.edge : "";
    const target = edge === "" ? Math.max(0, Math.min(untracked(columns) - 1,
      column + Math.round(translation.x / Math.max(1, untracked(columnWidth))))) : column;
    return commit(event, Calendar.gestureRange(event, target - column,
      translation.y / untracked(hourHeight) * 60, edge));
  }

  function slotRange(drag: SlotDrag): { start: number; end: number } {
    const day = untracked(days)[drag.column];
    const height = untracked(hourHeight);
    const first = Calendar.slotStart(day, Math.min(drag.fromY, drag.toY), 0, height, 15) as number;
    const last = Calendar.slotStart(day, Math.max(drag.fromY, drag.toY), 0, height, 15) as number + 900000;
    return { start: first, end: Math.max(first + 900000, last) };
  }

  function finishSlot() {
    const drag = untracked(slotDrag);
    slotDrag.set(null);
    if (!drag) return;
    const day = untracked(days)[drag.column];
    if (!drag.moved) { view.createAt(Calendar.slotStart(day, drag.fromY, 0, untracked(hourHeight), 30)); return; }
    const range = slotRange(drag);
    view.compose({ startMs: range.start, endMs: range.end });
  }

  // ---------------------------------------------------------- wiring
  view.setWeekZoom((direction) => {
    if (untracked(pendingGesture) || untracked(gesture)) return;
    controller.zoomHours(direction, untracked(hourHeight), untracked(timelineHeight) / HOURS);
  });
  cleanup(() => view.setWeekZoom(null));

  // The period, the scope or the calendars changed: open at the first event.
  let periodKey = "";
  effect(() => {
    const key = days().map((day) => day.isoDate).join(",") + "|" + controller.calendarScope();
    if (key === periodKey) return;
    periodKey = key;
    if (!untracked(gesture) && !untracked(pendingGesture)) untracked(resetTimeScroll);
  });
  effect(() => {
    controller.enabledSourceKey();
    if (!movedByHand) { follows = true; untracked(showOpeningHour); }
  });
  effect(() => {
    openingHour();
    if (follows) untracked(showOpeningHour);
  });
  // A new height keeps the same hour at the top.
  effect(() => {
    hourHeight();
    timelineHeight();
    untracked(placeTopHour);
  });
  effect(() => {
    if (!controller.loading() && !controller.pendingRangeStart()) follows = false;
    if (!controller.loading() && !controller.eventWriting()) untracked(() => pendingGesture.set(null));
  });
  const offUpdated = controller.signals.eventUpdated.on((ok) => { if (!ok) pendingGesture.set(null); });
  cleanup(offUpdated);

  // Each day's events, with the one being saved already at its new time.
  const shownEvents = computed(() => {
    const pending = pendingGesture();
    return controller.events().map((event: CalendarEvent) => pending && eventKey(event) === pending.key
      ? { ...event, start: { ...event.start, ms: pending.start }, end: { ...(event.end || {}), ms: pending.end } } : event);
  });

  const preview = computed(() => {
    const current = gesture();
    if (!current || !current.moved || !current.proposed) return null;
    const column = current.edge === "" ? days().findIndex((day) => current.proposed!.start >= day.startMs
      && current.proposed!.start < day.endMs) : current.column;
    if (column < 0) return null;
    const event = previewEvent(current.proposed.start, current.proposed.end);
    const day = days()[column];
    return {
      column,
      top: Calendar.eventTop(event, day, 0, hourHeight()) as number,
      height: Calendar.eventHeight(event, day, hourHeight()) as number,
      label: Calendar.timeRangeLabel(current.proposed.start, current.proposed.end, localeHourCycle()) as string,
    };
  });

  const nowRail = () => Calendar.weekNowOffset(days(), 0, HOURS, hourHeight(), controller.nowMs()) as number;

  return (
    <View
      testID="calendar-week"
      class="flex-1"
      onLayout={(e) => viewport.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
      onWheel={(e) => {
        if (!e.modifiers.control && !e.modifiers.platform) return;
        view.zoomHours(e.delta.y < 0 ? 1 : -1);
      }}
    >
      {/* Day headers */}
      {/* The header's and the all-day lane's bottoms are structural lines
          (the divider); day columns and hour lines stay content borders. */}
      <View class={cx("flex-row border-b", LINE.divider)} style={{ height: HEADER() }}>
        <View style={{ width: RAIL() }} />
        <Each of={days()} key={(day: Day) => day.isoDate}>
          {(day) => {
            const today = () => day().isoDate === view.todayIso();
            return (
              <View class="flex-1 flex-row items-center justify-center gap-1.5 border-l border-border"
                accessibilityLabel={WEEKDAYS[new Date(day().startMs).getDay()] + " " + day().day + (today() ? ", today" : "")}>
                <Text class={TEXT.caption}>{weekday(day())}</Text>
                <View class={cx(sizedBox("min-w-[22px]", "min-w", 22), sizedBox("h-[20px]", "h", 20), "px-1 items-center justify-center rounded-(--radius)",
                  today() ? "bg-primary" : "")}>
                  <Text class={cx(TYPE.md, TEXT.mono, today() ? "text-primary-foreground font-semibold" : "text-foreground")}>
                    {String(day().day)}
                  </Text>
                </View>
              </View>
            );
          }}
        </Each>
        <View class="border-l border-border" style={{ width: GUTTER() }} />
      </View>

      {/* All-day lane */}
      <View class={cx("flex-row border-b", LINE.divider, CLASS.fade)} style={{ height: allDayHeight() }}>
        <View style={{ width: RAIL() }} class="items-end justify-start pt-1.5 pr-2">
          <Text class={TEXT.caption}>all-day</Text>
        </View>
        <View
          testID="calendar-all-day"
          class="flex-1 relative"
          onPressDown={(e) => allDayDrag.set({ from: columnAt(e.position.x), to: columnAt(e.position.x) })}
          onMouseMove={(e) => {
            const drag = allDayDrag();
            if (!drag) return;
            if (e.pressedButton === null) { allDayDrag.set(null); return; }
            allDayDrag.set({ ...drag, to: columnAt(e.position.x) });
          }}
          onPress={(e) => {
            const drag = untracked(allDayDrag) || { from: columnAt(e.position.x), to: columnAt(e.position.x) };
            allDayDrag.set(null);
            const list = untracked(days);
            const first = list[Math.min(drag.from, drag.to)], last = list[Math.max(drag.from, drag.to)];
            if (first && last) view.compose({ startMs: first.startMs, endMs: last.endMs, allDay: true });
          }}
          accessibilityLabel="Create an all-day event"
        >
          <View class="absolute inset-0 flex-row">
            <Each of={days()} key={(day: Day) => day.isoDate}>
              {(day, index) => {
                const drag = () => allDayDrag();
                const chosen = () => !!drag() && index() >= Math.min(drag()!.from, drag()!.to)
                  && index() <= Math.max(drag()!.from, drag()!.to);
                return <View class={cx("flex-1 border-l border-border", CLASS.wash, chosen() ? "bg-primary/15" : "")} />;
              }}
            </Each>
          </View>
          <Each of={allDayLayout().segments} key={(segment) => eventKey(segment.event)}>
            {(segment) => <AllDayBar segment={segment()} columnWidth={columnWidth()} />}
          </Each>
        </View>
        <View class="border-l border-border" style={{ width: GUTTER() }} />
      </View>

      {/* Timeline */}
      <Scroll
        ref={(node) => { scroller = node; }}
        testID="calendar-time-scroll"
        class="flex-1"
        onScroll={(e) => {
          scrolledTo.set(e.offset.y);
          if (Math.abs(e.offset.y - placedY) < 1) return;
          placedY = e.offset.y;
          topHour = e.offset.y / Math.max(1, untracked(hourHeight));
          stopFollowing();
        }}
      >
        <View class="flex-row" style={{ height: Math.max(timelineHeight(), hourHeight() * HOURS) }}>
          {/* The hour rail */}
          <View style={{ width: RAIL() }} class="relative">
            <Each of={Array.from({ length: HOURS }, (_, hour) => hour)} key="index">
              {(hour) => (
                <If when={hour() > 0 && hour() % hourLabelStep() === 0
                  && (nowRail() < 0 || Math.abs(nowRail() - hour() * hourHeight()) > 12)
                  // The top line's label would be cut in half by the scroll
                  // edge: it sits just inside it instead, so the first hour
                  // in view is named too.
                  && hour() * hourHeight() >= scrolledTo() - 1}>
                  <Text class={cx(TEXT.caption, TEXT.mono, "absolute right-2")}
                    style={{ top: Math.max(hour() * hourHeight() - scaled(7), scrolledTo()) }}>
                    {Calendar.timeLabel(new Date(2000, 0, 1, hour()).getTime(), localeHourCycle())}
                  </Text>
                </If>
              )}
            </Each>
            <If when={nowRail() >= 0}>
              <View class={cx("absolute right-1 px-1 justify-center rounded-(--radius) bg-danger", sizedBox("h-[16px]", "h", 16))}
                style={{ top: nowRail() - 8 }}>
                <Text class={cx(TYPE.xs, "font-semibold text-primary-foreground tabular-nums")}>
                  {Calendar.timeLabel(controller.nowMs(), localeHourCycle())}
                </Text>
              </View>
            </If>
          </View>

          {/* The day columns */}
          <View
            class="flex-1 relative"
            onMouseMove={(e) => {
              const current = gesture();
              if (current) {
                if (e.pressedButton === null) { gesture.set(null); return; }
                moveGesture(e.pagePosition, e.position.x);
                return;
              }
              const drag = slotDrag();
              if (drag) {
                if (e.pressedButton === null) { slotDrag.set(null); return; }
                const moved = drag.moved || Math.abs(e.position.y - drag.fromY) >= 6;
                slotDrag.set({ ...drag, toY: e.position.y, moved });
              }
            }}
            onMouseUp={() => {
              // A press on a card also reaches its column: the card's gesture wins.
              if (untracked(gesture)) { slotDrag.set(null); finishGesture(); }
              else if (untracked(slotDrag)) finishSlot();
            }}
            style={{ cursor: gesture()?.moved ? (gesture()!.edge === "" ? "grabbing" : "ns-resize") : "auto" }}
          >
            {/* Hour lines */}
            <Each of={Array.from({ length: HOURS }, (_, hour) => hour)} key="index">
              {(hour) => (
                <View class={cx("absolute left-0 right-0 h-px", hour() % hourLabelStep() === 0 ? "bg-border" : "bg-border/50")}
                  style={{ top: hour() * hourHeight() }} />
              )}
            </Each>
            <View class="absolute inset-0 flex-row">
              <Each of={days()} key={(day: Day) => day.isoDate}>
                {(day, column) => (
                  <DayColumn
                    day={day()}
                    column={column()}
                    hourHeight={hourHeight()}
                    events={shownEvents()}
                    resizeEdge={resizeEdge()}
                    cardMargin={cardMargin()}
                    pending={pendingGesture()}
                    gesture={gesture()}
                    hovered={hovered()}
                    slot={slotDrag()?.column === column() && slotDrag()!.moved ? slotRange(slotDrag()!) : null}
                    onSlotDown={(y) => slotDrag.set({ column: column(), fromY: y, toY: y, moved: false })}
                    onCardDown={(event, page, y, height) => beginGesture(event, column(), page, y, height)}
                    onCardRelease={(event) => {
                      slotDrag.set(null);
                      if (untracked(gesture)) finishGesture();
                      else if (Date.now() - finishedAt >= 400) view.activateEvent(event);
                    }}
                    onCardPanEnd={(event, translation, cancelled) => finishPan(event, column(), translation, cancelled)}
                    onHover={(next) => hovered.set(next)}
                  />
                )}
              </Each>
            </View>
            <If when={preview()}>
              {(shown) => (
                <View
                  testID="calendar-drag-preview"
                  class="absolute rounded-(--radius) border-2 border-dashed border-primary bg-primary/10 px-1.5 py-0.5"
                  style={{ left: shown().column * columnWidth() + 2, width: columnWidth() - 6,
                    top: shown().top, height: Math.max(18, shown().height) }}
                >
                  <Text class={cx(TYPE.sm, "font-semibold text-primary tabular-nums")}>{shown().label}</Text>
                </View>
              )}
            </If>
          </View>
          <View class="border-l border-border" style={{ width: GUTTER() }} />
        </View>
      </Scroll>
    </View>
  );
}

function AllDayBar(props: { segment: SpanSegment; columnWidth: number }) {
  const event = () => props.segment.event as CalendarEvent;
  const tone = () => eventTone(event());
  const selected = () => view.selectedEventId() === eventKey(event());
  const timed = () => !isAllDay(event());
  return (
    <View
      testID={"calendar-all-day-" + eventKey(event())}
      role="button"
      focusable
      accessibilityLabel={eventLabel(event())}
      tooltip={eventTitle(event()) + "\n" + rangeLabel(event())}
      onPress={() => view.activateEvent(event())}
      style={{ position: "absolute", top: 4 + props.segment.lane * ALL_DAY_ROW(), height: ALL_DAY_ROW() - 3,
        left: props.segment.startColumn * props.columnWidth + 2,
        width: Math.max(0, (props.segment.endColumn - props.segment.startColumn + 1) * props.columnWidth - 4),
        cursor: "pointer" }}
      class={cx("flex-row items-center gap-1 rounded-(--radius) overflow-hidden border", CLASS.wash,
        "border-transparent", selected() ? tone().fillSelected : tone().fill,
        "focus-visible:border-primary")}
    >
      <View class={cx("w-[3px] self-stretch", props.segment.continuesBefore ? "" : tone().bar)} />
      <If when={props.segment.continuesBefore}>
        <Icon name="chevronLeft" size={10} label="Continues from before" class="text-text-secondary" />
      </If>
      <Text class={cx(TYPE.sm, "line-clamp-1 flex-1", selected() ? "text-bright font-semibold" : "text-foreground")}>
        {(timed() ? "Timed · " : "") + eventTitle(event())}
      </Text>
      <If when={props.segment.continuesAfter}>
        <Icon name="chevronRight" size={10} label="Continues after" class="text-text-secondary mr-1" />
      </If>
    </View>
  );
}

function DayColumn(props: {
  day: Day;
  column: number;
  hourHeight: number;
  events: CalendarEvent[];
  resizeEdge: number;
  cardMargin: number;
  pending: { key: string } | null;
  gesture: Gesture | null;
  hovered: { key: string; edge: "" | "start" | "end" } | null;
  slot: { start: number; end: number } | null;
  onSlotDown: (y: number) => void;
  onCardDown: (event: CalendarEvent, page: { x: number; y: number }, y: number, height: number) => void;
  onCardRelease: (event: CalendarEvent) => void;
  onCardPanEnd: (event: CalendarEvent, translation: { x: number; y: number }, cancelled: boolean) => boolean;
  onHover: (next: { key: string; edge: "" | "start" | "end" } | null) => void;
}) {
  const width = signal(0);
  const today = () => props.day.isoDate === view.todayIso();
  const lanes = computed(() => Calendar.dayLanes(Calendar.eventsOnDay(props.events, props.day), props.day,
    props.hourHeight) as Array<{ event: CalendarEvent; lane: number; lanes: number; span: number }>);
  const now = () => Calendar.nowOffset(props.day, 0, HOURS, props.hourHeight, controller.nowMs()) as number;
  // The column holding a dragged card paints over its neighbours, so the
  // card stays visible as it crosses into them.
  const holdsDrag = () => !!props.gesture && lanes().some((item) => eventKey(item.event) === eventKey(props.gesture!.event));
  return (
    <View
      style={{ zIndex: holdsDrag() ? 2 : 0 }}
      class={cx("flex-1 relative border-l border-border", today() ? "bg-primary/5" : "")}
      onLayout={(e) => width.set(e.bounds.size.width)}
      onPressDown={(e) => props.onSlotDown(e.position.y)}
      accessibilityLabel={"Create an event on " + WEEKDAYS[new Date(props.day.startMs).getDay()] + " " + props.day.day}
    >
      <If when={props.slot}>
        {(slot) => (
          <View class="absolute left-1 right-1 rounded-(--radius) bg-primary/20 border border-primary px-1.5"
            style={{ top: Calendar.eventTop(previewEvent(slot().start, slot().end), props.day, 0, props.hourHeight),
              height: Calendar.eventHeight(previewEvent(slot().start, slot().end), props.day, props.hourHeight) }}>
            <Text class={cx(TYPE.sm, "font-semibold text-primary tabular-nums")}>
              {Calendar.timeRangeLabel(slot().start, slot().end, localeHourCycle())}
            </Text>
          </View>
        )}
      </If>
      <Each of={lanes()} key={(item) => eventKey(item.event)}>
        {(item) => (
          <EventCard
            item={item()}
            day={props.day}
            columnWidth={width()}
            hourHeight={props.hourHeight}
            resizeEdge={props.resizeEdge}
            cardMargin={props.cardMargin}
            saving={!!props.pending && props.pending.key === eventKey(item().event)}
            dragging={!!props.gesture && props.gesture.moved && eventKey(props.gesture.event) === eventKey(item().event)}
            hoveredEdge={props.hovered && props.hovered.key === eventKey(item().event) ? props.hovered.edge : null}
            onDown={(page, y, height) => props.onCardDown(item().event, page, y, height)}
            onRelease={() => props.onCardRelease(item().event)}
            onPanEnd={(translation, cancelled) => props.onCardPanEnd(item().event, translation, cancelled)}
            onHover={props.onHover}
          />
        )}
      </Each>
      <If when={now() >= 0}>
        <View class="absolute left-0 right-0 h-[2px] bg-danger" style={{ top: now() - 1 }} />
        <View class="absolute w-[7px] h-[7px] rounded-(--radius) bg-danger" style={{ top: now() - 3.5, left: -3.5 }} />
      </If>
    </View>
  );
}

function EventCard(props: {
  item: { event: CalendarEvent; lane: number; lanes: number; span: number };
  day: Day;
  columnWidth: number;
  hourHeight: number;
  resizeEdge: number;
  cardMargin: number;
  saving: boolean;
  dragging: boolean;
  hoveredEdge: "" | "start" | "end" | null;
  onDown: (page: { x: number; y: number }, y: number, height: number) => void;
  /** The press ended on the card: an open, or the end of a gesture the
   * column did not finish (the keyboard's Enter has no gesture at all). */
  onRelease: () => void;
  /** The pan ended; answers whether the move was written. */
  onPanEnd: (translation: { x: number; y: number }, cancelled: boolean) => boolean;
  onHover: (next: { key: string; edge: "" | "start" | "end" } | null) => void;
}) {
  const event = () => props.item.event;
  // The card follows the finger or the pointer on the UI thread; on release
  // it lands where the write puts it, or springs back.
  const panX = createAnimatedValue(0);
  const panY = createAnimatedValue(0);
  function settle(written: boolean) {
    if (written || reduceMotion()) { panX.set(0); panY.set(0); return; }
    panX.spring(0, SPRING);
    panY.spring(0, SPRING);
  }
  const tone = () => eventTone(event());
  const selected = () => view.selectedEventId() === eventKey(event());
  const top = () => Calendar.eventTop(event(), props.day, 0, props.hourHeight) as number;
  const height = () => Calendar.eventHeight(event(), props.day, props.hourHeight) as number;
  const laneWidth = () => Math.max(0, props.columnWidth - 6) / Math.max(1, props.item.lanes);
  const left = () => 2 + props.item.lane * laneWidth();
  const width = () => Math.max(0, props.item.span * laneWidth() - (props.item.lane + props.item.span < props.item.lanes ? 2 : 0));
  const showsTime = () => height() >= scaled(34);
  const tight = () => height() - 2 < scaled(16) + 4;
  // A narrow card keeps its title to one line rather than breaking words; a
  // second line is only taken when the time still fits below it.
  const narrow = () => width() < scaled(72);
  const canMove = () => controller.rescheduleRefusal(event()) === "";
  const edgeAt = (y: number): "" | "start" | "end" => !canMove() ? ""
    : y < props.resizeEdge ? "start" : y > height() - props.resizeEdge ? "end" : "";
  return (
    <View
      testID={"calendar-event-" + eventKey(event())}
      role="button"
      focusable
      accessibilityLabel={eventLabel(event())}
      tooltip={eventTitle(event()) + "\n" + rangeLabel(event())}
      // Only a pointer starts a move or resize; Enter or Space opens the event.
      onPressDown={(e) => { if (e.clickCount !== 0) props.onDown(e.pagePosition, e.position.y, height()); }}
      onPress={(e) => (e.clickCount === 0 ? view.activateEvent(event()) : props.onRelease())}
      pan={canMove() ? { x: panX, y: panY } : undefined}
      onPanEnd={(e) => settle(props.onPanEnd(e.translation, e.cancelled))}
      onMouseMove={(e) => props.onHover({ key: eventKey(event()), edge: edgeAt(e.position.y) })}
      onMouseLeave={() => props.onHover(null)}
      style={{ position: "absolute", top: top() + 1, height: Math.max(2, height() - 2), left: left(), width: width(),
        opacity: props.dragging ? 0.35 : 1, translate: [panX, panY], zIndex: props.dragging ? 3 : 0,
        cursor: props.hoveredEdge ? "ns-resize" : canMove() ? "grab" : "pointer" }}
      class={cx("flex-row rounded-(--radius) overflow-hidden border", CLASS.wash, CLASS.fade,
        "border-transparent", selected() ? tone().fillSelected : tone().fill,
        "hover:border-rule-strong focus-visible:border-primary")}
    >
      <View class={cx("w-[3px]", tone().bar)} />
      {/* A card shorter than a caption line (a half hour at a small hour
          height, or a large base size) centres one tight line, so neither
          Latin descenders nor CJK glyphs are cut. */}
      <View class={cx("flex-1 overflow-hidden", tight() ? "justify-center" : "")}
        style={{ paddingLeft: props.cardMargin, paddingRight: props.cardMargin,
          paddingTop: tight() ? 0 : Math.min(props.cardMargin, Math.max(0, (height() - scaled(16)) / 2)) }}>
        <Text class={cx(TYPE.sm, selected() ? "text-bright font-semibold" : "text-foreground font-medium",
          showsTime() && !narrow() && height() >= scaled(52) ? "line-clamp-2" : "line-clamp-1")}
          style={tight() ? { lineHeight: Math.max(scaled(12), height() - 4) } : undefined}>
          {eventTitle(event())}
        </Text>
        <If when={showsTime()}>
          <Text class={cx(TEXT.caption, TEXT.mono, "line-clamp-1")}>
            {props.saving ? "Saving · " + rangeLabel(event()) : rangeLabel(event())}
          </Text>
        </If>
      </View>
      <If when={props.hoveredEdge === "start" || props.hoveredEdge === "end"}>
        <View class={cx("absolute left-[30%] right-[30%] h-[3px] rounded-(--radius) bg-rule-strong",
          props.hoveredEdge === "start" ? "top-[2px]" : "bottom-[2px]")} />
      </If>
    </View>
  );
}
