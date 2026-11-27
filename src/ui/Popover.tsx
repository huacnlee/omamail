// The ui Popover: nsh-omarchy's look (surface, one border, 12pt padding, a
// fade and 4pt rise in), on nsh/base Popover so it can take a width and
// follow the base size. nsh-omarchy's own popover is 200-320pt wide with no
// way to change it; a contacts list or a date panel needs its own width.
// Same props as nsh-omarchy's Popover, plus `width`; a `title` is set on
// the top edge of its border (Titled), not as a heading block.
import { HoverCard as BaseHoverCard, Popover as BasePopover } from "nsh/base";
import { signal, type JSX } from "nsh";
import { escapeMayClose, imeSafe, trackOverlay } from "./overlays-stack";
import { scaled } from "./font";
import { Titled } from "./Titled";
import { cx, LINE, RADIUS, TEXT } from "./tokens";

type Placement = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

export interface PopoverProps {
  /** What toggles it: a button usually. */
  trigger?: JSX.Element;
  /** The content, made on each opening. */
  children?: JSX.Element;
  /** Its title, set on the top edge of its border (a Titled frame on the popover surface; Visual language v2). */
  title?: string | null;
  /** Open (controlled): write it back in `onOpenChange`. Left out, the popover keeps it. */
  open?: boolean | null;
  /** The side of the trigger it opens on (below when left out). */
  placement?: Placement;
  /** How it lines up with the trigger (centered when left out). */
  align?: Align;
  /** Its width in points at base size 14 (scaled). Left out: as wide as its content, 200 to 320. */
  width?: number;
  /** Its content's own padding (default true: 12pt; false for a list that pads its rows). */
  padded?: boolean;
  /** It asks to open or to close (Escape, back, a press outside, its trigger). */
  onOpenChange?: (event: { open: boolean }) => void;
  testID?: string;
}

const MOTION = "transition duration-[140ms] ease-out motion-reduce:transition-none";
const HIDDEN = "opacity-0 -translate-y-1 motion-reduce:translate-y-0";

/** An anchored, non-modal surface: a press outside and Escape close it, the focus goes back to the trigger. */
export function Popover(props: PopoverProps) {
  // Its own open state while the app does not hold `open`: the overlay stack needs it.
  const shown = signal(false);
  trackOverlay(() => props.open ?? shown());
  return (
    <BasePopover
      testID={props.testID}
      open={props.open}
      closeOnEscape={escapeMayClose()}
      placement={props.placement}
      align={props.align}
      offset={scaled(4)}
      margin={scaled(8)}
      onOpenChange={imeSafe((e) => {
        shown.set(e.open);
        props.onOpenChange?.({ open: e.open });
      })}
      trigger={props.trigger}
      popupClass={cx(
        // Titled: the frame is the Titled panel's own (its title on the
        // border), so the popup draws no border or padding of its own.
        props.title ? "" : cx(props.padded === false ? "" : "p-3", "gap-2", LINE.border),
        "bg-popover shadow-md",
        RADIUS,
        TEXT.body,
        MOTION,
      )}
      popupStyle={
        props.width != null
          ? { width: scaled(props.width) }
          : { minWidth: scaled(200), maxWidth: scaled(320) }
      }
      popupStartingClass={HIDDEN}
      popupEndingClass="opacity-0"
    >
      <If when={props.title} else={props.children}>
        <Titled
          testID={props.testID ? `${props.testID}-frame` : undefined}
          title={props.title ?? ""}
          surface="popover"
          // Unpadded (a list), the content still stops inside the 1pt frame.
          bodyClass={cx(props.padded === false ? "pt-3 px-px pb-px" : "p-3", "gap-2")}
        >
          {props.children}
        </Titled>
      </If>
    </BasePopover>
  );
}

export interface HoverCardProps {
  /** What it previews; it keeps its own role and presses. */
  trigger?: JSX.Element;
  /** The content, made on each opening. */
  children?: JSX.Element;
  /** The side of the trigger it opens on (below when left out). */
  placement?: Placement;
  /** It asks to open or to close. */
  onOpenChange?: (event: { open: boolean }) => void;
  testID?: string;
}

/**
 * nsh-omarchy's HoverCard at the base size: a 280pt card (scaled) on the
 * popover's surface that opens after the pointer rests 400ms on the trigger
 * and closes 200ms after it leaves both, as nsh-omarchy's does.
 */
export function HoverCard(props: HoverCardProps) {
  return (
    <BaseHoverCard
      testID={props.testID}
      placement={props.placement}
      openDelay={400}
      closeDelay={200}
      offset={scaled(4)}
      margin={scaled(8)}
      onOpenChange={(e) => props.onOpenChange?.({ open: e.open })}
      trigger={props.trigger}
      popupClass={cx("p-3 gap-2 bg-popover shadow-md", RADIUS, LINE.border, TEXT.body, MOTION)}
      popupStyle={{ width: scaled(280) }}
      popupStartingClass={HIDDEN}
      popupEndingClass="opacity-0"
    >
      {props.children}
    </BaseHoverCard>
  );
}
