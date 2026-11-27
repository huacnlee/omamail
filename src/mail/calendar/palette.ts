// A line-for-line port of omarchy/ui/calendar/Palette.js, typed with the
// shapes in types.ts; its behavior is unchanged from the Qt client's, and the
// tests next to it are the Qt tests ported.
import type { PaletteColors } from "./types";
export var SLOT_KEYS: string[] = ["accent", "red", "green", "yellow", "blue", "magenta", "cyan"]
export var ANSI_KEYS: { [slot: string]: string } = {
  red: "color1", green: "color2", yellow: "color3", blue: "color4",
  magenta: "color5", cyan: "color6"
}

export function keys(): string[] { return SLOT_KEYS.slice() }

export function normalizeKey(value?: unknown): string {
  var key = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  return SLOT_KEYS.indexOf(key) >= 0 ? key : ""
}

export function defaultKey(identity?: unknown): string {
  var text = String(identity || "")
  var hash = 0
  for (var i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0
  return SLOT_KEYS[hash % SLOT_KEYS.length]
}

export function parse(raw?: unknown): PaletteColors {
  var values: { [key: string]: string } = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) values[match[1].toLowerCase()] = match[2]
  }
  var result: PaletteColors = {}
  for (var k = 0; k < SLOT_KEYS.length; k++) {
    var key = SLOT_KEYS[k]
    var value = values[key] || values[ANSI_KEYS[key]] || ""
    if (value !== "") result[key] = value
  }
  return result
}
