// nsh-omarchy's DatePicker on nsh/base `DatePicker`, so its trigger and the
// month in its popup follow Omarchy's base size (nsh-omarchy draws them at
// Rust constants). Same props and events as nsh-omarchy's.
//
// The look is nsh-omarchy's (components/date_picker.rs), except the width:
// an outline trigger that fills its slot (the caller sizes the slot) and is
// as tall as an Input of its size (HEIGHT_PT), 8pt padding and gap, the
// control border on the rest fill, a hover and pressed wash, the focus
// border for the keyboard and the accent border while the popup is open;
// the picked day as "Nov 19, 2026" (a range "start – end") in 12pt text, the
// placeholder in secondary text, a 14pt chevron. The popup is 12pt padding
// in one border on the popover fill, 4pt from the trigger and 8pt from the
// window's edges, holding the ui Calendar's month. Every size is scaled
// with the base size; at 14 it is drawn as nsh-omarchy's.
//
// nsh/base owns the behavior: Return or Space on the trigger opens it, the
// calendar's keys move and pick, a pick or Escape closes it and gives the
// focus back.
import { signal, Text, View } from "nsh";
import { DatePicker as BaseDatePicker, type DatePickerValue } from "nsh/base";
import { CALENDAR_PARTS, calendarText, type DateRange } from "./Calendar";
import { FieldLabel } from "./Field";
import { scaled } from "./font";
import { Icon } from "./Icon";
import { cx, HEIGHT_PT, TYPE } from "./tokens";

export type { DateRange };

type Size = "small" | "medium" | "large";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `"2026-11-19"` as nsh-omarchy writes it: `"Nov 19, 2026"`; "" for anything else. */
export function dateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "";
  return `${MONTHS[month - 1]} ${Number(m[3])}, ${m[1]}`;
}

export interface DatePickerProps {
  /** The picked day, `null` for none (`"2026-11-19"`). Set, the app owns it and writes back what `onChange` reports; left out, the picker keeps the pick. */
  value?: string | null;
  /** Pick a range: the first press starts it, the second ends it (`rangeValue`, `onRangeChange`). */
  range?: boolean;
  /** The picked range while `range`, `null` for none. Set, the app owns it; left out, the picker keeps it. */
  rangeValue?: DateRange | null;
  /** The first day that can be picked. */
  min?: string | null;
  /** The last day that can be picked. */
  max?: string | null;
  /** It does not open; dimmed. */
  disabled?: boolean;
  /** What the trigger says while nothing is picked (default "Choose a date", "Choose dates" for a range). */
  placeholder?: string | null;
  /** As tall as an Input of the size: `small` (26 points), `medium` (30, the default) or `large` (34), at base 14. */
  size?: Size;
  /** What screen readers call the trigger (default the surrounding Field's label, then "Choose a date"). */
  accessibilityLabel?: string | null;
  /** The user picked a day: the day asked for. */
  onChange?: (event: { value: string }) => void;
  /** The user picked a range's end (while `range`): the range asked for. */
  onRangeChange?: (event: { value: DateRange }) => void;
  testID?: string;
  class?: string;
}

/** A trigger showing the picked day that opens a month below it. */
export function DatePicker(props: DatePickerProps) {
  const field = FieldLabel();
  // The picker's own pick while the app does not hold `value` / `rangeValue`,
  // and a range's first day while its second is not picked yet.
  const ownDay = signal<string | null>(null);
  const ownRange = signal<DateRange | null>(null);
  const started = signal<string | null>(null);
  const day = () => (props.value !== undefined ? props.value : ownDay());
  const span = () => (props.rangeValue !== undefined ? props.rangeValue : ownRange());
  const value = (): DatePickerValue => {
    if (!props.range) return day() ?? null;
    if (started() !== null) return [started(), null];
    const s = span();
    return s ? [s.start, s.end] : [null, null];
  };
  const label = (): string | null => {
    if (!props.range) {
      const d = day();
      return d ? dateLabel(d) || null : null;
    }
    const s = span();
    return s ? `${dateLabel(s.start)} – ${dateLabel(s.end)}` : null;
  };
  const shown = () => label() ?? props.placeholder ?? (props.range ? "Choose dates" : "Choose a date");
  const matcher = () => {
    const min = props.min ?? null;
    const max = props.max ?? null;
    return min || max ? { before: min, after: max } : null;
  };
  return (
    <BaseDatePicker
      testID={props.testID}
      // Fills its slot: the caller gives the slot its width (`flex-1`, a fixed
      // width), and `min-w-0` lets the slot shrink below the label's width.
      class={cx("self-stretch min-w-0", props.class ?? "")}
      value={value()}
      range={!!props.range}
      disabled={!!props.disabled}
      disabledMatcher={matcher()}
      accessibilityLabel={props.accessibilityLabel ?? field?.() ?? "Choose a date"}
      dateFormat="%b %-d, %Y"
      previousAccessibilityLabel="Previous month"
      nextAccessibilityLabel="Next month"
      offset={scaled(4)}
      margin={scaled(8)}
      popupClass={cx("p-3 border border-border bg-popover text-foreground", calendarText())}
      calendarClass="gap-2"
      headerClass={CALENDAR_PARTS.headerClass()}
      rowClass={CALENDAR_PARTS.rowClass}
      itemClass={CALENDAR_PARTS.itemClass()}
      renderItem={CALENDAR_PARTS.renderItem}
      trigger={
        <View
          class={cx(
            "w-full min-w-0 flex-row items-center gap-2 px-3 rounded-(--radius) border border-border bg-background",
            "transition-colors duration-[120ms] ease-out motion-reduce:transition-none",
            "hover:border-rule-strong",
            "aria-expanded:border-primary focus-visible:border-primary",
            "disabled:opacity-50",
          )}
          // Whole points, as Input's: a field beside it lines up at every base size.
          style={{ height: Math.round(scaled(HEIGHT_PT[props.size ?? "medium"])) }}
        >
          <Text
            class={cx(
              "flex-1 min-w-0 line-clamp-1",
              // A field's text, as Input's.
              TYPE.md,
              label() === null || props.disabled ? "text-text-secondary" : "text-foreground",
            )}
          >
            {shown()}
          </Text>
          <Icon name="chevronDown" size={14} class="shrink-0 text-text-secondary" />
        </View>
      }
      onChange={(e) => {
        const picked = e.value;
        if (typeof picked === "string") {
          const d = picked.slice(0, 10);
          ownDay.set(d);
          props.onChange?.({ value: d });
        } else if (Array.isArray(picked)) {
          const [start, end] = picked;
          if (start && end) {
            const next = { start: start.slice(0, 10), end: end.slice(0, 10) };
            started.set(null);
            ownRange.set(next);
            props.onRangeChange?.({ value: next });
          } else {
            started.set(start ? start.slice(0, 10) : null);
          }
        }
      }}
    />
  );
}
