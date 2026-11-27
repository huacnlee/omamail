// Small pieces every calendar view draws: an event's tone, its labels and
// the chip a month cell or the agenda shows. Titles, places and guest names
// are the organizer's text and always render as plain text.
import { Text, View } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import { formatDate } from "../../mail/calendar/format";
import { CLASS, cx, TEXT } from "../../ui";
import { toneFor, type EventTone } from "./palette";
import { controller } from "./service";
import { localeHourCycle } from "./time";
import type { CalendarEvent } from "./controller";


export function eventTone(event: CalendarEvent | null | undefined): EventTone {
  return toneFor(event ? controller.colorKeyFor(String(event.sourceId || "")) : "accent");
}

export function eventTitle(event: CalendarEvent | null | undefined): string {
  return String(event?.summary || "Untitled event");
}

export function isAllDay(event: CalendarEvent | null | undefined): boolean {
  return !!event?.start?.allDay;
}

/** "09:30" for a timed event, "" for an all-day one. */
export function startLabel(event: CalendarEvent): string {
  return isAllDay(event) ? "" : Calendar.timeLabel(event.start.ms, localeHourCycle());
}

/** "09:30–10:00", or "All day", or a multi-day "3 Nov – 5 Nov". */
export function rangeLabel(event: CalendarEvent): string {
  if (!event?.start) return "";
  const start = Number(event.start.ms);
  const end = event.end ? Number(event.end.ms) : start;
  if (Calendar.spansMultipleDays(event)) {
    const last = isAllDay(event) ? end - 1 : end;
    return formatDate(new Date(start), "d MMM") + " – " + formatDate(new Date(last), "d MMM");
  }
  if (isAllDay(event)) return "All day";
  return Calendar.timeRangeLabel(start, end, localeHourCycle());
}

/** The calendar an event is on, by name: its color bar says the same, and
 * color alone must not carry it. */
export function calendarName(event: CalendarEvent | null | undefined): string {
  const source = event ? controller.findSource(String(event.sourceId || "")) : null;
  return source ? String(source.name || source.id || "") : "";
}

/** What a screen reader says for an event: its title, when, and its calendar. */
export function eventLabel(event: CalendarEvent, when?: string): string {
  const name = calendarName(event);
  return eventTitle(event) + ", " + (when ?? rangeLabel(event)) + (name ? ", " + name : "");
}

/** The agenda's and the overflow's second line. */
export function agendaWhen(event: CalendarEvent): string {
  if (isAllDay(event)) return formatDate(new Date(Number(event.start.ms)), "ddd, MMM d") + " · All day";
  return Calendar.dateTimeLabel(event.start.ms, "ddd, MMM d", localeHourCycle(), " · ");
}

/** An event in a list: the calendar's bar, the title and when. */
export function EventLine(props: {
  event: CalendarEvent;
  selected?: boolean;
  when?: string;
  testID?: string;
  onPress: () => void;
}) {
  const tone = () => eventTone(props.event);
  return (
    <View
      testID={props.testID}
      role="button"
      focusable
      accessibilityLabel={eventLabel(props.event, props.when)}
      onPress={() => props.onPress()}
      style={{ cursor: "pointer" }}
      class={cx("flex-row items-stretch gap-2 rounded-(--radius) overflow-hidden border", CLASS.wash,
        "border-transparent", props.selected ? tone().fillSelected : tone().fill,
        "hover:border-rule-strong focus-visible:border-primary")}
    >
      <View class={cx("w-[3px]", tone().bar)} />
      <View class="flex-1 gap-0.5 py-2 pr-3">
        <Text class={cx(TEXT.listTitle, "line-clamp-1", props.selected ? "text-bright font-semibold" : "font-medium")}>{eventTitle(props.event)}</Text>
        <Text class={cx(TEXT.caption, TEXT.mono, "line-clamp-1")}>{props.when ?? rangeLabel(props.event)}</Text>
      </View>
    </View>
  );
}
