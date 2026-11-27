// Work in progress: a turning loader, and a row that names what is loading.
// Prefer a skeleton where the coming content's shape is known; a spinner is
// for work whose result has no shape yet (a search, a send).
//
// Under reduced motion the loader rests and the words carry the state.
import { cleanup, createMotion, reduceMotion, Text, View } from "nsh";
import { Icon } from "./Icon";
import { cx, TEXT, HEIGHT } from "./tokens";

export interface SpinnerProps {
  /** Points (default 14). */
  size?: number;
  /** What screen readers hear ("Searching"); left out, it is decorative beside its words. */
  label?: string;
  testID?: string;
}

export function Spinner(props: SpinnerProps) {
  const motion = createMotion();
  if (!reduceMotion()) {
    void motion.play("spin", { iterations: "infinite", duration: 900, easing: "linear" });
  }
  cleanup(() => void motion.rotate.stop());
  return (
    <View
      testID={props.testID}
      style={motion.style}
      role={props.label ? "progressbar" : undefined}
      accessibilityLabel={props.label}
      accessibilityState={props.label ? { busy: true } : undefined}
      accessibilityElementsHidden={!props.label}
      class="items-center justify-center"
    >
      <Icon name="loading" size={props.size ?? 14} class="text-text-secondary" />
    </View>
  );
}

export interface LoadingRowProps {
  /** What is happening, in this app's words ("Searching all mail..."). */
  label: string;
  /** `inline` (default) sits in a row of content; `block` centers itself in a pane. */
  layout?: "inline" | "block";
  testID?: string;
}

/** A spinner and its words, announced politely as they appear. */
export function LoadingRow(props: LoadingRowProps) {
  return (
    <View
      testID={props.testID}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      class={cx("flex-row items-center gap-2", props.layout === "block" ? "flex-1 justify-center p-4" : cx(HEIGHT.medium, "px-2"))}
    >
      <Spinner />
      <Text class={TEXT.caption}>{props.label}</Text>
    </View>
  );
}
