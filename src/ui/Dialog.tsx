// Dialogs with nsh-omarchy's look on nsh/base, so their titles, text and
// padding follow Omarchy's base size (nsh-omarchy draws them at Rust
// constants). The props are nsh-omarchy's `Dialog`, `AlertDialog` and
// `Sheet`, so features compile unchanged.
//
// nsh/base owns the modal behavior: the dialog role named by the title, the
// focus moved in and kept inside, returned as it goes, Escape and the scrim.
// This file draws (Visual language v2): a 420pt card (surface, one border, a
// shadow, 24pt padding with 16 between title, body and actions, the title
// 16pt semibold bright, the description muted, the actions right-aligned)
// that fades in; a sheet at an edge with a header (24 by 16), a scrolling
// body and a footer over a hairline.
import { Scroll, Text, View, signal, type JSX, type ViewRef } from "nsh";
import { escapeMayClose, imeSafe, useEscapeToClose } from "./overlays-stack";
import { Dialog as BaseDialog, Sheet as BaseSheet } from "nsh/base";
import { ToolButton } from "./ActionBar";
import { Button } from "./Controls";
import { scaled } from "./font";
import { Titled } from "./Titled";
import { cx, LINE, RADIUS, TEXT, TYPE } from "./tokens";

// The scrim takes the window toward `muted` (below the background on Ink and
// Paper alike), so the card on the popover surface, its hairline and shadow
// read as raised above it: modal, with the page still legible behind.
const SCRIM = "bg-muted/70";
const CARD_MOTION = "transition duration-[180ms] ease-out motion-reduce:transition-none";

export interface DialogProps {
  /** The heading, also the dialog's name for screen readers. */
  title: string;
  /** Shown (controlled): write it back in `onOpenChange`. Left out, closed. */
  open?: boolean | null;
  /** Secondary text under the title. */
  description?: string | null;
  /** The actions, right-aligned under the body (buttons). */
  footer?: JSX.Element;
  /** A press on the scrim closes it (default true). */
  closeOnBackdropPress?: boolean;
  /** Escape and the back button close it (default true). */
  closeOnEscape?: boolean;
  /** The body, made on each opening. */
  children?: JSX.Element;
  /** It asks to close (Escape, back, the scrim). */
  onOpenChange?: (event: { open: boolean }) => void;
  /** Its width in points at base size 14 (default 420, scaled). */
  width?: number;
  /** An alert dialog: screen readers say it asks to confirm something. */
  alert?: boolean;
  /** It is shown: move the focus to the action it should start on. */
  onOpen?: () => void;
  /**
   * `default`: a card with its title block. `finder`: a picker (Move to,
   * Label as): no title block; the title sits on the card's top hairline
   * (a Titled frame on the popover surface; its panels inherit it), 12pt padding at the sides and bottom,
   * 20 above and between the caller's panels so their own titles clear (a `FinderPanel` field, then its results). The same
   * modal behavior, named by `title`.
   */
  variant?: "default" | "finder";
  testID?: string;
}

// Escape from a focused field, topmost only, never mid-composition (overlays-stack.ts).
export { useEscapeToClose } from "./overlays-stack";

/** A modal card in the middle of the window. */
export function Dialog(props: DialogProps) {
  useEscapeToClose(
    () => !!props.open && (props.closeOnEscape ?? true),
    () => props.onOpenChange?.({ open: false }),
  );
  return (
    <BaseDialog
      testID={props.testID}
      open={!!props.open}
      animation="fade"
      role={props.alert ? "alertdialog" : "dialog"}
      accessibilityLabel={props.title}
      accessibilityDescription={props.description ?? undefined}
      closeOnEscape={(props.closeOnEscape ?? true) && escapeMayClose()}
      closeOnBackdropPress={props.closeOnBackdropPress ?? !props.alert}
      onOpenChange={imeSafe((e) => props.onOpenChange?.({ open: e.open }))}
      onOpen={() => props.onOpen?.()}
      backdropClass={SCRIM}
      class={cx("flex-1 items-center justify-center p-6")}
    >
      <If when={props.variant === "finder"}>
        <View
          class={cx("max-w-full shadow-lg", RADIUS, TEXT.body, CARD_MOTION)}
          style={{ width: scaled(props.width ?? 420) }}
        >
          <Titled
            testID={props.testID ? `${props.testID}-card` : undefined}
            title={props.title}
            surface="popover"
            // 12 at the sides and bottom; 20 above and between, so a titled
            // panel's title (9pt above its frame) clears the one above it.
            bodyClass={cx("gap-5 px-3 pb-3 pt-5")}
          >
            {props.children}
            <If when={props.footer}>
              <View class={cx("flex-row justify-end gap-2")}>{props.footer}</View>
            </If>
          </Titled>
        </View>
      </If>
      <If when={props.variant !== "finder"}>
      <View
        class={cx("max-w-full gap-4 p-6 bg-popover shadow-lg", RADIUS, LINE.border, TEXT.body, CARD_MOTION)}
        style={{ width: scaled(props.width ?? 420) }}
      >
        <View class="gap-1.5">
          <Text role="header" class={cx(TYPE.lg, "font-semibold text-bright")}>
            {props.title}
          </Text>
          <If when={props.description}>
            <Text class={cx(TYPE.md, "text-text-secondary")}>{props.description}</Text>
          </If>
        </View>
        {props.children}
        <If when={props.footer}>
          <View class={cx("flex-row justify-end gap-2")}>{props.footer}</View>
        </If>
      </View>
      </If>
    </BaseDialog>
  );
}

export interface AlertDialogProps {
  /** The question ("Delete workspace?"). */
  title: string;
  /** The confirming action's label ("Delete"). */
  actionLabel: string;
  /** Shown (controlled): write it back in `onOpenChange`. */
  open?: boolean | null;
  /** What follows from it. */
  description?: string | null;
  /** The cancelling action's label (default "Cancel"). */
  cancelLabel?: string | null;
  /** The confirming action's color: `accent` (default), `success`, `warning` or `danger`. */
  tone?: "accent" | "success" | "warning" | "danger";
  /** It asks to close (an action, Escape or back). */
  onOpenChange?: (event: { open: boolean }) => void;
  /** The user confirmed; the dialog closes. */
  onAction?: () => void;
  testID?: string;
}

/** A question with one action and Cancel; the focus starts on Cancel. */
export function AlertDialog(props: AlertDialogProps) {
  let cancel: ViewRef | undefined;
  return (
    <Dialog
      testID={props.testID}
      title={props.title}
      description={props.description}
      open={props.open}
      alert
      onOpen={() => cancel?.focus()}
      onOpenChange={(e) => props.onOpenChange?.(e)}
      footer={
        <>
          <Button
            ref={(r: ViewRef) => (cancel = r)}
            testID={props.testID ? `${props.testID}-cancel` : undefined}
            label={props.cancelLabel ?? "Cancel"}
            variant="ghost"
            onPress={() => props.onOpenChange?.({ open: false })}
          />
          <Button
            testID={props.testID ? `${props.testID}-action` : undefined}
            label={props.actionLabel}
            variant={props.tone === "danger" ? "danger" : "primary"}
            onPress={() => {
              // The action first: a caller that answers on close knows it was chosen.
              props.onAction?.();
              props.onOpenChange?.({ open: false });
            }}
          />
        </>
      }
    />
  );
}

export interface SheetProps {
  /** The heading, also the panel's name for screen readers. */
  title: string;
  /** Shown (controlled): write it back in `onOpenChange`. */
  open?: boolean | null;
  /** The edge it is on (default `right`). */
  placement?: "top" | "bottom" | "left" | "right";
  /** Secondary text under the title. */
  description?: string | null;
  /** Actions at the bottom of the panel, over a divider (buttons). */
  footer?: JSX.Element;
  /** The close button's label, for screen readers (default "Close"). */
  closeLabel?: string | null;
  /** The content, made on each opening; it scrolls. */
  children?: JSX.Element;
  /** It asks to close (the close button, Escape, back, the scrim). */
  onOpenChange?: (event: { open: boolean }) => void;
  testID?: string;
}

/** A panel at an edge of the window, 360pt across (scaled). */
export function Sheet(props: SheetProps) {
  const side = () => props.placement ?? "right";
  const across = () => (side() === "left" || side() === "right" ? { width: scaled(360) } : { height: scaled(360) });
  const edge = () =>
    ({ right: "border-l", left: "border-r", top: "border-b", bottom: "border-t" })[side()] + " border-border";
  // The close button holds no tooltip under the keyboard focus: the first
  // Escape must close the sheet, not the tooltip.
  const closeFocused = signal(false);
  useEscapeToClose(() => !!props.open, () => props.onOpenChange?.({ open: false }));
  return (
    <BaseSheet
      testID={props.testID}
      open={!!props.open}
      side={side()}
      accessibilityLabel={props.title}
      closeOnEscape={escapeMayClose()}
      onOpenChange={imeSafe((e) => props.onOpenChange?.({ open: e.open }))}
      backdropClass={SCRIM}
      popupClass={cx("bg-popover shadow-lg", edge(), TEXT.body)}
      popupStyle={across()}
    >
      <View class={cx("flex-row items-start gap-2 px-6 py-4")}>
        <View class={cx("flex-1 min-w-0 gap-1.5")}>
          <Text role="header" class={cx(TYPE.lg, "font-semibold text-bright")}>
            {props.title}
          </Text>
          <If when={props.description}>
            <Text class={cx(TYPE.md, "text-text-secondary")}>{props.description}</Text>
          </If>
        </View>
        <View
          onFocusIn={() => closeFocused.set(true)}
          onFocusOut={() => closeFocused.set(false)}
        >
          <ToolButton
            testID={props.testID ? `${props.testID}-close` : undefined}
            label={props.closeLabel ?? "Close"}
            icon="close"
            iconOnly
            shortcut="esc"
            hideTooltip={closeFocused()}
            onPress={() => props.onOpenChange?.({ open: false })}
          />
        </View>
      </View>
      <Scroll class="flex-1 min-h-0">
        <View class={cx("px-6 pb-4")}>{props.children}</View>
      </Scroll>
      <If when={props.footer}>
        <View class={cx("flex-row justify-end gap-2 px-6 py-4 border-t border-border")}>{props.footer}</View>
      </If>
    </BaseSheet>
  );
}
