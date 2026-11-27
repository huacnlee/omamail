// The ui overlays open now, newest last: the topmost takes Escape. A dialog
// binds Escape itself only while it is the topmost (so a popover or select
// open inside it closes first, and the dialog on the next Escape), and no
// overlay closes on Escape while an input method composes (Escape is the
// composition's then).
import { cleanup, effect, keymap, signal, untracked } from "nsh";
import { imeComposing } from "./ime";

const open = signal<number[]>([]);
let next = 1;

/** Notes the overlay as open while `isOpen()` is; `isTop()` says whether it is the newest open one. */
export function trackOverlay(isOpen: () => boolean): { isTop: () => boolean } {
  const id = next++;
  const remove = () => open.update((list) => (list.includes(id) ? list.filter((x) => x !== id) : list));
  effect(() => {
    if (isOpen()) {
      untracked(() => open.update((list) => (list.includes(id) ? list : [...list, id])));
      return remove;
    }
    untracked(remove);
  });
  cleanup(remove);
  return { isTop: () => open()[open().length - 1] === id };
}

/** Whether any ui overlay is open (reactive). */
export function overlayOpen(): boolean {
  return open().length > 0;
}

/** Whether Escape may close an overlay now: not while an input method composes (reactive). */
export function escapeMayClose(): boolean {
  return !imeComposing();
}

/** An overlay's onOpenChange that drops a close while an input method composes (the Escape was the composition's). */
export function imeSafe<E extends { open: boolean }>(handler: (e: E) => void): (e: E) => void {
  return (e) => {
    if (!e.open && untracked(imeComposing)) return;
    handler(e);
  };
}

/**
 * Escape closes an open dialog, sheet or panel even from a focused text field
 * (which keeps Escape from the overlay's own native handling): an app
 * binding, made only while the overlay is the topmost ui overlay and no input
 * method composes.
 */
export function useEscapeToClose(isOpen: () => boolean, close: () => void): void {
  const overlay = trackOverlay(isOpen);
  effect(() => {
    if (!isOpen() || !overlay.isTop() || imeComposing()) return;
    return keymap.bind("escape", () => close(), { when: "always" });
  });
}
