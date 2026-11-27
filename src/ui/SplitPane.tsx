// Resizable panes with the separator docs/DESIGN.md "Split panes" asks
// for: a hairline to see and a wider band to grab (a precision line should
// not demand precision pointing), a subtle accent while dragged, the resize
// cursor across the whole band, and a double click that restores the
// default. The drag itself is nsh/base's: it runs in the core, frame by
// frame, within the panels' minimums, and reports the sizes when it ends.
//
// The stored preference is the caller's: pass the sizes `onResize` reports
// back as the panels' `size`, and on `onReset` pass the proportional default
// again. A window too small for the sizes clamps them for now without
// replacing the preference, because the group shrinks panels in the core.
import { View, type JSX, type PressEvent } from "nsh";
import { ResizablePanel, ResizablePanelGroup, type ResizeHandleContext } from "nsh/base";
import { cx } from "./tokens";

/** The band a handle takes presses and drags in, in points. */
export const SPLIT_HIT = 7;

/** A press that asks the split to go back to its default: a double click. */
export function isResetPress(e: Pick<PressEvent, "clickCount">): boolean {
  return e.clickCount === 2;
}

export interface SplitPaneProps {
  /** `horizontal` (default): panes side by side; `vertical`: one above the other. */
  axis?: "horizontal" | "vertical";
  /** What screen readers say a handle resizes ("Message list width"). */
  label: string;
  /** A locked layout: no drags. */
  disabled?: boolean;
  /** The `SplitPanel`s. */
  children?: JSX.Element;
  /** A drag ended: every visible panel's size, in order. Store them and pass them back. */
  onResize?: (sizes: number[]) => void;
  /** The handle `index` was double-clicked: restore the default sizes. */
  onReset?: (index: number) => void;
  testID?: string;
}

export function SplitPane(props: SplitPaneProps) {
  return (
    <ResizablePanelGroup
      testID={props.testID}
      axis={props.axis ?? "horizontal"}
      disabled={props.disabled}
      handleAccessibilityLabel={props.label}
      // The indicator is the hairline: the border role at rest, the strong
      // rule while the pointer is over the band, the primary while pressed or
      // dragged. The group owns the wider band around it that takes the drag.
      handleClass={cx(
        "bg-divider group-hover:bg-rule-strong group-active:bg-primary",
        "transition-colors duration-[120ms] motion-reduce:transition-none",
      )}
      // A press target as wide as the band, centered on the hairline, for the
      // double click that resets the split.
      renderHandle={(handle: ResizeHandleContext) => (
        <View
          class={handle.axis === "horizontal" ? "absolute inset-y-0 -left-[3px] -right-[3px]" : "absolute inset-x-0 -top-[3px] -bottom-[3px]"}
          onPress={(e) => {
            if (isResetPress(e)) props.onReset?.(handle.index);
          }}
        />
      )}
      onResize={(e) => props.onResize?.(e.sizes)}
    >
      {props.children}
    </ResizablePanelGroup>
  );
}

export interface SplitPanelProps {
  /** The size it wants along the axis (points); without one it shares what is left. */
  size?: number | null;
  /** The smallest it gets (default 100): the size at which its task still works. */
  minSize?: number;
  maxSize?: number | null;
  /** Keeps its size as the window changes (a sidebar); the others share the difference. */
  fixed?: boolean;
  /** Hidden panels release their whole allocation. */
  visible?: boolean;
  children?: JSX.Element;
  testID?: string;
}

/** One pane of a `SplitPane`. Its look is its content's; it only sizes. */
export function SplitPanel(props: SplitPanelProps) {
  return (
    <ResizablePanel
      testID={props.testID}
      size={props.size}
      minSize={props.minSize}
      maxSize={props.maxSize}
      fixed={props.fixed}
      visible={props.visible}
      class="overflow-hidden"
    >
      {props.children}
    </ResizablePanel>
  );
}
