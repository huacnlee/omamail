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

const undoSend = byId("undoSend")
assert.ok(undoSend, "the delayed-send state offers an undo action")
assert.strictEqual(keymap.displayFor(undoSend), "Alt+Z")
keymap.CONTEXTS.forEach(function (context) {
  assert.strictEqual(keymap.isEnabled(undoSend, context, false), true,
    "Alt+Z must undo a delayed send from " + context)
})

assert.strictEqual(keymap.contextFor({
  sendPending: true,
  currentView: "reader"
}), "reader", "a delayed send must not replace the reader's keyboard context")
assert.strictEqual(keymap.contextFor({
  sendPending: true,
  currentView: "list"
}), "list", "a delayed send must not replace the list's keyboard context")

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

// The key sheet remains reachable while a field owns ordinary typing.
assert.strictEqual(keymap.isSequenceEnabled(help, "Ctrl+K", "compose", false), true)
assert.strictEqual(keymap.isSequenceEnabled(help, "?", "compose", false), false,
  "the old bare help key remains mailbox-only")
assert.strictEqual(keymap.isSequenceEnabled(help, "?", "list", false), true)
assert.strictEqual(byId("helpAnywhere"), undefined,
  "one help action must render as one row")
assert.strictEqual(keymap.isEnabled(byId("search"), "compose", false), false,
  "while the bare slash is a character in the draft")

const settings = byId("settings")
assert.strictEqual(keymap.displayFor(settings), "Ctrl+,")
assert.strictEqual(keymap.isEnabled(settings, "calendar", false), true,
  "settings must open from the calendar")
assert.strictEqual(keymap.isEnabled(settings, "page", false), true,
  "the settings route is available from every screen")

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
assert.strictEqual(keymap.displayFor(byId("help")), "Ctrl+K, ?, Ctrl+/, Ctrl+?",
  "a slash inside a sequence must not read as the separator")

// Qt's sequence syntax is not the UI's.
assert.strictEqual(keymap.readableSequence("g,i"), "g then i",
  "a chord reads as a chord, not as Qt's comma")
assert.strictEqual(keymap.readableSequence("Escape"), "Esc")
assert.strictEqual(keymap.readableSequence("Ctrl+Return"), "Ctrl+Enter")
assert.strictEqual(keymap.displayFor(byId("goMailbox")), "Ctrl+1…0",
  "ten mailbox keys are one row on the sheet, not ten")

const goAccount = byId("goAccount")
assert.ok(goAccount, "number keys switch directly to email accounts")
assert.strictEqual(keymap.displayFor(goAccount), "Alt+1…0",
  "ten account keys are one row on the sheet")
assert.strictEqual(keymap.slotFor("goAccount", "Alt+1"), 0)
assert.strictEqual(keymap.slotFor("goAccount", "Alt+9"), 8)
assert.strictEqual(keymap.slotFor("goAccount", "Alt+0"), 9)

// Which key of the row fired, read off the row's own list rather than parsed.
assert.strictEqual(keymap.slotFor("goMailbox", "Ctrl+1"), 0)
assert.strictEqual(keymap.slotFor("goMailbox", "Ctrl+9"), 8)
assert.strictEqual(keymap.slotFor("goMailbox", "Ctrl+0"), 9, "the tenth row, not the zeroth")
assert.strictEqual(keymap.slotFor("goMailbox", "Alt+1"), -1)
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
const calendar = byId("calendar")
assert.strictEqual(keymap.displayFor(calendar), "Alt+C")
assert.strictEqual(keymap.isEnabled(calendar, "list", false), true)
assert.strictEqual(keymap.isEnabled(calendar, "reader", false), true)
assert.strictEqual(keymap.isEnabled(calendar, "calendar", false), true)
assert.strictEqual(keymap.isEnabled(calendar, "page", false), false)
const createEvent = byId("createEvent")
assert.strictEqual(keymap.displayFor(createEvent), "c")
assert.strictEqual(keymap.isEnabled(createEvent, "calendar", false), true)
assert.strictEqual(keymap.isEnabled(createEvent, "list", false), false)
assert.strictEqual(keymap.isEnabled(createEvent, "compose", false), false)
;["calendarNext", "calendarPrevious", "openCalendarEvent", "calendarPreviousPeriod",
  "calendarNextPeriod", "calendarToday", "calendarWeek", "calendarMonth"].forEach(function(id) {
  assert.ok(byId(id), id + " must be listed in the shared key map")
  assert.strictEqual(keymap.isEnabled(byId(id), "calendar", false), true)
  assert.strictEqual(keymap.isEnabled(byId(id), "list", false), false)
})
assert.strictEqual(keymap.displayFor(byId("calendarToday")), "t",
  "t returns the calendar to today")
const mailView = byId("mailView")
const calendarView = byId("calendarView")
assert.strictEqual(keymap.displayFor(mailView), "Ctrl+Shift+M")
assert.strictEqual(keymap.displayFor(calendarView), "Ctrl+Shift+C")
assert.strictEqual(keymap.isEnabled(mailView, "calendar", false), true)
assert.strictEqual(keymap.isEnabled(calendarView, "list", false), true)
assert.strictEqual(keymap.isEnabled(calendarView, "reader", false), true)
assert.strictEqual(keymap.isEnabled(calendarView, "compose", false), false)
assert.strictEqual(keymap.displayFor(byId("zoomReset")), "Ctrl+Shift+0")
const sidebar = byId("toggleSidebar")
assert.strictEqual(keymap.displayFor(sidebar), "[")
assert.strictEqual(keymap.isEnabled(sidebar, "list", false), true)
assert.strictEqual(keymap.isEnabled(sidebar, "reader", false), true)
assert.strictEqual(keymap.isEnabled(sidebar, "calendar", false), true)

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
assert.strictEqual(keymap.sequencesFor("compose").filter(function (row) {
  return row.id === "help" && row.sequence === "Ctrl+K"
}).length, 1, "the universal sequence reaches text-entry contexts")
assert.strictEqual(keymap.sequencesFor("compose").filter(function (row) {
  return row.id === "help" && row.sequence === "?"
}).length, 0, "the mailbox-only sequence stays out of text-entry contexts")

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

// A hint row must not offer what the provider refuses: that is the promise the
// button rule exists to stop, made one line lower down. The table itself stays
// whole — what a key means is a property of the application, and only whether
// it is on offer depends on which mailbox is open.
const offered = keymap.hintsFor("list")
const withoutBoth = keymap.hintsFor("list", ["archive", "star"])
assert.ok(offered.length > withoutBoth.length, "two hints go")
assert.ok(offered.some(h => h.label === "archive"))
assert.ok(!withoutBoth.some(h => h.label === "archive"))
assert.ok(!withoutBoth.some(h => h.label === "star"))
deepEqual(keymap.hintsFor("list", []), offered, "nothing missing changes nothing")
deepEqual(keymap.hintsFor("list", null), offered)

// ------------------------------------------------------------ the sheet
//
// The reference sheet is laid out in columns because one column was taller than
// a short window — and the Flickable that answered that put a scrollbar down
// the middle of the screen, since it was only as wide as the column.

const all = keymap.helpGroups().map(g => g.name)
const weight = g => g.rows.length + 1
const totalWeight = keymap.helpGroups().reduce((sum, g) => sum + weight(g), 0)

for (const count of [1, 2, 3, 4]) {
  const columns = keymap.helpColumns(count)
  assert.strictEqual(columns.length, Math.min(count, all.length),
    count + ": one list per column")
  // In order, and every group exactly once: a reader who knows the sheet finds
  // a group where it has always been, and none of them may go missing.
  deepEqual([].concat(...columns).map(g => g.name), all,
    count + ": the declared order survives the split")
  for (const column of columns) {
    assert.ok(column.length > 0, count + ": no column is left empty")
  }
  // Balanced enough to look like columns rather than a list with an appendix.
  // A heading counts as a line, which is what `helpWeight` exists to say.
  const heaviest = Math.max(...columns.map(c => c.reduce((sum, g) => sum + weight(g), 0)))
  assert.ok(heaviest <= Math.ceil(totalWeight / count) + 6,
    count + ": no column runs away with the sheet (" + heaviest + ")")
}

// A count that is not a count still has to draw something.
deepEqual(keymap.helpColumns(0), [keymap.helpGroups()])
deepEqual(keymap.helpColumns(-3), [keymap.helpGroups()])
deepEqual(keymap.helpColumns(99).length, all.length, "never more columns than groups")

console.log("test_keymap.js ok")
