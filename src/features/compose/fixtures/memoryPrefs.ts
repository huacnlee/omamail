// Import first in every compose fixture: window preferences live in memory,
// so a fixture never reads or writes this machine's window.json or storage.
import { prefs } from "../../../app/prefs";

prefs.useMemory();
