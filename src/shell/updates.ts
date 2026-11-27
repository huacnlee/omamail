// Omamail updates itself from its GitHub releases (nsh.json "updater"): each
// release carries a latest.json, signed with the key whose public half is in
// nsh.json, naming every platform's archive. `promptForUpdate` is NSH's own
// flow: it asks before it downloads, then installs and restarts, or installs
// on quit once the user chose automatic updates. In a development run (and a
// headless test) there is no installed package, so nothing is offered.
import { promptForUpdate } from "nsh/updater";
import { app } from "../app/store";

/** The check at launch: silent unless a newer version is out. */
export function checkForUpdatesQuietly(): void {
  promptForUpdate({ quiet: true }).catch(() => {
    // A check nobody asked for says nothing when it fails; the next launch
    // or "Check for Updates..." tries again.
  });
}

/** "Check for Updates...": the user asked, so every outcome shows. */
export function checkForUpdates(): void {
  promptForUpdate({ quiet: false }).catch(() => app.setNotice("Could not check for updates"));
}
