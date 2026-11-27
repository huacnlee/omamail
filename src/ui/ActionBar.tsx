// A bar of actions attached to a pane's edge (the reader's bottom actions,
// a list's batch bar), on nsh/base's Toolbar: one stop of Tab, the arrows
// move between its buttons, Space and Return press. Its buttons are ghost
// controls (Visual language v2): clear at rest, `surface-raised` on hover,
// the selection on press, the selection fill and a stronger border while
// selected (the state is also said to screen readers).
import { context, signal, Text, View, type JSX } from "nsh";
import { TitleBandContext } from "./titleBand";
import { Button as BaseButton, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";
import { Tooltip as OmTooltip } from "./Tooltip";
import { Icon, type IconKey } from "./Icon";
import { CLASS } from "./motion";
import { Spinner } from "./Spinner";
import { cx, FILL, HEIGHT, ICON_SIZE, LINE, PAD_X, RADIUS, SQUARE, TEXT_SIZE, sizedBox, type Size } from "./tokens";

export interface ActionBarProps {
  /** What screen readers call the bar ("Message actions"). */
  label: string;
  /** `bottom` (default): a top hairline, for a bar on a pane's lower edge; `top`: a bottom hairline; `none`. */
  edge?: "bottom" | "top" | "none";
  /** Every button disabled. */
  disabled?: boolean;
  /** `ToolButton`s, `ActionBarGroup`s, `ActionBarSeparator`s, and a `View class="flex-1"` to push the rest to the end. */
  children?: JSX.Element;
  /**
   * The title-band form: a plain row, each button its own Tab stop (as a
   * macOS title bar's items are). Unset, it is the form under a ui
   * `TitleBar`, and the Toolbar elsewhere. STOPGAP, see below.
   */
  inTitleBar?: boolean;
  testID?: string;
}

// While a plain-row bar (the title-band form) is around them: groups and
// separators draw as views, and its `disabled` reaches the buttons.
const PlainBar = context<{ disabled: () => boolean } | null>(null);

export function ActionBar(props: ActionBarProps) {
  const inBand = TitleBandContext();
  const barClass = () =>
    cx(
      sizedBox("h-11", "h", 44), "flex-row items-center gap-1 px-3 bg-background",
      props.edge === "none" ? "" : props.edge === "top" ? "border-b border-divider" : "border-t border-divider",
    );
  // STOPGAP (NSH issue draft: scratchpad nsh-issue-titlebar-press.md, second
  // section): on macOS, inside the hidden title bar's band an nsh/base
  // Toolbar takes presses on its first item only; a centre click on any
  // other is lost. In the band the bar is a plain row instead: a `toolbar`
  // to screen readers, each button its own Tab stop (no arrow keys between
  // them). Back to the Toolbar once NSH fixes it.
  if (props.inTitleBar ?? inBand) {
    return (
      <View testID={props.testID} role="toolbar" accessibilityLabel={props.label} class={barClass()}>
        <PlainBar.Provider value={{ disabled: () => !!props.disabled }}>{props.children}</PlainBar.Provider>
      </View>
    );
  }
  return (
    <Toolbar
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      class={barClass()}
    >
      {props.children}
    </Toolbar>
  );
}

/** A run of related buttons in an `ActionBar`, read as one unit. */
export function ActionBarGroup(props: { label: string; children?: JSX.Element }) {
  if (PlainBar()) {
    return (
      <View role="group" accessibilityLabel={props.label} class={cx("flex-row items-center gap-1")}>
        {props.children}
      </View>
    );
  }
  return (
    <ToolbarGroup accessibilityLabel={props.label} class={cx("flex-row items-center gap-1")}>
      {props.children}
    </ToolbarGroup>
  );
}

/** A hairline between runs of an `ActionBar`. */
export function ActionBarSeparator() {
  if (PlainBar()) return <View class={cx("mx-1 h-4 w-px bg-border")} />;
  return <ToolbarSeparator class={cx("mx-1 h-4 w-px bg-border")} />;
}

export interface ToolButtonProps {
  /** The action ("Archive"). Shown unless `iconOnly`; always what screen readers say. */
  label: string;
  icon?: IconKey;
  /** Only the icon shows; the label becomes the tooltip. */
  iconOnly?: boolean;
  /** `default` or `danger` (destructive: danger text, with an accurate label). Composes with `outline`. */
  variant?: "default" | "danger";
  /** `small` (26pt, default), `medium` (30pt) or `large` (34pt). */
  size?: Size;
  /**
   * Draw the border at rest (`LINE.control`) instead of reserving it clear: for
   * a tool button standing alone in content, whose box must show where it
   * starts (the reader's attachment toggle on the header's edge). Same size,
   * padding, states and icons as the ghost; bars keep the ghost.
   */
  outline?: boolean;
  /** A persistent state is on, or this button's menu is open. */
  selected?: boolean;
  disabled?: boolean;
  /** Working: the loader turns in place of the icon and presses are ignored. */
  loading?: boolean;
  /** The chord shown in the tooltip, from the keymap ("mod-e"). */
  shortcut?: string;
  /** A popup this button opened (its menu, a popover) is open: the tooltip stays hidden, so it never covers the popup. */
  popupOpen?: boolean;
  /** No tooltip (a dialog's close button under the keyboard focus: the first Escape must close the dialog, not the tooltip). */
  hideTooltip?: boolean;
  /** What screen readers call it when the visible label is not the whole name ("Mailbox: ada@example.com. Switch account..."). The label stays the visible text and the tooltip. */
  accessibilityLabel?: string;
  onPress?: () => void;
  testID?: string;
}

/** A ghost button with an icon and a label, for bars and pane headers; `outline` draws its border at rest. */
export function ToolButton(props: ToolButtonProps) {
  const plainBar = PlainBar();
  const size = () => props.size ?? "small";
  // A click hides the tooltip until the pointer leaves (the keyboard is not
  // affected): it said what the
  // button does, and the result (a menu, a dialog) is now on screen.
  const pressedSinceEnter = signal(false);
  const showTip = () =>
    (!!props.iconOnly || !!props.shortcut) && !props.popupOpen && !props.hideTooltip && !pressedSinceEnter();
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel || props.label}
      selected={!!props.selected}
      busy={!!props.loading}
      disabled={!!props.disabled || !!props.loading || !!plainBar?.disabled()}
      onPress={() => props.onPress?.()}
      onMouseUp={() => pressedSinceEnter.set(true)}
      onMouseLeave={() => pressedSinceEnter.set(false)}
      tooltip={showTip() ? <OmTooltip label={props.label} shortcut={props.shortcut ?? null} /> : undefined}
      class={cx(
        "group flex-row items-center justify-center gap-1.5",
        props.iconOnly ? SQUARE[size()] : cx(HEIGHT[size()], PAD_X[size()]),
        RADIUS,
        props.outline ? LINE.control : LINE.clear,
        LINE.focus,
        FILL.hover,
        FILL.pressed,
        "selected:bg-selection selected:border-rule-strong",
        "disabled:opacity-40",
        props.iconOnly ? CLASS.pressIcon : CLASS.press,
        props.variant === "danger" ? "text-danger" : "text-foreground hover:text-bright",
      )}
    >
      <If when={props.loading}>
        <Spinner size={ICON_SIZE[size()]} />
      </If>
      <If when={props.icon && !props.loading}>
        <Icon name={props.icon!} size={ICON_SIZE[size()]} />
      </If>
      <If when={!props.iconOnly}>
        <Text class={cx(TEXT_SIZE[size()], props.variant === "danger" ? "text-danger" : "text-foreground group-hover:text-bright")}>
          {props.label}
        </Text>
      </If>
    </BaseButton>
  );
}

/** Pushes what follows to the bar's end. */
export function ActionBarSpacer() {
  return <View class="flex-1" />;
}
