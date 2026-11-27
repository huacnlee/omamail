// Shapes of what is coming, so a pane does not jump when it lands
// (ListSkeleton.qml, ReaderSkeleton.qml). A word like "Opening..." says
// nothing the click did not already say.
//
// One animated value breathes a whole skeleton: running one per bar would put
// a dozen animations on the screen to say a single thing. It rests under
// reduced motion and stops when the skeleton goes.
import { cleanup, createAnimatedValue, reduceMotion, View, type JSX } from "nsh";
import { PULSE_MS } from "./motion";
import { cx, FILL, RADIUS } from "./tokens";

/** The shared breath: from 0.45 to 1 and back, eased, for as long as it is shown. */
function usePulse() {
  const pulse = createAnimatedValue(1);
  if (!reduceMotion()) {
    pulse.set(0.45);
    void pulse.keyframes([0.45, 1, 0.45], { duration: PULSE_MS * 2, iterations: "infinite", easing: "easeInOut" });
  }
  cleanup(() => void pulse.stop());
  return pulse;
}

export interface SkeletonBarProps {
  /** Width as a fraction of the line (0..1). */
  width: number;
  /** Height in points. */
  height: number;
}

/** One placeholder line. Use it inside a `Skeleton`, which breathes it. */
export function SkeletonBar(props: SkeletonBarProps) {
  return (
    <View
      class={cx(FILL.ghost, RADIUS)}
      style={{ width: `${Math.max(0.01, Math.min(1, props.width)) * 100}%`, height: props.height }}
    />
  );
}

export interface SkeletonProps {
  /** What screen readers hear is loading ("Loading messages"). */
  label: string;
  children?: JSX.Element;
  testID?: string;
}

/** A group of placeholder shapes breathing together, announced as loading. */
export function Skeleton(props: SkeletonProps) {
  const pulse = usePulse();
  return (
    <View
      testID={props.testID}
      role="progressbar"
      accessibilityLabel={props.label}
      accessibilityState={{ busy: true }}
      style={{ opacity: pulse }}
    >
      {props.children}
    </View>
  );
}

/** Rows shaped like message summaries: subject, sender, snippet. */
export const LIST_ROW_WIDTHS = [0.76, 0.61, 0.84, 0.69, 0.79, 0.57] as const;

export interface ListSkeletonProps {
  /** How many rows (default 6). */
  rows?: number;
  testID?: string;
}

export function ListSkeleton(props: ListSkeletonProps) {
  const widths = () => Array.from({ length: props.rows ?? LIST_ROW_WIDTHS.length }, (_, i) => LIST_ROW_WIDTHS[i % LIST_ROW_WIDTHS.length]!);
  return (
    <Skeleton label="Loading messages" testID={props.testID ?? "list-skeleton"}>
      <View class={cx("gap-0.5")}>
        <Each of={widths()} key="index">
          {(w) => (
            <View class={cx("h-16 justify-center gap-[5px] px-3.5")}>
              <SkeletonBar width={w()} height={9} />
              <SkeletonBar width={Math.max(0.28, w() - 0.34)} height={8} />
              <SkeletonBar width={Math.min(0.72, w() + 0.08)} height={7} />
            </View>
          )}
        </Each>
      </View>
    </Skeleton>
  );
}

/** Body paragraph lines; 0 is the gap between paragraphs. */
export const READER_BODY_WIDTHS = [0.96, 0.99, 0.72, 0, 0.94, 0.88, 0.97, 0.54, 0, 0.92, 0.63] as const;

/** A message on its way: a two-line subject, sender and meta lines, a rule, then paragraphs. */
export function ReaderSkeleton(props: { testID?: string }) {
  return (
    <Skeleton label="Loading message" testID={props.testID ?? "reader-skeleton"}>
      <View class={cx("gap-2 p-3.5")}>
        <SkeletonBar width={0.82} height={13} />
        <SkeletonBar width={0.46} height={13} />
        <View class={cx("h-1")} />
        <SkeletonBar width={0.38} height={9} />
        <SkeletonBar width={0.52} height={8} />
        <View class={cx("h-2.5")} />
        <View class="h-px bg-border" />
        <View class={cx("h-1.5")} />
        <Each of={READER_BODY_WIDTHS} key="index">
          {(w) => (
            <View class={w() === 0 ? "h-2.5" : "h-[15px]"}>
              <If when={w() !== 0}>
                <SkeletonBar width={w()} height={8} />
              </If>
            </View>
          )}
        </Each>
      </View>
    </Skeleton>
  );
}
