// The app's type, as Omarchy sets it. The Qt client took its family and sizes
// from the Omarchy shell (`Style.font`, `Style.space`), which follow `[font]`
// in `~/.config/omarchy/shell.toml`: `family`, and `base-size`, against which
// text, icons and spacing scale. omamail-native reads that section
// (`Backend.omarchyFont()`: fixed path, size-capped, `family` and `base-size`
// only), and this applies it:
//
// - the family is the tokens' `font-mono` (key caps, times, counts): the
//   configured family first, then the CSS generic `monospace` (fontconfig's
//   alias on Omarchy, which `omarchy font set` points at the chosen Nerd
//   Font; the system's monospaced face elsewhere). Interface and message
//   text are the system's sans (theme.ts).
// - the size is `uiScale()`, base-size / 14. The ui layer's sizes are drawn
//   at base 14, Omarchy's default and the fallback off Omarchy, so there
//   nothing moves; `tokens.ts` and `Icon` multiply by it.
//
// theme.ts sets the palette and these fonts over it. The file is read again every few seconds while the app has the
// focus: a change applies without a restart, as the README promises.
import { cleanup, effect, lifecycle, signal, untracked } from "nsh";
import { Backend } from "omamail-native";
import { setMonoFamily, setOmarchyDesktop, startTheme } from "./theme";

/** The generic family every list ends in. */
export const OMARCHY_FONT = "monospace";
/** The base size the ui layer is drawn at 1:1: Omarchy's default, and the size off Omarchy. */
export const BASE_SIZE = 14;
const POLL_MS = 3000;

export interface OmarchyFont {
  /** The configured family, or null for the system's monospace. */
  family: string | null;
  /** Points. */
  baseSize: number;
}

const font = signal<OmarchyFont>({ family: null, baseSize: BASE_SIZE });

/** How much larger than its base-14 sizes the ui layer is drawn (reactive). */
export function uiScale(): number {
  return font().baseSize / BASE_SIZE;
}

/** A base-14 length at the current scale, to the half point (reactive). */
export function scaled(points: number): number {
  const scale = uiScale();
  return scale === 1 ? points : Math.round(points * scale * 2) / 2;
}

/** The family list Text is drawn in (reactive). */
export function fontFamily(): string {
  const family = font().family;
  if (!family) return OMARCHY_FONT;
  // A quoted name: the name stays data, whatever characters it has.
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ${OMARCHY_FONT}`;
}

/** Omarchy's settings from what omamail-native returned; anything unusable is the default. */
export function parseOmarchyFont(value: unknown): OmarchyFont {
  const out: OmarchyFont = { family: null, baseSize: BASE_SIZE };
  if (!value || typeof value !== "object") return out;
  const v = value as { family?: unknown; baseSize?: unknown };
  if (typeof v.family === "string" && v.family.trim() !== "" && v.family.length <= 128) out.family = v.family.trim();
  if (typeof v.baseSize === "number" && Number.isFinite(v.baseSize) && v.baseSize >= 8 && v.baseSize <= 32) {
    out.baseSize = v.baseSize;
  }
  return out;
}

/** Sets the font as if shell.toml said so (tests, the gallery). */
export function setOmarchyFont(next: OmarchyFont): void {
  const now = untracked(font);
  if (now.family !== next.family || now.baseSize !== next.baseSize) font.set(next);
}

let lastRead: OmarchyFont | null = null;

function load(): void {
  let value: unknown = null;
  let omarchy = false;
  try {
    value = typeof Backend?.omarchyFont === "function" ? Backend.omarchyFont() : null;
  } catch {
    // A runner without the native module: the defaults.
  }
  try {
    // An Omarchy desktop: ~/.config/omarchy is a directory (native, no file read).
    omarchy = typeof Backend?.isOmarchy === "function" && Backend.isOmarchy() === true;
  } catch {
    // Off native (or an older binary): not Omarchy.
  }
  setOmarchyDesktop(omarchy);
  const next = parseOmarchyFont(value);
  // Only a change in the file applies: a size set in between stays.
  if (lastRead && lastRead.family === next.family && lastRead.baseSize === next.baseSize) return;
  lastRead = next;
  setOmarchyFont(next);
}

/**
 * Follows Omarchy's shell.toml: its `base-size` scales the ui layer and its
 * `family` is the `font-mono` family; also starts the Theme setting
 * (theme.ts), which draws the palette. Call once in the root component.
 */
export function followOmarchyFont(options: { poll?: boolean } = {}): void {
  load();
  // The family first, so the first palette already carries it.
  setMonoFamily(untracked(fontFamily));
  startTheme();
  effect(() => setMonoFamily(fontFamily()));
  if (options.poll !== false) {
    // Only while the app has the focus: a hidden or background window reads
    // nothing, and coming back reads at once. The owner's cleanup clears the
    // timer, so a closed root (a test) leaves none running.
    effect(() => {
      if (lifecycle() !== "active") return;
      untracked(load);
      const id = setInterval(load, POLL_MS);
      cleanup(() => clearInterval(id));
    });
  }
}
