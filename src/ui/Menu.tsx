// Menus with nsh-omarchy's look on nsh/base, so the rows follow Omarchy's
// base size (nsh-omarchy draws its rows at Rust constants). The props are
// nsh-omarchy's: features keep `<MenuItem label icon shortcut checked danger
// disabled closeOnSelect onSelect />`, `<MenuLabel />`, `<MenuSeparator />`,
// and the `Menu` / `ContextMenu` around them.
//
// nsh/base owns the behavior: the trigger opens it (press, Return, Space,
// Down), arrows / Home / End / typeahead move between rows, Escape and a
// press outside close it, the focus goes back to the trigger. This file
// draws: the popup (surface, one border, 4pt padding, a short fade and rise),
// rows (the hover / cursor wash with accent text, the pressed fill, dimmed
// when disabled), the shortcut at the row's end, an accent check on a
// checked row (kept invisible while unchecked so labels do not shift),
// a 1pt divider and a group heading.
import { keyCapLabel, keyCapParts } from "./Kbd";
import { signal, Text, View, type JSX } from "nsh";
import { trackOverlay } from "./overlays-stack";
import {
  ContextMenu as BaseContextMenu,
  Menu as BaseMenu,
  MenuItem as BaseMenuItem,
  MenuSeparator as BaseMenuSeparator,
} from "nsh/base";
import { Icon as NshIcon } from "nsh-icon";
import * as L from "nsh-icon-lucide";
import { Omarchy, type IconName } from "nsh-omarchy";
import { scaled } from "./font";
import { cx, FILL, LINE, RADIUS, sizedBox, TEXT, TYPE } from "./tokens";

type Placement = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

// ---- The popup ---------------------------------------------------------------

/** The popup every menu here draws: popover fill, one border, a shadow, 4pt padding. */
export function menuPopupClass(): string {
  return cx("min-w-[200px] p-1 bg-popover shadow-md", RADIUS, LINE.border, TEXT.body, MOTION);
}
const MOTION = "transition duration-[180ms] ease-out motion-reduce:transition-none";
/** Its first and last frame: faded and 4pt up (in place under reduced motion). */
export const MENU_HIDDEN = "opacity-0 -translate-y-1 motion-reduce:opacity-100 motion-reduce:translate-y-0";

// ---- Menu and ContextMenu ------------------------------------------------------

export interface MenuProps {
  /** What opens it: a button usually. Press, Return, Space or Down open it. */
  trigger?: JSX.Element;
  /** `MenuItem`, `MenuSeparator`, `MenuLabel`: made on each opening. */
  children?: JSX.Element;
  /** Open (controlled): write back what `onOpenChange` asks for. Left out, the menu keeps it. */
  open?: boolean | null;
  /** The side of the trigger it opens on (below when left out). */
  placement?: Placement;
  /** How it lines up with the trigger (its start when left out). */
  align?: Align;
  /** It asks to open or close: the trigger, a chosen row, Escape or a press outside. */
  onOpenChange?: (event: { open: boolean }) => void;
  testID?: string;
  class?: string;
}

/** A dropdown menu on its trigger. */
export function Menu(props: MenuProps) {
  const shown = signal(false);
  trackOverlay(() => props.open ?? shown());
  return (
    <BaseMenu
      testID={props.testID}
      class={props.class}
      open={props.open}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={scaled(4)}
      margin={scaled(8)}
      popupClass={menuPopupClass()}
      popupStartingClass={MENU_HIDDEN}
      popupEndingClass={MENU_HIDDEN}
      backdropClass="bg-foreground/20"
      onOpenChange={(e) => {
        shown.set(e.open);
        props.onOpenChange?.({ open: e.open });
      }}
      trigger={props.trigger}
    >
      {props.children}
    </BaseMenu>
  );
}

export interface ContextMenuProps {
  /** The menu's rows: `MenuItem`, `MenuSeparator`, `MenuLabel`. */
  menu?: JSX.Element;
  /** A secondary click opens nothing. */
  disabled?: boolean;
  /** Open (controlled), for a menu the app opens itself (a key, the focused row). */
  open?: boolean | null;
  /** The area a secondary click (a long press, Shift+F10, the Menu key) opens it over. */
  children?: JSX.Element;
  /** It asks to open or close: the secondary click, a chosen row, Escape or a press outside. */
  onOpenChange?: (event: { open: boolean }) => void;
  testID?: string;
  class?: string;
}

/** A context menu over its area. */
export function ContextMenu(props: ContextMenuProps) {
  const shown = signal(false);
  trackOverlay(() => props.open ?? shown());
  return (
    <BaseContextMenu
      testID={props.testID}
      open={props.open}
      disabled={!!props.disabled}
      offset={scaled(2)}
      margin={scaled(8)}
      popupClass={menuPopupClass()}
      popupStartingClass={MENU_HIDDEN}
      popupEndingClass={MENU_HIDDEN}
      backdropClass="bg-foreground/20"
      onOpenChange={(e) => {
        shown.set(e.open);
        props.onOpenChange?.({ open: e.open });
      }}
      trigger={<View class={props.class ?? "w-full"}>{props.children}</View>}
    >
      <View>{props.menu}</View>
    </BaseContextMenu>
  );
}

// ---- Rows ----------------------------------------------------------------------

export interface MenuItemProps {
  /** The row's text. */
  label: string;
  /** A glyph before the label, by its Lucide name (`"copy"`). */
  icon?: IconName | null;
  /** A shortcut at the row's end, as the keymap writes it: `"mod-s"` reads `cmd-s` on macOS. */
  shortcut?: string | null;
  /** A checkable row: an accent check at its end while `true`. Left out, the row is not checkable. */
  checked?: boolean | null;
  /** Destructive: danger text. */
  danger?: boolean;
  /** Not choosable; dimmed. */
  disabled?: boolean;
  /** Choosing it closes the menu (`true` when left out; a checkable row stays open). */
  closeOnSelect?: boolean | null;
  /** It was chosen (a press, Return or Space). */
  onSelect?: () => void;
  testID?: string;
  class?: string;
}

/** `"chevron-down"` → Lucide's `ChevronDown`; nothing for a name the set lacks. */
export function lucide(name: string): string | undefined {
  const key = name.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase());
  const svg = (L as unknown as Record<string, unknown>)[key];
  return typeof svg === "string" ? svg : undefined;
}

/** A menu row. */
export function MenuItem(props: MenuItemProps) {
  const checkable = () => props.checked !== undefined && props.checked !== null;
  const tone = () => (props.danger && !props.disabled ? "text-danger" : "text-foreground");
  return (
    <BaseMenuItem
      testID={props.testID}
      disabled={!!props.disabled}
      checked={checkable() ? !!props.checked : null}
      closeOnSelect={props.closeOnSelect ?? !checkable()}
      accessibilityLabel={props.label}
      onSelect={() => props.onSelect?.()}
      class={cx(
        "group flex-row items-center gap-2 px-2",
        sizedBox("h-[30px]", "h", 30),
        RADIUS,
        tone(),
        "transition-colors duration-[120ms] motion-reduce:transition-none",
        "hover:bg-surface-raised focus:bg-surface-raised",
        FILL.pressed,
        "disabled:bg-transparent disabled:text-text-secondary disabled:opacity-60",
        props.class ?? "",
      )}
    >
      <If when={props.icon && lucide(props.icon)}>
        <NshIcon icon={lucide(props.icon!)!} size={scaled(14)} />
      </If>
      <Text class={cx(TYPE.md, "flex-1 line-clamp-1")}>{props.label}</Text>
      <If when={props.shortcut}>
        <View class="pl-4">
          <KeyCaps shortcut={props.shortcut!} />
        </View>
      </If>
      <If when={checkable()}>
        <View class={cx("pl-4 items-center text-primary", props.checked ? "opacity-100" : "opacity-0")}>
          <NshIcon icon={L.Check} size={scaled(12)} />
        </View>
      </If>
    </BaseMenuItem>
  );
}

/** A 1pt divider between groups of rows, 4pt above and below. */
export function MenuSeparator(props: { testID?: string; class?: string }) {
  return <BaseMenuSeparator testID={props.testID} class={cx("h-px my-1 bg-border", props.class ?? "")} />;
}

/**
 * One key cap: mono caption on `surface-raised`, one border, 20 tall, at
 * least 20 wide. (The ui `Kbd` draws the same; this one serves menus and
 * tooltips.)
 */
export function MenuKey(props: { label: string }) {
  return (
    <View class={cx("h-5 min-w-5 px-1.25 items-center justify-center bg-surface-raised", RADIUS, LINE.border)}>
      <Text class={cx(TYPE.sm, TEXT.mono, "text-foreground")}>{props.label}</Text>
    </View>
  );
}

/** A chord as key caps, as the platform writes it (`"mod-s"` → `cmd` `s` on macOS). */
export function KeyCaps(props: { shortcut: string }) {
  const keys = () => keyCapParts(props.shortcut);
  return (
    <View class="flex-row items-center gap-1" accessibilityLabel={keyCapLabel(props.shortcut)}>
      <Each of={keys()} key="index">
        {(key) => <MenuKey label={key()} />}
      </Each>
    </View>
  );
}

/** A group's heading inside a menu: not focusable, not choosable. */
export function MenuLabel(props: { label: string; testID?: string; class?: string }) {
  return (
    <Text
      testID={props.testID}
      role="header"
      class={cx(TEXT.section, "px-2 pt-2 pb-1", props.class ?? "")}
    >
      {props.label}
    </Text>
  );
}
