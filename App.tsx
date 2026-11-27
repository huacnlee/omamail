// Omamail on NSH: one window whose shell (src/shell) slots the features. The
// mail library is Rust (`ext/omamail-native` over `core/`).
import { mount } from "nsh";
import { Application, Window } from "nsh/desktop";
import { shutdown } from "./src/backend/client";
import { Shell } from "./src/shell/Shell";
import { bringToFront, hidesOnClose } from "./src/shell/windowFocus";
import { followOmarchyFont, Omarchy, themeReady } from "./src/ui";

mount(() => {
  Omarchy.followSystem();
  // The desktop's font family and size, kept as shell.toml changes.
  followOmarchyFont();
  // Closing the window ends the app on Windows and Linux, as the Qt window
  // did. On macOS the close button and Command-W only hide it: the app stays
  // in the Dock, checking mail, and pressing the Dock icon shows it again.
  // The backend is told to stop before the process goes.
  Application.setQuitMode("lastWindowClosed");
  const hide = hidesOnClose();
  Application.on("reopen", () => {
    bringToFront();
  });
  Application.on("quit", () =>
    shutdown().catch(() => {
      // A backend that cannot answer (gone already, a test's stand-in host)
      // has nothing left to drain; quitting goes on.
    }),
  );
  return (
    <Window
      id="main"
      title="Omamail"
      defaultSize={{ width: 1280, height: 820 }}
      minSize={{ width: 420, height: 360 }}
      restoreBounds
      closeOnPress={!hide}
      onClosePress={() => {
        if (hide) Window.get("main")?.hide();
      }}
    >
      {/* In the Omarchy mode the palette arrives a moment after mount (at
          most 300 ms): the first frame waits for every color role. */}
      {() => (
        <If when={themeReady()}>
          <Shell canQuit onQuit={() => Application.quit()} />
        </If>
      )}
    </Window>
  );
});
