// Settings and setup pages' building blocks, moved here from accounts and
// settings: a titled section, a row of words beside (or above) a control, a
// hint under a control, and a disclosure that shows or hides more. Token-only
// classes; text is plain.
import { Text, View, type JSX, type ViewRef } from "nsh";
import { Icon } from "./Icon";
import { CLASS } from "./motion";
import { SectionHeading } from "./Section";
import { cx, FILL, HEIGHT, LINE, RADIUS, TEXT, sizedBox } from "./tokens";

export interface SettingSectionProps {
  /** Its heading. */
  title: string;
  /** The section's view, to scroll it into view (`reveal()`). */
  viewRef?: (ref: ViewRef) => void;
  children?: JSX.Element;
  testID?: string;
}

/** A section of settings: a heading over its rows. */
export function SettingSection(props: SettingSectionProps) {
  return (
    <View testID={props.testID} ref={(ref: ViewRef) => props.viewRef?.(ref)} class={cx("gap-1 pt-6")}>
      <SectionHeading label={props.title} inset="flush" />
      <View>{props.children}</View>
    </View>
  );
}

export interface SettingRowProps {
  title: string;
  /** What it costs or means, under the title. */
  description?: string;
  /** The control sits under the words, not beside them (a wide field). */
  stacked?: boolean;
  /** The control. */
  children?: JSX.Element;
  testID?: string;
}

/**
 * A setting: its name and what it means on the left, the control on the
 * right (or under the words), at least 44pt tall, a hairline under it.
 */
export function SettingRow(props: SettingRowProps) {
  return (
    <View
      testID={props.testID}
      class={cx(
        sizedBox("min-h-11", "min-h", 44),
        "py-2.5 border-b border-border",
        props.stacked ? "gap-2" : "flex-row items-center gap-6",
      )}
    >
      <View class={cx("gap-0.5", props.stacked ? "" : "flex-1")}>
        <Text class={TEXT.body}>{props.title}</Text>
        <If when={props.description}>
          <Text class={cx(TEXT.caption, "leading-relaxed")}>{props.description}</Text>
        </If>
      </View>
      {props.children}
    </View>
  );
}

export interface HintProps {
  text: string;
  /** `danger` and `warning` tint it; the words must say it too. */
  tone?: "default" | "danger" | "warning";
  testID?: string;
}

/** Words under a control: a cost, a limit, an outcome. */
export function Hint(props: HintProps) {
  return (
    <Text
      testID={props.testID}
      class={cx(
        TEXT.caption,
        "leading-relaxed",
        props.tone === "danger" ? TEXT.danger : props.tone === "warning" ? TEXT.warning : "",
      )}
    >
      {props.text}
    </Text>
  );
}

export interface DisclosureProps {
  /** Shown (controlled). */
  open: boolean;
  /** Its label while closed ("Show advanced settings"). */
  label: string;
  /** Its label while open (default `label`). */
  openLabel?: string;
  onToggle: () => void;
  /** What it shows while open, under it. */
  children?: JSX.Element;
  testID?: string;
}

/** A chevron and a label that show or hide more; screen readers hear it expanded or collapsed. */
export function Disclosure(props: DisclosureProps) {
  return (
    <View class={cx("gap-2")}>
      <View class="flex-row">
        <View
          testID={props.testID}
          focusable
          role="button"
          accessibilityLabel={props.open ? (props.openLabel ?? props.label) : props.label}
          accessibilityState={{ expanded: props.open }}
          onPress={() => props.onToggle()}
          class={cx(
            "flex-row items-center gap-1.5 pl-1 pr-2",
            HEIGHT.small,
            RADIUS,
            LINE.clear,
            LINE.focus,
            FILL.hover,
            FILL.pressed,
            CLASS.wash,
          )}
        >
          <Icon name={props.open ? "chevronDown" : "chevronRight"} size={14} class="text-text-secondary" />
          <Text class={TEXT.body}>{props.open ? (props.openLabel ?? props.label) : props.label}</Text>
        </View>
      </View>
      <If when={props.open}>{props.children}</If>
    </View>
  );
}
