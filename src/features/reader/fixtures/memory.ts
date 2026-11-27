// Imported first by every reader preview entry, before the reader's store:
// its computeds read the preferences while the modules load, so the switch to
// memory has to come before them. From here on window.json is never read or
// written by a preview.
import { prefs } from "../../../app/prefs";

prefs.useMemory();
