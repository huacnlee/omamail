.pragma library

// Which palette the standalone window draws with when no Omarchy theme is
// installed: the desktop's own light or dark choice, or one of the two named
// outright. The stored value is the label the settings row shows, the way
// `contentDirection` and `heavyMessageRendering` are stored.
//
// The Omarchy plugin never reads this. Its colours are the shell's, and the
// shell has already answered the question in colors.toml.
var SYSTEM = "System"
var LIGHT = "Light"
var DARK = "Dark"
var MODES = [SYSTEM, LIGHT, DARK]
var MODE_DEFAULT = SYSTEM

// A stored value is one of the three labels, matched case-insensitively so an
// older or hand-edited settings file still lands on the mode it meant, and
// anything else is the default rather than a fourth state.
function normalizeMode(value) {
  var text = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  for (var i = 0; i < MODES.length; i++) if (MODES[i].toLowerCase() === text) return MODES[i]
  return MODE_DEFAULT
}

// The palette a mode asks for: "light", "dark", or "" for whatever the desktop
// says.
function paletteFor(mode) {
  var normalized = normalizeMode(mode)
  if (normalized === LIGHT) return "light"
  if (normalized === DARK) return "dark"
  return ""
}
