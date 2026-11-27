// The shell's own movements, on the ui layer's tokens (src/ui, motion).
// Each is a no-op under reduced motion, where the change lands at once.
import { LayoutAnimation, reduceMotion, type MotionSpec } from "nsh";
import { DISTANCE, DURATION } from "../ui";

/** The next commit's frames ease to their new places: the sidebar folding
 * to its rail, the list giving the reader room. */
export function animateNextLayout(): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(DURATION.normal, "easeOut", "opacity"));
}

/** In compact mode the reader arrives from the side the list sends it to,
 * and the list comes back from the other. */
export function slideIn(fromRight: boolean): MotionSpec {
  return {
    keyframes: { opacity: [0, 1], translateX: [fromRight ? DISTANCE.page : -DISTANCE.page, 0] },
    duration: DURATION.normal,
    easing: "easeOut",
  };
}
