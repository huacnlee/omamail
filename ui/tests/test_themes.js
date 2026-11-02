const assert = require("assert")
const { load, deepEqual } = require("./load")

const themes = load("theme/Themes.js")

// ---------------------------------------------------------------- names
//
// A theme name becomes a path segment under a theme directory, so it is the
// one string in this feature a settings file can use to reach somewhere else.
// Everything that is not a plain name is Follow Omarchy.
assert.strictEqual(themes.FOLLOW, "")
assert.strictEqual(themes.validName("nord"), true)
assert.strictEqual(themes.validName("catppuccin-latte"), true)
assert.strictEqual(themes.validName("retro-82"), true)
assert.strictEqual(themes.validName("a.b_c-1"), true)
assert.strictEqual(themes.validName(""), false)
assert.strictEqual(themes.validName("."), false)
assert.strictEqual(themes.validName(".."), false)
assert.strictEqual(themes.validName("../../etc/passwd"), false)
assert.strictEqual(themes.validName("a/b"), false)
assert.strictEqual(themes.validName("a\\b"), false)
assert.strictEqual(themes.validName(".hidden"), false)
assert.strictEqual(themes.validName("-rf"), false)
assert.strictEqual(themes.validName("n ord"), false)
assert.strictEqual(themes.validName("nord\nrm -rf /"), false)
assert.strictEqual(themes.validName("nord\0"), false)
assert.strictEqual(themes.validName("a".repeat(65)), false)
assert.strictEqual(themes.validName(null), false)
assert.strictEqual(themes.validName(undefined), false)
assert.strictEqual(themes.validName(42), false)

assert.strictEqual(themes.normalizeName("nord"), "nord")
assert.strictEqual(themes.normalizeName("  nord  "), "nord")
assert.strictEqual(themes.normalizeName("Nord"), "Nord")
assert.strictEqual(themes.normalizeName("../../x"), "")
assert.strictEqual(themes.normalizeName(""), "")
assert.strictEqual(themes.normalizeName(null), "")
assert.strictEqual(themes.normalizeName(undefined), "")
assert.strictEqual(themes.normalizeName(7), "")

// The picker shows the name a person would say, from the name a directory has.
assert.strictEqual(themes.displayName("catppuccin-latte"), "Catppuccin Latte")
assert.strictEqual(themes.displayName("retro-82"), "Retro 82")
assert.strictEqual(themes.displayName("nord"), "Nord")
assert.strictEqual(themes.displayName("flexoki_light"), "Flexoki Light")
assert.strictEqual(themes.displayName("osaka.jade"), "Osaka Jade")
assert.strictEqual(themes.displayName(""), "")

// ------------------------------------------------------------ colors.toml
//
// A current Omarchy theme states its roles outright.
const modern = themes.parseColors([
  'mode = "dark"',
  '',
  'accent = "#89b4fa"',
  'selection = "#45475a"',
  'muted = "#585b70"',
  '',
  'background = "#1e1e2e"',
  'foreground = "#cdd6f4"',
  '',
  'red = "#f38ba8"',
].join("\n"))
deepEqual(modern, {
  foreground: "#cdd6f4", background: "#1e1e2e", accent: "#89b4fa",
  urgent: "#f38ba8", muted: "#585b70", selection: "#45475a",
  mode: "dark", light: false, hyprlandActiveBorder: "",
})

// An older theme has only the sixteen terminal colours; the same four
// fallbacks the shell's Color.loadColors uses fill the roles in.
const legacy = themes.parseColors([
  'color0 = "#101010"',
  'color1 = "#cc3333"',
  'color4 = "#3355ff"',
  'color7 = "#e0e0e0"',
  'color8 = "#707070"',
].join("\n"))
deepEqual(legacy, {
  foreground: "#e0e0e0", background: "#101010", accent: "#3355ff",
  urgent: "#cc3333", muted: "#707070", selection: "#707070",
  mode: "dark", light: false, hyprlandActiveBorder: "",
})

// No muted colour means the foreground, and no accent means color4 — an
// explicit accent is not overwritten by a color4 that appears later.
const sparse = themes.parseColors([
  'foreground = "#ffffff"',
  'background = "#000000"',
  'color4 = "#123456"',
].join("\n"))
assert.strictEqual(sparse.accent, "#123456")
assert.strictEqual(sparse.muted, "#ffffff")

// Comments, inline comments, unquoted values, unknown keys and malformed
// lines are tolerated; a second reading of a key wins, as it does in the
// shell's own loader.
const messy = themes.parseColors([
  '# a comment',
  'foreground = "#eeeeee" # trailing',
  'background=#111111',
  'mode = "light"',
  'selection = "#45475a"',
  'not a line at all',
  'foreground = "#zzzzzz"',
  'foreground = "#dddddd"',
].join("\n"))
assert.strictEqual(messy.foreground, "#dddddd")
assert.strictEqual(messy.background, "#111111")
assert.strictEqual(messy.mode, "light")
assert.strictEqual(messy.light, true)

// A file with no usable colour is not a theme: null, so the stored name
// falls back to Follow Omarchy instead of becoming an error state.
assert.strictEqual(themes.parseColors(""), null)
assert.strictEqual(themes.parseColors(undefined), null)
assert.strictEqual(themes.parseColors('mode = "dark"\n'), null)

// A theme that cannot be drawn is not a theme. Foreground text on a
// background surface is the whole of what a window needs, and a file that
// states only one of the two used to be accepted with an empty role, which
// paints black text on black or nothing at all.
assert.strictEqual(themes.parseColors('background = "#eff1f5"\nforeground = "garbage"\n'), null)
assert.strictEqual(themes.parseColors('foreground = "#4c4f69"\nbackground = "garbage"\n'), null)
assert.strictEqual(themes.parseColors('color7 = "#e0e0e0"\n'), null)

// The roles a theme leaves out are filled deliberately, never left empty.
const noAccent = themes.parseColors('foreground = "#4c4f69"\nbackground = "#eff1f5"\n')
assert.strictEqual(noAccent.accent, "#4c4f69")
assert.strictEqual(noAccent.urgent, "#4c4f69")
const noUrgent = themes.parseColors([
  'foreground = "#4c4f69"',
  'background = "#eff1f5"',
  'accent = "#8839ef"',
].join("\n"))
assert.strictEqual(noUrgent.urgent, "#8839ef")
assert.strictEqual(noUrgent.selection, noUrgent.muted)

// colors.toml's Hyprland active border is what the stock template puts behind
// a popup when the theme ships no shell.toml of its own; only its first colour
// can be drawn on a single-colour surface.
const hypr = themes.parseColors([
  'foreground = "#4c4f69"',
  'background = "#eff1f5"',
  'accent = "#8839ef"',
  'hyprland_active_border = "#123456 #654321 45deg"',
].join("\n"))
assert.strictEqual(hypr.hyprlandActiveBorder, "#123456")
assert.strictEqual(themes.resolveTheme(hypr, "").popups.border, "#123456")
// A theme's own shell.toml still decides the popup border when it states one.
assert.strictEqual(themes.resolveTheme(hypr, '[popups]\nborder = "accent"\n').popups.border, "#8839ef")
// Without either, the accent is what the template falls back to.
assert.strictEqual(themes.resolveTheme(themes.parseColors([
  'foreground = "#4c4f69"', 'background = "#eff1f5"', 'accent = "#8839ef"',
].join("\n")), "").popups.border, "#8839ef")

// A theme that does not state its mode is read from its background.
const inferred = themes.parseColors('foreground = "#4c4f69"\nbackground = "#eff1f5"\n')
assert.strictEqual(inferred.mode, "light")
assert.strictEqual(inferred.light, true)

// ------------------------------------------------------------ gradients
assert.strictEqual(themes.firstColorToken("#89b4fa #8ba4f0 45deg"), "#89b4fa")
assert.strictEqual(themes.firstColorToken("45deg #89b4fa #8ba4f0"), "#89b4fa")
assert.strictEqual(themes.firstColorToken("#89b4fa"), "#89b4fa")
assert.strictEqual(themes.firstColorToken(""), "")

// ------------------------------------------------------------- surfaces
const light = themes.parseColors([
  'mode = "light"',
  'foreground = "#4c4f69"',
  'background = "#eff1f5"',
  'accent = "#8839ef"',
  'red = "#d20f39"',
  'muted = "#8c8fa1"',
].join("\n"))

// A theme that ships no shell.toml gets the stock template's meaning.
const stock = themes.resolveTheme(light, "")
assert.strictEqual(stock.palette.foreground, "#4c4f69")
assert.strictEqual(stock.popups.background, "#eff1f5")
assert.strictEqual(stock.popups.text, "#4c4f69")
assert.strictEqual(stock.popups.border, "#8839ef")
assert.strictEqual(stock.popups.backgroundAlpha, 1)
assert.strictEqual(stock.tooltip.background, "#eff1f5")
assert.strictEqual(stock.tooltip.text, "#4c4f69")
assert.strictEqual(stock.tooltip.border, "#4c4f69")
assert.strictEqual(stock.tooltip.backgroundAlpha, 0.97)
// Control colours stay tokens, because a caller's own foreground is what a
// role means. That is what makes a themed control follow the window.
assert.strictEqual(stock.controls.normal.color, "foreground")
assert.strictEqual(stock.controls.hover.color, "foreground")
assert.strictEqual(stock.controls.selected.color, "foreground")
assert.strictEqual(stock.controls.pressed.color, "foreground")
assert.strictEqual(stock.controls.selection.color, "foreground")
assert.strictEqual(stock.controls.normal.border, "foreground")
assert.strictEqual(stock.controls.selected.border, "foreground")

// A theme that ships its own shell.toml is obeyed: role names resolve
// against the picked palette, hex is taken as written, and a popup border
// naming the Hyprland gradient becomes its first colour.
const shipped = themes.resolveTheme(light, [
  '[hyprland]',
  'active-border = "#8839ef #7297ff 45deg"',
  '[controls]',
  'normal-color = "accent"',
  'hover-cursor-color = "#ff0000"',
  '[popups]',
  'background = "foreground"',
  'border = "hyprland.active-border"',
  'background-alpha = 0.95',
  '[tooltip]',
  'text = "accent"',
].join("\n"))
assert.strictEqual(shipped.popups.border, "#8839ef")
assert.strictEqual(shipped.popups.background, "#4c4f69")
assert.strictEqual(shipped.popups.backgroundAlpha, 0.95)
assert.strictEqual(shipped.tooltip.text, "#8839ef")
assert.strictEqual(shipped.controls.normal.color, "accent")
assert.strictEqual(shipped.controls.hover.color, "#ff0000")

// A popup border with no gradient and no hex falls back to the accent.
const noBorder = themes.resolveTheme(light, [
  '[popups]',
  'border = "transparent"',
].join("\n"))
assert.strictEqual(noBorder.popups.border, "transparent")
assert.strictEqual(themes.resolveTheme(light, '[popups]\nborder = "nonsense"\n').popups.border, "#8839ef")

// Tokens a caller passes a colour for resolve at call time.
assert.strictEqual(themes.resolveToken("foreground", light), "#4c4f69")
assert.strictEqual(themes.resolveToken("text", light), "#4c4f69")
assert.strictEqual(themes.resolveToken("accent", light), "#8839ef")
assert.strictEqual(themes.resolveToken("urgent", light), "#d20f39")
assert.strictEqual(themes.resolveToken("background", light), "#eff1f5")
assert.strictEqual(themes.resolveToken("#ff0000", light), "#ff0000")
assert.strictEqual(themes.resolveToken("transparent", light), "transparent")
assert.strictEqual(themes.resolveToken("nonsense", light), "")

// ---------------------------------------------------------------- roots
//
// The user's own theme wins over the installed one of the same name, and
// OMARCHY_PATH is honoured when it is set — which it often is not inside the
// plugin's own environment.
deepEqual(themes.themeRoots("/home/u", "/opt/omarchy"), [
  "/home/u/.config/omarchy/themes",
  "/opt/omarchy/themes",
  "/home/u/.local/share/omarchy/themes",
  "/usr/share/omarchy/themes",
])
deepEqual(themes.themeRoots("/home/u", ""), [
  "/home/u/.config/omarchy/themes",
  "/home/u/.local/share/omarchy/themes",
  "/usr/share/omarchy/themes",
])
deepEqual(themes.themeRoots("", ""), ["/usr/share/omarchy/themes"])

deepEqual(themes.mergeEntries(
  [{ name: "nord", dir: "/home/u/.config/omarchy/themes/nord" }],
  [
    { name: "nord", dir: "/usr/share/omarchy/themes/nord" },
    { name: "catppuccin-latte", dir: "/usr/share/omarchy/themes/catppuccin-latte" },
  ]), [
  { name: "catppuccin-latte", label: "Catppuccin Latte", dir: "/usr/share/omarchy/themes/catppuccin-latte", user: false },
  { name: "nord", label: "Nord", dir: "/home/u/.config/omarchy/themes/nord", user: true },
])

// A directory whose name is not a theme name is not offered.
deepEqual(themes.mergeEntries([{ name: "..", dir: "/x" }, { name: "", dir: "/y" }], []), [])
deepEqual(themes.mergeEntries(undefined, undefined), [])

console.log("test_themes.js ok")
