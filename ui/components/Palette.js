.pragma library

var SLOT_KEYS = ["accent", "red", "green", "yellow", "blue", "magenta", "cyan"]
var ANSI_KEYS = {
  red: "color1", green: "color2", yellow: "color3", blue: "color4",
  magenta: "color5", cyan: "color6"
}

function keys() { return SLOT_KEYS.slice() }

function normalizeKey(value) {
  var key = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  return SLOT_KEYS.indexOf(key) >= 0 ? key : ""
}

function defaultKey(identity) {
  var text = String(identity || "")
  var hash = 0
  for (var i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0
  return SLOT_KEYS[hash % SLOT_KEYS.length]
}

function parse(raw) {
  var values = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) values[match[1].toLowerCase()] = match[2]
  }
  var result = {}
  for (var k = 0; k < SLOT_KEYS.length; k++) {
    var key = SLOT_KEYS[k]
    var value = values[key] || values[ANSI_KEYS[key]] || ""
    if (value !== "") result[key] = value
  }
  return result
}

// Hue alone carries the identity when the theme's own palette cannot. A
// greyscale theme supplies six greys that name the same thing, and a host with
// no Omarchy palette supplies nothing at all, so those callers draw from here
// instead. The golden angle spreads successive hue slots as far apart as a
// circle allows, so two identities that hash near each other do not come out
// the same colour.
var GOLDEN_ANGLE = 137.508

function rgb(hex) {
  var value = String(hex || "")
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255
  ]
}

function saturation(hex) {
  var channels = rgb(hex)
  if (channels === null) return 0
  var max = Math.max(channels[0], channels[1], channels[2])
  var min = Math.min(channels[0], channels[1], channels[2])
  if (max === min) return 0
  var lightness = (max + min) / 2
  return lightness > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
}

// Whether a parsed palette carries any colour at all. The "white" theme's six
// ANSI slots are one grey ramp, and identity colours taken from them would be
// six greys that read as one. Three coloured slots is the floor.
function chromatic(values) {
  if (!values || typeof values !== "object") return false
  var colored = 0
  for (var i = 0; i < SLOT_KEYS.length; i++) {
    if (SLOT_KEYS[i] === "accent") continue
    if (saturation(values[SLOT_KEYS[i]]) >= 0.25) colored++
  }
  return colored >= 3
}

function identityHue(identity) {
  var text = String(identity || "")
  var hash = 0
  for (var i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0
  return Math.round((hash * GOLDEN_ANGLE) % 360)
}

// The hue each named slot stands for, so a theme with no colour at all in its
// palette still draws "yellow" as yellow. Accent is the theme's own colour and
// names no hue.
var KEY_HUES = { red: 2, yellow: 48, green: 138, cyan: 186, blue: 217, magenta: 310 }

function keyHue(key) {
  var value = KEY_HUES[String(key || "")]
  return typeof value === "number" ? value : null
}

// A colour at a given hue, where the only fact about the panel is whether it is
// light or dark: the hue carries the meaning, the lightness keeps the colour
// readable on the panel it is drawn on.
function generatedHueColor(hue, light) {
  var h = ((Number(hue) || 0) % 360) / 360
  var saturation = light ? 0.62 : 0.55
  var lightness = light ? 0.40 : 0.72
  function channel(offset) {
    var k = (offset + h * 12) % 12
    var a = saturation * Math.min(lightness, 1 - lightness)
    return Math.round((lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  function hex(value) {
    var text = value.toString(16)
    return text.length < 2 ? "0" + text : text
  }
  return "#" + hex(channel(0)) + hex(channel(8)) + hex(channel(4))
}

// A stable colour for an identity, where the only fact about the panel is
// whether it is light or dark.
function generatedColor(identity, light) {
  return generatedHueColor(identityHue(identity), light)
}
