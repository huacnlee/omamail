// A row of a picker or switcher (labels, accounts, the message picker): a
// name with an optional second line, a lead (icon or avatar), and two marks
// that are not the same thing: `cursor`, the row the keyboard is on (a
// border as well as the hover fill), and `selected`, the one in use (the
// selected fill and bold text). Neither is color alone.
//
// It reports how it was pressed: a single click, a double click, or the
// keyboard (0), so a picker can choose on a double click and only move the
// cursor on a single one. Adopted from src/features/mailbox/LabelMenu.tsx.
import { effect, Text, untracked, View, type JSX, type ViewRef } from "nsh";
import { Tooltip as OmTooltip } from "./Tooltip";
import { Icon, type IconKey } from "./Icon";
import { scaled } from "./font";
import { CLASS } from "./motion";
import { ROW_INDENT } from "./Row";
import { cx, FILL, RADIUS, TEXT, TYPE, sizedBox, RING, SELECTED_TEXT } from "./tokens";

export interface PickerRowProps {
  /** The row's name. Plain text: labels and account names come from servers. */
  label: string;
  /** A second line (an address under a name). */
  detail?: string;
  /** The detail is a problem (an account's error): danger text, with words that say so. */
  detailDanger?: boolean;
  icon?: IconKey;
  /** Leading content in place of the icon (an `InitialAvatar`). */
  lead?: JSX.Element;
  /** Nesting level, one indent each (at most 8). */
  depth?: number;
  /** The keyboard's row: a border as well as the hover fill; kept on screen as it moves. */
  cursor?: boolean;
  /** In use (the open account, the current label): the selected fill and bold text. */
  selected?: boolean;
  /**
   * Pressed: `clickCount` 1 for a click, 2 for a double click, 0 for the
   * keyboard. Left out for a row that is a Popover's trigger: the popover
   * takes the press.
   */
  onPress?: (clickCount: number) => void;
  /** Cannot be chosen now (a provider this build lacks): dimmed, no presses or focus, and screen readers say so. Say why nearby. */
  disabled?: boolean;
  /** What screen readers say, when not the label and detail. */
  accessibilityLabel?: string;
  /** Shown on hover (a collapsed rail's footer). */
  tooltip?: string;
  /** Its view, for `measure()` or `reveal()`. */
  rowRef?: (ref: ViewRef) => void;
  testID?: string;
}

export function PickerRow(props: PickerRowProps) {
  // No label and no detail (a collapsed rail's avatar): the lead alone,
  // centred, with no text column or gap beside it.
  const leadOnly = () => !props.label && !props.detail;
  let row: ViewRef | null = null;
  // The keyboard's row stays on screen as the cursor walks a long list.
  effect(() => {
    if (props.cursor) untracked(() => row?.reveal({ vertical: "nearest" }));
  });
  return (
    <View
      ref={(r) => {
        row = r;
        props.rowRef?.(r);
      }}
      testID={props.testID}
      role="button"
      focusable={!props.disabled}
      accessibilityLabel={props.accessibilityLabel ?? (props.detail ? `${props.label}, ${props.detail}` : props.label)}
      accessibilityState={{ selected: !!props.selected, disabled: !!props.disabled }}
      tooltip={props.tooltip ? <OmTooltip label={props.tooltip} /> : undefined}
      onPress={props.onPress && !props.disabled ? (e) => props.onPress!(e.clickCount ?? 0) : undefined}
      class={cx(
        sizedBox("min-h-[30px]", "min-h", 30),
        "flex-row items-center py-1",
        leadOnly() ? "justify-center" : "gap-2 pr-3",
        RADIUS,
        RING.rest,
        RING.focus,
        // Selected wins over hover: the selection fill, never the hover wash.
        props.disabled ? "opacity-40" : cx(props.selected ? FILL.selected : FILL.hover, FILL.pressed),
        props.disabled && props.selected ? FILL.selected : "",
        CLASS.wash,
        // The keyboard's row in a picker: the hover fill, as a menu's cursor
        // (the selection keeps its own fill; no ring, which would read as a
        // second selection).
        props.cursor && !props.selected ? FILL.raised : "",
      )}
      style={leadOnly() ? { paddingLeft: scaled(7), paddingRight: scaled(7) } : { paddingLeft: scaled(11 + Math.min(8, props.depth ?? 0) * ROW_INDENT) }}
    >
      <If
        when={props.lead}
        else={
          <View class={cx("size-4 items-center justify-center")}>
            <If when={props.icon}>
              <Icon name={props.icon!} size={14} class="text-text-secondary" />
            </If>
          </View>
        }
      >
        {props.lead}
      </If>
      <If when={!leadOnly()}>
      <View class="flex-1">
        <Text class={cx(TYPE.md, "line-clamp-1", props.selected ? SELECTED_TEXT : "text-foreground")}>
          {props.label}
        </Text>
        <If when={props.detail}>
          <Text class={cx(TYPE.sm, "line-clamp-1", props.detailDanger ? TEXT.danger : "text-text-secondary")}>
            {props.detail}
          </Text>
        </If>
      </View>
      </If>
    </View>
  );
}
