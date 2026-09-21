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
assert.strictEqual(keymap.contextFor({ assistantEditing: true, assistantCommands: true, composing: true }), "assistantCommands")
assert.strictEqual(keymap.contextFor({ assistantEditing: true, assistantCommands: false, composing: true }), "assistant")
assert.strictEqual(keymap.contextFor({ assistantEditing: false, assistantCommands: true, composing: true }), "compose")
deepEqual(byId("assistantSend").keys, ["Return", "Enter", "Ctrl+Return", "Ctrl+Enter"])
deepEqual(byId("assistantChooseCommand").keys, ["Return", "Enter"])
assert.ok(!keymap.sequencesFor("assistant").some(entry => ["Up", "Down"].includes(entry.sequence)))
for (const key of ["Return", "Enter"]) {
  assert.strictEqual(keymap.sequencesFor("assistant").find(entry => entry.sequence === key).id, "assistantSend")
  assert.strictEqual(keymap.sequencesFor("assistantCommands").find(entry => entry.sequence === key).id, "assistantChooseCommand")
  for (const context of ["assistant", "assistantCommands"]) {
    assert.ok(!keymap.sequencesFor(context).some(entry => entry.sequence === "Shift+" + key))
  }
}
assert.ok(keymap.sequencesFor("assistantCommands").some(entry => entry.id === "assistantCommandDown" && entry.sequence === "Down"))
assert.ok(!keymap.sequencesFor("compose").some(entry => entry.id === "assistantSend"))
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

// A bare question mark belongs to mailbox navigation, never text entry.
deepEqual(help.keys, ["?"])
assert.strictEqual(keymap.isSequenceEnabled(help, "?", "compose", false), false,
  "a question mark remains text inside a draft")
assert.strictEqual(keymap.isSequenceEnabled(help, "?", "list", false), true)
assert.strictEqual(byId("helpAnywhere"), undefined,
  "one help action must render as one row")
assert.strictEqual(keymap.isEnabled(byId("search"), "compose", false), false,
  "while the bare slash is a character in the draft")

const settings = byId("settings")
assert.strictEqual(keymap.displayFor(settings), "Ctrl+,")
keymap.CONTEXTS.forEach(function (context) {
  const entries = keymap.sequencesFor(context).filter(entry => entry.sequence === "Ctrl+,")
  assert.strictEqual(entries.length, 1, "Ctrl+, has exactly one action in " + context)
  assert.strictEqual(entries[0].id, "settings")
  assert.strictEqual(keymap.isSequenceEnabled(settings, "Ctrl+,", context, false), true)
})
assert.strictEqual(keymap.isEnabled(settings, "calendar", false), true,
  "settings must open from the calendar")
assert.strictEqual(keymap.isEnabled(settings, "page", false), true,
  "the settings route is available from every screen")

// Checking for mail answers to the browser's reload chord as well as its key.
// Ctrl+R is a modified sequence, so it is live while a query or a draft is
// being typed, where a bare `r` is a letter and stays reply's.
deepEqual(byId("refresh").keys, ["F5", "Ctrl+R"],
  "F5 and Ctrl+R both check for mail")
// Through the table the router instantiates from, not `isSequenceEnabled`,
// which answers for any sequence whether or not the row binds it.
keymap.CONTEXTS.forEach(function (context) {
  var live = keymap.sequencesFor(context).some(function (entry) {
    return entry.id === "refresh" && entry.sequence === "Ctrl+R"
  })
  assert.strictEqual(live, true, "Ctrl+R must check for mail from " + context)
})

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
assert.strictEqual(keymap.displayFor(byId("help")), "?")

// Qt's sequence syntax is not the UI's.
assert.strictEqual(keymap.readableSequence("g,i"), "g then i",
  "a chord reads as a chord, not as Qt's comma")
assert.strictEqual(keymap.readableSequence("Escape"), "Esc")
assert.strictEqual(keymap.readableSequence("Ctrl+Return"), "Ctrl+Enter")
assert.strictEqual(keymap.displayFor(byId("goMailbox")), "Ctrl+1…9",
  "nine mailbox keys are one row on the sheet, not nine")

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
assert.strictEqual(keymap.slotFor("goMailbox", "Ctrl+0"), -1,
  "Ctrl+0 is reset zoom, as in every browser, not a tenth row")
assert.strictEqual(keymap.slotFor("goMailbox", "Alt+1"), -1)
assert.strictEqual(keymap.slotFor("goMailbox", ""), -1)
assert.strictEqual(keymap.slotFor("nothing", "Alt+1"), -1)
assert.strictEqual(keymap.displayFor(byId("open")), "Enter, o")
assert.strictEqual(keymap.displayFor(byId("openReader")), "Right")
assert.strictEqual(keymap.displayFor(byId("scrollDown")), "Shift+J")
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
assert.strictEqual(keymap.isEnabled(byId("scrollDown"), "reader", true), true)
assert.strictEqual(keymap.isEnabled(byId("scrollUp"), "reader", true), true)
assert.strictEqual(keymap.isEnabled(byId("openReader"), "list", false), true)
assert.strictEqual(keymap.isEnabled(byId("openReader"), "reader", false), false)
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
assert.strictEqual(keymap.displayFor(byId("zoomReset")), "Ctrl+0")
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
assert.strictEqual(keymap.keycapLabel("Shift+J / Shift+K"), "shift+j / shift+k")
assert.strictEqual(keymap.keycapLabel("Ctrl+Enter, Esc, Space"), "ctrl+enter, esc, space")
assert.ok(!keymap.hintsFor("reader").some(function (hint) { return hint.label === "open" }))
deepEqual(listHints.map(function (h) { return h.key + " " + h.label }),
  ["j / k move", "e archive", "d trash", "Space select", "c compose"],
  "the status bar offers what the list can do, in its short form")
const selectedListHints = keymap.hintsFor("list", [], true)
deepEqual(selectedListHints.map(function (h) { return h.key + " " + h.label }),
  ["j / k move", "e archive", "d trash", "v move to", "Space select", "c compose"],
  "the move hint joins the existing row only while a message is selected")
assert.ok(!keymap.hintsFor("list", ["move"], true).some(function (h) {
  return h.key === "v"
}), "a provider without move does not offer the move hint")
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
  return row.id === "help"
}).length, 0, "Help stays out of text-entry contexts")

// -------------------------------------------------- the doc cannot drift

// docs/KEYS.md carries the table for people rather than for the engine. Three
// hand-written copies of this list used to exist and had already drifted apart,
// so this one is asserted against the source rather than trusted.
{
  const fs = require("fs")
  const path = require("path")
  const doc = fs.readFileSync(
    path.join(__dirname, "..", "..", "docs", "KEYS.md"), "utf8")
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
const withoutAgent = keymap.helpGroups(["askAgent", "assistantSend",
  "assistantCommandUp", "assistantCommandDown", "assistantChooseCommand"])
assert.ok(!withoutAgent.some(g => g.name === "AI"),
  "a host without the agent does not advertise AI shortcuts")
assert.ok(!withoutAgent.some(g => g.rows.some(r => r.action.indexOf("Ask AI") >= 0)),
  "the Ask AI shortcut leaves the host-specific reference sheet")

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

// `v` is Gmail's own move key, which is what issue #58 asks these to match.
// `m` mutes there, so a move on `m` would be the one binding somebody arriving
// from Gmail has to unlearn -- pinned here because "it was free" is exactly the
// reasoning that would put it back.
const move = keymap.BINDINGS.filter(b => b.id === "moveToLabel")
assert.strictEqual(move.length, 1, "one move row")
deepEqual(move[0].keys, ["v"], "Gmail moves with v")
assert.ok(keymap.BINDINGS.every(b => b.keys.indexOf("m") < 0 || b.contexts.indexOf("calendar") >= 0),
  "m stays out of the mailbox, where Gmail means mute by it")

// Bound where a message is, and nowhere else: the calendar has no message to
// move, and a row added to the wrong context list would bind it there silently.
deepEqual(keymap.bindingsFor("list").filter(b => b.id === "moveToLabel").length, 1)
deepEqual(keymap.bindingsFor("reader").filter(b => b.id === "moveToLabel").length, 1)
deepEqual(keymap.bindingsFor("calendar").filter(b => b.id === "moveToLabel").length, 0)

// A count that is not a count still has to draw something.
deepEqual(keymap.helpColumns(0), [keymap.helpGroups()])
deepEqual(keymap.helpColumns(-3), [keymap.helpGroups()])
deepEqual(keymap.helpColumns(99).length, all.length, "never more columns than groups")

// ------------------------------------------------------------ user overrides
//
// The rows are data at runtime, not only at authoring time: keybindings.json
// names a few of them and the effective keys follow. Everything is a filter in
// front of `effectiveKeys`, so an override reaches the router, the sheet and
// the hints together and the defaults in this file are still the defaults.

// What is the user's to move, and what is not.
assert.ok(keymap.isRebindable(byId("archive")), "a bare mailbox key can be rebound")
assert.ok(keymap.isRebindable(byId("search")), "so can the one in the mailbox on `/`")
assert.ok(!keymap.isRebindable(byId("back")), "Escape is the way out of everywhere")
assert.ok(!keymap.isRebindable(byId("goMailbox")), "a numbered rail is a range, not a key")
assert.ok(!keymap.isRebindable(byId("send")), "a key in a draft would need a modifier Qt eats first")
assert.ok(!keymap.isRebindable(byId("settings")), "nor one bound in every context")
assert.ok(!keymap.isRebindable(byId("undoSend")))
keymap.rebindable().forEach(function (row) {
  assert.ok(keymap.isRebindable(row), "rebindable() lists only rebindable rows")
})

// An override changes what a row answers to, everywhere a row is read from.
keymap.setOverrides({ archive: ["z"] })
assert.ok(keymap.isOverridden("archive"))
assert.strictEqual(keymap.displayFor(byId("archive")), "z",
  "the sheet shows the override")
deepEqual(keymap.effectiveKeys(byId("archive")), ["z"])
assert.strictEqual(keymap.slotFor("archive", "z"), 0)
assert.ok(keymap.sequencesFor("list").some(function (s) {
  return s.id === "archive" && s.sequence === "z"
}), "the router binds the override")
assert.ok(!keymap.sequencesFor("list").some(function (s) {
  return s.id === "archive" && s.sequence === "e"
}), "and not the default it replaced")
// The default is untouched: a reset is the absence of an entry.
deepEqual(byId("archive").keys, ["e"], "keys/Keymap.js still holds the default")

// A rebound row loses its hand-written status hint and falls to its real keys.
assert.strictEqual(keymap.hintKeyFor(byId("archive")), "z")

// conflicts() sees overrides, so checkBinding can ask it one edit ahead.
keymap.setOverrides({ archive: ["j"] })
assert.ok(keymap.conflicts().some(function (c) {
  return c.ids.indexOf("archive") >= 0 && c.ids.indexOf("cursorDown") >= 0
}), "an override onto j collides with Move down")
keymap.resetAll()
deepEqual(keymap.conflicts(), [], "and the collision is gone once it is cleared")

// checkBinding: "" to allow, a sentence to refuse — and it leaves no trace.
assert.strictEqual(keymap.checkBinding("archive", ["z"]), "", "a free key is allowed")
assert.ok(!keymap.isOverridden("archive"), "checkBinding does not commit")
assert.ok(keymap.checkBinding("archive", ["j"]).indexOf("move down") >= 0,
  "a taken key names what already holds it")
assert.ok(keymap.checkBinding("back", ["q"]).length > 0, "a fixed action refuses")
assert.ok(keymap.checkBinding("archive", []).length > 0, "nothing pressed refuses")
assert.strictEqual(keymap.checkBinding("archive", ["e"]), "",
  "rebinding a row to its own default is allowed and clears the override")

// applyOverride commits after checkBinding has approved; a default clears it.
keymap.applyOverride("archive", ["z"])
assert.ok(keymap.isOverridden("archive"))
keymap.applyOverride("archive", ["e"])
assert.ok(!keymap.isOverridden("archive"), "the default is not an override")
keymap.applyOverride("archive", ["z"])
keymap.applyOverride("archive", [])
assert.ok(!keymap.isOverridden("archive"), "an empty list is a reset")

// The file round-trips through parse/serialize, and setOverrides sanitises it.
keymap.setOverrides({ archive: ["z"], trash: ["Ctrl+D"] })
const written = keymap.serializeOverrides()
assert.deepStrictEqual(JSON.parse(written), { version: 1, bindings: { archive: ["z"], trash: ["Ctrl+D"] } })
keymap.resetAll()
keymap.setOverrides(keymap.parseOverrides(written))
assert.strictEqual(keymap.displayFor(byId("trash")), "Ctrl+D")
deepEqual(keymap.parseOverrides(""), {}, "no file is no overrides")
deepEqual(keymap.parseOverrides("not json"), {}, "and neither is a broken one")
deepEqual(keymap.parseOverrides('{"bindings":42}'), {})
keymap.setOverrides({ back: ["q"], nonesuch: ["z"], archive: ["Escape"] })
assert.ok(!keymap.isOverridden("back"), "a structural id is dropped on load")
assert.ok(!keymap.isOverridden("nonesuch"), "an unknown id is dropped on load")
assert.ok(!keymap.isOverridden("archive"), "an entry that cleans to nothing is dropped")
keymap.resetAll()

// A Reset does not go through checkBinding, so a conflict can outlive the
// capture flow: move Archive off e, put Reply on e, then reset Archive back to
// its default and both answer to e. conflictReport() is what the settings
// section shows for exactly this.
deepEqual(keymap.conflictReport(), [], "a clean table reports no conflicts")
keymap.applyOverride("archive", ["z"])
keymap.applyOverride("reply", ["e"])
deepEqual(keymap.conflictReport(), [], "no clash while Archive is on z")
keymap.applyOverride("archive", []) // the Reset that checkBinding never sees
const report = keymap.conflictReport()
assert.strictEqual(report.length, 1, "one clash, not one per mailbox context")
assert.strictEqual(report[0].key, "e")
assert.strictEqual(report[0].where, "the mailbox")
const labels = report[0].actions.map(function (a) { return a.label }).sort()
deepEqual(labels, ["Archive", "Reply"])
const replySide = report[0].actions.filter(function (a) { return a.id === "reply" })[0]
const archiveSide = report[0].actions.filter(function (a) { return a.id === "archive" })[0]
assert.strictEqual(replySide.overridden, true, "Reply is the one to offer a reset for")
assert.strictEqual(archiveSide.overridden, false, "Archive is back on its default")
keymap.applyOverride("reply", []) // resolving it by backing the other side out
deepEqual(keymap.conflictReport(), [], "and the section clears")
keymap.resetAll()

// The hand-written short form names two rows' keys: "j / k" is Move down's
// hint and half of it is Move up's key. Rebinding either side has to drop it.
assert.strictEqual(keymap.hintKeyFor(byId("cursorDown")), "j / k")
keymap.applyOverride("cursorUp", ["p"])
assert.strictEqual(keymap.hintKeyFor(byId("cursorDown")), "j, Down",
  "a rebind of the partner row drops the short form")
keymap.resetAll()
keymap.applyOverride("calendarPrevious", ["p"])
assert.strictEqual(keymap.hintKeyFor(byId("calendarNext")), "j, Down",
  "and the same for the calendar pair")
keymap.resetAll()

// Qt reads "J" and "j" as one key, so a hand-edited file that spells a binding
// the other way would be an ambiguous Shortcut, not a conflict anyone can see.
// Every write path runs through cleanKeyList, so normalising there covers all.
deepEqual(keymap.cleanKeyList(["J"]), ["j"], "a bare letter binds lower-case")
deepEqual(keymap.cleanKeyList(["Ctrl+e"]), ["Ctrl+E"], "a modified one upper")
deepEqual(keymap.cleanKeyList(["j", "J"]), ["j"], "and the two are one key")
deepEqual(keymap.cleanKeyList(["escape"]), [], "escape goes whatever its case")
keymap.rebindable().forEach(function (binding) {
  deepEqual(keymap.cleanKeyList(binding.keys), binding.keys,
    binding.id + " is already spelled the way cleanKeyList spells it")
})
keymap.setOverrides(keymap.parseOverrides('{"version":1,"bindings":{"archive":["J"]}}'))
assert.strictEqual(keymap.displayFor(byId("archive")), "j", "loaded case-folded")
assert.strictEqual(keymap.conflictReport().length, 1,
  "so the clash with Move down is one the settings section can show")
keymap.resetAll()

// Modifier order is the same hazard as letter case and needs the same answer:
// Qt reads "Meta+Ctrl+A" and "Ctrl+Meta+A" as one chord, so two rows spelled
// the two ways are an ambiguous Shortcut rather than a conflict conflicts()
// can see. Canonical order is Ctrl, Alt, Meta, Shift — what keys/Capture.js
// records in, not what Qt prints.
deepEqual(keymap.cleanKeyList(["Meta+Ctrl+A"]), ["Ctrl+Meta+A"], "modifiers sort")
deepEqual(keymap.cleanKeyList(["shift+ctrl+alt+meta+b"]), ["Ctrl+Alt+Meta+Shift+B"])
deepEqual(keymap.cleanKeyList(["Ctrl+Meta+A", "Meta+Ctrl+A"]), ["Ctrl+Meta+A"],
  "and the two spellings are one key")
deepEqual(keymap.cleanKeyList(["Hyper+A"]), ["Hyper+A"],
  "a prefix we do not know is left alone rather than rewritten")
keymap.setOverrides({ archive: ["Meta+Ctrl+A"], trash: ["Ctrl+Meta+A"] })
assert.strictEqual(keymap.conflictReport().length, 1,
  "so the section can show it instead of Qt quietly firing neither")
keymap.resetAll()

// StandardKey.Close is an application shortcut in the standalone host, and Qt
// answers a tie by firing neither, so a rebind onto it would take the window's
// Close with it.
assert.strictEqual(keymap.checkBinding("archive", ["Ctrl+W"]),
  "Ctrl+W closes the window")
assert.strictEqual(keymap.checkBinding("archive", ["Ctrl+F4"]),
  "Ctrl+F4 closes the window")
assert.strictEqual(keymap.checkBinding("archive", ["z"]), "",
  "and an ordinary free key is still fine")

// The AI dock is a text-entry context, and its bare keys are reachable only
// through KeyRouter.routeKeyEvent, which decodes Up, Down, Return and Enter
// and nothing else — so a row moved onto any other key there would report
// success and then never fire.
;["assistantSend", "assistantCommandUp", "assistantCommandDown",
  "assistantChooseCommand"].forEach(function (id) {
  assert.ok(byId(id), id + " is in the table")
  assert.strictEqual(keymap.isRebindable(byId(id)), false,
    id + " is not the user's to move")
  assert.strictEqual(keymap.checkBinding(id, ["z"]), "This action's keys are fixed")
})
assert.ok(!keymap.rebindable().some(function (b) {
  return (b.contexts || []).some(function (c) {
    return c === "assistant" || c === "assistantCommands"
  })
}), "and the settings section offers none of them")

// Every hand-written short form that names a second row's key has to say which
// row, or a rebind of that row leaves the hint naming a key nobody is bound to.
keymap.BINDINGS.forEach(function (binding) {
  if (!binding.hintKey || binding.hintKey.indexOf(" / ") < 0) return
  assert.ok(binding.hintWith,
    binding.id + "'s hint names another row's key and must name the row")
  assert.ok(byId(binding.hintWith), binding.id + " names a row that exists")
})
keymap.applyOverride("scrollUp", ["Shift+P"])
assert.strictEqual(keymap.hintKeyFor(byId("scrollDown")), "Shift+J",
  "the reader hint drops the short form when its partner moves")
keymap.resetAll()

// Nothing above leaked into the defaults the rest of the suite trusts.
deepEqual(keymap.conflicts(), [], "back to a clean table")
deepEqual(keymap.conflictReport(), [])
assert.strictEqual(keymap.displayFor(byId("archive")), "e")

console.log("test_keymap.js ok")
