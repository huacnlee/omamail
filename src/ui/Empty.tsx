// What a pane says while it has nothing (docs/DESIGN.md "States"): what is
// empty and the next relevant action, centered in the pane, on the pane's
// own background. No frame: a pane is already bounded, and a dashed box
// inside it would be a second surface saying nothing.
//
// Only where the blank needs explaining: an empty search, a mailbox with no
// mail, an error. A reader with no message chosen says so once, quietly.
import { createMotion, Text, View, type JSX } from "nsh";
import { Icon, type IconKey } from "./Icon";
import { enterFade } from "./motion";
import { cx, TEXT, TONE_TEXT, type Tone, TYPE } from "./tokens";

export interface EmptyPaneProps {
  /** What is empty, in a few words ("No messages"). */
  title: string;
  /** Why, or what would fill it ("Mail you archive lands here."). */
  description?: string;
  icon?: IconKey;
  /** `neutral` (default) or a status tone for an error or warning; the icon and title carry it, with words. */
  tone?: "neutral" | Tone;
  /** `pane` (default) centers in the pane; `inline` sits at the top of a list's area. */
  layout?: "pane" | "inline";
  /** The next action: one or two `Button`s. */
  actions?: JSX.Element;
  testID?: string;
}

export function EmptyPane(props: EmptyPaneProps) {
  const motion = createMotion({ enter: enterFade() });
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      testID={props.testID}
      style={motion.style}
      role={tone() === "danger" ? "alert" : undefined}
      class={cx(
        "items-center gap-2 px-6",
        props.layout === "inline" ? "py-8" : "flex-1 justify-center py-6",
      )}
    >
      <If when={props.icon}>
        <Icon
          name={props.icon!}
          size={24}
          class={tone() === "neutral" ? "text-text-secondary" : TONE_TEXT[tone() as Tone]}
        />
      </If>
      <Text role="header" class={cx(TYPE.lg, "font-semibold text-foreground text-center")}>
        {props.title}
      </Text>
      <If when={props.description}>
        <Text class={cx(TEXT.caption, "text-center max-w-[320px]")}>{props.description}</Text>
      </If>
      <If when={props.actions}>
        <View class={cx("mt-2 flex-row items-center gap-2")}>{props.actions}</View>
      </If>
    </View>
  );
}
