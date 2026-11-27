// Whether a view sits in the window's title band: `TitleBar` provides it, and
// `ActionBar` reads it to draw its title-band form (a STOPGAP, see ActionBar).
import { context } from "nsh";

/** True under a `TitleBar` (ui's), where the window's hidden title bar lies. */
export const TitleBandContext = context<boolean>(false);
