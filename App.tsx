// Omamail on NSH: one window whose shell (src/shell) slots the features. The
// mail library is Rust (`ext/omamail-native` over `core/`).
import { mount } from "nsh";
import { Application, Window } from "nsh/desktop";
import { shutdown } from "./src/backend/client";
import { Shell } from "./src/shell/Shell";
import { followOmarchyFont, Omarchy, themeReady } from "./src/ui";

mount(() => {
  Omarchy.followSystem();
  // The desktop's font family and size, kept as shell.toml changes.
  followOmarchyFont();
  // Closing the window ends the app on every platform, as the Qt window did;
  // the backend is told to stop before the process goes.
  Application.setQuitMode("lastWindowClosed");
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
