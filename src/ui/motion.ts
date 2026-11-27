// Motion tokens: every animated change in the app takes its duration and
// easing from here, so the whole window moves at one tempo. Reduced motion
// (`reduceMotion()` from nsh) turns movement into fades of DURATION.instant.
//
// The numbers follow Omarchy's shell, which is quick and dense: pointer
// feedback well under 200ms, reveals under 300ms, leaving faster than
// entering. `CLASS` carries the same numbers as Tailwind classes for the
// transitions the ui components declare in `class`; `enterRise()` and friends
// carry them as motions for views that appear.
import { reduceMotion, type MotionSpec } from "nsh";

export const DURATION = { instant: 0, fast: 120, normal: 180, slow: 260 } as const;
export const EASING = { standard: "ease-out", enter: "ease-out", exit: "ease-in" } as const;
/** How far a popup or toast travels as it appears, in points. */
export const DISTANCE = { popup: 4, toast: 8, page: 16 } as const;
/** Press feedback for buttons and rows. */
export const SCALE = { press: 0.97, pressIcon: 0.95, enter: 0.97 } as const;

/** The soft settle presses land on (AffectUI's curve). */
export const SETTLE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** One skeleton breath, each way: slow enough to read as waiting, not as an alarm. */
export const PULSE_MS = 900;

/** A list's entrance wave: rows this far apart, only the first `cap` waiting. */
export const STAGGER = { step: 40, cap: 10 } as const;

/**
 * The transitions as classes, for state styles (hover, press, selected).
 * Each turns itself off under reduced motion.
 */
export const CLASS = {
  /** Hover and selection washes: a color change only. */
  wash: "transition-colors duration-[120ms] ease-out motion-reduce:transition-none",
  /** The press: the whole control to SCALE.press. */
  press:
    "transition duration-[120ms] ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  /** The press of a square icon control: a little deeper. */
  pressIcon:
    "transition duration-[120ms] ease-out active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100",
  /** Opacity changes: a lane that shows or hides its content. */
  fade: "transition-opacity duration-[180ms] ease-out motion-reduce:transition-none",
} as const;

/** A duration, or 0 while the user asks for less motion. Read it where it is used. */
export function ms(duration: number): number {
  return reduceMotion() ? 0 : duration;
}

/** Content arriving in place: a fade, rising `distance` points. */
export function enterRise(distance: number = DISTANCE.popup, delay = 0): MotionSpec {
  return {
    keyframes: { opacity: [0, 1], translateY: [distance, 0] },
    duration: DURATION.normal,
    easing: "easeOut",
    delay,
  };
}

/** Content arriving where it was already expected (a pane's body): a fade only. */
export function enterFade(delay = 0): MotionSpec {
  return { keyframes: { opacity: [0, 1] }, duration: DURATION.normal, easing: "easeOut", delay };
}

/** A capped wave delay for the `index`th item entering together. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), STAGGER.cap) * STAGGER.step;
}
