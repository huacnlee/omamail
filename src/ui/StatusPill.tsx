// A small filled label naming a place or a state: the status line's
// `INBOX`, `COMPOSE`, `SETTINGS` (docs/DESIGN.md, Visual language v2). The
// label is drawn as given; callers pass the words. Its tone is a fill, and
// the words say the state, so it never rests on color alone.
import { Text, View } from "nsh";
import { cx, RADIUS, sizedBox, TYPE } from "./tokens";

export type StatusPillTone = "primary" | "danger" | "warning" | "success";

const FILL: Record<StatusPillTone, string> = {
  primary: "bg-primary",
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
};

export interface StatusPillProps {
  /** What it says, as given ("INBOX"). */
  label: string;
  /** Its fill (default primary). */
  tone?: StatusPillTone;
  testID?: string;
  class?: string;
}

/** A filled pill: on-primary text on the tone's fill, 20 tall (it can stretch). */
export function StatusPill(props: StatusPillProps) {
  return (
    <View
      testID={props.testID}
      class={cx(
        "justify-center px-2",
        sizedBox("min-h-[20px]", "min-h", 20),
        RADIUS,
        FILL[props.tone ?? "primary"],
        props.class ?? "",
      )}
    >
      <Text class={cx(TYPE.sm, "font-semibold text-primary-foreground")}>{props.label}</Text>
    </View>
  );
}
