// The shell's own movements, on the ui layer's tokens (src/ui, motion).
// Each is a no-op under reduced motion, where the change lands at once.
import { LayoutAnimation, reduceMotion } from "nsh";
import { DURATION } from "../ui";

/** The next commit's frames ease to their new places: the sidebar folding
 * to its rail, the list giving the reader room. */
export function animateNextLayout(): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(DURATION.normal, "easeOut", "opacity"));
}
