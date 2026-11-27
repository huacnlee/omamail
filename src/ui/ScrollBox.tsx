// A scroll view as tall as its content up to a cap, scrolling beyond it: a
// picker with one match is one row tall, with fifty it stops at `maxHeight`
// and scrolls. A plain Scroll with a fixed height leaves the rest blank.
import { Scroll, View, type JSX } from "nsh";
import { scaled } from "./font";

export interface ScrollBoxProps {
  /** The cap in points at base size 14 (scaled). */
  maxHeight: number;
  children?: JSX.Element;
  /** The content's classes (gaps, padding). */
  class?: string;
  testID?: string;
}

/** Content-sized up to `maxHeight`, then it scrolls. */
export function ScrollBox(props: ScrollBoxProps) {
  return (
    <Scroll testID={props.testID} class="grow-0 shrink" style={{ maxHeight: scaled(props.maxHeight) }}>
      <View class={props.class}>{props.children}</View>
    </Scroll>
  );
}

