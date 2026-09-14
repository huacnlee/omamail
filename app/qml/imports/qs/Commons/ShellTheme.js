.pragma library

// The standalone host cannot import Quickshell's FileView-backed theme
// singletons. Keep the shell.toml grammar and validation here so Color and
// Style can consume one normalized, atomically replaceable value.

var FONT_KEYS = {
  "caption": true, "body-small": true, "body": true, "subtitle": true,
  "title": true, "heading": true, "display": true, "display-large": true,
  "icon-small": true, "icon": true, "icon-large": true
}

var SPACING_KEYS = {
  "xxs": true, "xs": true, "sm": true, "md": true, "lg": true,
  "xl": true, "xxl": true, "xxxl": true, "huge": true,
  "control-gap": true, "control-padding-x": true,
  "control-padding-y": true, "input-padding-y": true,
  "control-height": true, "popup-row-height": true,
  "dropdown-width": true, "searchable-dropdown-width": true,
  "number-field-width": true, "searchable-popup-min-height": true,
  "row-gap": true, "row-padding-x": true, "label-gap": true,
  "panel-gap": true, "panel-padding": true, "popup-padding": true
}

var CONTROL_COLORS = {
  "normal-color": true, "hover-cursor-color": true,
  "selected-color": true, "pressed-color": true, "focus-color": true,
  "selection-color": true
}

var CONTROL_NUMBERS = {
  "normal-border-width": true, "hover-cursor-border-width": true,
  "selected-border-width": true, "focus-border-width": true,
  "normal-fill-alpha": true, "hover-cursor-fill-alpha": true,
  "selected-fill-alpha": true, "pressed-fill-alpha": true,
  "focus-fill-alpha": true, "selection-fill-alpha": true,
  "normal-border-alpha": true, "hover-cursor-border-alpha": true,
  "selected-border-alpha": true, "focus-border-alpha": true
}

var POPUP_COLORS = { "background": true, "text": true, "border": true }
var POPUP_ALPHAS = { "background-alpha": true, "border-alpha": true }

function parse(raw) {
  var parsed = {}
  var lines = String(raw || "").split(/\r?\n/)
  var section = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "")
    if (line === "" || line.charAt(0) === "#") continue
    var sectionMatch = line.match(/^\[([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      continue
    }
    var valueMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/)
    if (!valueMatch || section === "") continue
    var value = valueMatch[2] !== undefined ? valueMatch[2]
      : (valueMatch[3] !== undefined ? valueMatch[3] : valueMatch[4])
    parsed[section + "." + valueMatch[1].toLowerCase()] = value
  }
  return parsed
}

function merge(theme, user) {
  var result = {}
  var base = theme || {}
  var overrides = user || {}
  for (var key in base) result[key] = base[key]
  for (var userKey in overrides) result[userKey] = overrides[userKey]
  return result
}

function number(value, minimum, maximum) {
  if (typeof value !== "string" && typeof value !== "number") return null
  var text = String(value).replace(/^\s+|\s+$/g, "")
  if (!text.match(/^-?\d+(?:\.\d+)?$/)) return null
  var result = Number(text)
  if (!isFinite(result) || result < minimum || result > maximum) return null
  return result
}

function boolean(value) {
  var text = String(value || "").toLowerCase()
  if (text === "true" || text === "1" || text === "yes" || text === "on") return true
  if (text === "false" || text === "0" || text === "no" || text === "off") return false
  return null
}

function colorToken(value) {
  var text = String(value || "").replace(/^\s+|\s+$/g, "")
  var role = text.toLowerCase()
  if (role === "foreground" || role === "text" || role === "accent"
      || role === "urgent" || role === "background" || role === "transparent"
      || role === "hover" || role === "hover-cursor" || role === "inherit") return text
  return /^(?:#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8})$/.test(text)
    ? text : null
}

function normalize(values) {
  var source = values || {}
  var result = {
    font: { baseSize: 12, overrides: {} },
    spacing: { scale: 1, scaleWithFont: true, overrides: {} },
    controls: {},
    popups: {}
  }
  var baseSize = number(source["font.base-size"], 1, 1000)
  if (baseSize !== null) result.font.baseSize = Math.round(baseSize)
  for (var fontKey in FONT_KEYS) {
    var fontValue = number(source["font." + fontKey], 1, 1000)
    if (fontValue !== null) result.font.overrides[fontKey] = Math.round(fontValue)
  }

  var scale = number(source["spacing.scale"], 0, 100)
  if (scale !== null) result.spacing.scale = scale
  var scaleWithFont = boolean(source["spacing.scale-with-font"])
  if (scaleWithFont !== null) result.spacing.scaleWithFont = scaleWithFont
  for (var spacingKey in SPACING_KEYS) {
    var spacingValue = number(source["spacing." + spacingKey], 0, 100000)
    if (spacingValue !== null) result.spacing.overrides[spacingKey] = spacingValue
  }

  for (var controlColor in CONTROL_COLORS) {
    var colorValue = colorToken(source["controls." + controlColor]
      || source["style." + controlColor])
    if (colorValue !== null) result.controls[controlColor] = colorValue
  }
  for (var controlNumber in CONTROL_NUMBERS) {
    var raw = source["controls." + controlNumber]
    if (raw === undefined) raw = source["style." + controlNumber]
    var maximum = controlNumber.indexOf("-alpha") >= 0 ? 1 : 1000
    var numericValue = number(raw, 0, maximum)
    if (numericValue !== null) result.controls[controlNumber] = numericValue
  }

  for (var popupColor in POPUP_COLORS) {
    var popupColorValue = colorToken(source["popups." + popupColor])
    if (popupColorValue !== null) result.popups[popupColor] = popupColorValue
  }
  for (var popupAlpha in POPUP_ALPHAS) {
    var popupAlphaValue = number(source["popups." + popupAlpha], 0, 1)
    if (popupAlphaValue !== null) result.popups[popupAlpha] = popupAlphaValue
  }
  return result
}

function resolve(themeRaw, userRaw) {
  return normalize(merge(parse(themeRaw), parse(userRaw)))
}
