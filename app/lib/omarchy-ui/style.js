// @ts-check

// The Omarchy shell's structural style tokens, ported from the shell's
// `Style.qml` singleton at /usr/share/omarchy/shell/Commons/Style.qml.
//
// Color is the palette (see theme.js); Style is everything else a theme can
// influence — corner rounding, the spacing scale, the type scale, and the
// alphas that make up a control's idle/hover/selected chrome. The QML client
// read these from `theme/shell.toml` plus `hyprctl getoption`; the GPUI client
// reads the same two sources through the `omarchy-theme` host module, so both
// clients are dense in the same places and square in the same places.
//
// gpui's semantic theme carries colors, seven spacing steps and six radii and
// nothing else, so the rest lives here as a module-level singleton the way it
// lived as a QML singleton: views ask `style()` for a token instead of
// inventing a rem value. `applyOmarchyStyle` replaces it once, at startup,
// from the host's sources.

/**
 * `section.key` → raw string, matching the dict `Style.applyShellValues`
 * consumes. Comments and quotes are stripped; sections without a header are
 * ignored, because every key in shell.toml lives under one.
 * @param {string} source
 * @returns {Record<string, string>}
 */
export function parseShellToml(source) {
  /** @type {Record<string, string>} */
  const values = {};
  let section = "";
  for (const raw of String(source || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (!section) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    let value = pair[2].trim();
    const quoted = value.match(/^(["'])(.*?)\1/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "").trim();
    values[`${section}.${pair[1]}`] = value;
  }
  return values;
}

/** @param {Record<string, string>} values @param {string} key @param {number} fallback */
function number(values, key, fallback) {
  const parsed = Number(values[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** @param {Record<string, string>} values @param {string} key @param {boolean} fallback */
function flag(values, key, fallback) {
  const value = String(values[key] ?? "")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return fallback;
}

/** Alphas are ratios; anything outside 0..1 is a typo, not an intent. @param {number} value */
function clampAlpha(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * `#rgb`, `#rrggbb` and `#rrggbbaa` in; `{r,g,b,a}` in 0..1 out. Returns null
 * for anything else so callers can fall back rather than paint transparent
 * black.
 * @param {string} value
 */
export function parseColor(value) {
  const text = String(value || "").trim();
  const short = text.match(/^#([0-9A-Fa-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("");
    return {
      r: parseInt(r + r, 16) / 255,
      g: parseInt(g + g, 16) / 255,
      b: parseInt(b + b, 16) / 255,
      a: 1,
    };
  }
  const full = text.match(/^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/);
  if (!full) return null;
  return {
    r: parseInt(full[1].slice(0, 2), 16) / 255,
    g: parseInt(full[1].slice(2, 4), 16) / 255,
    b: parseInt(full[1].slice(4, 6), 16) / 255,
    a: full[2] ? parseInt(full[2], 16) / 255 : 1,
  };
}

/** @param {{r:number,g:number,b:number,a:number}} color @returns {import("gpui").Color} */
export function formatColor(color) {
  const channel = (/** @type {number} */ value) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return /** @type {import("gpui").Color} */ (
    `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${channel(color.a)}`
  );
}

/**
 * The shell's `Util.alpha`: the same color at a new opacity. Every control
 * fill and border in Omarchy is a foreground or accent at an alpha rather than
 * a literal gray, which is what keeps a light theme from getting a dark
 * "muted" and a dark theme a light one.
 * @param {import("gpui").Color|string} color @param {number} value
 * @returns {import("gpui").Color}
 */
export function alpha(color, value) {
  const parsed = parseColor(color);
  if (!parsed) return /** @type {import("gpui").Color} */ (color);
  return formatColor({ ...parsed, a: clampAlpha(value) });
}

/**
 * Mix `color` toward `toward` by `amount`. Secondary text mixes the
 * foreground toward the *background* — on a light theme, darkening an
 * almost-black foreground makes "secondary" text heavier than body text,
 * which is the opposite of what it means.
 * @param {import("gpui").Color|string} color
 * @param {import("gpui").Color|string} toward
 * @param {number} amount
 * @returns {import("gpui").Color}
 */
export function mix(color, toward, amount) {
  const from = parseColor(color);
  const to = parseColor(toward);
  if (!from || !to) return /** @type {import("gpui").Color} */ (color);
  const ratio = Math.min(1, Math.max(0, amount));
  return formatColor({
    r: from.r * (1 - ratio) + to.r * ratio,
    g: from.g * (1 - ratio) + to.g * ratio,
    b: from.b * (1 - ratio) + to.b * ratio,
    a: from.a,
  });
}

/** @param {{r:number,g:number,b:number,a:number}} color */
function toHsl(color) {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness, a: color.a };
  const span = max - min;
  const saturation =
    lightness > 0.5 ? span / (2 - max - min) : span / (max + min);
  let hue;
  if (max === color.r) hue = ((color.g - color.b) / span + (color.g < color.b ? 6 : 0)) / 6;
  else if (max === color.g) hue = ((color.b - color.r) / span + 2) / 6;
  else hue = ((color.r - color.g) / span + 4) / 6;
  return { h: hue, s: saturation, l: lightness, a: color.a };
}

/** @param {{h:number,s:number,l:number,a:number}} hsl */
function fromHsl(hsl) {
  if (hsl.s === 0) return { r: hsl.l, g: hsl.l, b: hsl.l, a: hsl.a };
  const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
  const p = 2 * hsl.l - q;
  const channel = (/** @type {number} */ t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return {
    r: channel(hsl.h + 1 / 3),
    g: channel(hsl.h),
    b: channel(hsl.h - 1 / 3),
    a: hsl.a,
  };
}

/**
 * The same hue and lightness at a capped saturation. Omarchy's palette has no
 * separate "primary": `accent` is it, and an accent near full saturation is
 * right for a 5px unread dot and wrong for a link inside a paragraph.
 * @param {import("gpui").Color|string} color @param {number} maximum
 * @returns {import("gpui").Color}
 */
export function capSaturation(color, maximum) {
  const parsed = parseColor(color);
  if (!parsed) return /** @type {import("gpui").Color} */ (color);
  const hsl = toHsl(parsed);
  return formatColor(fromHsl({ ...hsl, s: Math.min(hsl.s, maximum) }));
}

// The defaults below are Style.qml's own, so a machine with no shell.toml —
// a test runner, a non-Omarchy desktop — still lays out at the density the
// design was drawn at rather than at gpui's.
const DEFAULT_SPACING = {
  xxs: 2,
  xs: 3,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  xxl: 12,
  xxxl: 14,
  huge: 18,
  controlGap: 8,
  controlPaddingX: 10,
  controlPaddingY: 6,
  inputPaddingY: 7,
  controlHeight: 28,
  popupRowHeight: 28,
  dropdownWidth: 240,
  searchableDropdownWidth: 260,
  numberFieldWidth: 120,
  searchablePopupMinHeight: 220,
  rowGap: 8,
  rowPaddingX: 12,
  labelGap: 4,
  panelGap: 14,
  panelPadding: 18,
  popupPadding: 14,
};

/** shell.toml writes kebab-case; Style.qml reads camelCase. */
const SPACING_KEYS = {
  xxs: "xxs",
  xs: "xs",
  sm: "sm",
  md: "md",
  lg: "lg",
  xl: "xl",
  xxl: "xxl",
  xxxl: "xxxl",
  huge: "huge",
  controlGap: "control-gap",
  controlPaddingX: "control-padding-x",
  controlPaddingY: "control-padding-y",
  inputPaddingY: "input-padding-y",
  controlHeight: "control-height",
  popupRowHeight: "popup-row-height",
  dropdownWidth: "dropdown-width",
  searchableDropdownWidth: "searchable-dropdown-width",
  numberFieldWidth: "number-field-width",
  searchablePopupMinHeight: "searchable-popup-min-height",
  rowGap: "row-gap",
  rowPaddingX: "row-padding-x",
  labelGap: "label-gap",
  panelGap: "panel-gap",
  popupPadding: "popup-padding",
  panelPadding: "panel-padding",
};

// Multipliers off `[font] base-size`, which is the rem root of the scale.
const FONT_SCALE = {
  caption: 0.833,
  bodySmall: 0.917,
  body: 1.0,
  subtitle: 1.083,
  title: 1.167,
  heading: 1.333,
  display: 2.0,
  displayLarge: 2.333,
};

const FONT_KEYS = {
  caption: "caption",
  bodySmall: "body-small",
  body: "body",
  subtitle: "subtitle",
  title: "title",
  heading: "heading",
  display: "display",
  displayLarge: "display-large",
};

/**
 * Build the token set from the shell's own two sources.
 * @param {string} shellSource contents of `theme/shell.toml`
 * @param {{ cornerRadius?: number, fontFamily?: string }} [host]
 */
export function omarchyStyle(shellSource, host = {}) {
  const values = parseShellToml(shellSource);

  const baseSize = Math.max(1, Math.round(number(values, "font.base-size", 12)));
  const fontScale = Math.max(1 / 12, baseSize / 12);
  const spacingScale =
    Math.max(0, number(values, "spacing.scale", 1)) *
    (flag(values, "spacing.scale-with-font", true) ? fontScale : 1);

  /** Every component asks for its old pixel value and gets it scaled. */
  const spaceReal = (/** @type {number} */ px) => {
    const value = Number(px);
    return Number.isFinite(value) && value > 0 ? value * spacingScale : 0;
  };
  const space = (/** @type {number} */ px) => {
    const value = spaceReal(px);
    return value <= 0 ? 0 : Math.max(1, Math.round(value));
  };

  /** @type {Record<string, number>} */
  const spacing = {};
  for (const [name, key] of Object.entries(SPACING_KEYS)) {
    const pinned = Number(values[`spacing.${key}`]);
    spacing[name] =
      Number.isFinite(pinned) && pinned >= 0
        ? Math.round(pinned)
        : space(DEFAULT_SPACING[/** @type {keyof typeof DEFAULT_SPACING} */ (name)]);
  }
  spacing.hairline = space(1);

  /** @type {Record<string, number>} */
  const font = { baseSize };
  for (const [name, key] of Object.entries(FONT_KEYS)) {
    const pinned = Number(values[`font.${key}`]);
    font[name] =
      Number.isFinite(pinned) && pinned > 0
        ? Math.round(pinned)
        : Math.max(
            1,
            Math.round(
              baseSize * FONT_SCALE[/** @type {keyof typeof FONT_SCALE} */ (name)],
            ),
          );
  }
  font.iconSmall = Math.round(number(values, "font.icon-small", font.bodySmall));
  font.icon = Math.round(number(values, "font.icon", font.title));
  font.iconLarge = Math.round(
    number(values, "font.icon-large", Math.round(baseSize * 1.5)),
  );

  const normalBorderWidth = Math.max(
    0,
    Math.round(number(values, "controls.normal-border-width", 1)),
  );
  const hoverBorderWidth = Math.max(
    0,
    Math.round(number(values, "controls.hover-cursor-border-width", normalBorderWidth)),
  );
  const hoverFillAlpha = clampAlpha(
    number(values, "controls.hover-cursor-fill-alpha", 0.08),
  );
  const hoverBorderAlpha = clampAlpha(
    number(values, "controls.hover-cursor-border-alpha", 0.25),
  );

  return {
    // Mirrors Hyprland's decoration:rounding, so the app's corners match every
    // other window on the desktop instead of picking their own roundness.
    cornerRadius: Math.max(0, Math.round(host.cornerRadius ?? 0)),
    // "monospace" is the fontconfig alias `omarchy font set` rewrites; the
    // host resolves it to a concrete family so gpui, which has no alias
    // support, still follows the user's choice.
    fontFamily: host.fontFamily || "monospace",
    spacingScale,
    space,
    spaceReal,
    spacing: /** @type {typeof DEFAULT_SPACING & {hairline:number}} */ (
      /** @type {unknown} */ (spacing)
    ),
    font: /** @type {Record<keyof typeof FONT_SCALE | "baseSize"|"icon"|"iconSmall"|"iconLarge", number>} */ (
      /** @type {unknown} */ (font)
    ),
    state: {
      normalBorderWidth,
      hoverBorderWidth,
      selectedBorderWidth: Math.max(
        0,
        Math.round(number(values, "controls.selected-border-width", 0)),
      ),
      focusBorderWidth: Math.max(
        0,
        Math.round(number(values, "controls.focus-border-width", hoverBorderWidth)),
      ),
      normalFillAlpha: clampAlpha(number(values, "controls.normal-fill-alpha", 0.04)),
      hoverFillAlpha,
      selectedFillAlpha: clampAlpha(
        number(values, "controls.selected-fill-alpha", 0.18),
      ),
      pressedFillAlpha: clampAlpha(
        number(values, "controls.pressed-fill-alpha", 0.22),
      ),
      focusFillAlpha: clampAlpha(
        number(values, "controls.focus-fill-alpha", hoverFillAlpha),
      ),
      selectionFillAlpha: clampAlpha(
        number(values, "controls.selection-fill-alpha", 0.35),
      ),
      normalBorderAlpha: clampAlpha(
        number(values, "controls.normal-border-alpha", 0.4),
      ),
      hoverBorderAlpha,
      selectedBorderAlpha: clampAlpha(
        number(values, "controls.selected-border-alpha", 1.0),
      ),
      focusBorderAlpha: clampAlpha(
        number(values, "controls.focus-border-alpha", hoverBorderAlpha),
      ),
    },
    // Popup and tooltip surfaces are their own roles in shell.toml: a menu
    // card is not the window background, and a theme may say so.
    surfaces: {
      popupBackground: values["popups.background"] || "",
      popupBackgroundAlpha: clampAlpha(
        number(values, "popups.background-alpha", 1),
      ),
      popupBorder: values["popups.border"] || "",
      popupBorderAlpha: clampAlpha(number(values, "popups.border-alpha", 1)),
      popupText: values["popups.text"] || "",
      tooltipBackground: values["tooltip.background"] || "",
      tooltipBackgroundAlpha: clampAlpha(
        number(values, "tooltip.background-alpha", 1),
      ),
      tooltipBorder: values["tooltip.border"] || "",
      tooltipBorderAlpha: clampAlpha(number(values, "tooltip.border-alpha", 1)),
      tooltipText: values["tooltip.text"] || "",
      // `border = "hyprland.active-border"` is a reference into another
      // section rather than a color; resolve it the way Color.qml does.
      hyprlandActiveBorder: values["hyprland.active-border"] || "",
      hyprlandActiveBorderForeground:
        values["hyprland.active-border-foreground"] || "",
    },
  };
}

/** @typedef {ReturnType<typeof omarchyStyle>} OmarchyStyle */

/** @type {OmarchyStyle} */
let active = omarchyStyle("");

/** The live token set. Views read this the way QML read the `Style` singleton. */
export function style() {
  return active;
}

/**
 * Replace the live tokens. Called once at startup with the host's sources, and
 * again if the theme changes underneath a running window.
 * @param {string} shellSource @param {{cornerRadius?:number,fontFamily?:string}} [host]
 */
export function applyOmarchyStyle(shellSource, host = {}) {
  active = omarchyStyle(shellSource, host);
  return active;
}

/**
 * Hyprland's own colour syntax, as `shell.toml` writes it, in hex.
 *
 * A window border in Hyprland may be a **gradient** — two or more colours and
 * an angle — and the shell's surface sections reference it verbatim so a menu's
 * edge matches the frame the compositor draws. gpui paints one colour, so the
 * first stop is taken and the angle dropped: the alternative is refusing to
 * draw the card at all, which is what happens if the string is passed through.
 *
 * The colours themselves are `rgba(RRGGBBAA)` / `rgb(RRGGBB)` — Hyprland's own
 * spelling, with the hex digits inside the parentheses rather than the CSS
 * comma-separated form — or `0xAARRGGBB`, or a plain `#` literal.
 * @param {string} value
 * @returns {import("gpui").Color|null}
 */
export function parseHyprlandColor(value) {
  // Matched rather than split on whitespace: the CSS spelling puts spaces
  // inside its own parentheses, so `rgba(255, 0, 0, 0.5)` is one colour and
  // not four tokens. The first match is the gradient's first stop; the angle
  // that follows never matches anything.
  const first = String(value || "").match(
    /rgba?\([^)]*\)|#[0-9A-Fa-f]{3,8}|0x[0-9A-Fa-f]{8}/,
  )?.[0];
  if (!first) return null;
  if (first.startsWith("#"))
    return parseColor(first) ? /** @type {any} */ (first) : null;

  const packed = first.match(/^rgba?\(\s*([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\s*\)$/);
  if (packed) return /** @type {any} */ (`#${packed[1]}`);

  // The CSS spelling, which Hyprland also takes. Alpha is a ratio here, unlike
  // every other channel.
  const listed = first.match(/^rgba?\(([^)]*)\)$/);
  if (listed) {
    const parts = listed[1].split(",").map((part) => Number(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite))
      return formatColor({
        r: parts[0] / 255,
        g: parts[1] / 255,
        b: parts[2] / 255,
        a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
      });
  }

  // `0xAARRGGBB`: alpha leads, which is the one place Hyprland puts it first.
  const legacy = first.match(/^0x([0-9A-Fa-f]{8})$/);
  if (legacy)
    return /** @type {any} */ (`#${legacy[1].slice(2)}${legacy[1].slice(0, 2)}`);

  return null;
}

/**
 * Resolve a `section.key` reference like `"hyprland.active-border"` to the
 * color it points at, leaving a literal color alone.
 * @param {OmarchyStyle} tokens @param {string} value
 * @param {import("gpui").Color} fallback
 * @param {number} [opacity] the section's `*-alpha` companion
 * @returns {import("gpui").Color}
 */
export function resolveSurfaceColor(tokens, value, fallback, opacity) {
  const source =
    value === "hyprland.active-border"
      ? tokens.surfaces.hyprlandActiveBorder
      : value === "hyprland.active-border-foreground"
        ? tokens.surfaces.hyprlandActiveBorderForeground
        : value;
  const parsed = parseHyprlandColor(source);
  if (!parsed) return fallback;
  return opacity === undefined ? parsed : alpha(parsed, opacity);
}
