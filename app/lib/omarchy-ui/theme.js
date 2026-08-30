// @ts-check

import {
  alpha,
  capSaturation,
  mix,
  omarchyStyle,
  style as activeStyle,
} from "./style.js";

/** @param {string} source */
function parsePalette(source) {
  /** @type {Record<string, string>} */
  const palette = {};
  for (const line of String(source).split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(["'])(.*?)\2/);
    if (match) palette[match[1]] = match[3];
  }
  return palette;
}

/** @param {Record<string, string>} palette @param {...string} keys */
function first(palette, ...keys) {
  return keys.map((key) => palette[key]).find(Boolean);
}

/** @param {string} source */
export function omarchyBaseColors(source) {
  const palette = parsePalette(source);
  return [
    first(palette, "red", "color1"),
    first(palette, "green", "color2"),
    first(palette, "yellow", "color3"),
    first(palette, "blue", "color4"),
    first(palette, "magenta", "purple", "color5"),
    first(palette, "cyan", "color6"),
  ].filter(Boolean);
}

/** @param {string} source */
export function omarchyStatusColors(source) {
  const palette = parsePalette(source);
  return {
    danger: first(palette, "red", "color1"),
    success: first(palette, "green", "color2"),
    warning: first(palette, "yellow", "color3"),
    info: first(palette, "cyan", "color6"),
  };
}

/**
 * The four foundational roles plus the ones the app derives from them.
 *
 * Omarchy's palette is deliberately small — background, foreground, accent and
 * urgent — and every other tone in the window is a mix or an alpha of those,
 * which is what lets a theme change propagate without a second palette to keep
 * in sync. These are the same derivations `App.qml` declared at the top of the
 * window and passed down as required properties.
 * @param {string} source
 */
export function omarchyRoles(source) {
  const palette = parsePalette(source);
  const background = /** @type {import("gpui").Color|undefined} */ (
    first(palette, "background", "bg", "color0")
  );
  const foreground = /** @type {import("gpui").Color|undefined} */ (
    first(palette, "foreground", "fg", "color7")
  );
  if (!background || !foreground) return null;
  const accent = /** @type {import("gpui").Color} */ (
    first(palette, "accent", "blue", "color4") ?? foreground
  );
  const urgent = /** @type {import("gpui").Color} */ (
    first(palette, "red", "color1") ?? foreground
  );
  return {
    background,
    foreground,
    accent,
    urgent,
    // Destructive controls consume a role named for their meaning; Omarchy's
    // foundational palette currently calls that source `urgent`.
    danger: urgent,
    // Mixed toward the ground rather than darkened: on a light theme darkening
    // an almost-black foreground makes secondary text heavier than body text.
    dim: mix(foreground, background, 0.32),
    dimmer: mix(foreground, background, 0.55),
    // Same hue and lightness as the accent, capped saturation — calm enough to
    // read past in a paragraph, still clearly a link.
    link: capSaturation(accent, 0.55),
    // A panel rule, which is not a control border. `Ui/PanelSeparator.qml`
    // hard-codes 0.12 on the foreground and says why in its own comment: it
    // has to stay legible "without competing with text or borders", which the
    // control border's 0.4 does. gpui's seventeen tokens have one `border` and
    // no room for the second weight, so the window drew every rule — the rail
    // edge, the list/reader split, the header and status strips, every section
    // rule — at the heavier one. Blended against the ground rather than left
    // translucent, because a theme token drops its alpha.
    separator: mix(background, foreground, 0.12),
    selection: palette.selection ?? alpha(accent, 0.35),
    lighterBackground:
      first(palette, "lighter_background", "lighter_bg") ?? background,
    darkBackground: first(palette, "dark_background", "dark_bg") ?? background,
    lightForeground:
      first(palette, "light_foreground", "light_fg") ?? foreground,
    brightForeground:
      first(palette, "bright_foreground", "bright_fg") ??
      first(palette, "light_foreground", "light_fg") ??
      foreground,
    mutedForeground:
      first(palette, "dark_foreground", "dark_fg") ?? mix(foreground, background, 0.32),
  };
}

/**
 * Project Omarchy colors into a complete gpui-base semantic theme snapshot.
 *
 * Spacing and radius come from the shell's structural tokens rather than from
 * gpui's own scale: Omarchy is a 12px monospace desktop whose corners follow
 * Hyprland's `decoration:rounding`, and a mail window that rounds its own
 * corners or pads at gpui's default rhythm reads as a foreign application on
 * that desktop. `fallback` still supplies any color role Omarchy has no
 * opinion about.
 * @param {string} source
 * @param {any} fallback
 * @param {import("./style.js").OmarchyStyle} [tokens]
 * @returns {{appearance:"light"|"dark",tokens:{colors:any,spacing:any,radius:any}}|null}
 */
export function omarchyTheme(source, fallback, tokens = activeStyle()) {
  const roles = omarchyRoles(source);
  if (!roles) return null;
  const palette = parsePalette(source);

  const appearance =
    first(palette, "mode", "theme_type") === "light" ? "light" : "dark";
  const state = tokens.state;

  // A border is the foreground at the theme's border alpha, never a literal
  // gray: the same rule the shell's own controls follow. Blended against the
  // ground rather than left translucent, for the same reason the fills are —
  // gpui resolves a theme token to a solid colour and drops the alpha, and a
  // dropped alpha here turns every rule in the window pure white.
  const border = mix(roles.background, roles.foreground, state.normalBorderAlpha);
  const radius = tokens.cornerRadius;

  return {
    appearance,
    tokens: {
      spacing: {
        xxs: tokens.spacing.xxs,
        xs: tokens.spacing.xs,
        sm: tokens.spacing.sm,
        md: tokens.spacing.md,
        lg: tokens.spacing.lg,
        xl: tokens.spacing.xl,
        xxl: tokens.spacing.xxl,
      },
      radius: {
        none: 0,
        sm: radius,
        md: radius,
        lg: radius,
        xl: radius,
        // `full` is a pill, not a corner treatment, so it stays round even on
        // a square desktop — it is what draws the unread dot.
        full: 9999,
      },
      colors: {
        ...fallback.colors,
        background: roles.background,
        foreground: roles.foreground,
        // The window is one surface. Omarchy panels separate regions with a
        // hairline, not with a second background tone.
        surface: roles.background,
        surface_foreground: roles.foreground,
        primary: roles.accent,
        primary_foreground: roles.brightForeground,
        secondary: roles.lighterBackground,
        secondary_foreground: roles.lightForeground,
        // `muted` and `accent` are the shell's hover and selected fills. They
        // are blended against the ground rather than handed over translucent:
        // gpui resolves a theme token to a solid colour, so an alpha written
        // here is dropped and the "selected" tint arrives as a solid block of
        // accent — which is the one thing the Omarchy kit never draws.
        muted: mix(roles.background, roles.foreground, state.hoverFillAlpha),
        muted_foreground: roles.dim,
        accent: mix(roles.background, roles.accent, state.selectedFillAlpha),
        accent_foreground: roles.foreground,
        destructive: roles.danger,
        destructive_foreground: roles.brightForeground,
        border,
        input: border,
        ring: roles.accent,
      },
    },
  };
}

/**
 * The theme a test or a non-Omarchy desktop gets: the same structural tokens,
 * so layout assertions do not depend on a machine having a theme installed.
 * @param {string} shellSource
 * @param {{cornerRadius?:number,fontFamily?:string}} [host]
 */
export function omarchyStyleFrom(shellSource, host) {
  return omarchyStyle(shellSource, host);
}

// gpui's semantic theme carries seventeen colour tokens and no more: there is
// no `link`, no `popover`, no second dim. Omarchy's window needs those, and
// `App.qml` declared them at the top of the window and passed them down as
// required properties so a theme change propagated through every view. This is
// that list, as a live singleton beside `style()` — writing them into the
// theme would be writing them nowhere, since gpui drops what it does not know.

/** @type {ReturnType<typeof omarchyRoles>} */
let activeRoles = null;

/** The derived palette roles. Null until the host has read a theme. */
export function roles() {
  return activeRoles;
}

/**
 * Resolve one derived role, falling back to a theme token when no Omarchy
 * palette has been read — a test, or a desktop that is not Omarchy.
 * @param {"dim"|"dimmer"|"link"|"urgent"|"danger"|"accent"|"selection"|"separator"} name
 * @param {import("gpui").Color} fallback
 * @returns {import("gpui").Color}
 */
export function role(name, fallback) {
  const current = activeRoles;
  return current ? /** @type {any} */ (current[name]) : fallback;
}

/** @param {string} source */
export function applyOmarchyRoles(source) {
  activeRoles = omarchyRoles(source);
  return activeRoles;
}
