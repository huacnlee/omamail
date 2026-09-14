.pragma library

// Standalone application roles derived from Omarchy's colors.toml. Parsing is
// deliberately all-or-nothing: mixing one broken user role with fallback
// colours produces a palette that belongs to neither theme.
var DARK_FALLBACK = {
  background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7",
  red: "#f7768e", yellow: "#e0af68", green: "#9ece6a",
  lighter_background: "#24283b", dark_background: "#13141c",
  bright_foreground: "#c0caf5", selection: "#292e42", muted: "#414868",
  mode: "dark"
}

// Lupine is Omarchy's built-in light theme. This standalone adaptation keeps
// its palette pinned to the source, with the user-selected pure-white window
// background replacing Lupine's near-white background:
// https://github.com/bjarneo/omarchy-lupine-theme/blob/3c225d2129e6f8649e6a9ebba18ea5db4e37f7a3/colors.toml
var LIGHT_FALLBACK = {
  background: "#ffffff", foreground: "#212121", accent: "#3264eb",
  red: "#c900c4", yellow: "#026fde", green: "#4a2fd0",
  lighter_background: "#f5f5f5", dark_background: "#ececec",
  bright_foreground: "#000000", selection: "#d0d0d0", muted: "#9e9e9e",
  mode: "light"
}

function copy(source) {
  var result = {}
  for (var key in source) result[key] = source[key]
  return result
}

function validHex(value) { return /^#[0-9a-fA-F]{6}$/.test(String(value || "")) }

function rgb(value) {
  return [parseInt(value.substr(1, 2), 16), parseInt(value.substr(3, 2), 16),
    parseInt(value.substr(5, 2), 16)]
}

function hex(values) {
  var result = "#"
  for (var i = 0; i < 3; i++) {
    var part = Math.max(0, Math.min(255, Math.round(values[i]))).toString(16)
    result += part.length === 1 ? "0" + part : part
  }
  return result
}

function mix(first, second, amount) {
  var a = rgb(first)
  var b = rgb(second)
  return hex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount])
}

function luminance(value) {
  var values = rgb(value)
  var total = [0.2126, 0.7152, 0.0722]
  var result = 0
  for (var i = 0; i < 3; i++) {
    var channel = values[i] / 255
    channel = channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    result += channel * total[i]
  }
  return result
}

function contrast(first, second) {
  var a = luminance(first)
  var b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function readableStatus(value, background, light) {
  if (!light || contrast(value, background) >= 4.5) return value
  var candidate = value
  for (var i = 1; i <= 20; i++) {
    candidate = mix(value, "#000000", i / 20)
    if (contrast(candidate, background) >= 4.5) return candidate
  }
  return "#000000"
}

function onAccent(accent) {
  return contrast("#000000", accent) >= contrast("#ffffff", accent)
    ? "#000000" : "#ffffff"
}

function parse(raw) {
  var values = {}
  var lines = String(raw || "").split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "")
    if (line === "" || line.charAt(0) === "#") continue
    var match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^\s]*))\s*(?:#.*)?$/)
    if (!match) return null
    values[match[1]] = match[2] !== undefined ? match[2]
      : (match[3] !== undefined ? match[3] : match[4])
  }

  var mapped = {
    background: values.background || values.bg || values.color0,
    foreground: values.foreground || values.fg || values.color7,
    accent: values.accent || values.color4,
    red: values.red || values.color1,
    yellow: values.yellow || values.color3,
    green: values.green || values.color2,
    lighter_background: values.lighter_background || values.lighter_bg,
    dark_background: values.dark_background || values.dark_bg,
    bright_foreground: values.bright_foreground || values.bright_fg
      || values.selection_foreground || values.cursor,
    selection: values.selection || values.selection_background,
    muted: values.muted || values.color8,
    mode: values.mode
  }
  var required = ["background", "foreground", "accent", "red", "yellow", "green"]
  for (var j = 0; j < required.length; j++) if (!validHex(mapped[required[j]])) return null
  var optional = ["lighter_background", "dark_background", "bright_foreground", "selection", "muted"]
  for (var k = 0; k < optional.length; k++) {
    var optionalValue = mapped[optional[k]]
    if (optionalValue !== undefined && !validHex(optionalValue)) return null
  }
  if (mapped.mode !== undefined && mapped.mode !== "dark" && mapped.mode !== "light") return null
  return mapped
}

function roles(values) {
  var palette = copy(values)
  var light = palette.mode === "light"
    || (palette.mode === undefined && luminance(palette.background) > luminance(palette.foreground))
  return {
    appearance: light ? "light" : "dark",
    background: palette.background,
    foreground: palette.foreground,
    accent: palette.accent,
    urgent: readableStatus(palette.red, palette.background, light),
    warning: readableStatus(palette.yellow, palette.background, light),
    success: readableStatus(palette.green, palette.background, light),
    surface: palette.lighter_background || mix(palette.background, palette.foreground, 0.05),
    inset: palette.dark_background || mix(palette.background, palette.foreground, 0.08),
    bright: palette.bright_foreground || palette.foreground,
    secondary: mix(palette.background, palette.foreground, 0.75),
    selection: palette.selection || mix(palette.background, palette.accent, 0.20),
    border: palette.muted || mix(palette.background, palette.foreground, 0.25),
    onAccent: onAccent(palette.accent)
  }
}

function fallback(appearance) {
  return roles(copy(appearance === "light" ? LIGHT_FALLBACK : DARK_FALLBACK))
}
function resolve(raw, fallbackAppearance) {
  var parsed = parse(raw)
  return parsed ? roles(parsed) : fallback(fallbackAppearance)
}
