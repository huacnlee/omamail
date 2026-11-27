// Brings the mail window in front of the person who pressed a notification:
// the NSH form of omarchy/ui/hyprland/WindowFocus.qml. Qt asked Hyprland to
// focus the window by its title and retried while a just-summoned window was
// still being mapped; NSH's `WindowRef.focus()` shows, raises and focuses the
// window on every desktop (Hyprland included, through the platform), so one
// call is the whole of it. Features that open a message from a notification
// call this after opening it.
import { windows } from "nsh/desktop";
import { isApple } from "../ui";

/** Closing the mail window hides it rather than ending the app: macOS, where
 * an app stays in the Dock with no window and the Dock icon shows it again. */
export function hidesOnClose(): boolean {
  return isApple();
}

export function bringToFront(id = "main"): boolean {
  try {
    const window = windows().find((w) => w.id === id) ?? windows()[0];
    if (!window) return false;
    window.focus();
    return true;
  } catch {
    // No desktop windows (mobile, the web): nothing to raise.
    return false;
  }
}
