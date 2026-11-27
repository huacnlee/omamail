// A control's label above it and a description or an error below, with
// nsh-omarchy's look (11pt medium secondary label, a danger asterisk when
// required, the note in secondary or danger), built here so its text follows
// Omarchy's base size. Same props as nsh-omarchy's `Field`.
//
// As nsh-omarchy's does, it names the control inside: the ui Input, Textarea,
// NumberInput and Select read the label from `FieldLabel` when they have no
// `accessibilityLabel` of their own (`label:Hostname` finds the input).
import { context, Text, View, type JSX } from "nsh";
import { cx, TYPE } from "./tokens";

/** The label of the Field around a control, if any (a function, so it stays live). */
export const FieldLabel = context<(() => string) | null>(null);

export interface FieldProps {
  /** The label above the control. */
  label: string;
  /** A line below the control on what it takes. */
  description?: string | null;
  /** What is wrong with the value: shown in the danger color in place of the description. */
  error?: string | null;
  /** Marks the label with a danger asterisk: the form needs a value. */
  required?: boolean;
  /** The control. */
  children?: JSX.Element;
  testID?: string;
  class?: string;
}

/** A control's label, and its description or error. */
export function Field(props: FieldProps) {
  const note = () => props.error || props.description || "";
  return (
    <View testID={props.testID} class={cx("gap-1", props.class ?? "")}>
      <View class={cx("flex-row gap-1")}>
        <Text class={cx(TYPE.sm, "font-medium text-text-secondary")}>{props.label}</Text>
        <If when={props.required}>
          <Text accessibilityElementsHidden class={cx(TYPE.sm, "text-danger")}>
            *
          </Text>
        </If>
      </View>
      <FieldLabel.Provider value={() => props.label}>{props.children}</FieldLabel.Provider>
      <If when={note()}>
        <Text class={cx(TYPE.sm, props.error ? "text-danger" : "text-text-secondary")}>{note()}</Text>
      </If>
    </View>
  );
}
