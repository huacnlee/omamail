const assert = require("assert")
const { load, deepEqual } = require("./load")

const nav = load("account/Navigation.js")

// A stack is only ever handed around, never edited in place, so every check
// below that a function left its input alone compares against this snapshot.
function frozen(stack) {
  return JSON.stringify(stack)
}

// ------------------------------------------------------------------- shape

deepEqual(nav.ROOTS, ["list", "calendar"])
deepEqual(nav.OVERLAYS, ["compose", "eventComposer", "help"])

deepEqual(nav.entry("reader", { id: "m1" }), { id: "m1", kind: "reader" })
deepEqual(nav.entry("list"), { kind: "list" })
deepEqual(nav.entry("nothing-of-the-sort"), { kind: "list" }, "an unknown kind is the list")
deepEqual(nav.entry(null), { kind: "list" })
deepEqual(nav.entry("settings", { kind: "bogus" }), { kind: "settings" },
  "a field named kind cannot smuggle an unknown one in")

assert.strictEqual(nav.isOverlay("compose"), true)
assert.strictEqual(nav.isOverlay("eventComposer"), true)
assert.strictEqual(nav.isOverlay("help"), true)
assert.strictEqual(nav.isOverlay("reader"), false)
assert.strictEqual(nav.isOverlay(""), false)
assert.strictEqual(nav.isOverlay(null), false)

// The empty stack reads as the list, so nothing upstream has to special-case
// the moment before the root is computed.
deepEqual(nav.top([]), { kind: "list" })
deepEqual(nav.top(null), { kind: "list" })
deepEqual(nav.top(undefined), { kind: "list" })
deepEqual(nav.page([]), { kind: "list" })
assert.strictEqual(nav.overlay([]), null)
assert.strictEqual(nav.depth([]), 0)
assert.strictEqual(nav.depth(null), 0)
deepEqual(nav.kinds([]), [])
deepEqual(nav.kinds(null), [])

// ---------------------------------------------------------- push, pop, replace

const list = [nav.entry("list")]

let stack = nav.push(list, nav.entry("settings"))
deepEqual(nav.kinds(stack), ["list", "settings"])
assert.strictEqual(nav.depth(stack), 2)
deepEqual(nav.top(stack), { kind: "settings" })

stack = nav.push(stack, nav.entry("picker"))
stack = nav.push(stack, nav.entry("setup", { provider: "imap", draft: true }))
deepEqual(nav.kinds(stack), ["list", "settings", "picker", "setup"])
deepEqual(nav.top(stack), { kind: "setup", provider: "imap", draft: true })

stack = nav.pop(stack)
deepEqual(nav.kinds(stack), ["list", "settings", "picker"])
stack = nav.pop(stack)
deepEqual(nav.kinds(stack), ["list", "settings"])
stack = nav.pop(stack)
deepEqual(nav.kinds(stack), ["list"])

deepEqual(nav.kinds(nav.replace(nav.push(list, nav.entry("settings")), nav.entry("picker"))),
  ["list", "picker"], "replace swaps the top without recording a step")
deepEqual(nav.replace([], nav.entry("settings")), [{ kind: "settings" }],
  "replacing the top of nothing is a stack of that one entry")

// Pushing nothing is nothing.
deepEqual(nav.kinds(nav.push(list, null)), ["list"])
deepEqual(nav.kinds(nav.push([], nav.entry("settings"))), ["list", "settings"],
  "an empty stack is the list, so a push lands over it")

// A push carries the caller's kind through entry: an unknown one is the list.
deepEqual(nav.kinds(nav.push(list, { kind: "no-such-page" })), ["list", "list"])

// Opening the next message does not lengthen history.
const reader1 = nav.push(list, nav.entry("reader", { id: "m1" }))
const reader2 = nav.push(reader1, nav.entry("reader", { id: "m2" }))
deepEqual(nav.kinds(reader2), ["list", "reader"])
deepEqual(nav.top(reader2), { kind: "reader", id: "m2" })
deepEqual(nav.kinds(nav.pop(reader2)), ["list"], "one Back leaves both messages")

// An overlay raised twice is the one that is there.
const help1 = nav.push(reader1, nav.entry("help"))
const help2 = nav.push(help1, nav.entry("help"))
deepEqual(nav.kinds(help2), ["list", "reader", "help"])
const compose1 = nav.push(reader1, nav.entry("compose"))
const compose2 = nav.push(compose1, nav.entry("compose"))
deepEqual(nav.kinds(compose2), ["list", "reader", "compose"])
assert.strictEqual(nav.top(compose2).returnTo, 2,
  "the second draft keeps a returnTo measured with the first one gone")

// A different overlay over an overlay stacks: help over a draft hides the
// draft, and closing help has to bring the draft back.
const helpOverCompose = nav.push(compose1, nav.entry("help"))
deepEqual(nav.kinds(helpOverCompose), ["list", "reader", "compose", "help"])

// ------------------------------------------------------- returnTo truncation

// Reply from the list: the reader is pushed on the way to the draft, so
// leaving the draft leaves the message with it.
const fromList = nav.push(list, nav.entry("reader", { id: "m1" }))
const replyFromList = nav.push(fromList, nav.entry("compose", { returnTo: 1 }))
deepEqual(nav.kinds(replyFromList), ["list", "reader", "compose"])
deepEqual(nav.kinds(nav.pop(replyFromList)), ["list"])

// Reply from the reader: the user opened the message on purpose, and Back
// out of the draft lands in it.
const replyFromReader = nav.push(fromList, nav.entry("compose", { returnTo: 2 }))
deepEqual(nav.kinds(replyFromReader), ["list", "reader", "compose"])
deepEqual(nav.kinds(nav.pop(replyFromReader)), ["list", "reader"])

// push fills returnTo with the depth it was raised from when the caller
// did not, and leaves a caller's own alone.
assert.strictEqual(nav.top(nav.push(list, nav.entry("compose"))).returnTo, 1)
assert.strictEqual(nav.top(nav.push(fromList, nav.entry("compose"))).returnTo, 2)
assert.strictEqual(nav.top(nav.push(fromList, nav.entry("eventComposer"))).returnTo, 2)
assert.strictEqual(nav.top(nav.push(fromList, nav.entry("compose", { returnTo: 1 }))).returnTo, 1)
assert.strictEqual(nav.top(nav.push(fromList, nav.entry("help"))).returnTo, undefined,
  "only a draft records where it was raised from")

// A returnTo cannot leave the stack as it was, or pin it above the root.
deepEqual(nav.kinds(nav.pop([nav.entry("list"), nav.entry("reader", { id: "m1" }),
  nav.entry("compose", { returnTo: 7 })])), ["list", "reader"],
  "a returnTo past the top still pops one step")
deepEqual(nav.kinds(nav.pop([nav.entry("list"), nav.entry("compose", { returnTo: 0 })])),
  ["list"], "a returnTo below the root stops at the root")
deepEqual(nav.kinds(nav.pop([nav.entry("list"), nav.entry("reader", { id: "m1" }),
  nav.entry("compose", { returnTo: "1" })])), ["list", "reader"],
  "a returnTo that is not a number is not a returnTo")

// ------------------------------------------------------------ pop on a root

// Back on the root is what closes the window, and the caller tells by
// identity rather than by content.
const calendar = [nav.entry("calendar")]
assert.strictEqual(nav.pop(list), list)
assert.strictEqual(nav.pop(calendar), calendar)
const picker = [nav.entry("picker")]
assert.strictEqual(nav.pop(picker), picker, "a first-run picker is a root too")
assert.notStrictEqual(nav.pop(reader1), reader1)

// Nothing to pop from is the list, and a new array — there was no root to
// hand back.
deepEqual(nav.pop([]), [{ kind: "list" }])
deepEqual(nav.pop(null), [{ kind: "list" }])
deepEqual(nav.pop(undefined), [{ kind: "list" }])
deepEqual(nav.pop("list"), [{ kind: "list" }])

// ------------------------------------------------------- page and overlay

// The reader under a sheet is still the page, and the sheet is what is over
// it. Help over a draft: the draft is still the page's overlay only once the
// sheet is gone.
const readerHelp = nav.push(reader1, nav.entry("help"))
deepEqual(nav.page(readerHelp), { kind: "reader", id: "m1" })
deepEqual(nav.overlay(readerHelp), { kind: "help" })
deepEqual(nav.page(helpOverCompose), { kind: "reader", id: "m1" })
deepEqual(nav.overlay(helpOverCompose), { kind: "help" })
deepEqual(nav.overlay(nav.pop(helpOverCompose)), { kind: "compose", returnTo: 2 })
assert.strictEqual(nav.overlay(reader1), null)
deepEqual(nav.page(reader1), { kind: "reader", id: "m1" })
deepEqual(nav.page(list), { kind: "list" })

// A stack made only of overlays has no page to show; the list is what it
// falls back on rather than nothing.
deepEqual(nav.page([nav.entry("help")]), { kind: "list" })

// ------------------------------------------------------ roots and resets

deepEqual(nav.replaceRoot(reader1, "calendar"), [{ kind: "calendar" }])
deepEqual(nav.replaceRoot(helpOverCompose, "list"), [{ kind: "list" }])
deepEqual(nav.resetTo(helpOverCompose, "list"), [{ kind: "list" }])
deepEqual(nav.resetTo(reader1, "picker"), [{ kind: "picker" }],
  "a first-run root resets to the picker, not the list")
deepEqual(nav.replaceRoot(reader1, "not-a-kind"), [{ kind: "list" }])
deepEqual(nav.replaceRoot(null, "calendar"), [{ kind: "calendar" }])

// ------------------------------------------------------------------ rootFor

// A working mailbox starts on the list, or on the calendar when that is the
// view the user left it on.
deepEqual(nav.rootFor({ anyReady: true, view: "list" }), [{ kind: "list" }])
deepEqual(nav.rootFor({ anyReady: true, view: "calendar" }), [{ kind: "calendar" }])
deepEqual(nav.rootFor({ anyReady: true, view: "reader" }), [{ kind: "list" }],
  "only the calendar is a root; anything else is the list")
deepEqual(nav.rootFor({ anyReady: true }), [{ kind: "list" }])

// First run: nothing saved, so the question comes first.
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: false }), [{ kind: "picker" }])

// A saved row whose setup is underway: its form, with the picker underneath
// so Back lands on the question it answered.
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: true, provider: "imap" }),
  [{ kind: "picker" }, { kind: "setup", provider: "imap", draft: false }])

// Saved rows, none underway: the picker alone.
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: false, provider: "imap" }),
  [{ kind: "picker" }])

// The view chooses only when a mailbox is ready; before that there is no
// calendar to show.
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: false, view: "calendar" }), [{ kind: "picker" }])
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: true, provider: "gmail", view: "calendar" }),
  [{ kind: "picker" }, { kind: "setup", provider: "gmail", draft: false }])

// Setup underway with no saved row cannot happen, and reads as first run.
deepEqual(nav.rootFor({ anyReady: false, hasSavedAccounts: false, setupUnderway: true, provider: "imap" }),
  [{ kind: "picker" }])
deepEqual(nav.rootFor(null), [{ kind: "picker" }])
deepEqual(nav.rootFor({}), [{ kind: "picker" }])

// ---------------------------------------------------------------- kinds

deepEqual(nav.kinds(helpOverCompose), ["list", "reader", "compose", "help"])
deepEqual(nav.kinds(nav.rootFor({ anyReady: false, hasSavedAccounts: true, setupUnderway: true, provider: "hey" })),
  ["picker", "setup"])

// ---------------------------------------------------------- immutability

const before = [nav.entry("list"), nav.entry("reader", { id: "m1" }), nav.entry("compose", { returnTo: 1 })]
const snapshot = frozen(before)
const draft = nav.entry("compose")
const draftSnapshot = frozen(draft)

nav.push(before, draft)
nav.push(before, nav.entry("reader", { id: "m2" }))
nav.push(before, nav.entry("help"))
nav.pop(before)
nav.replace(before, nav.entry("settings"))
nav.replaceRoot(before, "calendar")
nav.resetTo(before, "list")
nav.top(before)
nav.page(before)
nav.overlay(before)
nav.kinds(before)
assert.strictEqual(frozen(before), snapshot, "no function edits the stack it was given")
assert.strictEqual(frozen(draft), draftSnapshot, "push fills returnTo on a copy, not on the caller's entry")

// Every mutator hands back a different array, and the entries in it are not
// the caller's objects either: a stack on screen must not change under it.
const pushed = nav.push(before, nav.entry("help"))
assert.notStrictEqual(pushed, before)
assert.notStrictEqual(pushed[0], before[0])
const popped = nav.pop(before)
assert.notStrictEqual(popped, before)
assert.notStrictEqual(popped[0], before[0])
const replaced = nav.replace(before, nav.entry("settings"))
assert.notStrictEqual(replaced, before)
const settings = nav.entry("settings")
const withSettings = nav.push(list, settings)
assert.notStrictEqual(withSettings[1], settings, "an entry is copied onto the stack")

console.log("test_navigation.js ok")
