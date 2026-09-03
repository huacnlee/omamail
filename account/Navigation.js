.pragma library

// Where the user is and how they got there. `App.qml` used to keep that in
// eight independent flags and guess, at every call site, what Back should do
// with them; some guesses were wrong, and one of them stranded a first-run
// user on a form with no way back to the question it answered. So navigation
// is a history stack instead — plain data, one entry per place, ruled here —
// and `App.qml` derives every `visible:` from the top and has one way out.
//
// Everything is pure and every mutator returns a new array. The QML side
// holds the stack in a property and rebinds off it, so an array changed in
// place would leave the screen showing a history that no longer exists.
// `pop` has one deliberate exception: a root is handed back as the same
// instance, because "Back did nothing" is what the window closes on, and
// identity is the cheapest way for the caller to tell.

// The two places a stack can start. Switching between them is `replaceRoot`,
// never a push: the calendar is not somewhere the user went from the list, it
// is the other thing the window is for.
var ROOTS = ["list", "calendar"]

// Drawn over a page rather than instead of it. The page underneath is still
// the page — `page` skips these, and `overlay` reports them — so the reader
// stays open while the shortcut sheet is up.
var OVERLAYS = ["compose", "eventComposer", "help"]

// Every place there is. `entry` refuses anything else and lands on the list,
// because an unknown kind on the stack would be a screen nothing knows how
// to draw.
var KINDS = ["list", "calendar", "reader", "calendarDetail", "settings",
  "picker", "setup", "compose", "eventComposer", "help"]

var DEFAULT_KIND = "list"

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function contains(list, value) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] === value) return true
  }
  return false
}

function isOverlay(kind) {
  return contains(OVERLAYS, trimmed(kind))
}

function normalizeKind(kind) {
  var name = trimmed(kind)
  return contains(KINDS, name) ? name : DEFAULT_KIND
}

// An entry is `{ kind }` plus whatever that kind carries — a reader's `id`, a
// form's `provider` and `draft`, an overlay's `returnTo`. The fields are
// copied rather than kept, so a caller that goes on editing its object does
// not edit the history with it, and `kind` is written last so a field named
// `kind` cannot smuggle an unknown one past the check above.
function entry(kind, fields) {
  var made = {}
  var extra = isObject(fields) ? fields : {}
  for (var key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) made[key] = extra[key]
  }
  made.kind = normalizeKind(kind)
  return made
}

// The stack as this file reads it: a fresh array of fresh entries. Anything
// that is not a non-empty array is the list on its own, which is what the
// window shows when it has nothing else to say — and why `top` of nothing is
// the list, and `pop` of nothing is `[list]`.
function copy(stack) {
  var source = Array.isArray(stack) ? stack : []
  var next = []
  for (var i = 0; i < source.length; i++) {
    var item = source[i]
    if (isObject(item)) next.push(entry(item.kind, item))
  }
  if (next.length === 0) next.push(entry(DEFAULT_KIND))
  return next
}

function depth(stack) {
  return Array.isArray(stack) ? stack.length : 0
}

function top(stack) {
  var source = Array.isArray(stack) ? stack : []
  var last = source.length > 0 ? source[source.length - 1] : null
  return isObject(last) ? last : entry(DEFAULT_KIND)
}

// Opening the next message does not lengthen history: `j` through a whole
// mailbox and Back still goes to the list, not back through every message
// read on the way. A second sheet or draft raised while one is already up is
// the same idea — there is one of each, and asking for it again is asking for
// the one that is there.
//
// A draft records the depth it was raised from, because leaving it must land
// where the user was and not merely one step down: a reply started from the
// list pushes the reader first, so one step down would be a message the user
// never opened on purpose.
function push(stack, item) {
  var next = copy(stack)
  if (!isObject(item)) return next
  var added = entry(item.kind, item)
  var above = next[next.length - 1]
  var replaces = (added.kind === "reader" && above.kind === "reader")
    || (isOverlay(added.kind) && above.kind === added.kind)
  if (replaces) next.pop()
  var remembers = added.kind === "compose" || added.kind === "eventComposer"
  if (remembers && typeof added.returnTo !== "number") added.returnTo = next.length
  next.push(added)
  return next
}

// Back. A root is returned as the very same array, and that is the contract:
// the caller compares by identity and closes the window when nothing was
// popped. Everything else comes back new.
//
// A `returnTo` is trusted only as far as it can be: never below the root,
// and never so high that Back would leave the stack as it was — a draft that
// somehow recorded its own depth would otherwise be a place the user cannot
// leave, which is the defect this file replaces.
function pop(stack) {
  if (Array.isArray(stack) && stack.length === 1 && isObject(stack[0])) return stack
  var next = copy(stack)
  if (next.length === 1) return next
  var leaving = next[next.length - 1]
  var keep = next.length - 1
  if (typeof leaving.returnTo === "number" && isFinite(leaving.returnTo))
    keep = Math.min(keep, Math.floor(leaving.returnTo))
  return next.slice(0, Math.max(1, keep))
}

// Swap the top for something else without recording a step. This is a plain
// exchange: a `returnTo` is filled by `push` alone, because only a push knows
// the depth the user was actually at.
function replace(stack, item) {
  var next = copy(stack)
  if (!isObject(item)) return next
  next[next.length - 1] = entry(item.kind, item)
  return next
}

// A new stack of one. Nothing above the root survives, which is the point:
// the calendar is not a place reached from the reader, and neither is a list
// that has just been searched or switched to another mailbox.
function replaceRoot(stack, kind) {
  return [entry(kind)]
}

// The same operation under the name the callers that mean "start over" use —
// a search, a mailbox switch, an account switch. Naming it separately says
// that those are not navigation; the stack is dropped because the list under
// it has changed, not because the user went somewhere.
function resetTo(stack, kind) {
  return replaceRoot(stack, kind)
}

// The topmost entry that is drawn as a page. Overlays sit over a page and
// leave it on screen, so the reader under a shortcut sheet is still the page.
function page(stack) {
  var source = Array.isArray(stack) ? stack : []
  for (var i = source.length - 1; i >= 0; i--) {
    if (isObject(source[i]) && !isOverlay(source[i].kind)) return source[i]
  }
  return entry(DEFAULT_KIND)
}

// The topmost overlay, or null when nothing is drawn over the page. Only the
// top of the overlays counts: help raised over a draft hides the draft, so
// that is the one Escape has to close first.
function overlay(stack) {
  var source = Array.isArray(stack) ? stack : []
  for (var i = source.length - 1; i >= 0; i--) {
    if (isObject(source[i]) && isOverlay(source[i].kind)) return source[i]
  }
  return null
}

// Where the stack starts, from what the service knows. Recomputed only when
// `anyReady` flips and at startup — saving an address or adding a draft row
// leaves the stack alone, or every keystroke on a form would reset the form.
//
// The picker sits *under* a first-run form rather than being replaced by it.
// That is the structural fix for the report this file answers: a user refused
// by Google after choosing IMAP presses Back and lands on the question they
// answered wrongly, whatever the form does or does not offer.
function rootFor(state) {
  var value = isObject(state) ? state : {}
  if (value.anyReady === true)
    return [entry(trimmed(value.view) === "calendar" ? "calendar" : "list")]
  if (value.hasSavedAccounts === true && value.setupUnderway === true)
    return [entry("picker"), entry("setup", { provider: trimmed(value.provider), draft: false })]
  return [entry("picker")]
}

function kinds(stack) {
  var source = Array.isArray(stack) ? stack : []
  var names = []
  for (var i = 0; i < source.length; i++) {
    names.push(isObject(source[i]) ? String(source[i].kind || "") : "")
  }
  return names
}
