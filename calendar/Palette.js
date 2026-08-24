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
