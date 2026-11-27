// A calendar's color as theme classes: CalendarPalette.qml drew each slot
// from the Omarchy theme's terminal colors (color1..color6) and the accent,
// so here each slot is the matching theme token. Class strings are written
// out whole so the style compiler sees every one.
//
// Omamail's own palettes (Ink, Paper) set the terminal colors; the ui layer
// fills them for an Omarchy palette that lacks them. Should a theme still
// leave one unset, each slot takes the nearest semantic role instead
// (danger, success, warning, primary, violet, cyan), which every palette has.
import { token } from "nsh";
import * as Palette from "../../mail/calendar/palette";


export interface EventTone {
  /** The 3pt bar at an event's leading edge, and a calendar's dot. */
  bar: string;
  /** The event's own wash. */
  fill: string;
  /** The wash while the event is selected. */
  fillSelected: string;
  /** The selected event's outline. */
  border: string;
}

const TONES: Record<string, EventTone> = {
  accent: { bar: "bg-primary", fill: "bg-primary/15", fillSelected: "bg-primary/30", border: "border-primary" },
  red: { bar: "bg-ansi-1", fill: "bg-ansi-1/15", fillSelected: "bg-ansi-1/30", border: "border-ansi-1" },
  green: { bar: "bg-ansi-2", fill: "bg-ansi-2/15", fillSelected: "bg-ansi-2/30", border: "border-ansi-2" },
  yellow: { bar: "bg-ansi-3", fill: "bg-ansi-3/15", fillSelected: "bg-ansi-3/30", border: "border-ansi-3" },
  blue: { bar: "bg-ansi-4", fill: "bg-ansi-4/15", fillSelected: "bg-ansi-4/30", border: "border-ansi-4" },
  magenta: { bar: "bg-ansi-5", fill: "bg-ansi-5/15", fillSelected: "bg-ansi-5/30", border: "border-ansi-5" },
  cyan: { bar: "bg-ansi-6", fill: "bg-ansi-6/15", fillSelected: "bg-ansi-6/30", border: "border-ansi-6" },
};

/** The same slots from roles every Omarchy palette sets. */
const FALLBACK: Record<string, EventTone> = {
  red: { bar: "bg-danger", fill: "bg-danger/15", fillSelected: "bg-danger/30", border: "border-danger" },
  green: { bar: "bg-success", fill: "bg-success/15", fillSelected: "bg-success/30", border: "border-success" },
  yellow: { bar: "bg-warning", fill: "bg-warning/15", fillSelected: "bg-warning/30", border: "border-warning" },
  blue: { bar: "bg-primary", fill: "bg-primary/15", fillSelected: "bg-primary/30", border: "border-primary" },
  magenta: { bar: "bg-violet", fill: "bg-violet/15", fillSelected: "bg-violet/30", border: "border-violet" },
  cyan: { bar: "bg-cyan", fill: "bg-cyan/15", fillSelected: "bg-cyan/30", border: "border-cyan" },
};

const ANSI: Record<string, "ansi-1" | "ansi-2" | "ansi-3" | "ansi-4" | "ansi-5" | "ansi-6"> = {
  red: "ansi-1", green: "ansi-2", yellow: "ansi-3", blue: "ansi-4", magenta: "ansi-5", cyan: "ansi-6",
};

/** Whether the theme drawn now sets the terminal color `name`. Read in a
 * binding, it follows theme changes. */
function themeHas(name: "ansi-1" | "ansi-2" | "ansi-3" | "ansi-4" | "ansi-5" | "ansi-6"): boolean {
  const value: unknown = token(name);
  return typeof value === "string" && value !== "";
}

/** A slot key (`red`, `accent`, ...) as classes; an unknown key is the accent. */
export function toneFor(key: string): EventTone {
  const slot = Palette.normalizeKey(key);
  const ansi = ANSI[slot];
  if (ansi && !themeHas(ansi)) return FALLBACK[slot];
  return TONES[slot] ?? TONES.accent;
}

/** The slots a calendar can take, in the settings' order, with their names. */
export function slots(): Array<{ key: string; label: string }> {
  return Palette.keys().map((key: string) => ({ key, label: key === "accent" ? "Accent" : key.charAt(0).toUpperCase() + key.slice(1) }));
}
