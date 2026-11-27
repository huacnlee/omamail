// A small set of named, mutually exclusive options in a row: a view's
// density, the reader's "Original / Plain" switch. Built on nsh/base Tabs, so
// the arrows move between options and screen readers hear a tab list with a
// selected tab. Visual language v2: one hairline frame with hairlines between
// the options; the chosen one is filled with primary (its label in
// on-primary, semibold), the fill sliding natively to it. Never color alone:
// the chosen label is also bold, and screen readers hear "selected".
//
// Every option has a word. An icon may stand beside it, not for it.
import { Text } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { Tooltip as OmTooltip } from "./Tooltip";
import { Icon, type IconKey } from "./Icon";
import { CLASS } from "./motion";
import { cx, HEIGHT, RADIUS, TEXT_SIZE, type Size } from "./tokens";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconKey;
  disabled?: boolean;
  /** What choosing it does, shown on hover and focus ("Shows the sender's layout and images you allowed"). */
  tooltip?: string;
  /** A chord that chooses it, shown in the tooltip ("mod-1"). */
  shortcut?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  /** What screen readers call the set ("Density"). */
  label: string;
  options: readonly SegmentOption<T>[];
  /** The chosen option. Controlled: write `onChange`'s value back. */
  value: T;
  onChange: (value: T) => void;
  /** `small` (26pt, default) or `medium` (30pt). */
  size?: Extract<Size, "small" | "medium">;
  /** Options share the width (`fill`), or each takes its label's (`hug`, default). */
  width?: "hug" | "fill";
  testID?: string;
}

export function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>) {
  const size = () => props.size ?? "small";
  return (
    <Tabs
      testID={props.testID}
      orientation="horizontal"
      accessibilityLabel={props.label}
      // The chosen fill, sliding from one option to the next natively (and at
      // once under reduced motion, which the core honors for indicators).
      indicatorClass="inset-y-0 bg-primary"
      // No frame of its own: each segment draws its part of the one outline,
      // and the pick draws its part in primary, so the fill reaches the
      // silhouette (never an inset box). Hugging, it leaves its cross-axis
      // placement to the parent (a row's items-center centres it).
      class={cx(
        "flex-row items-stretch overflow-hidden",
        HEIGHT[size()],
        RADIUS,
        props.width === "fill" ? "w-full" : "",
      )}
    >
      <Each of={props.options} key={(o) => o.value}>
        {(option, index) => (
          <Tab
            testID={props.testID ? `${props.testID}-${option().value}` : undefined}
            selected={props.value === option().value}
            disabled={!!option().disabled}
            accessibilityLabel={option().label}
            tooltip={
              option().tooltip || option().shortcut ? (
                <OmTooltip label={option().tooltip ?? option().label} shortcut={option().shortcut ?? null} />
              ) : undefined
            }
            onPress={() => {
              if (props.value !== option().value) props.onChange(option().value);
            }}
            class={cx(
              "group flex-row items-center justify-center gap-1.5 px-3 h-full",
              props.width === "fill" ? "flex-1" : "",
              "border-y border-l border-border selected:border-primary",
              index() === props.options.length - 1 ? "border-r" : "",
              "text-text-secondary hover:bg-surface-raised hover:text-foreground",
              "selected:text-primary-foreground selected:hover:bg-transparent",
              "focus-visible:outline focus-visible:outline-primary disabled:opacity-40",
              CLASS.wash,
            )}
          >
            <If when={option().icon}>
              <Icon name={option().icon!} size={14} class={props.value === option().value ? "text-primary-foreground" : "text-text-secondary"} />
            </If>
            <Text
              class={cx(
                TEXT_SIZE[size()],
                props.value === option().value ? "text-primary-foreground font-semibold" : "text-text-secondary group-hover:text-foreground",
              )}
            >
              {option().label}
            </Text>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}

/** The heights of a SegmentedControl's frame, for laying it beside other controls. */
export const SEGMENTED_HEIGHT = {
  get small(): string { return HEIGHT.small; },
  get medium(): string { return HEIGHT.medium; },
};
