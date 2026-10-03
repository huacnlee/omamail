.pragma library

// A key event, as the Keyboard settings section records it: turn one press
// into the sequence string `keys/Keymap.js` and Qt's Shortcut both speak
// ("Ctrl+Shift+M", "Shift+I", "j", "/"). Kept out of QML so the node tests
// reach it — the capture field in SettingsPage.qml only forwards the three
// fields of the event and shows what comes back.
//
// Deliberately ASCII only. A sequence string Qt can bind and round-trip is
// Latin; a key that produces "é" or a CJK character is not one QKeySequence
// parses back, so it records nothing and the field stays open.

// Qt.KeyboardModifier bits.
var MOD_SHIFT = 0x02000000
var MOD_CTRL = 0x04000000
var MOD_ALT = 0x08000000
var MOD_META = 0x10000000

// Qt.Key_* codes for the keys named on their keycap rather than carrying a
// character. The value is the token Qt's QKeySequence understands.
var NAMED = ({})
NAMED[0x01000000] = "Escape"
NAMED[0x01000001] = "Tab"
NAMED[0x01000003] = "Backspace"
NAMED[0x01000004] = "Return"
NAMED[0x01000005] = "Enter"
NAMED[0x01000006] = "Insert"
NAMED[0x01000007] = "Delete"
NAMED[0x01000010] = "Home"
NAMED[0x01000011] = "End"
NAMED[0x01000012] = "Left"
NAMED[0x01000013] = "Up"
NAMED[0x01000014] = "Right"
NAMED[0x01000015] = "Down"
NAMED[0x01000016] = "PgUp"
NAMED[0x01000017] = "PgDown"
NAMED[0x20] = "Space"

var NAMED_TOKENS = ({})
for (var code in NAMED) NAMED_TOKENS[NAMED[code]] = true

// Qt.Key_* codes for the modifier keys themselves, so pressing only Ctrl or
// only Shift records nothing and the field waits for the rest.
var MODIFIER_KEYS = ({})
MODIFIER_KEYS[0x01000020] = true // Shift
MODIFIER_KEYS[0x01000021] = true // Control
MODIFIER_KEYS[0x01000022] = true // Meta
MODIFIER_KEYS[0x01000023] = true // Alt
MODIFIER_KEYS[0x01000024] = true // AltGr
MODIFIER_KEYS[0x01001103] = true // Mode_switch

function isModifierKey(key) {
  return MODIFIER_KEYS[key] === true
}

// F1..F35 run from 0x01000030.
function functionKey(key) {
  if (key >= 0x01000030 && key <= 0x01000052) return "F" + (key - 0x01000030 + 1)
  return ""
}

function isNamedToken(token) {
  return NAMED_TOKENS[token] === true
}

// The key without its modifiers, as a token. Qt.Key_A is 0x41 and Qt.Key_0 is
// 0x30, so a letter or digit code is already its character; most punctuation
// matches too. The event's own text is the fallback for anything else that is
// still one printable ASCII character.
function baseToken(key, text) {
  if (NAMED[key]) return NAMED[key]
  var fn = functionKey(key)
  if (fn !== "") return fn
  if (key >= 0x21 && key <= 0x7e) return String.fromCharCode(key).toUpperCase()
  var raw = String(text || "")
  if (raw.length === 1 && raw.charCodeAt(0) >= 0x21 && raw.charCodeAt(0) <= 0x7e)
    return raw.toUpperCase()
  return ""
}

// The sequence a press stands for, or "" for a lone modifier or a key with no
// ASCII name — in both cases the capture field keeps waiting.
function sequenceFromEvent(key, modifiers, text) {
  if (isModifierKey(key)) return ""
  var base = baseToken(key, text)
  if (base === "") return ""

  var mods = Number(modifiers) || 0
  var parts = []
  if (mods & MOD_CTRL) parts.push("Ctrl")
  if (mods & MOD_ALT) parts.push("Alt")
  if (mods & MOD_META) parts.push("Meta")

  // Shift is only named where it is not already in the character: "Shift+I" is
  // a binding, "Shift+?" is not — "?" is what the shifted key produces. So
  // Shift counts with a letter, a named key, or a function key, and nowhere
  // else.
  var shiftMeans = (/^[A-Z]$/).test(base) || isNamedToken(base)
    || (/^F[0-9]+$/).test(base)
  if ((mods & MOD_SHIFT) && shiftMeans) parts.push("Shift")

  // A bare letter binds lower-case in the table ("j"); a modified one binds
  // upper ("Ctrl+K", "Shift+I"). Match that so displayFor and slotFor stay
  // stable across a rebind.
  if (parts.length === 0 && (/^[A-Z]$/).test(base)) return base.toLowerCase()

  parts.push(base)
  return parts.join("+")
}
