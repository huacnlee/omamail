// A value stepped one notch at a time: − value + inside one hairline frame,
// 26pt tall (Visual language v2, NsVim's stepper). The app owns the value and
// writes back what `onStep` asks for; it also decides the bounds (a button
// whose step the app refuses still presses, so pass `disabled` at a bound).
//
// The buttons say what they do ("Decrease Font size") and the value is read
// with them; the value is mono so its width holds while it changes.
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon } from "./Icon";
import { cx, LINE, RADIUS, sizedBox, TEXT, TYPE } from "./tokens";

export interface StepperProps {
  /** What is stepped, for screen readers ("Font size"). */
  name: string;
  /** The value as shown ("14 pt"). */
  value: string;
  /** A button asks to step down (-1) or up (1). */
  onStep: (dir: -1 | 1) => void;
  /** Neither button presses; dimmed. */
  disabled?: boolean;
  testID?: string;
}

function StepButton(props: { dir: -1 | 1; name: string; disabled: boolean; onStep: (dir: -1 | 1) => void; testID?: string }) {
  return (
    <BaseButton
      testID={props.testID}
      disabled={props.disabled}
      accessibilityLabel={`${props.dir < 0 ? "Decrease" : "Increase"} ${props.name}`}
      onPress={() => props.onStep(props.dir)}
      class={cx(
        "items-center justify-center h-full text-foreground",
        sizedBox("w-[28px]", "w", 28),
        "transition-colors duration-[120ms] motion-reduce:transition-none",
        "hover:bg-surface-raised active:bg-selection focus-visible:outline focus-visible:outline-primary",
        "disabled:opacity-40",
      )}
    >
      <Icon name={props.dir < 0 ? "minus" : "plus"} size={14} />
    </BaseButton>
  );
}

/** − value +: one notch at a time. */
export function Stepper(props: StepperProps) {
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.name}
      class={cx("flex-row self-start items-stretch bg-background overflow-hidden", LINE.border, RADIUS, sizedBox("h-[26px]", "h", 26))}
    >
      <StepButton
        dir={-1}
        name={props.name}
        disabled={!!props.disabled}
        onStep={props.onStep}
        testID={props.testID ? `${props.testID}-down` : undefined}
      />
      <View
        class={cx(
          "items-center justify-center border-x border-border",
          sizedBox("min-w-[64px]", "min-w", 64),
          sizedBox("px-[8px]", "px", 8),
          props.disabled ? "opacity-50" : "",
        )}
      >
        <Text class={cx(TYPE.md, TEXT.mono, "text-foreground")}>{props.value}</Text>
      </View>
      <StepButton
        dir={1}
        name={props.name}
        disabled={!!props.disabled}
        onStep={props.onStep}
        testID={props.testID ? `${props.testID}-up` : undefined}
      />
    </View>
  );
}
