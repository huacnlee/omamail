// A standalone resize handle for one pane's edge (the assistant dock's left
// edge), for a pane whose size the app owns rather than a ResizablePanelGroup.
// Same look as SplitPane's: a hairline to see in a 7-point band to grab, the
// resize cursor across the band, the accent while pressed or dragged.
//
// While dragged, a guide line follows the pointer on the UI thread (a `pan`
// bound to an animated value), and the pane's size is committed once, on
// release: re-laying a pane's content at every frame is what makes resizing
// feel heavy. A double click restores `defaultSize`. From the keyboard the
// handle is one Tab stop: the arrows step the size (Shift for larger steps),
// Home and End go to the limits, Return restores the default. Screen readers
// hear an adjustable control with its value and limits.
import { createAnimatedValue, signal, View } from "nsh";
import { cx } from "./tokens";

/** Points one arrow press moves the edge; Shift moves four times as far. */
export const SPLIT_STEP = 16;

/** The size a drag of `delta` points gives, within the limits. */
export function resizedSize(size: number, delta: number, grow: 1 | -1, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, size + grow * delta)));
}

export interface SplitHandleProps {
  /** What screen readers say it resizes ("Assistant width"). */
  label: string;
  /** `vertical` (default): a vertical band dragged left and right; `horizontal`: dragged up and down. */
  orientation?: "vertical" | "horizontal";
  /** The pane's size now, in points (controlled). */
  size: number;
  min: number;
  max: number;
  /** Where a double click or Return puts it back. */
  defaultSize: number;
  /**
   * Which way grows the pane: `1` when dragging right (down) grows it (a
   * handle on the pane's right or bottom edge), `-1` when dragging left (up)
   * does (a handle on its left edge: a dock on the right of the window).
   */
  grow: 1 | -1;
  /** A drag ended, a key moved it, or it was reset: the new size, within the limits. Write it back as `size`. */
  onResize: (size: number) => void;
  /** It was reset to `defaultSize` (after `onResize` with that size). */
  onReset?: () => void;
  /** Pressed or dragged, and released. */
  onActiveChange?: (active: boolean) => void;
  /**
   * Where the hairline sits in the band: `center` (default), or on its `start`
   * / `end` edge (left / right, top / bottom) so it meets a neighbouring
   * pane's own borders. The band, guide and focus ring stay where they are.
   */
  line?: "center" | "start" | "end";
  disabled?: boolean;
  testID?: string;
}

export function SplitHandle(props: SplitHandleProps) {
  const vertical = () => (props.orientation ?? "vertical") === "vertical";
  // Where the guide is drawn, relative to the hairline: driven by the drag.
  const guide = createAnimatedValue(0);
  const dragging = signal(false);
  const set = (next: number) => {
    const clamped = resizedSize(next, 0, 1, props.min, props.max);
    if (clamped !== props.size) props.onResize(clamped);
  };
  const reset = () => {
    set(props.defaultSize);
    props.onReset?.();
  };

  return (
    <View
      testID={props.testID}
      role="adjustable"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: props.min, max: props.max, now: Math.round(props.size) }}
      accessibilityActions={[
        { name: "increment", label: "Wider" },
        { name: "decrement", label: "Narrower" },
        { name: "activate", label: "Reset to default" },
      ]}
      onAccessibilityAction={(e) => {
        if (e.actionName === "increment") set(props.size + SPLIT_STEP);
        else if (e.actionName === "decrement") set(props.size - SPLIT_STEP);
        else if (e.actionName === "activate") reset();
      }}
      focusable={!props.disabled}
      pan={props.disabled ? undefined : vertical() ? { x: guide } : { y: guide }}
      onPanStart={() => {
        dragging.set(true);
        props.onActiveChange?.(true);
      }}
      onPanEnd={(e) => {
        dragging.set(false);
        props.onActiveChange?.(false);
        guide.set(0);
        if (e.cancelled) return;
        const delta = vertical() ? e.translation.x : e.translation.y;
        set(resizedSize(props.size, delta, props.grow, props.min, props.max));
      }}
      onPress={(e) => {
        if (!props.disabled && e.clickCount === 2) reset();
      }}
      onKeyDown={(e) => {
        if (props.disabled) return;
        const step = e.modifiers.shift ? SPLIT_STEP * 4 : SPLIT_STEP;
        // "Forward" along the axis is right or down; `grow` says whether that widens.
        const forward = vertical() ? "ArrowRight" : "ArrowDown";
        const backward = vertical() ? "ArrowLeft" : "ArrowUp";
        if (e.key === forward) set(props.size + props.grow * step);
        else if (e.key === backward) set(props.size - props.grow * step);
        else if (e.key === "Home") set(props.min);
        else if (e.key === "End") set(props.max);
        else if (e.key === "Enter") reset();
      }}
      class={cx(
        "group items-center justify-center border border-transparent focus-visible:border-primary",
        vertical() ? "w-[7px] self-stretch" : "h-[7px] self-stretch",
        props.disabled ? "opacity-40" : vertical() ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      {/* The hairline. */}
      <View
        style={hairlineEdge(vertical(), props.line ?? "center")}
        class={cx(
          (props.line ?? "center") === "center"
            ? vertical() ? "h-full w-px" : "w-full h-px"
            : vertical() ? "absolute w-px" : "absolute h-px",
          dragging()
            ? "bg-primary"
            : "bg-divider group-hover:bg-rule-strong group-active:bg-primary",
          "transition-colors duration-[120ms] motion-reduce:transition-none",
        )}
      />
      {/* The guide: where the edge will land, following the pointer while dragged. */}
      <If when={dragging()}>
        <View
          class={cx("absolute bg-primary", vertical() ? "inset-y-0 w-px" : "inset-x-0 h-px")}
          style={{ transform: vertical() ? [{ translateX: guide }] : [{ translateY: guide }] }}
        />
      </If>
    </View>
  );
}

// On an edge, the hairline lies over the band's 1pt reserved border so it
// touches the neighbour: the focus ring draws over it when focused.
function hairlineEdge(vertical: boolean, line: "center" | "start" | "end") {
  if (line === "center") return undefined;
  const side = vertical ? (line === "start" ? "left" : "right") : line === "start" ? "top" : "bottom";
  return vertical ? { [side]: -1, top: -1, bottom: -1 } : { [side]: -1, left: -1, right: -1 };
}
