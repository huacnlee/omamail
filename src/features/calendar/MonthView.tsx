// The month grid (CalendarView.qml's month page): a weekday header, five or
// six weeks of day cells, events spanning days as bars across a week, and
// "+N more..." when a cell runs out of room, with the whole day on hover.
//
// An event drags to another day: the grid follows the pointer, the target
// cell shows where the event lands ("Move to Tue 24 Nov · 09:30"), and the
// write goes through the normal reschedule path, which asks before mailing
// guests. A press without movement opens the event; Escape cancels a drag.
import { Text, View, createAnimatedValue, effect, reduceMotion, signal } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import { formatDate, WEEKDAYS } from "../../mail/calendar/format";
import { CLASS, HoverCard, Icon, LINE, cx, TEXT, sizedBox, TYPE, scaled } from "../../ui";
import { eventLabel, eventTitle, eventTone, EventLine, isAllDay, rangeLabel, startLabel } from "./parts";
import { controller, eventKey, view } from "./service";
import { localeHourCycle } from "./time";
import { WEEK_START, type MonthDrag } from "./view";
import type { SpanSegment } from "../../mail/calendar/types";
import type { CalendarEvent } from "./controller";


const HEADER = () => scaled(32); // the weekday names
const CELL_HEAD = () => scaled(24); // a cell's day number
const ROW = () => scaled(22); // one event row
const GAP = 2;
const OVERFLOW = () => scaled(18); // "+N more..."
const NARROW = () => scaled(140);

interface Day { isoDate: string; day: number; month: number; year: number; startMs: number; endMs: number; inMonth: boolean }

function weekdayNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) out.push(WEEKDAYS[(WEEK_START + i) % 7].substring(0, 3));
  return out;
}

/** The grid's cell size, for a pan that ends without the grid hearing it. */
let cellSize = { width: 1, height: 1 };
const SPRING = { stiffness: 420, damping: 34 };

/** A chip's pan ended (touch, and the pointer too): the day it was carried
 * to, from the cell it left. Answers whether the move was handed to the
 * write, so the chip lands rather than springs back. */
function finishPan(translation: { x: number; y: number }, cancelled: boolean): boolean {
  const drag = view.monthDrag();
  if (!drag) return view.pendingMonthMove() !== null;
  if (cancelled) { view.cancelMonthDrag(); return false; }
  const to = drag.from + Math.round(translation.x / cellSize.width) + Math.round(translation.y / cellSize.height) * 7;
  const point = { x: drag.initial.x + translation.x, y: drag.initial.y + translation.y };
  view.finishMonthDrag(point, to >= 0 && to < view.days().length ? to : -1);
  return view.pendingMonthMove() !== null;
}

/** A chip that follows the pointer natively while it is carried. */
function carried() {
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  return {
    pan: { x, y },
    translate: [x, y] as [typeof x, typeof y],
    settle(written: boolean) {
      if (written || reduceMotion()) { x.set(0); y.set(0); return; }
      x.spring(0, SPRING);
      y.spring(0, SPRING);
    },
  };
}

/** A press that ended on a chip: an open, unless the pointer moved, which
 * the grid's release finishes (the keyboard's Enter has no drag at all). */
function releaseChip(event: CalendarEvent, page: { x: number; y: number }, clickCount: number) {
  // Enter or Space on a focused chip opens it; only a pointer can carry one.
  if (clickCount === 0) { view.cancelMonthDrag(); view.activateEvent(event); return; }
  const drag = view.monthDrag();
  if (!drag) { view.activateEvent(event); return; }
  if (!drag.active) view.finishMonthDrag(page, drag.from);
}

/** The label over the cell an event is dropped on. */
function dropLabel(move: MonthDrag | null, saved: boolean, pending: boolean): string {
  if (!move || !move.range) return "";
  const prefix = pending ? (saved ? "Refreshing · " : "Saving · ") : "Move to ";
  const start = new Date(move.range.start);
  return prefix + formatDate(start, "ddd d MMM")
    + (isAllDay(move.event) ? "" : " · " + Calendar.timeLabel(move.range.start, localeHourCycle()));
}

export function MonthView() {
  const size = signal({ width: 0, height: 0 });
  const days = () => view.days() as Day[];
  const weeks = () => Math.max(1, Math.ceil(days().length / 7));
  const cellWidth = () => size().width / 7;
  const rowHeight = () => Math.max(CELL_HEAD() + ROW(), size().height / weeks());
  const narrow = () => cellWidth() < NARROW();
  // Kept for pans that end without the grid hearing the release.
  effect(() => { cellSize = { width: Math.max(1, cellWidth()), height: Math.max(1, rowHeight()) }; });
  const spans = () => view.monthSpans();
  const targetIso = () => {
    const move = view.monthMove();
    return move && move.range ? Calendar.isoDate(new Date(move.range.start)) : "";
  };

  function dayAt(position: { x: number; y: number }): number {
    const column = Math.floor(position.x / Math.max(1, cellWidth()));
    const row = Math.floor(position.y / Math.max(1, rowHeight()));
    if (column < 0 || column > 6 || row < 0 || row >= weeks()) return -1;
    return row * 7 + column;
  }

  function startDrag(event: CalendarEvent, page: { x: number; y: number }, index: number) {
    view.beginMonthDrag(event, page, index);
  }

  return (
    <View testID="calendar-month" class="flex-1">
      <View class="flex-row border-b border-border" style={{ height: HEADER() }}>
        {weekdayNames().map((name) => (
          <View class="flex-1 justify-center px-2"><Text class={TEXT.caption}>{name}</Text></View>
        ))}
      </View>
      <View
        class="flex-1 relative"
        onLayout={(e) => size.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
        onMouseMove={(e) => {
          if (!view.monthDrag()) return;
          if (e.pressedButton === null) { view.cancelMonthDrag(); return; }
          view.updateMonthDrag(e.pagePosition, dayAt(e.position));
        }}
        onMouseUp={(e) => { if (view.monthDrag()) view.finishMonthDrag(e.pagePosition, dayAt(e.position)); }}
        style={{ cursor: view.monthDrag()?.active ? (view.monthDrag()!.range ? "grabbing" : "not-allowed") : "auto" }}
      >
        <Each of={Array.from({ length: weeks() }, (_, week) => week)} key="index">
          {(week) => (
            <View class="flex-row border-b border-border"
              style={{ height: rowHeight(), zIndex: Math.floor((view.monthDrag()?.from ?? -7) / 7) === week() ? 2 : 0 }}>
              <Each of={days().slice(week() * 7, week() * 7 + 7)} key={(day: Day) => day.isoDate}>
                {(day, column) => (
                  <MonthCell
                    day={day()}
                    index={week() * 7 + column()}
                    lanes={spans().laneCounts[week()] || 0}
                    height={rowHeight()}
                    narrow={narrow()}
                    target={targetIso() === day().isoDate}
                    onDragStart={startDrag}
                  />
                )}
              </Each>
            </View>
          )}
        </Each>
        <Each of={spans().segments} key={(segment) => eventKey(segment.event) + ":" + segment.week}>
          {(segment) => (
            <SpanBar
              segment={segment()}
              left={segment().startColumn * cellWidth() + GAP}
              top={segment().week * rowHeight() + CELL_HEAD() + segment().lane * (ROW() + GAP)}
              width={(segment().endColumn - segment().startColumn + 1) * cellWidth() - GAP * 2}
              onDragStart={(event, page) => startDrag(event, page, segment().week * 7 + segment().startColumn)}
            />
          )}
        </Each>
      </View>
    </View>
  );
}

function MonthCell(props: {
  day: Day;
  index: number;
  lanes: number;
  height: number;
  narrow: boolean;
  target: boolean;
  onDragStart: (event: CalendarEvent, page: { x: number; y: number }, index: number) => void;
}) {
  const today = () => props.day.isoDate === view.todayIso();
  const events = () => (Calendar.eventsOnDay(controller.events(), props.day) as CalendarEvent[])
    .filter((event) => !Calendar.spansMultipleDays(event));
  const all = () => Calendar.eventsOnDay(controller.events(), props.day) as CalendarEvent[];
  const available = () => props.height - CELL_HEAD() - props.lanes * (ROW() + GAP) - 4;
  const limit = () => Calendar.monthEventLimit(available(), ROW(), GAP, OVERFLOW(), events().length) as number;
  const shown = () => events().slice(0, limit());
  // Spanning events are drawn as bars in their lanes, so only the day's own
  // events can be left out.
  const hidden = () => events().length - shown().length;
  const move = () => view.monthMove();
  return (
    <View
      testID={"calendar-day-" + props.day.isoDate}
      role="button"
      focusable
      accessibilityLabel={formatDate(new Date(props.day.startMs), "dddd, d MMMM") + (today() ? ", today" : "")
        + " · " + all().length + (all().length === 1 ? " event" : " events")}
      onPress={() => view.createAt(props.day.startMs + 9 * 3600000)}
      // The cell a chip is carried out of lets it show over its neighbours.
      style={{ zIndex: view.monthDrag()?.from === props.index ? 2 : 0 }}
      class={cx("flex-1 border-r border-border", view.monthDrag()?.from === props.index ? "" : "overflow-hidden", CLASS.wash,
        today() ? "bg-primary/8" : props.day.inMonth ? "" : "bg-muted",
        props.target ? "border border-primary" : "", "hover:bg-surface-raised",
        "focus-visible:border focus-visible:border-primary")}
    >
      <View class="flex-row items-center justify-between px-2" style={{ height: CELL_HEAD() }}>
        <View class={cx(sizedBox("min-w-[20px]", "min-w", 20), sizedBox("h-[18px]", "h", 18), "px-1 items-center justify-center rounded-(--radius)",
          today() ? "bg-primary" : "")}>
          <Text class={cx(TYPE.sm, TEXT.mono, today() ? "text-primary-foreground font-semibold"
            : props.day.inMonth ? "text-foreground" : "text-text-secondary")}>
            {String(props.day.day)}
          </Text>
        </View>
        <If when={props.target && move()}>
          <Text class={cx(TEXT.caption, "text-primary line-clamp-1 flex-1 text-right")}>
            {dropLabel(move(), view.monthMoveSaved(), view.pendingMonthMove() !== null)}
          </Text>
        </If>
      </View>
      <View class="px-0.5 gap-[2px]" style={{ marginTop: props.lanes * (ROW() + GAP) }}>
        <Each of={shown()} key={(event: CalendarEvent) => eventKey(event)}>
          {(event) => (
            <MonthChip event={event()} narrow={props.narrow}
              onDragStart={(page) => props.onDragStart(event(), page, props.index)} />
          )}
        </Each>
        <If when={hidden() > 0}>
          <HoverCard
            placement="right"
            trigger={
              <View
                role="button"
                focusable
                accessibilityLabel={"Show all " + all().length + " events in the day view"}
                onPress={() => { view.showDate(props.day.startMs); view.setView("day"); }}
                class={cx("px-1.5 rounded-(--radius) border border-transparent", CLASS.wash, "hover:bg-surface-raised", LINE.focus)}
                style={{ height: OVERFLOW(), cursor: "pointer" }}
              >
                <Text class={TEXT.caption}>{"+" + hidden() + " more..."}</Text>
              </View>
            }
          >
            <View class={cx(sizedBox("w-[260px]", "w", 260), "gap-1.5 p-2")}>
              <Text class={TEXT.title}>
                {formatDate(new Date(props.day.startMs), "dddd, d MMMM") + " · " + all().length + " events"}
              </Text>
              <Each of={all()} key={(event: CalendarEvent) => eventKey(event)}>
                {(event) => (
                  <EventLine event={event()} selected={view.selectedEventId() === eventKey(event())}
                    onPress={() => view.activateEvent(event())} />
                )}
              </Each>
            </View>
          </HoverCard>
        </If>
      </View>
    </View>
  );
}

/** One event in a cell: "09:30 Standup", or "Standup · 09:30" when narrow. */
function MonthChip(props: { event: CalendarEvent; narrow: boolean; onDragStart: (page: { x: number; y: number }) => void }) {
  const drag = carried();
  const tone = () => eventTone(props.event);
  const selected = () => view.selectedEventId() === eventKey(props.event);
  const time = () => startLabel(props.event);
  const titleClass = () => cx(TYPE.sm, "line-clamp-1 flex-1 pr-1", selected() ? "text-bright font-semibold" : "text-foreground");
  return (
    <View
      testID={"calendar-event-" + eventKey(props.event)}
      role="button"
      focusable
      accessibilityLabel={eventLabel(props.event)}
      tooltip={eventTitle(props.event) + "\n" + rangeLabel(props.event)}
      onPressDown={(e) => { if (e.clickCount !== 0) props.onDragStart(e.pagePosition); }}
      // A pointer press is finished by the grid (a click or a drop); the
      // keyboard's Enter opens the event here.
      onPress={(e) => releaseChip(props.event, e.pagePosition, e.clickCount)}
      pan={drag.pan}
      onPanEnd={(e) => drag.settle(finishPan(e.translation, e.cancelled))}
      style={{ height: ROW(), opacity: view.monthEventOpacity(props.event), cursor: "pointer", translate: drag.translate,
        zIndex: view.monthDrag()?.active && eventKey(view.monthDrag()!.event) === eventKey(props.event) ? 3 : 0 }}
      class={cx("flex-row items-center gap-1.5 rounded-(--radius) overflow-hidden border", CLASS.wash, CLASS.fade,
        "border-transparent", selected() ? tone().fillSelected : tone().fill,
        "focus-visible:border-primary")}
    >
      <View class={cx("w-[3px] self-stretch", tone().bar)} />
      {/* The time in mono; narrow, after the title, which matters more there. */}
      <If when={time() !== "" && !props.narrow}>
        <Text class={cx(TYPE.sm, TEXT.mono, "text-text-secondary")}>{time()}</Text>
      </If>
      <Text class={titleClass()}>{eventTitle(props.event)}</Text>
      <If when={time() !== "" && props.narrow}>
        <Text class={cx(TYPE.sm, TEXT.mono, "text-text-secondary pr-1")}>{time()}</Text>
      </If>
    </View>
  );
}

/** A multi-day event across its week, with ‹ › where it continues. */
function SpanBar(props: {
  segment: SpanSegment;
  left: number;
  top: number;
  width: number;
  onDragStart: (event: CalendarEvent, page: { x: number; y: number }) => void;
}) {
  const event = () => props.segment.event as CalendarEvent;
  const drag = carried();
  const tone = () => eventTone(event());
  const selected = () => view.selectedEventId() === eventKey(event());
  const label = () => (isAllDay(event()) || props.segment.continuesBefore ? "" : startLabel(event()) + " · ")
    + eventTitle(event());
  return (
    <View
      testID={"calendar-span-" + eventKey(event()) + "-" + props.segment.week}
      role="button"
      focusable
      accessibilityLabel={eventLabel(event())}
      tooltip={eventTitle(event()) + "\n" + rangeLabel(event())}
      onPressDown={(e) => { if (e.clickCount !== 0) props.onDragStart(event(), e.pagePosition); }}
      onPress={(e) => releaseChip(event(), e.pagePosition, e.clickCount)}
      pan={drag.pan}
      onPanEnd={(e) => drag.settle(finishPan(e.translation, e.cancelled))}
      style={{ translate: drag.translate, position: "absolute", left: props.left, top: props.top, width: Math.max(0, props.width), height: ROW(),
        opacity: view.monthEventOpacity(event()), cursor: "pointer" }}
      class={cx("flex-row items-center gap-1.5 rounded-(--radius) overflow-hidden border", CLASS.wash, CLASS.fade,
        "border-transparent", selected() ? tone().fillSelected : tone().fill,
        "focus-visible:border-primary")}
    >
      <View class={cx("w-[3px] self-stretch", props.segment.continuesBefore ? "" : tone().bar)} />
      <If when={props.segment.continuesBefore}>
        <Icon name="chevronLeft" size={10} label="Continues from the week before" class="text-text-secondary" />
      </If>
      <Text class={cx(TYPE.sm, "line-clamp-1 flex-1", selected() ? "text-bright font-semibold" : "text-foreground")}>{label()}</Text>
      <If when={props.segment.continuesAfter}>
        <Icon name="chevronRight" size={10} label="Continues into the next week" class="text-text-secondary mr-1" />
      </If>
    </View>
  );
}
