const assert = require("assert")
const { load } = require("./load")

const capture = load("keys/Capture.js")

// Qt.KeyboardModifier bits and the Qt.Key_* codes the tests press.
const SHIFT = 0x02000000
const CTRL = 0x04000000
const ALT = 0x08000000
const META = 0x10000000
const Key = {
  Escape: 0x01000000,
  Return: 0x01000004,
  Left: 0x01000012,
  Space: 0x20,
  F5: 0x01000034,
  Control: 0x01000021,
  Shift: 0x01000020,
  Alt: 0x01000023,
  A: 0x41,
  J: 0x4a,
  M: 0x4d,
  Slash: 0x2f,
  Question: 0x3f,
  Comma: 0x2c,
  BracketLeft: 0x5b
}

const seq = capture.sequenceFromEvent

// A bare letter binds lower-case, the way the table writes "j".
assert.strictEqual(seq(Key.J, 0, "j"), "j")
assert.strictEqual(seq(Key.A, 0, "a"), "a")

// A modified letter binds upper-case: "Ctrl+K", "Ctrl+Shift+M", "Shift+I".
assert.strictEqual(seq(Key.M, CTRL, ""), "Ctrl+M")
assert.strictEqual(seq(Key.M, CTRL | SHIFT, ""), "Ctrl+Shift+M")
assert.strictEqual(seq(0x49, SHIFT, "I"), "Shift+I", "Gmail's mark-read shape")

// Modifier order is Ctrl, Alt, Meta, Shift — ours, not Qt's printing order.
// QKeySequence parses any order, so what matters is that one order is used
// everywhere: keys/Keymap.js normalises a hand-edited file to this one.
assert.strictEqual(seq(Key.A, ALT, ""), "Alt+A")
assert.strictEqual(seq(Key.A, CTRL | ALT | META | SHIFT, ""), "Ctrl+Alt+Meta+Shift+A")

// Punctuation comes through as itself, unshifted or shifted.
assert.strictEqual(seq(Key.Slash, 0, "/"), "/")
assert.strictEqual(seq(Key.Question, SHIFT, "?"), "?",
  "the shift is already in the character; it is not named twice")
assert.strictEqual(seq(Key.Comma, CTRL, ","), "Ctrl+,")
assert.strictEqual(seq(Key.BracketLeft, 0, "["), "[")

// Named keys use their keycap token; readableSequence turns Return into Enter.
assert.strictEqual(seq(Key.Return, CTRL, "\r"), "Ctrl+Return")
assert.strictEqual(seq(Key.Left, ALT, ""), "Alt+Left")
assert.strictEqual(seq(Key.Space, CTRL, " "), "Ctrl+Space")
assert.strictEqual(seq(Key.F5, 0, ""), "F5")
assert.strictEqual(seq(Key.F5, SHIFT, ""), "Shift+F5")

// A lone modifier records nothing — the field keeps waiting.
assert.strictEqual(seq(Key.Control, CTRL, ""), "")
assert.strictEqual(seq(Key.Shift, SHIFT, ""), "")
assert.strictEqual(seq(Key.Alt, ALT, ""), "")

// Escape is a key like any other here; SettingsPage treats it as cancel before
// it ever calls this.
assert.strictEqual(seq(Key.Escape, 0, ""), "Escape")

// A key with no ASCII name and no usable text records nothing rather than
// something Qt cannot bind.
assert.strictEqual(seq(0x01000062, 0, ""), "", "an unmapped media key")
assert.strictEqual(seq(0x41, 0, "é"), "a",
  "a dead-key accent still falls back to the ASCII key code")

console.log("test_capture.js ok")
