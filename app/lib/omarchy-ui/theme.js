// @ts-check

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

/** Project Omarchy colors into a complete gpui-base semantic theme snapshot. */
/** @param {string} source @param {any} fallback @returns {{appearance:"light"|"dark",tokens:{colors:any,spacing:any,radius:any}}|null} */
export function omarchyTheme(source, fallback) {
  const palette = parsePalette(source);
  const background = first(palette, "background", "bg", "color0");
  const foreground = first(palette, "foreground", "fg", "color7");
  if (!background || !foreground) return null;

  const appearance = first(palette, "mode", "theme_type") === "light" ? "light" : "dark";
  const primary = first(palette, "accent", "blue", "color4") ?? foreground;
  const muted = first(palette, "muted", "dark_foreground", "dark_fg") ?? foreground;
  const mutedForeground = first(palette, "dark_foreground", "dark_fg") ?? muted;
  const lightForeground = first(palette, "light_foreground", "light_fg") ?? foreground;
  const brightForeground =
    first(palette, "bright_foreground", "bright_fg") ?? lightForeground;
  const secondary = first(palette, "lighter_background", "lighter_bg") ?? background;
  const accent = palette.selection ?? muted;
  const destructive = first(palette, "red", "color1") ?? fallback.colors.destructive;

  return {
    appearance,
    tokens: {
      spacing: fallback.spacing,
      radius: fallback.radius,
      colors: {
        ...fallback.colors,
        background,
        foreground,
        surface: background,
        surface_foreground: foreground,
        primary,
        primary_foreground: brightForeground,
        secondary,
        secondary_foreground: lightForeground,
        muted,
        muted_foreground: mutedForeground,
        accent,
        accent_foreground: lightForeground,
        destructive,
        destructive_foreground: brightForeground,
        border: muted,
        input: muted,
        ring: primary,
      },
    },
  };
}
