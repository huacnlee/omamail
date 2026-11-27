// Counts and the unread dot: the two small marks rows carry in their
// trailing lanes. Neither is the only sign of what it says: a count is
// digits, and the unread dot comes with the row's heavier weight.
import { Text, View } from "nsh";
import { cx, TEXT, TYPE } from "./tokens";

/** A count as a badge writes it: "" for none, `cap+` past the cap (Model.js badgeText). */
export function badgeText(count: number, cap = 99): string {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  const limit = Math.max(1, Math.floor(Number(cap) || 99));
  if (value === 0) return "";
  return value > limit ? `${limit}+` : String(value);
}

export interface CountBadgeProps {
  count: number;
  /** The largest number written out (default 999, the sidebar's). */
  cap?: number;
  /** `accent` (default): a count worth noticing, in the accent and bold; `quiet`: secondary text. */
  variant?: "accent" | "quiet";
  /** What screen readers say after the number ("unread"). */
  noun?: string;
  testID?: string;
}

/**
 * A count in a row's suffix lane, right-aligned in tabular digits. It draws
 * nothing at zero: a row without a count keeps its lane through its own
 * layout, not through an empty badge.
 */
export function CountBadge(props: CountBadgeProps) {
  const text = () => badgeText(props.count, props.cap ?? 999);
  return (
    <If when={text() !== ""}>
      <Text
        testID={props.testID}
        accessibilityLabel={props.noun ? `${text()} ${props.noun}` : text()}
        class={cx(
          TYPE.sm, "text-right",
          TEXT.mono,
          props.variant === "quiet" ? "text-text-secondary" : "text-primary font-bold",
        )}
      >
        {text()}
      </Text>
    </If>
  );
}

export interface UnreadDotProps {
  /** Unread: the dot shows. Read, it keeps its lane and draws nothing, so text does not move. */
  unread: boolean;
  /** `small` (5pt, a collapsed rail's corner) or `medium` (6pt, a list row's lead; the default). */
  size?: "small" | "medium";
  testID?: string;
}

/** The unread mark: an accent dot in a fixed lane, named for screen readers while shown. */
export function UnreadDot(props: UnreadDotProps) {
  return (
    <View
      testID={props.testID}
      class={cx(
        "rounded-full bg-primary transition-opacity duration-[120ms] motion-reduce:transition-none",
        props.size === "small" ? "size-[5px]" : "size-1.5",
      )}
      style={{ opacity: props.unread ? 1 : 0 }}
      accessibilityLabel={props.unread ? "Unread" : undefined}
      accessibilityElementsHidden={!props.unread}
    />
  );
}
