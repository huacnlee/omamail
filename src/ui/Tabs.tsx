// Tabs and Tab on nsh/base in Visual language v2's look, at Omarchy's base
// size. Props are nsh-omarchy's: `value` given, the app owns the selection;
// left out, the first enabled tab starts selected and the list keeps it.
//
// `underline` is a row over a hairline: tabs in muted text, the chosen one
// bright and semibold over a 2pt primary underline that slides to it.
// `segmented` is one hairline frame with hairlines between the tabs, the
// chosen one filled with primary (its label on-primary). Hover is
// `surface-raised`; the keyboard draws a primary outline. The chosen tab is
// also announced as selected and drawn bold: never color alone.
import { context, signal, split, Text, untracked, View, type JSX } from "nsh";
import { Tab as BaseTab, Tabs as BaseTabs } from "nsh/base";
import { Icon as NshIcon } from "nsh-icon";
import type { IconName } from "nsh-omarchy";
import { scaled, uiScale } from "./font";
import { lucide } from "./Menu";
import { cx } from "./tokens";

type Size = "small" | "medium" | "large";
const HEIGHT: Record<Size, number> = { small: 26, medium: 30, large: 34 };
const PADDING: Record<Size, number> = { small: 10, medium: 12, large: 14 };
const TEXT_SIZE: Record<Size, number> = { small: 12, medium: 13, large: 14 };

export type TabsVariant = "underline" | "segmented";

interface TabsState {
  current: () => string | null;
  size: () => Size;
  segmented: () => boolean;
  request: (value: string) => void;
  seed: (value: string) => void;
}
const TabsContext = context<TabsState | null>(null);

export interface TabsProps {
  /** The selected tab's `value`. Given, the app owns it; left out, the list keeps it. */
  value?: string | null;
  /** `underline` (the default) or `segmented`. */
  variant?: TabsVariant;
  /** `small` (26), `medium` (30, the default; segmented: 26) or `large` (34), at base 14. */
  size?: Size;
  /** What screen readers call the list ("Sections"). */
  accessibilityLabel?: string | null;
  children?: JSX.Element;
  /** A tab asks to be selected. */
  onChange?: (event: { value: string }) => void;
  testID?: string;
  class?: string;
}

function px(points: number): string {
  return `${uiScale() === 1 ? points : scaled(points)}px`;
}

/** A list of tabs. */
export function Tabs(props: TabsProps) {
  const [own, rest] = split(props, ["value", "variant", "size", "accessibilityLabel", "children", "onChange", "class"]);
  const kept = signal<string | null>(null);
  const current = () => (own.value != null ? own.value : kept());
  const state: TabsState = {
    current,
    size: () => own.size ?? (own.variant === "segmented" ? "small" : "medium"),
    segmented: () => own.variant === "segmented",
    request: (value) => {
      if (untracked(current) === value) return;
      if (own.value == null) kept.set(value);
      own.onChange?.({ value });
    },
    seed: (value) => {
      if (own.value == null && untracked(kept) == null) kept.set(value);
    },
  };
  const segmented = () => own.variant === "segmented";
  return (
    <BaseTabs
      {...rest}
      orientation="horizontal"
      accessibilityLabel={own.accessibilityLabel ?? null}
      class={cx(
        "flex-row",
        segmented()
          ? "items-stretch overflow-hidden rounded-(--radius)"
          : "items-end border-b border-border",
        own.class ?? "",
      )}
      indicatorClass={segmented() ? "inset-y-0 bg-primary" : "bottom-0 bg-primary"}
      indicatorStyle={segmented() ? { top: 0, bottom: 0 } : { bottom: 0, height: scaled(2) }}
    >
      <TabsContext.Provider value={state}>{own.children}</TabsContext.Provider>
    </BaseTabs>
  );
}

export interface TabProps {
  /** What identifies the tab in its list's `value`. */
  value: string;
  /** The tab's text, which screen readers say. */
  label: string;
  /** A glyph before the label, by its Lucide name (`"settings"`). */
  icon?: IconName | null;
  /** Not choosable: no press, skipped by the arrow keys, dimmed. */
  disabled?: boolean;
  /** Content after the label: a count, a badge. */
  suffix?: JSX.Element;
  testID?: string;
  class?: string;
  ref?: unknown;
}

/** One tab of a `Tabs`. */
export function Tab(props: TabProps) {
  const [own, rest] = split(props, ["value", "label", "icon", "disabled", "suffix", "class"]);
  const tabs = TabsContext();
  if (tabs && !untracked(() => own.disabled)) tabs.seed(untracked(() => own.value));
  const size = () => tabs?.size() ?? "medium";
  const segmented = () => tabs?.segmented() ?? false;
  const selected = () => (tabs ? tabs.current() === own.value : false);
  return (
    <BaseTab
      {...(rest as object)}
      selected={selected()}
      disabled={own.disabled ?? false}
      accessibilityLabel={own.label}
      onPress={() => tabs?.request(own.value)}
      class={cx(
        "flex-row items-center justify-center text-text-secondary transition-colors duration-[120ms] motion-reduce:transition-none",
        `h-[${px(HEIGHT[size()])}] px-[${px(PADDING[size()])}] gap-[${px(8)}]`,
        // Segmented: each tab draws its part of the one outline, the pick in primary.
        segmented() ? "border-y border-l border-border last:border-r selected:border-primary" : "",
        selected() ? "" : "hover:bg-surface-raised hover:text-foreground active:bg-selection",
        "focus-visible:outline focus-visible:outline-primary",
        segmented() ? "selected:text-primary-foreground" : "selected:text-bright",
        "disabled:opacity-40 disabled:bg-transparent",
        own.class ?? "",
      )}
    >
      <If when={own.icon != null && lucide(own.icon) !== undefined}>
        <NshIcon icon={lucide(own.icon!)!} size={scaled(14)} />
      </If>
      <Text class={selected() ? "font-semibold" : ""} style={{ fontSize: scaled(TEXT_SIZE[size()]) }}>
        {own.label}
      </Text>
      <View class="flex-row items-center">{own.suffix}</View>
    </BaseTab>
  );
}
