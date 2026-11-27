// Roving focus for a list or tree of rows (WAI-ARIA tree view): the rows are
// one Tab stop. While a row holds the keyboard focus, Up / Down (and Home /
// End) move to the next row and open it, so the focus ring and the selection
// sit on one row; a row that opens nothing (an ancestor no label names)
// takes the focus without opening. Right unfolds a folded row, then steps
// into its first child; Left folds an unfolded one, then steps out to its
// parent. Up and Down stop at the ends, as a tree does.
//
// `restingIndex` and `rovingMove` are the pure rules; `useRovingFocus` keeps
// the rows' views and the stop, and takes the arrows while the focus is in
// the list. `NavList roving={...}` and `NavRow rovingKey` wire it.
import { batch, effect, keymap, signal, untracked, type ViewRef } from "nsh";

/** One row the arrows reach, in the order the list draws them. */
export interface RovingTarget {
  /** Unique among the targets (`mailbox:<key>`, `label:<path>`). */
  key: string;
  /** Moving onto it opens it (false: an ancestor no label names). */
  opens: boolean;
  /** Nesting level, 0 at the top. */
  depth: number;
  /** It has children: Left / Right fold and unfold it. */
  folds: boolean;
  expanded: boolean;
  /** Left steps out only to a row that may be a parent (default: every row may). */
  parent?: boolean;
}

export type RovingKey = "up" | "down" | "home" | "end" | "left" | "right";

/** What a key asks for: move to a row, fold or unfold one, or nothing. */
export type RovingMove =
  | { kind: "move"; index: number }
  | { kind: "fold"; index: number; expanded: boolean }
  | { kind: "none" };

/** The row Tab enters at: the cursor, else the selected one, else the first. -1 when there are none. */
export function restingIndex(targets: readonly RovingTarget[], selectedKey: string, cursorKey: string): number {
  if (targets.length === 0) return -1;
  const cursor = targets.findIndex((t) => t.key === cursorKey);
  if (cursor >= 0) return cursor;
  const selected = targets.findIndex((t) => t.key === selectedKey);
  return selected >= 0 ? selected : 0;
}

/** The answer to `key` on the row at `at`. */
export function rovingMove(targets: readonly RovingTarget[], at: number, key: RovingKey): RovingMove {
  const n = targets.length;
  if (n === 0 || at < 0 || at >= n) return { kind: "none" };
  const here = targets[at];
  switch (key) {
    case "up":
      return at > 0 ? { kind: "move", index: at - 1 } : { kind: "none" };
    case "down":
      return at < n - 1 ? { kind: "move", index: at + 1 } : { kind: "none" };
    case "home":
      return at !== 0 ? { kind: "move", index: 0 } : { kind: "none" };
    case "end":
      return at !== n - 1 ? { kind: "move", index: n - 1 } : { kind: "none" };
    case "right":
      if (here.folds && !here.expanded) return { kind: "fold", index: at, expanded: true };
      if (here.folds && at + 1 < n && targets[at + 1].depth > here.depth) return { kind: "move", index: at + 1 };
      return { kind: "none" };
    case "left": {
      if (here.folds && here.expanded) return { kind: "fold", index: at, expanded: false };
      if (here.depth === 0) return { kind: "none" };
      for (let i = at - 1; i >= 0; i--) {
        if (targets[i].depth < here.depth && targets[i].parent !== false) return { kind: "move", index: i };
      }
      return { kind: "none" };
    }
  }
}

/** Takes the arrow keys until the function it returns runs (`keymap.bind` by default; an app with a key router passes its own layer). */
export type RovingKeyBinder = (keys: Record<RovingKey, () => void>) => () => void;

const bindWithKeymap: RovingKeyBinder = (keys) =>
  keymap.bind({ up: keys.up, down: keys.down, home: keys.home, end: keys.end, left: keys.left, right: keys.right }, { when: "notEditing" });

export interface RovingFocusOptions {
  /** The rows, in the order drawn (reactive). */
  targets: () => readonly RovingTarget[];
  /** The open row's key, where Tab enters when the keyboard has not been here (reactive). */
  selectedKey: () => string;
  /** Opens a row an arrow moved to (only rows with `opens`). */
  open: (target: RovingTarget) => void;
  /** Folds or unfolds a row (Left / Right on a row with `folds`). */
  fold?: (target: RovingTarget, expanded: boolean) => void;
  /** How the arrows are bound while the focus is in the list (default `keymap.bind`, not while editing). */
  bindKeys?: RovingKeyBinder;
}

export interface RovingFocus {
  /** Whether Tab stops at this row (reactive): give it to the row's `focusable`. */
  isStop: (key: string) => boolean;
  /** Hands a row's view to the roving focus; the function it returns takes it back. */
  register: (key: string, view: ViewRef) => () => void;
  /** For the list's `onFocusIn`. */
  focusIn: () => void;
  /** For the list's `onFocusOut`. */
  focusOut: () => void;
}

/** The roving focus of one list: create it in the list's component. */
export function useRovingFocus(options: RovingFocusOptions): RovingFocus {
  const views = new Map<string, ViewRef>();
  const cursor = signal("");
  const focused = signal(false);
  const at = () => restingIndex(options.targets(), options.selectedKey(), cursor());
  /** The row Tab stops at: the cursor while the focus is here, the open row otherwise. */
  const stopKey = () => options.targets()[at()]?.key ?? "";
  // The row the focus is leaving stays a stop until the new one, a stop from
  // the next frame, has taken the focus: no frame without a stop drops it.
  const leaving = signal("");
  // While a move hands the focus on, its focus-out is no leaving. Why a
  // timer and not the order of events: on macOS the list hears the old row's
  // focus-out before the new row's focus-in (AppKit resigns first responder,
  // then the new row is focused a frame later, from a setTimeout), so at the
  // focus-out nothing says whether a focus-in follows. A focus-out that comes
  // while handing therefore waits 60ms for the move's focus-in; if none comes
  // (Tab, or a click elsewhere, took the focus out of the list), it counts as
  // leaving.
  let handing = 0;
  let pendingOut = false;
  const leave = () =>
    batch(() => {
      focused.set(false);
      cursor.set("");
    });
  const step = (key: RovingKey) => () => {
    const list = options.targets();
    const move = rovingMove(list, untracked(at), key);
    if (move.kind === "none") return;
    const target = list[move.index];
    if (move.kind === "fold") {
      options.fold?.(target, move.expanded);
      return;
    }
    const hand = ++handing;
    setTimeout(() => {
      if (handing === hand) handing = 0;
    }, 500);
    batch(() => {
      leaving.set(untracked(stopKey));
      cursor.set(target.key);
      if (target.opens) options.open(target);
    });
    setTimeout(() => {
      const view = views.get(target.key);
      view?.focus();
      view?.reveal({ vertical: "nearest" });
      leaving.set("");
    }, 0);
  };
  const bind = options.bindKeys ?? bindWithKeymap;
  effect(() => {
    if (!focused()) return;
    return untracked(() =>
      bind({ up: step("up"), down: step("down"), home: step("home"), end: step("end"), left: step("left"), right: step("right") }),
    );
  });
  return {
    isStop: (key) => key === stopKey() || key === leaving(),
    register: (key, view) => {
      views.set(key, view);
      return () => {
        if (views.get(key) === view) views.delete(key);
      };
    },
    focusIn: () => {
      handing = 0;
      pendingOut = false;
      if (!untracked(focused)) {
        batch(() => {
          if (untracked(cursor) === "") cursor.set(untracked(stopKey));
          focused.set(true);
        });
      }
    },
    focusOut: () => {
      if (handing !== 0) {
        // See `handing`: wait for the move's focus-in, else it is a leaving.
        pendingOut = true;
        setTimeout(() => {
          if (!pendingOut) return;
          pendingOut = false;
          handing = 0;
          leave();
        }, 60);
        return;
      }
      leave();
    },
  };
}
