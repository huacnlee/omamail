// The app's palettes and the Theme setting (docs/DESIGN.md, "Visual language
// v2"). Omamail draws with its own NsVim-style pair by default, "ink" (dark)
// and "paper" (light); the Omarchy mode follows the desktop's palette, as the
// Qt client did. Settings → Appearance → Theme picks System / Light / Dark /
// Omarchy; with no choice stored, an Omarchy desktop gets Omarchy and every
// other system gets System (paper or ink by the system's appearance).
//
// Every role exists in every palette. nsh-omarchy's palettes set only its own
// roles (and replace the tokens whole), so in the Omarchy mode the roles it
// lacks are filled from the nearest semantic role it has, each time it
// applies one, and the radius and mono family are set over it.
//
// Type: interface and message text are the system's sans (`font-sans` is
// left to the system); key caps, times, counts and versions are `font-mono`,
// which follows Omarchy's `[font] family` where shell.toml names one.
import { cleanup, effect, setColorScheme, setTheme, signal, token, untracked } from "nsh";
import { Omarchy } from "nsh-omarchy";

export type ThemeMode = "system" | "light" | "dark" | "omarchy";
export const THEME_MODES: ThemeMode[] = ["system", "light", "dark", "omarchy"];

/** Corners of controls, panels and popups. */
export const RADIUS_TOKEN = "2px";
/** The generic family `font-mono` ends in. */
export const MONO_FALLBACK = "monospace";

type Palette = Record<string, string>;

/** Dark "ink": NsVim's editor theme, dark. */
export const INK: Palette = {
  background: "#0E1016",
  foreground: "#D6DAE4",
  muted: "#0A0C11",
  "muted-foreground": "#8B93A6",
  "surface-raised": "#151925",
  border: "#232838",
  /** Structural lines between the window's regions: a hair above the background, below `border`. */
  divider: "#171A24",
  "rule-strong": "#2E3448",
  "text-faint": "#7C8497",
  primary: "#6C9EFF",
  "primary-hover": "#8DB4FF",
  "primary-foreground": "#0A0C11",
  selection: "#2A3150",
  destructive: "#F2777A",
  danger: "#F2777A",
  warning: "#E5C07B",
  success: "#A7D46F",
  violet: "#C39BFF",
  orange: "#FFA266",
  cyan: "#5ED3D3",
  // shadcn's and Omarchy's roles, from the ones above.
  card: "#0E1016",
  "card-foreground": "#D6DAE4",
  popover: "#0E1016",
  "popover-foreground": "#D6DAE4",
  secondary: "#151925",
  "secondary-foreground": "#D6DAE4",
  accent: "#151925",
  "accent-foreground": "#D6DAE4",
  input: "#232838",
  ring: "#6C9EFF",
  sidebar: "#0A0C11",
  "sidebar-foreground": "#D6DAE4",
  surface: "#0E1016",
  inset: "#0A0C11",
  bright: "#F2F4F8",
  "on-accent": "#0A0C11",
  "text-secondary": "#8B93A6",
  "omarchy-accent": "#6C9EFF",
  "chart-1": "#6C9EFF",
  "chart-2": "#C39BFF",
  "chart-3": "#5ED3D3",
  "chart-4": "#E5C07B",
  "chart-5": "#A7D46F",
  "ansi-0": "#232838",
  "ansi-1": "#F2777A",
  "ansi-2": "#A7D46F",
  "ansi-3": "#E5C07B",
  "ansi-4": "#6C9EFF",
  "ansi-5": "#C39BFF",
  "ansi-6": "#5ED3D3",
  "ansi-7": "#8B93A6",
  "ansi-8": "#2E3448",
  "ansi-9": "#FF9497",
  "ansi-10": "#BFE38E",
  "ansi-11": "#FFA266",
  "ansi-12": "#8DB4FF",
  "ansi-13": "#D5B8FF",
  "ansi-14": "#86E2E2",
  "ansi-15": "#D6DAE4",
};

/** Light "paper": NsVim's editor theme, light. */
export const PAPER: Palette = {
  background: "#FAFAF7",
  foreground: "#1F2330",
  muted: "#F0F0EB",
  "muted-foreground": "#5B6273",
  "surface-raised": "#ECEDF2",
  border: "#D9DAE0",
  divider: "#E9E9E4",
  "rule-strong": "#C3C6D0",
  "text-faint": "#626877",
  primary: "#2F5FD0",
  "primary-hover": "#244DB0",
  "primary-foreground": "#FFFFFF",
  selection: "#D3DDF8",
  destructive: "#B83A3E",
  danger: "#B83A3E",
  warning: "#8A6200",
  success: "#39761D",
  violet: "#7A3FC8",
  orange: "#AB5019",
  cyan: "#0E7575",
  card: "#FAFAF7",
  "card-foreground": "#1F2330",
  popover: "#FAFAF7",
  "popover-foreground": "#1F2330",
  secondary: "#ECEDF2",
  "secondary-foreground": "#1F2330",
  accent: "#ECEDF2",
  "accent-foreground": "#1F2330",
  input: "#D9DAE0",
  ring: "#2F5FD0",
  sidebar: "#F0F0EB",
  "sidebar-foreground": "#1F2330",
  surface: "#FAFAF7",
  inset: "#F0F0EB",
  bright: "#0F121A",
  "on-accent": "#FFFFFF",
  "text-secondary": "#5B6273",
  "omarchy-accent": "#2F5FD0",
  "chart-1": "#2F5FD0",
  "chart-2": "#7A3FC8",
  "chart-3": "#0E7575",
  "chart-4": "#8A6200",
  "chart-5": "#39761D",
  "ansi-0": "#1F2330",
  "ansi-1": "#B83A3E",
  "ansi-2": "#39761D",
  "ansi-3": "#8A6200",
  "ansi-4": "#2F5FD0",
  "ansi-5": "#7A3FC8",
  "ansi-6": "#0E7575",
  "ansi-7": "#5B6273",
  "ansi-8": "#626877",
  "ansi-9": "#D0484C",
  "ansi-10": "#4A8F2A",
  "ansi-11": "#AB5019",
  "ansi-12": "#4A78E0",
  "ansi-13": "#9058DC",
  "ansi-14": "#178A8A",
  "ansi-15": "#0F121A",
};

/** Every role a palette has: the app reads only these. */
export const ROLES = Object.keys(INK);

/**
 * Roles nsh-omarchy's palettes may lack, each with the roles it is filled
 * from in the Omarchy mode, nearest first (by meaning, and for the terminal
 * colors by hue: a "blue" calendar stays blue). A role named here may be
 * filled from one filled before it in the same pass. Every other role is
 * one of nsh-omarchy's own.
 */
export const OMARCHY_FALLBACK: Record<string, string[]> = {
  "surface-raised": ["accent", "surface", "card"],
  "rule-strong": ["input", "border"],
  // Omarchy's look keeps its strong structural lines: the divider is the border.
  divider: ["border"],
  "text-faint": ["text-secondary", "muted-foreground"],
  "primary-hover": ["primary", "omarchy-accent"],
  sidebar: ["inset", "muted"],
  "ansi-0": ["inset", "muted", "background"],
  "ansi-1": ["danger", "destructive"],
  "ansi-2": ["success"],
  "ansi-3": ["warning"],
  "ansi-4": ["primary", "chart-1"],
  "ansi-5": ["violet", "chart-2"],
  "ansi-6": ["cyan", "chart-3"],
  "ansi-7": ["foreground"],
  "ansi-8": ["text-secondary"],
  "ansi-9": ["ansi-1", "danger", "destructive"],
  "ansi-10": ["ansi-2", "success"],
  "ansi-11": ["ansi-3", "warning"],
  "ansi-12": ["ansi-4", "primary", "chart-1"],
  "ansi-13": ["ansi-5", "violet", "chart-2"],
  "ansi-14": ["ansi-6", "cyan", "chart-3"],
  "ansi-15": ["foreground"],
  violet: ["ansi-5", "chart-2", "primary"],
  orange: ["ansi-11", "warning"],
  cyan: ["ansi-6", "chart-3", "primary"],
};

/** The theme file of the app's own palettes (what theme.json holds). */
export function ownTheme(mono: string): { cssVars: { theme: Palette; light: Palette; dark: Palette } } {
  return { cssVars: { theme: { radius: RADIUS_TOKEN, "font-mono": mono }, light: { ...PAPER }, dark: { ...INK } } };
}

/**
 * A complete palette from the one an Omarchy palette left in the tokens
 * (`read`). A missing role takes the first of its fallbacks that the
 * palette has, or that another fallback resolves to (chains resolve in
 * any order: `violet` → `ansi-5` → `chart-2`); a cycle ends at the next
 * fallback.
 */
export function completeOmarchy(read: (name: string) => string | undefined): Palette {
  const out: Palette = {};
  const resolving = new Set<string>();
  const resolve = (name: string): string | undefined => {
    if (out[name]) return out[name];
    const own = read(name);
    if (own) return (out[name] = own);
    if (resolving.has(name)) return undefined;
    resolving.add(name);
    let found: string | undefined;
    for (const from of OMARCHY_FALLBACK[name] ?? []) {
      found = resolve(from);
      if (found) break;
    }
    resolving.delete(name);
    if (found) out[name] = found;
    return found;
  };
  for (const name of ROLES) {
    // A role nothing fills keeps a readable value rather than none.
    if (!resolve(name)) out[name] = read("foreground") ?? INK[name];
  }
  return out;
}

// ---- The setting -------------------------------------------------------------

const chosen = signal<ThemeMode | null>(null);
const omarchyDesktop = signal(false);
const mono = signal(MONO_FALLBACK);

/** The Theme setting in effect (reactive): the stored choice, else the default. */
export function themeMode(): ThemeMode {
  return chosen() ?? defaultThemeMode();
}

/** Omarchy on an Omarchy desktop, System elsewhere (reactive). */
export function defaultThemeMode(): ThemeMode {
  return omarchyDesktop() ? "omarchy" : "system";
}

/** The Theme setting: a mode, or `null` for the default. Applies at once where `startTheme` runs. */
export function setThemeMode(mode: ThemeMode | null): void {
  chosen.set(mode);
}

/** Whether this is an Omarchy desktop (reactive). */
export function isOmarchyDesktop(): boolean {
  return omarchyDesktop();
}

/** Marks this as an Omarchy desktop or not (font.ts, from shell.toml; tests). */
export function setOmarchyDesktop(on: boolean): void {
  if (untracked(omarchyDesktop) !== on) omarchyDesktop.set(on);
}

/** The family list `font-mono` draws in (reactive). */
export function monoFamily(): string {
  return mono();
}

/** Sets `font-mono`'s family list (font.ts, from Omarchy's `[font] family`). */
export function setMonoFamily(family: string): void {
  if (untracked(mono) !== family) mono.set(family);
}

const read = token as unknown as (name: string) => string | number | undefined;
function readColor(name: string): string | undefined {
  const v = read(name);
  return typeof v === "string" && v !== "" ? v : undefined;
}

let started = false;
const ready = signal(false);

/**
 * Whether the palette with every role is in the tokens (reactive). True from
 * the start in the own palettes; in the Omarchy mode, once its palette has
 * arrived and been filled (nsh-omarchy's palette reaches the tokens a
 * message after it is asked for, without the app's roles). A root that
 * mounts its content only once this is true has no frame without a role:
 * `<If when={themeReady()}>`. A live switch keeps it true.
 */
export function themeReady(): boolean {
  return ready();
}

/**
 * Draws the app in the Theme setting's palette and keeps it so as the
 * setting, the desktop's palette and Omarchy's family change. Call once in
 * the root component (followOmarchyFont calls it).
 */
export function startTheme(): void {
  if (started) return;
  started = true;
  cleanup(() => {
    started = false;
    ready.set(false);
  });

  // The mode and the mono family: the own palettes, or Omarchy's. The first
  // palette is applied now, before the root's views exist, so the first frame
  // already has every role (an effect runs only after rendering); the effect
  // applies later changes of the setting.
  const apply = (mode: ThemeMode, family: string) => {
    if (mode === "omarchy") {
      Omarchy.followSystem();
      fillOmarchy();
    } else {
      Omarchy.stopFollowing();
      setTheme(ownTheme(family));
      setColorScheme(mode);
    }
  };
  untracked(() => {
    const mode = themeMode();
    apply(mode, mono());
    if (mode !== "omarchy") ready.set(true);
    else {
      // Never held for long: a palette that reports no change still shows.
      const id = setTimeout(() => ready.set(true), 300);
      cleanup(() => clearTimeout(id));
    }
  });
  let first = true;
  effect(() => {
    const mode = themeMode();
    const family = mono();
    if (first) {
      first = false;
      return;
    }
    untracked(() => apply(mode, family));
  });

  // An nsh-omarchy palette (the Omarchy mode, or an explicit
  // `Omarchy.applyTheme`) replaces the tokens whole, without the roles it
  // lacks: fill them in the turn its tokens arrive. `onChange` tells of a
  // new palette; the watch below also covers one applied again (no change
  // is told then). The tokens reach TS one message after nsh-omarchy sets
  // them, so the core draws that one update without the filled roles.
  const stop = Omarchy.onChange(() =>
    untracked(() => {
      fillOmarchy();
      if (!ready()) ready.set(true);
    }),
  );
  cleanup(stop);
  effect(() => {
    const raised = readColor("surface-raised");
    const family = read("font-mono");
    const radius = read("radius");
    for (const name of ["background", "foreground", "primary", "border"]) read(name);
    if (complete(raised, family, radius)) return;
    untracked(fillOmarchy);
  });
}

/** The tokens hold every role, Omamail's radius and the mono family. */
function complete(raised: string | undefined, family: unknown, radius: unknown): boolean {
  return !!raised && family === untracked(mono) && radius === 2;
}

function fillOmarchy(): void {
  if (complete(readColor("surface-raised"), read("font-mono"), read("radius"))) return;
  // The tokens are an nsh-omarchy palette: keep its colors, fill the rest.
  const palette = completeOmarchy(readColor);
  setTheme({ cssVars: { theme: { ...palette, radius: RADIUS_TOKEN, "font-mono": untracked(mono) } } });
}

/**
 * nsh-omarchy's `Omarchy` as the app's code sees it (src/ui's export). The
 * ui layer owns the palette, so `followSystem()` starts the Theme setting
 * (`startTheme`): the own palettes, or Omarchy's in the Omarchy mode, with
 * every role before the first frame. nsh-omarchy's own `followSystem`
 * applied its palette a message after the root's views were made, without
 * the app's roles. The rest is nsh-omarchy's: `applyTheme` draws a built-in
 * palette (its roles filled a frame later), `stopFollowing`, `current`,
 * `shortcutLabel`, `onChange`.
 */
export const AppOmarchy: typeof Omarchy = {
  followSystem: () => startTheme(),
  stopFollowing: () => Omarchy.stopFollowing(),
  applyTheme: (name) => Omarchy.applyTheme(name),
  current: () => Omarchy.current(),
  shortcutLabel: (keys) => Omarchy.shortcutLabel(keys),
  onChange: (listener) => Omarchy.onChange(listener),
};
