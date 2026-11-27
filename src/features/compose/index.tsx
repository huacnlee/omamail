// Feature entry: the shell imports only what this file exports.
//
// `ComposeSurface` fills the mail window while a draft is open over it. On
// desktops the draft can move to a window of its own ("Open in window...");
// the mail window then shows the mail again, and closing that window brings
// the draft back over the mail rather than dropping it.
import { View } from "nsh";
import { Window, type WindowRef } from "nsh/desktop";
import { registerCommand } from "../../keys/commands";
import { KeyedWindow } from "../../shell/KeyedWindow";
import { Omarchy, Toaster } from "../../ui";
import { registerComposeAssistant } from "./assistantHost";
import { ComposeView } from "./ComposeView";
import { compose, requestLeave, send, setWindowed, setWindowHooks, startCompose } from "./store";

export { openCompose, openFromPayload, undoSend, compose } from "./store";
export type { ComposeRequest } from "./store";

// The router reads this id: while this window has the focus, its key context
// is "compose" and its Escape / Back runs "leave:compose". Keep it.
const WINDOW_ID = "compose";
let windowRef: WindowRef | null = null;
let windowSeen = false;

setWindowHooks({
  close: () => {
    const ref = windowRef;
    windowRef = null;
    windowSeen = false;
    ref?.close();
  },
  isOpen: () => {
    if (!windowRef) return false;
    const open = Window.get(WINDOW_ID) !== null;
    // Not shown yet: the platform is still opening it.
    if (!windowSeen) {
      windowSeen = open;
      return true;
    }
    return open;
  },
});

startCompose();
registerComposeAssistant();

/** Send and leave answer the router wherever the draft is shown. */
function registerComposeCommands() {
  registerCommand("send", () => send());
  // The router's Back (Escape, the header's arrow) asks before a changed draft goes.
  registerCommand("leave:compose", () => requestLeave());
}

function ComposeWindow() {
  Omarchy.followSystem();
  // The mail window's ComposeSurface is gone while the draft is here.
  registerComposeCommands();
  return (
    <View class="flex-1 bg-background">
      <ComposeView windowed />
      <Toaster />
    </View>
  );
}

/** Moves the open draft to a window of its own (desktops only). */
function detach() {
  try {
    // KeyedWindow runs the shell's key router here: a window answers only the
    // keys bound inside it.
    windowRef = Window.open(() => <KeyedWindow><ComposeWindow /></KeyedWindow>, {
      id: WINDOW_ID,
      title: compose.title(),
      parent: "main",
      defaultSize: { width: 720, height: 680 },
      minSize: { width: 420, height: 360 },
      defaultPosition: "parentCenter",
      restoreBounds: true,
    });
    windowSeen = false;
    setWindowed(true);
  } catch {
    // Not a desktop, or windows are not granted: the draft stays here.
    windowRef = null;
  }
}

export function ComposeSurface() {
  registerComposeCommands();
  return <ComposeView onDetach={detach} />;
}
