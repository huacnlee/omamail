import assert from "node:assert/strict";

import {
  alpha,
  parseHyprlandColor,
  applyOmarchyStyle,
  capSaturation,
  mix,
  omarchyStyle,
  parseColor,
  parseShellToml,
  resolveSurfaceColor,
  style,
} from "../app/lib/omarchy-ui/style.js";

// A trimmed shell.toml in the shape Omarchy actually ships: sections, quoted
// strings, bare numbers, commented-out overrides, and a trailing comment on a
// value line.
const shell = `
# Omarchy shell surfaces.
[bar]
size-horizontal = 26
[hyprland]
active-border = "#355f01"
active-border-foreground = "#141414"
[controls]
normal-color        = "#feffff"
normal-fill-alpha   = 0.04
normal-border-width = 1
selected-fill-alpha = 0.18
selected-border-width = 0
[spacing]
scale = 1.0
scale-with-font = true
# md = 6
[font]
base-size = 12
# heading = 16
[popups]
background = "#040404"
border     = "hyprland.active-border"
`;

assert.equal(parseShellToml(shell)["controls.normal-fill-alpha"], "0.04");
assert.equal(parseShellToml(shell)["popups.border"], "hyprland.active-border");
// A commented-out override is not an override.
assert.equal(parseShellToml(shell)["spacing.md"], undefined);
// A key outside any section has nowhere to live; every real key has a header.
assert.equal(parseShellToml("stray = 1")["stray"], undefined);

const tokens = omarchyStyle(shell, {
  cornerRadius: 0,
  fontFamily: "JetBrainsMono Nerd Font",
});

// The scale is the shell's own, in pixels. These are the numbers Style.qml
// resolves to at the default 12px base; a mail window that pads at gpui's
// rhythm instead reads as a foreign application on this desktop.
assert.deepEqual(
  {
    xxs: tokens.spacing.xxs,
    xs: tokens.spacing.xs,
    sm: tokens.spacing.sm,
    md: tokens.spacing.md,
    lg: tokens.spacing.lg,
    xl: tokens.spacing.xl,
    xxl: tokens.spacing.xxl,
  },
  { xxs: 2, xs: 3, sm: 4, md: 6, lg: 8, xl: 10, xxl: 12 },
);
assert.equal(tokens.spacing.controlHeight, 28);
assert.equal(tokens.spacing.rowPaddingX, 12);
assert.equal(tokens.spacing.panelPadding, 18);
assert.equal(tokens.spacing.hairline, 1);

assert.equal(tokens.font.body, 12);
assert.equal(tokens.font.caption, 10);
assert.equal(tokens.font.bodySmall, 11);
assert.equal(tokens.font.title, 14);
assert.equal(tokens.font.heading, 16);
assert.equal(tokens.font.icon, tokens.font.title);
assert.equal(tokens.fontFamily, "JetBrainsMono Nerd Font");
assert.equal(tokens.cornerRadius, 0);

// `space(px)` is the identity at the default scale, which is what lets a port
// pass the QML's own pixel value and stay diffable against it.
assert.equal(tokens.space(14), 14);
assert.equal(tokens.space(0), 0);

// A larger base font scales the whole desktop, spacing included.
const large = omarchyStyle(shell.replace("base-size = 12", "base-size = 18"));
assert.equal(large.font.body, 18);
assert.equal(large.space(14), 21);
// Unless the theme has pinned spacing to its own scale.
const pinned = omarchyStyle(
  shell
    .replace("base-size = 12", "base-size = 18")
    .replace("scale-with-font = true", "scale-with-font = false"),
);
assert.equal(pinned.font.body, 18);
assert.equal(pinned.space(14), 14);

// A pinned per-token override wins over the derived value without disturbing
// the rest of the scale.
const pinnedToken = omarchyStyle(shell.replace("# md = 6", "md = 9"));
assert.equal(pinnedToken.spacing.md, 9);
assert.equal(pinnedToken.spacing.lg, 8);

assert.equal(tokens.state.normalFillAlpha, 0.04);
assert.equal(tokens.state.selectedFillAlpha, 0.18);
assert.equal(tokens.state.selectedBorderWidth, 0);
// Alphas are ratios; a theme that writes 4 meant 0.04 and gets clamped rather
// than painting an out-of-range colour.
assert.equal(
  omarchyStyle("[controls]\nnormal-fill-alpha = 4").state.normalFillAlpha,
  1,
);

// A fill is the control's colour at an alpha, never a literal gray.
assert.equal(alpha("#feffff", 0.08), "#feffff14");
assert.equal(alpha("#fff", 1), "#ffffffff");
assert.equal(alpha("not-a-colour", 0.5), "not-a-colour");
assert.deepEqual(parseColor("#040404"), { r: 4 / 255, g: 4 / 255, b: 4 / 255, a: 1 });
assert.equal(parseColor("#12345"), null);

// Secondary text mixes toward the ground rather than darkening: on a light
// theme, darkening an almost-black foreground makes it heavier than body text.
assert.equal(mix("#000000", "#ffffff", 0.5), "#808080ff");
assert.equal(mix("#000000", "#ffffff", 0), "#000000ff");

// The link tone keeps the accent's hue and lightness at a capped saturation.
const link = capSaturation("#5da602", 0.55);
assert.notEqual(link, "#5da602");
assert.equal(capSaturation("#808080", 0.55), "#808080ff");

// `border = "hyprland.active-border"` is a reference into another section, not
// a colour, and resolving it is what keeps a popup's edge matching the
// active-window border the compositor draws.
assert.equal(
  resolveSurfaceColor(tokens, tokens.surfaces.popupBorder, "#000000"),
  "#355f01",
);
assert.equal(resolveSurfaceColor(tokens, "#123456", "#000000"), "#123456");
assert.equal(resolveSurfaceColor(tokens, "", "#000000"), "#000000");

// Hyprland writes a window border as a gradient — two colours and an angle —
// and the shell's surface sections reference it verbatim so a card's edge
// matches the frame the compositor draws. gpui paints one colour and refuses
// the string outright, taking the whole view down with it, so the first stop
// is taken and the angle dropped.
assert.equal(
  parseHyprlandColor("rgba(6f1828e6) rgba(9c2331e6) 45deg"),
  "#6f1828e6",
);
assert.equal(parseHyprlandColor("rgba(6f1828e6)"), "#6f1828e6");
assert.equal(parseHyprlandColor("rgb(355f01)"), "#355f01");
assert.equal(parseHyprlandColor("#355f01"), "#355f01");
// The CSS spelling, which Hyprland also takes; alpha is a ratio there.
assert.equal(parseHyprlandColor("rgba(255, 0, 0, 0.5)"), "#ff000080");
// `0xAARRGGBB` is the one place Hyprland puts alpha first.
assert.equal(parseHyprlandColor("0x80112233"), "#11223380");
assert.equal(parseHyprlandColor(""), null);
assert.equal(parseHyprlandColor("45deg"), null);
assert.equal(parseHyprlandColor("not-a-colour"), null);

// The same, through the surface resolver a view actually calls, including the
// section's own `*-alpha` companion.
const gradient = omarchyStyle(`
[hyprland]
active-border = "rgba(6f1828e6) rgba(9c2331e6) 45deg"
[popups]
background = "#0a0708"
background-alpha = 0.9
border = "hyprland.active-border"
border-alpha = 1.0
`);
assert.equal(
  resolveSurfaceColor(
    gradient,
    gradient.surfaces.popupBorder,
    "#000000",
    gradient.surfaces.popupBorderAlpha,
  ),
  "#6f1828ff",
);
assert.equal(
  resolveSurfaceColor(
    gradient,
    gradient.surfaces.popupBackground,
    "#000000",
    gradient.surfaces.popupBackgroundAlpha,
  ),
  "#0a0708e6",
);
// Nothing usable falls back rather than handing gpui a string it will refuse.
assert.equal(resolveSurfaceColor(gradient, "45deg", "#123456"), "#123456");

// A machine with no theme installed still lays out at the density the design
// was drawn at, rather than at gpui's.
const bare = omarchyStyle("");
assert.equal(bare.spacing.md, 6);
assert.equal(bare.font.body, 12);
assert.equal(bare.fontFamily, "monospace");

applyOmarchyStyle(shell, { cornerRadius: 7, fontFamily: "Iosevka" });
assert.equal(style().cornerRadius, 7);
assert.equal(style().fontFamily, "Iosevka");

console.log("omarchy-ui style tests passed");
