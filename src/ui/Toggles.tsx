// Checkbox and Switch in Visual language v2's look, on nsh/base, at
// Omarchy's base size. Choices are checkboxes (NsVim's `Check`): a 14pt
// square on the background with a hairline; checked it fills with primary and
// draws a check in on-primary; indeterminate draws a dash. `Switch` keeps
// nsh-omarchy's props and the `switch` role, so screen readers still hear an
// on / off switch, but draws the same box (its own track is not drawn).
//
// The props are nsh-omarchy's: `checked` given, the app owns the value; left
// out, the control keeps its own. The row is 30 tall at least with 12 between
// the box and its 13pt label; the box's edge is the control's edge, and the
// wash (`surface-raised` under the pointer, a primary border for the
// keyboard's focus) reaches 6pt past it. State is never color alone: the check or
// dash is drawn.
import { signal, split, Text, View } from "nsh";
import { Checkbox as BaseCheckbox, Switch as BaseSwitch } from "nsh/base";
import { Icon } from "./Icon";
import { scaled } from "./font";
import { FieldLabel } from "./Field";
import { cx, RADIUS } from "./tokens";

type HostProps = { testID?: string; class?: string };

/**
 * The row both controls share, at the base size. The box's edge is the
 * control's edge, so a checkbox lines up with the fields and text around it;
 * the hover, press and focus wash is an overlay that reaches 6pt past it on
 * both sides (`Wash`).
 */
function rowClass(): string {
  return cx(
    "group relative flex-row self-start items-center text-foreground",
    `min-h-[${scaled(30)}px] gap-[${scaled(12)}px] text-[${scaled(13)}px]`,
    "disabled:opacity-50",
  );
}

/** The wash under the row: drawn past its edges, behind the box and label. */
function Wash() {
  return (
    <View
      class={cx(
        "absolute inset-y-0 -z-10 border border-transparent pointer-events-none",
        `-inset-x-[${scaled(6)}px]`,
        RADIUS,
        "transition-colors duration-[120ms] ease-out motion-reduce:transition-none",
        "group-hover:bg-surface-raised group-focus-visible:bg-surface-raised group-focus-visible:border-primary",
        "group-active:bg-selection group-disabled:bg-transparent",
      )}
    />
  );
}

/** The box: a hairline on the background; primary filled when marked. */
function boxClass(on: boolean): string {
  return cx(
    "shrink-0 items-center justify-center border transition-colors duration-[120ms] ease-out motion-reduce:transition-none",
    RADIUS,
    on ? "border-primary bg-primary" : "border-rule-strong bg-background",
  );
}

/** 14pt at base 14. */
function boxStyle() {
  return { width: scaled(14), height: scaled(14) };
}

/** The mark inside the box: a check, a dash, or nothing. It fills the box, as `<testID>-box`. */
function Mark(props: { checked: boolean; indeterminate: boolean; testID?: string }) {
  return (
    <View testID={props.testID} class="absolute -inset-px items-center justify-center">
      <If when={props.indeterminate}>
        <View class="bg-primary-foreground" style={{ width: scaled(8), height: scaled(2) }} />
      </If>
      <If when={props.checked && !props.indeterminate}>
        <Icon name="check" size={11} class="text-primary-foreground" />
      </If>
    </View>
  );
}

/** A value the app may own: `checked` when given, else the control's own. */
function ownedValue(props: { checked?: boolean | null }) {
  const own = signal(false);
  return {
    get: () => (props.checked == null ? own() : props.checked),
    set: (next: boolean) => {
      if (props.checked == null) own.set(next);
    },
  };
}

export interface CheckboxProps extends HostProps {
  /** The visible label, which screen readers say. */
  label: string;
  /** Checked or not. Set, the app owns it; left out, the checkbox keeps its own (unchecked at first). */
  checked?: boolean | null;
  /** Neither checked nor unchecked: a dash, and a press asks for checked. */
  indeterminate?: boolean;
  /** No presses, dimmed. */
  disabled?: boolean;
  /** What screen readers say in place of the label. */
  accessibilityLabel?: string | null;
  /** A press (a click, a tap, Space or Return) asks for this value. */
  onChange?: (event: { checked: boolean }) => void;
}

/** A square checkbox and its label. */
export function Checkbox(props: CheckboxProps) {
  const [own, rest] = split(props, ["class", "label", "checked", "indeterminate", "disabled", "accessibilityLabel", "onChange"]);
  const value = ownedValue(own);
  const field = FieldLabel();
  const marked = () => value.get() || own.indeterminate === true;
  return (
    <BaseCheckbox
      {...rest}
      checked={value.get()}
      indeterminate={own.indeterminate ?? false}
      disabled={own.disabled ?? false}
      accessibilityLabel={own.accessibilityLabel ?? (own.label !== "" ? own.label : field?.() ?? null)}
      onChange={(e) => {
        value.set(e.checked);
        own.onChange?.(e);
      }}
      class={cx(rowClass(), own.class ?? "")}
      indicatorClass={boxClass(marked())}
      indicatorStyle={boxStyle()}
      indicator={
        <Mark
          checked={value.get()}
          indeterminate={own.indeterminate === true}
          testID={rest.testID ? `${rest.testID}-box` : undefined}
        />
      }
    >
      <Wash />
      <If when={own.label !== ""}>
        <Text>{own.label}</Text>
      </If>
    </BaseCheckbox>
  );
}

export interface SwitchProps extends HostProps {
  /** The visible label, which screen readers say. */
  label: string;
  /** On or off. Set, the app owns it; left out, the switch keeps its own (off at first). */
  checked?: boolean | null;
  /** No presses, dimmed. */
  disabled?: boolean;
  /** What screen readers say in place of the label. */
  accessibilityLabel?: string | null;
  /** A press (a click, a tap, Space or Return) asks for this value. */
  onChange?: (event: { checked: boolean }) => void;
}

/** An on / off setting: the checkbox's box, announced as a switch. */
export function Switch(props: SwitchProps) {
  const [own, rest] = split(props, ["class", "label", "checked", "disabled", "accessibilityLabel", "onChange"]);
  const value = ownedValue(own);
  const field = FieldLabel();
  return (
    <BaseSwitch
      {...rest}
      checked={value.get()}
      disabled={own.disabled ?? false}
      accessibilityLabel={own.accessibilityLabel ?? (own.label !== "" ? own.label : field?.() ?? null)}
      onChange={(e) => {
        value.set(e.checked);
        own.onChange?.(e);
      }}
      class={cx(rowClass(), own.class ?? "")}
      trackClass="hidden"
      thumbClass="hidden"
    >
      <Wash />
      <View testID={rest.testID ? `${rest.testID}-box` : undefined} class={boxClass(value.get())} style={boxStyle()}>
        <Mark checked={value.get()} indeterminate={false} />
      </View>
      <If when={own.label !== ""}>
        <Text>{own.label}</Text>
      </If>
    </BaseSwitch>
  );
}
