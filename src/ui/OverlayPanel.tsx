// A modal panel over the window's content area, below its header: the
// shortcut sheet, as the Qt client's ShortcutHelp filled the content
// (`anchors.fill`) at a 96% background. nsh-omarchy's Sheet is a fixed 360pt
// edge panel; this one is as tall as the room below `top`.
//
// Built on nsh/base `Sheet` (bottom edge), which owns what makes it modal:
// the dialog role named by `title`, the focus kept inside and returned as it
// goes, Escape, the backdrop press, and the rise in / fall out (at once under
// reduced motion). The backdrop is clear: the header above stays readable,
// and a press on it closes the panel.
//
// Opening moves the keyboard focus into the panel, onto its scrolling
// content (a stop of its own, so the arrows and the app's j/k scroll it), not
// onto Close: Close's tooltip would take the first Escape. Close shows no
// tooltip while it holds the keyboard focus, for the same reason. While its
// content has the focus, the arrows, Page Up / Page Down, Space, Home and End
// scroll it (keys of the focused view, not app shortcuts).
import { Scroll, signal, Text, View, windowSize, type JSX, type KeyEvent, type ScrollEvent, type ScrollRef } from "nsh";
import { Sheet as BaseSheet } from "nsh/base";
import { ToolButton } from "./ActionBar";
import { escapeMayClose, imeSafe, useEscapeToClose } from "./overlays-stack";
import { scaled } from "./font";
import { cx, LINE, TEXT } from "./tokens";

export interface OverlayPanelProps {
  /** Shown while true (controlled). */
  open: boolean;
  /** It closed: the close button, Escape, a press on the backdrop. Set `open` from it. */
  onOpenChange: (open: boolean) => void;
  /** The heading, and what screen readers call the dialog. */
  title: string;
  /** Points left uncovered at the window's top (the header's height, unscaled). Default 0: the whole window. */
  top?: number;
  /** Beside the close button (a filter field, a count). */
  headerAccessory?: JSX.Element;
  /** The content. It scrolls when taller than the panel (a narrow window); lay it out to the panel's width (`flex-row flex-wrap` columns). */
  children?: JSX.Element;
  /** The content's scroll view, once shown (`scrollTo` for keyboard scrolling). */
  scrollRef?: (ref: ScrollRef) => void;
  /** The content scrolled. */
  onScroll?: (e: ScrollEvent) => void;
  testID?: string;
}

/** A modal panel filling the window below `top`, its content scrolling only when it does not fit. */
export function OverlayPanel(props: OverlayPanelProps) {
  const height = () => Math.max(0, windowSize().height - scaled(props.top ?? 0));
  let scroll: ScrollRef | undefined;
  const closeFocused = signal(false);
  // Escape closes it from a focused field too (a filter in `headerAccessory`).
  useEscapeToClose(() => props.open, () => props.onOpenChange(false));
  // Where the content is, from its own scroll events: what the keys move from.
  let offset = 0;
  let viewport = 0;
  let content = 0;
  const scrollKey = (e: KeyEvent) => {
    const page = Math.max(scaled(40), viewport - scaled(40));
    const line = scaled(40);
    const steps: Record<string, number> = {
      ArrowDown: line,
      ArrowUp: -line,
      PageDown: page,
      PageUp: -page,
      " ": e.modifiers.shift ? -page : page,
      Home: -Infinity,
      End: Infinity,
    };
    const step = steps[e.key];
    if (step === undefined || !scroll) return;
    const max = Math.max(0, content - viewport);
    const y = Math.min(max, Math.max(0, offset + step));
    scroll.scrollTo({ y, animated: true });
  };
  return (
    <BaseSheet
      testID={props.testID}
      open={props.open}
      side="bottom"
      accessibilityLabel={props.title}
      closeOnEscape={escapeMayClose()}
      onOpenChange={imeSafe((e) => props.onOpenChange(e.open))}
      backdropClass="bg-transparent"
      // No top line of its own: it opens below the header, whose bottom
      // divider is the one line between them.
      popupClass={cx("w-full bg-surface shadow-lg")}
      popupStyle={{ height: height() }}
      onOpen={() => scroll?.focus()}
    >
      <View class="flex-1 min-h-0">
        <View class={cx("flex-row items-center gap-2 px-6 py-3 border-b", LINE.divider)}>
          <Text role="header" class={cx(TEXT.title, "flex-1 line-clamp-1")}>
            {props.title}
          </Text>
          {props.headerAccessory}
          <View onFocusIn={() => closeFocused.set(true)} onFocusOut={() => closeFocused.set(false)}>
            <ToolButton
              testID={props.testID ? `${props.testID}-close` : undefined}
              label="Close"
              icon="close"
              iconOnly
              shortcut="esc"
              hideTooltip={closeFocused()}
              onPress={() => props.onOpenChange(false)}
            />
          </View>
        </View>
        <Scroll
          testID={props.testID ? `${props.testID}-content` : undefined}
          ref={(r) => {
            scroll = r;
            props.scrollRef?.(r);
          }}
          onScroll={(e) => {
            offset = e.offset.y;
            viewport = e.size.height;
            content = e.contentSize.height;
            props.onScroll?.(e);
          }}
          onLayout={(e) => (viewport = e.bounds.size.height)}
          onKeyDown={scrollKey}
          focusable
          accessibilityLabel={props.title}
          // The content holds the focus for its scroll keys but draws no ring:
          // the panel itself is the focused thing, and a ring round the whole
          // body after it opens reads as a selection.
          class="flex-1 min-h-0"
        >
          <View class={cx("px-6 py-4")} onLayout={(e) => (content = e.bounds.size.height)}>
            {props.children}
          </View>
        </Scroll>
      </View>
    </BaseSheet>
  );
}
