// A month calendar with nsh-omarchy's look on nsh/base `Calendar`, so its days,
// weekdays and header follow Omarchy's base size (nsh-omarchy draws them at
// Rust constants). Same props and events as nsh-omarchy's `Calendar`.
//
// nsh/base owns the behavior: the days are one Tab stop, the arrows move a
// day or a week, Home / End to the week's ends, Page Up / Down a month (with
// Shift a year), Return and Space pick; the header's toggles open the month
// and year views. This file draws: a bordered surface 250pt wide at base 14
// (seven 32pt columns and 12pt padding), 28pt rows, 12pt numbers and 11pt
// weekdays, the selected fill under the picked day (every day of a range),
// today's number in the accent with a bar under it, the days of the months
// around in secondary text. The picked day is also semibold and selected for
// screen readers, so it is not told by its fill alone.
import { signal, Text, View } from "nsh";
import { Calendar as BaseCalendar, type CalendarEntry, type CalendarValue } from "nsh/base";
import { scaled } from "./font";
import { Icon } from "./Icon";
import { cx, TYPE } from "./tokens";

/** A range of days, both ISO dates (`"2026-11-19"`), as nsh-omarchy's. */
export interface DateRange {
  /** The first day. */
  start: string;
  /** The last day. */
  end: string;
}

export interface CalendarProps {
  /** The picked day, `null` for none (`"2026-11-19"`). Set, the app owns it and writes back what `onChange` reports; left out, the calendar keeps the pick. */
  value?: string | null;
  /** Pick a range: the first press starts it, the second ends it (`rangeValue`, `onRangeChange`). */
  range?: boolean;
  /** The picked range while `range`, `null` for none. Set, the app owns it; left out, the calendar keeps it. */
  rangeValue?: DateRange | null;
  /** The first day that can be picked. */
  min?: string | null;
  /** The last day that can be picked. */
  max?: string | null;
  /** No day can be picked; the months still turn. */
  disabled?: boolean;
  /** The user picked a day: the day asked for. */
  onChange?: (event: { value: string }) => void;
  /** The user picked a range's end (while `range`): the range asked for. */
  onRangeChange?: (event: { value: DateRange }) => void;
  testID?: string;
  class?: string;
}

/** A day's column at base 14. */
const DAY = 32;
/** Seven days, the padding (12pt each side) and the border. */
const WIDTH = DAY * 7 + 12 * 2 + 1 * 2;

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const monthName = (month: number) => MONTHS[Math.min(11, Math.max(0, month - 1))];

// 12pt text with the font's own line height, as nsh-omarchy sets it
// (`TYPE.md` would add 16pt lines and move the numbers by a point).
const text12 = () => `text-[${scaled(12)}px]`;

// One function for every read, so the calendar is not asked again.
const EVERY_DAY = () => true;

/**
 * The calendar's parts as nsh/base `Calendar` and `DatePicker` take them, so
 * the DatePicker's popup draws the same month (DatePicker.tsx).
 */
export const CALENDAR_PARTS = {
  headerClass: () => cx("flex-row items-center gap-1"),
  rowClass: "flex-row",
  itemClass: () =>
    cx(
      "group h-7 min-w-8 flex-row items-stretch border border-transparent",
      "transition-colors duration-[100ms] motion-reduce:transition-none",
      "selected:bg-selection",
    ),
  renderItem: (entry: CalendarEntry) => <Item entry={entry} />,
};

/** 12pt text with the font's own line height, at the base size. */
export const calendarText = () => text12();

/** A month of days to pick a day (or a range) from. */
export function Calendar(props: CalendarProps) {
  // The calendar's own pick while the app does not hold `value` / `rangeValue`.
  const ownDay = signal<string | null>(null);
  const ownRange = signal<DateRange | null>(null);
  const day = () => (props.value !== undefined ? props.value : ownDay());
  const span = () => (props.rangeValue !== undefined ? props.rangeValue : ownRange());
  const value = (): CalendarValue => {
    if (!props.range) return day() ?? null;
    const s = span();
    return s ? [s.start, s.end] : [null, null];
  };
  const matcher = () => {
    if (props.disabled) return EVERY_DAY;
    const min = props.min ?? null;
    const max = props.max ?? null;
    return min || max ? { before: min, after: max } : null;
  };
  return (
    <BaseCalendar
      testID={props.testID}
      class={cx(
        "p-3 gap-2 border border-border bg-surface text-foreground",
        text12(),
        props.class ?? "",
      )}
      style={{ width: scaled(WIDTH) }}
      value={value()}
      range={!!props.range}
      disabledMatcher={matcher()}
      previousAccessibilityLabel="Previous month"
      nextAccessibilityLabel="Next month"
      headerClass={CALENDAR_PARTS.headerClass()}
      rowClass={CALENDAR_PARTS.rowClass}
      itemClass={CALENDAR_PARTS.itemClass()}
      renderItem={CALENDAR_PARTS.renderItem}
      onChange={(e) => {
        const picked = e.value;
        if (typeof picked === "string") {
          ownDay.set(picked);
          props.onChange?.({ value: picked });
        } else if (Array.isArray(picked) && picked[0] && picked[1]) {
          const next = { start: picked[0], end: picked[1] };
          ownRange.set(next);
          props.onRangeChange?.({ value: next });
        }
      }}
    />
  );
}

/** An item's content, from what it is (its state is the item's classes). */
function Item(props: { entry: CalendarEntry }) {
  const entry = props.entry;
  const kind = entry.kind;
  const arrow = kind === "previous" || kind === "next";
  const toggle = kind === "monthToggle" || kind === "yearToggle";
  const pressable = kind !== "weekday";
  const label =
    kind === "weekday"
      ? WEEKDAYS[((entry.value % 7) + 7) % 7]
      : kind === "monthToggle"
        ? monthName(entry.value)
        : kind === "month"
          ? monthName(entry.value).slice(0, 3)
          : String(entry.value);
  const color = entry.today
    ? "text-primary"
    : entry.outside || kind === "weekday"
      ? "text-text-secondary"
      : toggle
        ? "text-bright"
        : "text-foreground";
  return (
    <View
      class={cx(
        "flex-1 items-center justify-center border border-transparent",
        toggle && "px-2",
        "transition-colors duration-[100ms] motion-reduce:transition-none",
        pressable && "group-hover:bg-surface-raised group-focus-visible:border-primary",
      )}
    >
      {arrow ? (
        <Icon name={kind === "previous" ? "chevronLeft" : "chevronRight"} size={16} class="text-foreground" />
      ) : (
        <Text
          class={cx(
            kind === "weekday" ? TYPE.sm : text12(),
            entry.today || toggle ? "font-semibold" : "font-normal",
            // The picked day: semibold too, not its fill alone.
            kind === "day" && "group-selected:font-semibold",
            kind === "day" && "tabular-nums",
            color,
          )}
        >
          {label}
        </Text>
      )}
      {entry.today ? <View class={cx("w-3 bg-primary")} style={{ height: 1 }} /> : null}
    </View>
  );
}
