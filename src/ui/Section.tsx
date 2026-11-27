// A section's heading inside a pane or a sidebar: caption size, muted,
// sentence case (no uppercase tracking), with an optional trailing control (a count, an add
// button) on the same baseline. Screen readers hear it as a header.
import { Text, View, type JSX } from "nsh";
import { cx, TEXT, HEIGHT } from "./tokens";

export interface SectionHeadingProps {
  /** The section's name ("Labels"). */
  label: string;
  /** `inset` (default) lines up with rows' text lane; `flush` starts at the pane's edge. */
  inset?: "row" | "flush";
  /** A control or mark at the end: a CountBadge, an IconButton. */
  trailing?: JSX.Element;
  testID?: string;
}

export function SectionHeading(props: SectionHeadingProps) {
  return (
    <View
      testID={props.testID}
      class={cx(HEIGHT.medium, "flex-row items-center gap-2", props.inset === "flush" ? "px-0" : "px-3")}
    >
      <Text role="header" class={cx(TEXT.section, "flex-1 line-clamp-1")}>
        {props.label}
      </Text>
      {props.trailing}
    </View>
  );
}
