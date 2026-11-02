.pragma library

// What an Omarchy theme is, as rules rather than as files.
//
// The window can be drawn in a theme other than the desktop's, so it needs the
// same four foundational roles the shell reads from colors.toml, the same
// fallbacks for a theme that only has terminal colours, and the surface and
// control tokens Omarchy bakes from default/themed/shell.toml.tpl. None of
// that needs the shell, a window or a file handle: this module takes the text
// of a theme's files and answers with colours, so the node tests and
// `Paint.qml` run exactly the same rules.
//
// The one thing this module deliberately does not decide is when a colour is
// used: control colours stay tokens ("foreground", or a hex a theme pinned)
// because `foreground` means the foreground of the surface asking, which is
// what lets a themed control follow the window it is drawn in.

// The name that means "the desktop's theme". It is the empty string because
// that is what an absent setting reads as, and a theme may not be named it.
var FOLLOW = ""
var MAX_NAME_LENGTH = 64

// A theme name is a single path segment under a theme directory. Anything
// that could reach outside one — a separator, a parent reference, a leading
// dot, a leading dash for a program that takes options — is not a name.
function validName(name) {
  if (typeof name !== "string") return false
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false
  if (name.indexOf("..") >= 0) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

// A stored setting is untrusted: whatever it says, an unusable value is
// Follow Omarchy rather than an error the window has to report. Only a string
// can name a theme; a number or an object in a settings file is not one.
function normalizeName(value) {
  if (typeof value !== "string") return FOLLOW
  var text = value.replace(/^\s+|\s+$/g, "")
  return validName(text) ? text : FOLLOW
}

// "catppuccin-latte" is a directory; "Catppuccin Latte" is what a person
// calls it. Digits are left alone, so "retro-82" keeps its number.
function displayName(slug) {
  var parts = String(slug || "").split(/[-_.]+/)
  var words = []
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (part.length === 0) continue
    words.push(part.charAt(0).toUpperCase() + part.substring(1))
  }
  return words.join(" ")
}

// A border token may be a Hyprland-style gradient — colours and an angle in
// one string. A colour-only consumer, such as a native rectangle border,
// takes the first colour.
function firstColorToken(value) {
  var parts = String(value === undefined || value === null ? "" : value)
    .replace(/^\s+|\s+$/g, "")
    .split(/\s+/)
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length === 0) continue
    if (/^-?\d+(?:\.\d+)?deg$/.test(parts[i])) continue
    return parts[i]
  }
  return ""
}

function parseNumber(value, fallback) {
  var text = String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
  if (text === "") return fallback
  var n = Number(text)
  if (!isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

function channel(value) {
  var c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// Whether a background is light, for a theme whose colors.toml does not say.
// Only used to describe the palette; nothing takes a decision from it.
function luminance(hex) {
  var m = String(hex || "").match(/^#([0-9A-Fa-f]{6})$/)
  if (!m) return 0
  var h = m[1]
  return 0.2126 * channel(parseInt(h.substr(0, 2), 16))
    + 0.7152 * channel(parseInt(h.substr(2, 2), 16))
    + 0.0722 * channel(parseInt(h.substr(4, 2), 16))
}

var COLOR_LINE = /^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/
var MODE_LINE = /^\s*mode\s*=\s*["']?(light|dark)\b/i

// colors.toml into the four roles the window draws with, plus muted and the
// mode. The fallbacks are the shell's own: an older theme states only
// color0/color4/color7/color8, and a theme states its own accent or color4 is
// what "accent" meant.
//
// Returns null when the text states no usable colour at all — that is a
// broken or absent theme file, and the caller falls back to Follow Omarchy.
function parseColors(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  var out = {
    foreground: "", background: "", accent: "", urgent: "", muted: "",
    selection: "", mode: "", light: false, hyprlandActiveBorder: "",
  }
  var color0 = "", color4 = "", color7 = "", color8 = ""
  var foundAccent = false, foundMuted = false, foundBackground = false, foundForeground = false
  var lines = text.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var mode = lines[i].match(MODE_LINE)
    if (mode) out.mode = mode[1].toLowerCase()
    var match = lines[i].match(COLOR_LINE)
    if (!match) continue
    var key = match[1]
    var hex = match[2].toLowerCase()
    if (key === "foreground") { out.foreground = hex; foundForeground = true }
    else if (key === "background") { out.background = hex; foundBackground = true }
    else if (key === "accent") { out.accent = hex; foundAccent = true }
    else if (key === "muted") { out.muted = hex; foundMuted = true }
    else if (key === "selection") out.selection = hex
    else if (key === "color0") color0 = hex
    else if (key === "color4") color4 = hex
    else if (key === "color7") color7 = hex
    else if (key === "color8") color8 = hex
    else if (key === "red" || key === "color1") out.urgent = hex
    // The active border is a Hyprland gradient; only its first colour can be
    // drawn on a single-colour surface, and the shell's own template uses it as
    // the popup border when a theme ships no shell.toml of its own.
    else if (key === "hyprland_active_border") out.hyprlandActiveBorder = hex
  }
  if (!foundBackground) out.background = color0
  if (!foundForeground) out.foreground = color7
  if (!foundAccent) out.accent = color4
  // A theme has to be drawable before it may be used: foreground text on a
  // background surface. A file that states neither, or only one of the two, is
  // not a theme, and the caller falls back to Follow Omarchy.
  if (out.foreground === "" || out.background === "") return null
  // The remaining roles are optional in a theme, so they are filled
  // deliberately rather than left empty: an accent the theme did not state is
  // its foreground, as the shell's own accent falls back to its foreground, and
  // an urgent colour is its accent. A caller that paints one of them therefore
  // always has a real colour to paint.
  if (out.accent === "") out.accent = out.foreground
  if (out.urgent === "") out.urgent = out.accent
  if (!foundMuted || out.muted === "") out.muted = color8 !== "" ? color8 : out.foreground
  if (out.selection === "") out.selection = out.muted
  if (out.mode === "") out.mode = luminance(out.background) > 0.5 ? "light" : "dark"
  out.light = out.mode === "light"
  return out
}

// shell.toml into "section.key" values, the way Commons.Color.parseShell
// does: quoted strings, bare numbers, bare width lists and bare role names,
// with inline comments tolerated. Only the readers below decide what a value
// means.
function parseShell(raw) {
  var parsed = ({})
  var text = String(raw === undefined || raw === null ? "" : raw)
  if (text === "") return parsed
  var lines = text.split("\n")
  var section = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "")
    if (line === "" || line.charAt(0) === "#") continue
    var sectionMatch = line.match(/^\[([A-Za-z0-9_-]+)\]\s*(#.*)?$/)
    if (sectionMatch) { section = sectionMatch[1]; continue }
    var stringKv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']\s*(#.*)?$/)
    var numKv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(#.*)?$/)
    var bareKv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*([A-Za-z][A-Za-z0-9_-]*)\s*(#.*)?$/)
    var kv = stringKv || numKv || bareKv
    if (!kv || section === "") continue
    parsed[section + "." + kv[1]] = kv[2]
  }
  return parsed
}

// A role token against a palette. "" for anything the palette does not name,
// so a caller can fall back rather than paint black.
function resolveToken(token, palette) {
  var role = String(token === undefined || token === null ? "" : token)
    .replace(/^\s+|\s+$/g, "").toLowerCase()
  var p = palette || ({})
  if (role === "foreground" || role === "text") return p.foreground || ""
  if (role === "background") return p.background || ""
  if (role === "accent") return p.accent || ""
  if (role === "urgent" || role === "danger") return p.urgent || ""
  if (role === "muted") return p.muted || ""
  if (role === "selection") return p.selection || ""
  if (role === "transparent") return "transparent"
  if (/^#[0-9A-Fa-f]{3}$/.test(role) || /^#[0-9A-Fa-f]{6}$/.test(role)) return role
  return ""
}

// A theme's own shell.toml may point at another token ("hyprland.active-border")
// rather than state a colour. This follows that one hop — and only one kind of
// hop, a section.key that the same file defines — so a theme can describe its
// popup border in terms of the gradient it already states.
function followToken(value, shell) {
  var s = String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
  var seen = ({})
  while (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s) && !seen[s]) {
    seen[s] = true
    var next = shell[s]
    if (next === undefined || next === null) break
    s = String(next).replace(/^\s+|\s+$/g, "")
  }
  return s
}

// A surface colour: the theme's token when it states one, the role it means,
// or `fallback` when the theme is silent. Gradients reduce to their first
// colour, which is what a single-colour surface can honour.
function surfaceColor(rawValue, shell, palette, fallback) {
  var value = followToken(rawValue, shell)
  var token = firstColorToken(value)
  var colour = resolveToken(token, palette)
  if (colour !== "") return colour
  return resolveToken(fallback, palette)
}

var CONTROL_DEFAULTS = {
  normal: "foreground",
  hover: "foreground",
  focus: "foreground",
  selected: "foreground",
}

function controlKey(shell, key) {
  var value = shell["controls." + key]
  if (value === undefined || value === null || String(value) === "") value = shell["style." + key]
  if (value === undefined || value === null) return ""
  return String(value).replace(/^\s+|\s+$/g, "")
}

function controlTokens(shell) {
  var normal = {
    color: controlKey(shell, "normal-color") || CONTROL_DEFAULTS.normal,
    border: controlKey(shell, "normal-border"),
  }
  var hover = {
    color: controlKey(shell, "hover-cursor-color") || CONTROL_DEFAULTS.hover,
    border: controlKey(shell, "hover-cursor-border"),
  }
  var focus = {
    color: controlKey(shell, "focus-color") || hover.color,
    border: controlKey(shell, "focus-border"),
  }
  var selected = {
    color: controlKey(shell, "selected-color") || CONTROL_DEFAULTS.selected,
    border: controlKey(shell, "selected-border"),
  }
  var pressed = {
    color: controlKey(shell, "pressed-color") || hover.color,
  }
  var selection = {
    color: controlKey(shell, "selection-color") || CONTROL_DEFAULTS.selected,
  }
  // A border with no colour of its own follows the state's own colour, as the
  // shell's own Border.controlSpec does.
  if (normal.border === "") normal.border = normal.color
  if (hover.border === "") hover.border = hover.color
  if (focus.border === "") focus.border = focus.color
  if (selected.border === "") selected.border = selected.color
  return { normal: normal, hover: hover, focus: focus, selected: selected,
    pressed: pressed, selection: selection }
}

// A complete theme: the palette, the surfaces whose colour does not depend on
// a caller, and the control tokens a caller resolves with its own colours.
//
// Alphas, border widths, spacing, fonts and corner radius are not here on
// purpose. They come from the live Style — they are the user's shell-wide
// values, identical across the stock themes, and a window that changed them
// would stop matching the bar beside it.

// A popup border. The theme's own shell.toml wins; without one, the stock
// template asks for the Hyprland active border, which colors.toml states as a
// gradient — a single-colour surface takes its first colour — and the accent is
// what the template falls back to when the theme states neither.
function popupBorder(shell, palette) {
  if (shell["popups.border"] !== undefined) {
    return surfaceColor(shell["popups.border"], shell, palette, "accent")
  }
  var override = palette && palette.hyprlandActiveBorder !== undefined
    ? resolveToken(palette.hyprlandActiveBorder, palette) : ""
  if (override !== "") return override
  return resolveToken("accent", palette)
}

function resolveTheme(palette, shellRaw) {
  var colours = palette || parseColors("")
  var shell = parseShell(shellRaw)
  return {
    palette: colours,
    popups: {
      background: surfaceColor(shell["popups.background"], shell, colours, "background"),
      text: surfaceColor(shell["popups.text"], shell, colours, "foreground"),
      border: popupBorder(shell, colours),
      backgroundAlpha: parseNumber(shell["popups.background-alpha"], 1),
      borderAlpha: parseNumber(shell["popups.border-alpha"], 1),
    },
    tooltip: {
      background: surfaceColor(shell["tooltip.background"], shell, colours, "background"),
      text: surfaceColor(shell["tooltip.text"], shell, colours, "foreground"),
      border: surfaceColor(shell["tooltip.border"], shell, colours, "foreground"),
      backgroundAlpha: parseNumber(shell["tooltip.background-alpha"], 0.97),
    },
    controls: controlTokens(shell),
  }
}

// Where a theme directory may live, most specific first. The user's own themes
// win over the installed ones, the same rule bin/omarchy-theme-dir applies.
// OMARCHY_PATH is often unset inside a plugin's environment, so the two
// installation paths follow it.
function themeRoots(home, omarchyPath) {
  var h = String(home === undefined || home === null ? "" : home).replace(/\/+$/, "")
  var base = String(omarchyPath === undefined || omarchyPath === null ? "" : omarchyPath)
    .replace(/\/+$/, "")
  var roots = []
  if (h !== "") roots.push(h + "/.config/omarchy/themes")
  if (base !== "") roots.push(base + "/themes")
  if (h !== "") roots.push(h + "/.local/share/omarchy/themes")
  roots.push("/usr/share/omarchy/themes")
  return roots
}

// One list from the two roots: the user's copy of a name replaces the
// installed one, so picking "nord" picks the theme the user edited. Sorted by
// the name a person reads rather than by the directory spelling.
function mergeEntries(userEntries, systemEntries) {
  var seen = ({})
  var out = []
  var roots = [userEntries || [], systemEntries || []]
  for (var r = 0; r < roots.length; r++) {
    var entries = roots[r]
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var name = String(entry && entry.name !== undefined ? entry.name : "")
      if (!validName(name) || seen[name]) continue
      seen[name] = true
      out.push({
        name: name,
        label: displayName(name),
        dir: String(entry.dir === undefined || entry.dir === null ? "" : entry.dir),
        user: r === 0,
      })
    }
  }
  out.sort(function(a, b) {
    var left = a.label.toLowerCase()
    var right = b.label.toLowerCase()
    if (left === right) return 0
    return left < right ? -1 : 1
  })
  return out
}
