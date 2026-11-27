// A select on nsh/base `Select` in Visual language v2's look, at Omarchy's
// base size. Same props as nsh-omarchy's `Select`.
//
// nsh/base owns the behavior: the trigger opens the list (press, Return,
// Space, Down), Up / Down / Home / End and typeahead move, Return or Space
// choose, Escape and a press outside close, the focus goes back to the
// trigger; screen readers hear the trigger as a combobox with its value.
// This file draws: the trigger (a field: background, hairline, primary
// border while focused or open, the chosen label or the placeholder in muted
// text, a chevron), the popup (one hairline, 4pt padding, a shadow, at most
// 240pt tall), rows 30 tall (the cursor on `surface-raised`, the chosen row
// on the selection fill with a check) and the search field.
import { signal, Text, View } from "nsh";
import { trackOverlay } from "./overlays-stack";
import { Select as BaseSelect } from "nsh/base";
import { controlHeight } from "./Controls";
import { FieldLabel } from "./Field";
import { scaled } from "./font";
import { Icon } from "./Icon";
import { cx, HEIGHT, RADIUS, TYPE, type Size } from "./tokens";

export interface SelectItem {
  /** What choosing it sets the value to: unique among the items. */
  value: string;
  /** What its row and the trigger show, and screen readers say. */
  label: string;
  /** Its section: adjacent items of one group show under this title. */
  group?: string | null;
  /** It cannot be chosen. */
  disabled?: boolean;
}

export interface SelectProps {
  /** The items, in order (`group` sections them). */
  items: SelectItem[];
  /** The chosen item's `value`, `null` for none. Set, the app owns it and writes back what `onChange` reports. */
  value?: string | null;
  /** What the trigger says while nothing is chosen. */
  placeholder?: string | null;
  /** A search field above the items filters them. */
  searchable?: boolean;
  /** `small` (26pt tall), `medium` (30, the default) or `large` (34), at base 14. */
  size?: Size;
  /** It does not open; dimmed. */
  disabled?: boolean;
  /** Draws the danger border. */
  invalid?: boolean;
  /** What the choice is about, for screen readers (`"Theme"`); else the label of the Field around it. */
  accessibilityLabel?: string | null;
  /** The user chose an item: its `value`. */
  onChange?: (event: { value: string }) => void;
  testID?: string;
  class?: string;
}

const TEXT_OF: Record<Size, () => string> = {
  small: () => TYPE.sm,
  medium: () => TYPE.md,
  large: () => TYPE.body,
};

/** One value from a list: a trigger that opens it. */
export function Select(props: SelectProps) {
  const field = FieldLabel();
  // The select's own choice while the app does not hold `value`.
  const own = signal<string | null>(null);
  const chosen = () => (props.value !== undefined ? props.value : own());
  const shown = () => props.items.find((item) => item.value === chosen())?.label ?? null;
  const size = () => props.size ?? "medium";
  // The longest label in characters: about 7.5pt a character at 13pt sans.
  const longest = () => props.items.reduce((n, item) => Math.max(n, item.label.length), 0);
  // Open, for the overlay stack (a select inside a dialog closes first on Escape).
  const listOpen = signal(false);
  trackOverlay(listOpen);
  return (
    <BaseSelect
      onOpenChange={(e) => listOpen.set(e.open)}
      testID={props.testID}
      class={cx("self-start", props.class ?? "")}
      items={props.items.map((item) => ({
        value: item.value,
        title: item.label,
        group: item.group ?? null,
        disabled: !!item.disabled,
      }))}
      value={chosen()}
      placeholder={props.placeholder ?? null}
      searchable={!!props.searchable}
      searchPlaceholder={"Search options…"}
      disabled={!!props.disabled}
      accessibilityLabel={props.accessibilityLabel ?? field?.() ?? null}
      cover={false}
      offset={scaled(4)}
      popupClass={cx("p-1 border border-border bg-popover text-foreground shadow-md", RADIUS)}
      // The popup is the trigger's width at least; a label wider than that
      // widens it up to 320pt, and past that it is cut with an ellipsis.
      popupStyle={{ minWidth: scaled(Math.min(320, Math.max(160, 7.5 * longest() + 56))) }}
      listStyle={{ maxHeight: scaled(240) }}
      renderItem={(item) => (
        <>
          <Text class="flex-1 min-w-0 line-clamp-1">{item.title}</Text>
          {/* The check's lane: fixed, shown only on the chosen item, so labels never shift. */}
          <View
            testID={props.testID ? `${props.testID}-check-${item.value}` : undefined}
            class={cx("shrink-0 items-center justify-center size-4", item.value === chosen() ? "opacity-100" : "opacity-0")}
          >
            <Icon name="check" size={14} class="text-primary" />
          </View>
        </>
      )}
      itemClass={cx(
        "flex-row items-center gap-2 px-3 text-foreground",
        RADIUS,
        HEIGHT.medium,
        TYPE.md,
        "transition-colors duration-[120ms] motion-reduce:transition-none",
        "hover:bg-surface-raised focus:bg-surface-raised",
        "selected:bg-selection selected:text-bright",
        "disabled:text-text-faint disabled:opacity-60",
      )}
      groupClass={cx("px-3 pt-2 pb-1")}
      renderGroup={(g) => <Text class={cx("text-text-secondary font-medium", TYPE.sm)}>{g.title}</Text>}
      searchClass={cx("mb-1 px-3 border border-primary bg-background text-foreground", RADIUS, HEIGHT.medium, TYPE.md)}
      empty={<Text class={cx("px-3 py-2 text-text-secondary", TYPE.md)}>No matching options</Text>}
      onChange={(e) => {
        if (e.value == null) return;
        own.set(e.value);
        props.onChange?.({ value: e.value });
      }}
      trigger={
        <View
          class={cx(
            "flex-row items-center gap-2 px-3 min-w-[160px] border bg-background",
            props.invalid ? "border-danger" : "border-border hover:border-rule-strong",
            controlHeight(size()),
            RADIUS,
            "transition-colors duration-[120ms] motion-reduce:transition-none",
            "active:bg-surface-raised",
            props.invalid ? "" : "focus-visible:border-primary aria-expanded:border-primary",
            "disabled:border-border disabled:opacity-50",
          )}
        >
          <Text
            class={cx(
              "flex-1 min-w-0 line-clamp-1",
              TEXT_OF[size()](),
              props.disabled ? "text-text-secondary opacity-60" : shown() ? "text-foreground" : "text-text-secondary",
            )}
          >
            {shown() ?? props.placeholder ?? ""}
          </Text>
          <Icon name="chevronDown" size={14} class="text-text-secondary" />
        </View>
      }
    />
  );
}
