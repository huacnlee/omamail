// Small helpers around the ui layer's overlays, so features ask the same way
// every time: a confirmation with an accurate action, a menu that opens
// from its trigger and keeps that trigger selected while open, a context
// menu that tells its row it is open, and a tooltip that names the shortcut.
import { signal, View, type JSX } from "nsh";
import { Tooltip as OmTooltip } from "./Tooltip";
import { confirm as askConfirm } from "./Confirm";
import { Button as OmButton } from "./Controls";
import { Dialog as OmDialog } from "./Dialog";
import { ContextMenu as OmContextMenu, Menu as OmMenu } from "./Menu";
import { ToolButton, type ToolButtonProps } from "./ActionBar";
import { cx } from "./tokens";

export interface ConfirmRequest {
  /** The question, naming what it acts on ("Delete 3 messages forever?"). */
  title: string;
  /** What follows from it ("They cannot be recovered."). */
  description?: string;
  /** The action, as a verb on the thing ("Delete forever"); never "OK" or "Yes". */
  actionLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** The action destroys something: the platform marks it. */
  destructive?: boolean;
}

/**
 * Asks before an action that cannot be undone, in the window's ConfirmHost
 * (the platform's alert when none is mounted).
 * True when the user chose the action. An action that can be undone does not
 * ask: it acts and offers Undo in a toast.
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return askConfirm({
    title: request.title,
    description: request.description ?? null,
    actionLabel: request.actionLabel,
    cancelLabel: request.cancelLabel ?? null,
    tone: request.destructive ? "danger" : "accent",
  });
}

/** A tooltip that names the action and its chord, for a control's `tooltip` prop. */
export function ShortcutTooltip(props: { label: string; shortcut?: string | null }) {
  return <OmTooltip label={props.label} shortcut={props.shortcut ?? null} />;
}

export interface MenuButtonProps extends Omit<ToolButtonProps, "selected" | "onPress"> {
  /** The rows: `MenuItem`, `MenuSeparator`, `MenuLabel` (from ../ui). */
  children?: JSX.Element;
  /** The side it opens on (default `bottom`). */
  placement?: "top" | "bottom" | "left" | "right";
  /** How it lines up with the trigger (default `start`). */
  align?: "start" | "center" | "end";
  /** It opened or closed. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * A ghost button that opens a menu on its edge. The button stays selected
 * while the menu is open, so the menu reads as coming from it; Return,
 * Space and Down open it, Escape returns focus to it.
 */
export function MenuButton(props: MenuButtonProps) {
  const open = signal(false);
  return (
    <OmMenu
      open={open()}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      onOpenChange={(e) => {
        open.set(e.open);
        props.onOpenChange?.(e.open);
      }}
      trigger={
        <ToolButton
          testID={props.testID}
          label={props.label}
          accessibilityLabel={props.accessibilityLabel}
          icon={props.icon ?? "more"}
          iconOnly={props.iconOnly}
          size={props.size}
          variant={props.variant}
          disabled={props.disabled}
          loading={props.loading}
          shortcut={props.shortcut}
          selected={open()}
          popupOpen={open()}
        />
      }
    >
      {props.children}
    </OmMenu>
  );
}

export interface ContextMenuAreaProps {
  /** The rows: `MenuItem`, `MenuSeparator`, `MenuLabel`. */
  menu: JSX.Element;
  disabled?: boolean;
  /**
   * The area, given whether its menu is open: draw it selected while open, so
   * the row the menu is about stays marked.
   */
  children: (open: () => boolean) => JSX.Element;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A secondary click, a long press, Shift+F10 or the Menu key opens the menu
 * over its area; the area knows, through `open`, to keep itself selected.
 */
export function ContextMenuArea(props: ContextMenuAreaProps) {
  const open = signal(false);
  return (
    <OmContextMenu
      menu={props.menu}
      disabled={props.disabled}
      onOpenChange={(e) => {
        open.set(e.open);
        props.onOpenChange?.(e.open);
      }}
    >
      {props.children(open)}
    </OmContextMenu>
  );
}

export interface ControlledContextMenuProps {
  /** Open: the caller owns it (close it when the row it is about goes away). */
  open: boolean;
  /** A secondary click, Shift+F10 or the Menu key asks to open; Escape, a press outside or a chosen row asks to close. */
  onOpenChange: (open: boolean) => void;
  /** The rows: `MenuItem`, `MenuSeparator`, `MenuLabel`. */
  menu: JSX.Element;
  disabled?: boolean;
  /** The area: draw it selected while `open`. */
  children: JSX.Element;
  testID?: string;
}

/**
 * A context menu the caller holds open or closed. A secondary click opens it
 * at the pointer; set `open` from the app (a key, the focused row) and it
 * opens below the area with the focus on its first row.
 */
export function ControlledContextMenu(props: ControlledContextMenuProps) {
  return (
    <OmContextMenu
      testID={props.testID}
      open={props.open}
      disabled={!!props.disabled}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      menu={props.menu}
    >
      {props.children}
    </OmContextMenu>
  );
}

export interface Choice {
  /** What `onChoose` reports. */
  id: string;
  /** The verb ("Save", "Discard"): what it does, not "OK". */
  label: string;
  /** primary for the one most people want; danger for one that loses work. */
  tone?: "primary" | "danger" | "default";
  disabled?: boolean;
  /** Working: the button shows its loader and takes no presses. */
  busy?: boolean;
}

export interface ChoiceDialogProps {
  /** The question ("Save this draft?"); the dialog's name for screen readers. */
  title: string;
  /** What each answer does to the work. */
  description?: string;
  open: boolean;
  /** The answers, in reading order before Cancel's opposite end: e.g. Discard, Save. */
  choices: Choice[];
  /** The way back to where they were (default "Cancel"). */
  cancelLabel?: string;
  /** An answer was pressed; the caller closes the dialog (set `open` false) when it is done. */
  onChoose: (id: string) => void;
  /** Cancel, Escape or the scrim: nothing happened. */
  onCancel: () => void;
  testID?: string;
}

/** A question with more than one answer besides Cancel (Save / Discard / Cancel). */
export function ChoiceDialog(props: ChoiceDialogProps) {
  return (
    <OmDialog
      testID={props.testID}
      title={props.title}
      description={props.description ?? null}
      open={props.open}
      onOpenChange={(e) => {
        if (!e.open) props.onCancel();
      }}
      footer={
        <View class={cx("flex-row gap-2")}>
          <OmButton
            testID={props.testID ? props.testID + "-cancel" : undefined}
            label={props.cancelLabel ?? "Cancel"}
            variant="ghost"
            onPress={() => props.onCancel()}
          />
          <Each of={props.choices} key={(c: Choice) => c.id}>
            {(c: () => Choice) => (
              <OmButton
                testID={props.testID ? props.testID + "-" + c().id : undefined}
                label={c().label}
                variant={c().tone === "danger" ? "danger" : c().tone === "primary" ? "primary" : "default"}
                disabled={!!c().disabled}
                loading={!!c().busy}
                onPress={() => props.onChoose(c().id)}
              />
            )}
          </Each>
        </View>
      }
    />
  );
}
