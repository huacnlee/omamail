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

// ------------------------------------------------------------ every context

function byId(id) {
  return keymap.BINDINGS.filter(function (b) { return b.id === id })[0]
}

// Context is the only thing that decides what is live. A text-entry context
// binds no bare keys, so there is no "are they typing" question to get wrong:
// the field is on screen and Qt gives it its own keys first.
;["search", "compose", "page"].forEach(function (context) {
  keymap.bindingsFor(context).forEach(function (binding) {
    binding.keys.forEach(function (key) {
      var bare = key.indexOf("Ctrl+") < 0 && key.indexOf("Alt+") < 0
        && key.indexOf("Meta+") < 0 && !/^F[0-9]+$/.test(key)
      assert.ok(!bare || key === "Escape",
        context + " must bind no bare key but Escape, and binds " + key
          + " for " + binding.id)
    })
  })
})

// ------------------------------------------------------------------ enabling

const archive = byId("archive")
assert.strictEqual(keymap.isEnabled(archive, "list", false), true)
assert.strictEqual(keymap.isEnabled(archive, "reader", false), true)
assert.strictEqual(keymap.isEnabled(archive, "page", false), false,
  "a settings form is a form; e is not archive there")
assert.strictEqual(keymap.isEnabled(archive, "compose", false), false,
  "nor is it archive in the middle of a sentence")
assert.strictEqual(keymap.isEnabled(archive, "search", false), false,
  "nor in a query being typed")
assert.strictEqual(keymap.isEnabled(archive, "list", true), false,
  "an overlay stands it down")

const back = byId("back")
keymap.CONTEXTS.forEach(function (context) {
  assert.strictEqual(keymap.isEnabled(back, context, false), true,
    "Escape is the way out of " + context)
})
assert.strictEqual(keymap.isEnabled(back, "list", true), true,
  "including out of the overlay itself")

const help = byId("help")
assert.strictEqual(keymap.isEnabled(help, "list", true), true,
  "the sheet's own key has to close the sheet")

// Reaching search from inside a form or a draft is the whole point of binding
// it to a modified key as well.
assert.strictEqual(keymap.isEnabled(byId("searchAnywhere"), "compose", false), true)
assert.strictEqual(keymap.isEnabled(byId("search"), "compose", false), false,
  "while the bare slash is a character in the draft")

const zoomIn = byId("zoomIn")
assert.strictEqual(keymap.isEnabled(zoomIn, "reader", false), true)
assert.strictEqual(keymap.isEnabled(zoomIn, "page", false), false,
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

// The sheet enumerates and the status bar hints; one field could not do both.
// Enumerating put "j / k  Move down" on the sheet, which is true of neither.
assert.strictEqual(keymap.displayFor(byId("cursorUp")), "k, Up",
  "the sheet names every key that works")
assert.strictEqual(keymap.displayFor(byId("cursorDown")), "j, Down")
assert.strictEqual(keymap.displayFor(byId("help")), "?, Ctrl+/, Ctrl+?",
  "a slash inside a sequence must not read as the separator")

// Qt's sequence syntax is not the UI's.
assert.strictEqual(keymap.readableSequence("g,i"), "g then i",
  "a chord reads as a chord, not as Qt's comma")
assert.strictEqual(keymap.readableSequence("Escape"), "Esc")
assert.strictEqual(keymap.readableSequence("Ctrl+Return"), "Ctrl+Enter")
assert.strictEqual(keymap.displayFor(byId("goMailbox")), "Alt+1…0",
  "ten mailbox keys are one row on the sheet, not ten")

// Which key of the row fired, read off the row's own list rather than parsed.
assert.strictEqual(keymap.slotFor("goMailbox", "Alt+1"), 0)
assert.strictEqual(keymap.slotFor("goMailbox", "Alt+9"), 8)
assert.strictEqual(keymap.slotFor("goMailbox", "Alt+0"), 9, "the tenth row, not the zeroth")
assert.strictEqual(keymap.slotFor("goMailbox", "Ctrl+1"), -1)
assert.strictEqual(keymap.slotFor("goMailbox", ""), -1)
assert.strictEqual(keymap.slotFor("nothing", "Alt+1"), -1)
assert.strictEqual(keymap.displayFor(byId("open")), "Enter, o")
assert.strictEqual(keymap.displayFor(byId("back")), "Esc")
assert.strictEqual(keymap.displayFor(byId("switchAccount")), "Alt+A")
{
  const going = groups.filter(function (g) { return g.name === "Going" })[0]
  assert.ok(going, "Switch account lives with the other go-to keys")
  const sheet = going.rows.filter(function (r) { return r.action === "Switch account" })[0]
  assert.strictEqual(sheet.keys, "Alt+A")
}

// Only these, and only for the sheet they scroll.
assert.strictEqual(keymap.isEnabled(byId("cursorDown"), "list", true), true)
assert.strictEqual(keymap.isEnabled(byId("cursorUp"), "list", true), true)
assert.strictEqual(keymap.isEnabled(byId("archive"), "list", true), false,
  "nothing acts on mail behind the sheet")
assert.strictEqual(keymap.isEnabled(byId("open"), "list", true), false)
assert.strictEqual(keymap.isEnabled(byId("compose"), "list", true), false)

const switchAccount = byId("switchAccount")
assert.strictEqual(keymap.isEnabled(switchAccount, "list", false), true)
assert.strictEqual(keymap.isEnabled(switchAccount, "reader", false), true)
assert.strictEqual(keymap.isEnabled(switchAccount, "compose", false), false,
  "a draft is not a mailbox to leave")
assert.strictEqual(keymap.isEnabled(switchAccount, "search", false), false)
assert.strictEqual(keymap.isEnabled(switchAccount, "page", false), false)

assert.strictEqual(keymap.hintKeyFor(byId("cursorDown")), "j / k",
  "the status bar shows one line for the pair")
assert.strictEqual(keymap.hintKeyFor(byId("open")), "o",
  "and the short form of a row with several keys")
assert.strictEqual(keymap.hintKeyFor(byId("archive")), "e",
  "falling back to the keys when there is nothing to shorten")

const listHints = keymap.hintsFor("list")
deepEqual(listHints.map(function (h) { return h.key + " " + h.label }),
  ["j / k move", "o open", "e archive", "c compose"],
  "the status bar offers what the list can do, in its short form")
const composeHints = keymap.hintsFor("compose")
deepEqual(composeHints.map(function (h) { return h.label }),
  ["send", "close"],
  "Escape discards a draft, so it says close rather than back")
deepEqual(keymap.hintsFor("page").map(function (h) { return h.label }),
  ["back"],
  "a form's whole keyboard contract is leaving it")

// ------------------------------------------------- one entry per sequence

// A Shortcut binds one sequence, so the router needs the table flattened.
const listSequences = keymap.sequencesFor("list")
const expectedCount = keymap.bindingsFor("list").reduce(
  function (n, b) { return n + b.keys.length }, 0)
assert.strictEqual(listSequences.length, expectedCount,
  "every key of every row in the context is present")
listSequences.forEach(function (row) {
  assert.ok(row.id && row.sequence && row.binding,
    "each entry carries its id, its sequence, and the row it came from")
})

// -------------------------------------------------- the doc cannot drift

// docs/KEYS.md carries the table for people rather than for the engine. Three
// hand-written copies of this list used to exist and had already drifted apart,
// so this one is asserted against the source rather than trusted.
{
  const fs = require("fs")
  const path = require("path")
  const doc = fs.readFileSync(
    path.join(__dirname, "..", "docs", "KEYS.md"), "utf8")
  const body = doc.split("<!-- BEGIN BINDINGS -->")[1]
  assert.ok(body, "docs/KEYS.md must fence its table with BEGIN/END BINDINGS")
  const rows = body.split("<!-- END BINDINGS -->")[0]
    .split("\n")
    .filter(function (line) { return line.indexOf("| `") === 0 })

  function shorthand(binding) {
    return binding.contexts.join("+")
      .replace("list+reader", "mail")
      .replace("*", "all")
  }

  assert.strictEqual(rows.length, keymap.BINDINGS.length,
    "docs/KEYS.md lists every binding and no others")

  keymap.BINDINGS.forEach(function (binding, i) {
    const expected = "| `" + binding.id + "` | "
      + binding.keys.map(function (k) { return "`" + k + "`" }).join(", ")
      + " | " + shorthand(binding) + " | " + binding.label + " |"
    assert.strictEqual(rows[i].trim(), expected,
      "docs/KEYS.md row " + (i + 1) + " is out of step with keys/Keymap.js")
  })
}

console.log("test_keymap.js ok")
