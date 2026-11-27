// The tooltip a control's `tooltip` prop shows above it (`tooltip={<Tooltip
// label="Save" shortcut="mod-s" />}`), in Visual language v2: the surface
// with one border, 8 by 4 padding, a 12pt label and the shortcut as key caps,
// as the platform writes it (`mod-s` is `cmd` `s` on macOS). At most 320
// wide. Every size scales with the base size.
import { Text, View } from "nsh";
import { KeyCaps } from "./Menu";
import { cx, LINE, RADIUS, sizedBox, TYPE } from "./tokens";

export interface TooltipProps {
  /** What it says. */
  label: string;
  /** A shortcut after the label, as key caps, as the platform writes it (`"mod-s"`). */
  shortcut?: string | null;
  testID?: string;
}

/** A tooltip's content, given to a control's `tooltip` prop. */
export function Tooltip(props: TooltipProps) {
  return (
    <View
      testID={props.testID}
      class={cx(
        "flex-row items-center gap-2 px-2 py-1 bg-surface shadow-md",
        sizedBox("max-w-[320px]", "max-w", 320),
        RADIUS,
        LINE.border,
        TYPE.sm,
      )}
    >
      <Text class="text-foreground">{props.label}</Text>
      <If when={props.shortcut != null && props.shortcut !== ""}>
        <KeyCaps shortcut={props.shortcut!} />
      </If>
    </View>
  );
}
