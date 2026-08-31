import assert from "node:assert/strict";

import {
  omarchyBaseColors,
  applyOmarchyRoles,
  omarchyRoles,
  omarchyStatusColors,
  omarchyTheme,
  role,
} from "omarchy-ui";
import { mix, omarchyStyle } from "omarchy-ui";

const source = `
mode = "light"
background = "#f8f7f2"
foreground = "#242424"
accent = "#3465a4"
selection = "#d9e4f2"
lighter_background = "#ffffff"
dark_foreground = "#666666"
light_foreground = "#eeeeee"
bright_foreground = "#ffffff"
red = "#a40000"
green = "#4e9a06"
yellow = "#c4a000"
blue = "#3465a4"
magenta = "#75507b"
cyan = "#06989a"
`;

const fallback = {
  appearance: "dark",
  colors: {
    background: "fallback-background",
    foreground: "fallback-foreground",
    destructive: "fallback-destructive",
  },
  spacing: { md: 12 },
  radius: { md: 8 },
};

assert.deepEqual(omarchyBaseColors(source), [
  "#a40000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
]);
assert.deepEqual(omarchyStatusColors(source), {
  danger: "#a40000",
  success: "#4e9a06",
  warning: "#c4a000",
  info: "#06989a",
});

const tokens = omarchyStyle("", { cornerRadius: 6 });
const theme = omarchyTheme(source, fallback, tokens);
assert.equal(theme.appearance, "light");
assert.equal(theme.tokens.colors.background, "#f8f7f2");
assert.equal(theme.tokens.colors.foreground, "#242424");
assert.equal(theme.tokens.colors.primary, "#3465a4");
assert.equal(theme.tokens.colors.destructive, "#a40000");

// Secondary text mixes the foreground toward the background rather than taking
// the palette's own `dark_foreground`: on this light theme that key is
// #666666, which is *darker* than a mixed value would be and so reads heavier
// than the body text it is supposed to sit behind.
const roles = omarchyRoles(source);
assert.equal(theme.tokens.colors.muted_foreground, roles.dim);
assert.notEqual(roles.dim, "#666666");

// A border is the foreground at the theme's border alpha, never a literal gray
// — and opaque, because a token's alpha is dropped on the way in. Left
// translucent it resolves to the bare foreground, which on this light theme is
// near-black and on a dark one is pure white: every rule in the window as loud
// as the text it separates.
assert.equal(
  theme.tokens.colors.border,
  mix("#f8f7f2", "#242424", 0.4),
);
assert.equal(theme.tokens.colors.border.slice(-2), "ff");
assert.notEqual(theme.tokens.colors.border, roles.foreground);

// The hover and selected fills are blended against the ground, not handed over
// translucent: gpui resolves a theme token to a solid colour, so an alpha
// written into one is dropped — and a dropped alpha turns the "selected" tint
// into a solid block of accent, which the Omarchy kit never draws.
assert.equal(theme.tokens.colors.accent.slice(-2), "ff");
assert.equal(theme.tokens.colors.muted.slice(-2), "ff");
assert.notEqual(theme.tokens.colors.accent, roles.accent);
assert.equal(theme.tokens.colors.input, theme.tokens.colors.border);

// Spacing and radius come from the desktop, not from gpui's own scale.
assert.deepEqual(theme.tokens.spacing, {
  xxs: 2,
  xs: 3,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  xxl: 12,
});
assert.equal(theme.tokens.radius.sm, 6);
assert.equal(theme.tokens.radius.xl, 6);
// A pill stays a pill even where the desktop is square: it is what draws the
// unread dot, not a corner treatment.
assert.equal(theme.tokens.radius.full, 9999);
assert.equal(omarchyTheme(source, fallback, omarchyStyle("")).tokens.radius.sm, 0);

// The link tone keeps the accent's hue and lightness at a capped saturation.
assert.notEqual(roles.link, roles.accent);

// gpui's token set has no `link`, `popover` or `selection`, so writing them
// into the theme would be writing them nowhere. They live beside it, and
// `role()` is how a view reaches one.
assert.equal(theme.tokens.colors.link, undefined);
assert.equal(theme.tokens.colors.popover, undefined);
assert.equal(role("link", "#000000"), "#000000");
applyOmarchyRoles(source);
assert.equal(role("link", "#000000"), roles.link);
assert.equal(role("dim", "#000000"), roles.dim);

// A panel rule is not a control border, and gpui has one token for both.
//
// `Ui/PanelSeparator.qml` hard-codes 0.12 on the foreground and its own comment
// says why: the rule has to stay legible "without competing with text or
// borders", which the control border's 0.4 does. Drawing the rail edge, the
// list/reader split and every section rule at `colors.border` made all of them
// visibly heavier than the QML's, so the second weight lives beside the theme
// like the other three.
assert.equal(role("separator", "#000000"), roles.separator);
assert.notEqual(
  roles.separator,
  theme.tokens.colors.border,
  "a panel rule is fainter than a control border",
);
assert.equal(
  roles.separator,
  mix(roles.background, roles.foreground, 0.12),
  "and it is the QML's own 0.12, blended against the ground",
);

// The general rule the three above are instances of: gpui resolves a theme
// token to a solid colour and silently drops any alpha, so a translucent one
// does not arrive faint — it arrives at full strength. Every colour handed to
// `set_theme` is blended here instead.
for (const [name, value] of Object.entries(theme.tokens.colors)) {
  if (typeof value !== "string" || !value.startsWith("#")) continue;
  assert.equal(
    value.length === 9 ? value.slice(-2) : "ff",
    "ff",
    `theme colour \`${name}\` is translucent; blend it against the ground instead`,
  );
}

assert.equal(omarchyTheme("red = '#a40000'", fallback, tokens), null);

console.log("omarchy-ui theme tests passed");
