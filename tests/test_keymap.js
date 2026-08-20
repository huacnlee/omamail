const assert = require("assert")
const { load, deepEqual } = require("./load")

const keymap = load("keys/Keymap.js")

// ---------------------------------------------------------------- the table

assert.ok(keymap.BINDINGS.length > 20, "the table describes the whole keyboard")

// Anything that renders a binding needs all of these, so a row missing one
// would reach the help sheet as a blank line.
keymap.BINDINGS.forEach(function (binding) {
  assert.ok(binding.id, "every binding has an id")
  assert.ok(binding.group, binding.id + " needs a group for the help sheet")
  assert.ok(binding.label, binding.id + " needs a label for the help sheet")
  assert.ok(binding.keys.length > 0, binding.id + " binds at least one key")
  binding.contexts.forEach(function (context) {
    assert.ok(context === "*" || keymap.CONTEXTS.indexOf(context) >= 0,
      binding.id + " names a context that exists: " + context)
  })
})

const ids = keymap.BINDINGS.map(function (b) { return b.id })
assert.strictEqual(new Set(ids).size, ids.length, "ids are unique")

// ------------------------------------------------------------ no collisions

// Two bindings claiming one sequence in one context is a bug the table finds by
// itself. Sequences compare whole, so `s` and `g,s` are different keys.
deepEqual(keymap.conflicts(), [],
  "no sequence is bound twice within one context")

// ------------------------------------------------- standing down for typing

function byId(id) {
  return keymap.BINDINGS.filter(function (b) { return b.id === id })[0]
}

// Derived from the key, never declared. The guard that used to be written by
// hand on every line is the guard that was forgotten on nine text fields.
assert.strictEqual(keymap.suppressedByTyping(byId("archive"), "e"), true,
  "a bare letter must not fire into a text field")
assert.strictEqual(keymap.suppressedByTyping(byId("open"), "Return"), true,
  "Return is a bare key: it belongs to the field being typed in")
assert.strictEqual(keymap.suppressedByTyping(byId("cursorDown"), "Down"), true,
  "the arrows move the caret while typing")
assert.strictEqual(keymap.suppressedByTyping(byId("markRead"), "Shift+I"), true,
  "Shift+I is what typing a capital I looks like, so Shift is not a modifier here")
assert.strictEqual(keymap.suppressedByTyping(byId("goInbox"), "g,i"), true,
  "a chord of bare keys is still bare")
assert.strictEqual(keymap.suppressedByTyping(byId("refresh"), "F5"), false,
  "F5 is not a character")
assert.strictEqual(keymap.suppressedByTyping(byId("back"), "Escape"), false,
  "Escape is the one bare key that must survive typing")

// Per key, not per row. This is what lets one Search row hold both `/`, which
// has to stand down inside a field, and Ctrl+K, whose whole purpose is reaching
// search from inside one. Deciding by row would have forced them apart and put
// two identical lines in the help sheet.
const search = byId("search")
assert.strictEqual(keymap.suppressedByTyping(search, "/"), true,
  "a bare slash is a character someone is typing")
assert.strictEqual(keymap.suppressedByTyping(search, "Ctrl+K"), false,
  "Ctrl+K is unreachable by typing, so it stays live in the same row")

// ------------------------------------------------------------------ enabling

const archive = byId("archive")
assert.strictEqual(keymap.isEnabled(archive, "e", "list", false, false), true)
assert.strictEqual(keymap.isEnabled(archive, "e", "reader", false, false), true)
assert.strictEqual(keymap.isEnabled(archive, "e", "page", false, false), false,
  "a settings form is a form; e is not archive there")
assert.strictEqual(keymap.isEnabled(archive, "e", "compose", false, false), false)
assert.strictEqual(keymap.isEnabled(archive, "e", "list", true, false), false,
  "typing stands it down")
assert.strictEqual(keymap.isEnabled(archive, "e", "list", false, true), false,
  "an overlay stands it down")

assert.strictEqual(keymap.isEnabled(search, "/", "list", true, false), false,
  "the bare key of a mixed row stands down")
assert.strictEqual(keymap.isEnabled(search, "Ctrl+K", "list", true, false), true,
  "while its modified key, in the same row, does not")

const back = byId("back")
assert.strictEqual(keymap.isEnabled(back, "Escape", "page", true, true), true,
  "Escape dismisses the overlay and leaves the field, so it survives both")

const help = byId("help")
assert.strictEqual(keymap.isEnabled(help, "Ctrl+?", "list", false, true), true,
  "the sheet's own key has to close the sheet")
assert.strictEqual(keymap.isEnabled(help, "?", "list", false, true), true,
  "and so does the bare one: an overlay is not a text field")

// The zoom keys used to be live everywhere, including on a settings form.
const zoomIn = byId("zoomIn")
assert.strictEqual(keymap.isEnabled(zoomIn, "Ctrl+=", "reader", false, false), true)
assert.strictEqual(keymap.isEnabled(zoomIn, "Ctrl+=", "page", false, false), false,
  "there is no message body to size on a form")

// ------------------------------------------------------------ what renders

const groups = keymap.helpGroups()
const rowCount = groups.reduce(function (n, g) { return n + g.rows.length }, 0)
assert.strictEqual(rowCount, keymap.BINDINGS.length,
  "the help sheet shows every binding — it cannot drift from the table again")
groups.forEach(function (group) {
  assert.ok(group.name, "a group is named")
  group.rows.forEach(function (row) {
    assert.ok(row.keys, "a help row shows its keys")
    assert.ok(row.action, "a help row says what the keys do")
  })
})

assert.strictEqual(keymap.displayFor(byId("cursorUp")), "k / Up",
  "keys read as themselves unless the row overrides it")
assert.strictEqual(keymap.displayFor(byId("cursorDown")), "j / k",
  "the pair reads as a pair where one line stands for both")

const listHints = keymap.hintsFor("list")
deepEqual(listHints.map(function (h) { return h.label }),
  ["move", "open", "archive", "compose"],
  "the status bar offers what the list can do")
const composeHints = keymap.hintsFor("compose")
deepEqual(composeHints.map(function (h) { return h.label }),
  ["send", "close"],
  "Escape discards a draft, so it says close rather than back")
deepEqual(keymap.hintsFor("page").map(function (h) { return h.label }),
  ["back"],
  "a form's whole keyboard contract is leaving it")

console.log("test_keymap.js ok")
