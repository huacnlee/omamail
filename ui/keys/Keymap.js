.pragma library

// Every key this window answers to, in one table.
//
// Three descriptions of this list used to exist — the Shortcut declarations in
// App.qml, the help sheet, and the status-bar hints — and they had already
// drifted: the sheet listed Esc twice, was missing `u` and `?`, and carried a
// mouse gesture among the keys. Anything that shows or fires a binding now
// reads this file, so there is nothing left to keep in step by hand.

// The window is in exactly one of these at a time. The context is the single
// owner of "where am I": App.qml derives it from the screen, and the keyboard
// follows it — a context that is not text entry parks the focus rather than
// leaving it wherever the last click put it. Keeping those two as separate
// things is what let a dismissed compose field go on eating j and k.
var CONTEXTS = ["list", "reader", "search", "compose", "page", "calendar", "assistant", "assistantCommands"]

// Shorthands, so a row says where it lives rather than restating the set.
var MAIL = ["list", "reader"]
var ANY = ["*"]

var BINDINGS = [
  // These survive the shortcut sheet, and they are the only mailbox keys that
  // do: behind the sheet they scroll it. A reference sheet taller than the
  // window that could only be read with a mouse would be the one screen here
  // that contradicts the rest. The account switcher is not on this list — it is
  // a popup, and a popup takes every key before the shortcut map sees it, so it
  // answers `j`/`k` itself.
  { id: "cursorDown", keys: ["j", "Down"], contexts: MAIL,
    survivesOverlay: true,
    group: "Moving", label: "Move down",
    hintKey: "j / k", hintWith: "cursorUp", hint: { list: "move" } },
  { id: "cursorUp", keys: ["k", "Up"], contexts: MAIL,
    survivesOverlay: true,
    group: "Moving", label: "Move up" },
  { id: "scrollDown", keys: ["Shift+J"], contexts: ["reader"],
    survivesOverlay: true,
    group: "Moving", label: "Scroll down",
    hintKey: "Shift+J / Shift+K", hintWith: "scrollUp",
    hint: { reader: "scroll" } },
  { id: "scrollUp", keys: ["Shift+K"], contexts: ["reader"],
    survivesOverlay: true,
    group: "Moving", label: "Scroll up" },
  // Explicit opening remains available, but cursor movement already opens the
  // reader, so the footer does not need an additional open hint.
  { id: "open", keys: ["Return", "Enter", "o"], contexts: MAIL,
    group: "Moving", label: "Open the selected message",
    hintKey: "o" },
  { id: "openReader", keys: ["Right"], contexts: ["list"],
    group: "Moving", label: "Open the selected message" },
  { id: "backToList", keys: ["u", "Left"], contexts: ["reader"],
    group: "Moving", label: "Back to the list" },
  // Along the conversation rail, which only the reader has. Two letters rather
  // than a reuse of `j` and `k`: those move the list cursor, and they go on
  // moving it while the reader is open — the cursor and the open message are
  // two different things, and a key that moved both would collapse them. Gmail
  // uses this pair for the same movement, and both were unbound here.
  //
  // A conversation of one draws no rail and these do nothing, which is the
  // context doing its job: what a key means is a property of the application,
  // and whether there is anywhere to go is a property of the message.
  //
  // No status hint. The hint row says what the keyboard does *here*, and here
  // is any open message — while these two do something only on a conversation
  // of two or more. Offering them on every message would be the promise the
  // hint filter exists to stop being made, one line lower down. They are on the
  // shortcut sheet, with the rest of the table.
  { id: "nextMember", keys: ["n"], contexts: ["reader"],
    group: "Moving", label: "Next message in the conversation" },
  { id: "previousMember", keys: ["p"], contexts: ["reader"],
    group: "Moving", label: "Previous message in the conversation" },

  { id: "archive", keys: ["e"], contexts: MAIL,
    group: "Acting", label: "Archive",
    hint: { list: "archive", reader: "archive" } },
  { id: "trash", keys: ["d"], contexts: MAIL,
    group: "Acting", label: "Move to trash",
    hint: { list: "trash", reader: "trash" } },
  { id: "star", keys: ["s"], contexts: MAIL,
    group: "Acting", label: "Star or unstar" },
  // `v` because that is the key Gmail moves a message with, and issue #58 asks
  // for those shortcuts one for one. Not `m`: free here, but Gmail's `m` mutes
  // a conversation, and taking it for a move would be the one binding somebody
  // arriving from Gmail has to unlearn.
  //
  // "Move to" rather than "Move to a label" because the destination is a label
  // on Gmail and a folder on IMAP, and the sheet has no provider to ask.
  { id: "moveToLabel", keys: ["v"], contexts: MAIL,
    group: "Acting", label: "Move to",
    hint: { list: "move to", reader: "move to" },
    hintNeedsSelection: true, hintUnavailableId: "move" },
  { id: "markRead", keys: ["Shift+I"], contexts: MAIL,
    group: "Acting", label: "Mark read" },
  { id: "markUnread", keys: ["Shift+U"], contexts: MAIL,
    group: "Acting", label: "Mark unread" },
  // Space or Gmail's x toggles the cursor row, including while the reader
  // is open beside the list.
  { id: "toggleCheck", keys: ["x", "Space"], contexts: MAIL,
    group: "Acting", label: "Select or deselect the message",
    hintKey: "Space", hint: { list: "select" } },
  { id: "checkAll", keys: ["Ctrl+A"], contexts: ["list"],
    group: "Acting", label: "Select every message loaded, or none" },

  // Answering works from the list too, the way the row's own menu does: the
  // message is opened first and the draft waits for it. Binding these to the
  // reader only left the keyboard able to do less than a right-click.
  { id: "reply", keys: ["r"], contexts: MAIL,
    group: "Writing", label: "Reply", hint: { reader: "reply" } },
  { id: "replyAll", keys: ["a"], contexts: MAIL,
    group: "Writing", label: "Reply to all" },
  { id: "forward", keys: ["f"], contexts: MAIL,
    group: "Writing", label: "Forward" },
  { id: "compose", keys: ["c"], contexts: MAIL,
    group: "Writing", label: "Compose or edit a draft", hint: { list: "compose" } },
  { id: "createEvent", keys: ["c"], contexts: ["calendar"],
    group: "Writing", label: "Create an event", hint: { calendar: "create" } },
  { id: "calendarNext", keys: ["j", "Down"], contexts: ["calendar"],
    group: "Calendar", label: "Select the next event",
    hintKey: "j / k", hintWith: "calendarPrevious", hint: { calendar: "select" } },
  { id: "calendarPrevious", keys: ["k", "Up"], contexts: ["calendar"],
    group: "Calendar", label: "Select the previous event" },
  { id: "openCalendarEvent", keys: ["Return", "o"], contexts: ["calendar"],
    group: "Calendar", label: "Open the selected event",
    hintKey: "o", hint: { calendar: "open" } },
  { id: "calendarPreviousPeriod", keys: ["h", "Left"], contexts: ["calendar"],
    group: "Calendar", label: "Previous week or month" },
  { id: "calendarNextPeriod", keys: ["l", "Right"], contexts: ["calendar"],
    group: "Calendar", label: "Next week or month" },
  { id: "calendarToday", keys: ["t"], contexts: ["calendar"],
    group: "Calendar", label: "Go to today" },
  { id: "calendarWeek", keys: ["w"], contexts: ["calendar"],
    group: "Calendar", label: "Show week view" },
  { id: "calendarMonth", keys: ["m"], contexts: ["calendar"],
    group: "Calendar", label: "Show month view" },
  // Both Enters: the main keyboard's is Return, the numpad's is Enter, and
  // a hand on the numpad expects the same thing of them.
  { id: "send", keys: ["Ctrl+Return", "Ctrl+Enter"], contexts: ["compose"],
    group: "Writing", label: "Send", hint: { compose: "send" } },
  { id: "undoSend", keys: ["Alt+Z"], contexts: ANY,
    survivesOverlay: true,
    group: "Writing", label: "Undo send" },

  // Reachable from the mailbox. `/` is a bare key, so it is only offered where
  // bare keys mean anything — inside the field it is a character being typed,
  // and Qt gives the field its keys before any Shortcut sees them.
  { id: "search", keys: ["/"], contexts: MAIL,
    group: "Finding", label: "Search" },

  // The rail by number, and nothing to remember: hold Ctrl and every row says
  // which digit opens it. This replaced `g i` / `g s` / `g u` / `g t`, which
  // were two problems in one row — a chord nobody recalls under pressure, and
  // Qt's own 400ms deadline on an unfinished sequence, so half of them did
  // nothing and said nothing about why. A modifier has no deadline.
  //
  // One row, nine sequences: `slotFor` reads which one fired off this row's
  // own key list, so the `Ctrl+` prefix is not written down a second time.
  // Nine and not ten, because `Ctrl+0` is reset zoom in every browser and
  // stays that here; a tenth row on the rail would have taken it.
  { id: "goMailbox",
    keys: ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5",
      "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9"],
    contexts: MAIL, group: "Going", label: "Go to that mailbox",
    display: "Ctrl+1…9" },

  // Accounts are surfaces rather than destinations inside the current one, so
  // they use Alt and the same visible order as the account switcher.
  { id: "goAccount",
    keys: ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5",
      "Alt+6", "Alt+7", "Alt+8", "Alt+9", "Alt+0"],
    contexts: ["list", "reader", "calendar"], group: "Going",
    label: "Go to that email account", display: "Alt+1…0" },

  // One key, not nine, and modified rather than bare. Switching mailboxes is
  // not frequent enough to spend a letter on — the bare ones are the scarce
  // thing here — and not a chord either, because it opens a list the keyboard
  // then walks — or types into: letters narrow it, the arrows move, `Enter`
  // takes one.
  { id: "switchAccount", keys: ["Alt+A"], contexts: MAIL,
    group: "Going", label: "Switch account" },
  // The message agent, on the cursor row. A popup, so the same shape as the
  // account switcher: opened through the table, then answering its own keys.
  { id: "askAgent", keys: ["Alt+G"], contexts: ["list", "reader", "compose"],
    group: "Acting", label: "Ask AI about the message or draft" },
  { id: "assistantSend", keys: ["Return", "Enter", "Ctrl+Return", "Ctrl+Enter"], contexts: ["assistant", "assistantCommands"],
    sequenceContexts: { "Return": ["assistant"], "Enter": ["assistant"] },
    group: "AI", label: "Send the AI message" },
  { id: "assistantCommandUp", keys: ["Up"], contexts: ["assistantCommands"],
    group: "AI", label: "Previous AI command" },
  { id: "assistantCommandDown", keys: ["Down"], contexts: ["assistantCommands"],
    group: "AI", label: "Next AI command" },
  { id: "assistantChooseCommand", keys: ["Return", "Enter"], contexts: ["assistantCommands"],
    group: "AI", label: "Fill the selected AI command" },

  { id: "calendar", keys: ["Alt+C"], contexts: ["list", "reader", "calendar"],
    group: "Going", label: "Switch between mail and calendar" },
  { id: "mailView", keys: ["Ctrl+Shift+M"], contexts: ["list", "reader", "calendar"],
    group: "Going", label: "Go to mail" },
  { id: "calendarView", keys: ["Ctrl+Shift+C"], contexts: ["list", "reader", "calendar"],
    group: "Going", label: "Go to calendar" },
  { id: "toggleSidebar", keys: ["["], contexts: ["list", "reader", "calendar"],
    group: "Going", label: "Show or hide the sidebar" },

  // Only where there is a message body to size. These carried no context at
  // all, which left them live on a settings form.
  { id: "zoomIn", keys: ["Ctrl++", "Ctrl+="], contexts: ["reader"],
    group: "Reading", label: "Zoom the message body in" },
  { id: "zoomOut", keys: ["Ctrl+-"], contexts: ["reader"],
    group: "Reading", label: "Zoom the message body out" },
  { id: "zoomReset", keys: ["Ctrl+0"], contexts: ["reader"],
    group: "Reading", label: "Reset the zoom" },

  { id: "refresh", keys: ["F5", "Ctrl+R"], contexts: ANY,
    group: "Mailbox", label: "Check for mail" },
  { id: "settings", keys: ["Ctrl+,"], contexts: ANY,
    group: "Mailbox", label: "Open settings" },
  // A question mark asks for the key reference while the keyboard belongs to
  // mail. Text-entry contexts keep it as text instead.
  { id: "help", keys: ["?"], contexts: MAIL,
    survivesOverlay: true,
    group: "Mailbox", label: "Toggle all keybindings" },
  { id: "back", keys: ["Escape"], contexts: ANY,
    survivesOverlay: true,
    group: "Mailbox", label: "Back, or close the window",
    hint: { reader: "back", page: "back", compose: "close", search: "leave" } }
]

// A pending send is a transient action over the screen, not a screen of its
// own. It does not replace this context, so mailbox navigation stays live while
// the toast offers Alt+Z and its button.
function contextFor(state) {
  var value = state || ({})
  if (value.assistantEditing) return value.assistantCommands ? "assistantCommands" : "assistant"
  if (value.showPage) return "page"
  if (value.composing) return "compose"
  if (value.searchFocused) return "search"
  if (value.calendarVisible) return "calendar"
  if (value.currentView === "reader") return "reader"
  return "list"
}

function byId(id) {
  for (var i = 0; i < BINDINGS.length; i++) {
    if (BINDINGS[i].id === id) return BINDINGS[i]
  }
  return null
}

// ------------------------------------------------------------ user overrides
//
// The one part of this table that is data at runtime and not only at authoring
// time. The rows were always data and nothing consumed a second copy of them,
// so an override is a filter in front of one accessor — `effectiveKeys` — and
// not a merge that every reader would have to learn. App.qml fills OVERRIDES
// from ~/.config/omamail/keybindings.json when the window opens and rewrites
// that file when the Keyboard section of Settings changes one.
//
// `keys/Keymap.js` stays the source of the defaults: an override is dropped
// the moment it equals the row's own keys, so a reset is the absence of an
// entry rather than a copy of the default sitting on top of it.
var OVERRIDES = ({})

// Not the user's to move. `back` is Escape — the only key bound in every
// context and the way out of every one of them. The two digit rails are ranges
// the sheet renders by holding a modifier rather than single keys, so there is
// nothing a capture field could record against them. Everything else that is
// off limits is off limits because it lives in a text-entry context, which the
// contexts check below decides rather than a list.
var STRUCTURAL = ["back", "goMailbox", "goAccount"]

// A binding is the user's to rebind when it is not structural and does not live
// in a text-entry context. A text-entry context binds no bare key but Escape,
// so a rebind there would have to carry a modifier and mean something Qt hands
// the field first anyway — the same reason the table never put a bare key in
// one. Keeping the rule as "which contexts" rather than a second locked list
// means a row that gains a text context stops being rebindable on its own.
//
// The AI dock is two of those contexts. The table does put bare keys there —
// Return sends, Up and Down walk the command list — but they are reachable
// only through `KeyRouter.routeKeyEvent`, which decodes those four keys and
// nothing else, so a row moved onto any other key there would report success
// and then never fire.
function isRebindable(binding) {
  if (!binding) return false
  if (STRUCTURAL.indexOf(binding.id) >= 0) return false
  var contexts = binding.contexts || []
  for (var i = 0; i < contexts.length; i++) {
    var context = contexts[i]
    if (context === "*" || context === "search" || context === "compose"
        || context === "page" || context === "assistant"
        || context === "assistantCommands") return false
  }
  return true
}

// The rows a Keyboard settings section offers, in table order.
function rebindable() {
  var out = []
  for (var i = 0; i < BINDINGS.length; i++)
    if (isRebindable(BINDINGS[i])) out.push(BINDINGS[i])
  return out
}

function sameKeys(a, b) {
  if (a.length !== b.length) return false
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Qt parses "J" and "j" as the same key, and it parses "Ctrl+Meta+A" and
// "Meta+Ctrl+A" as the same chord, so a keybindings.json written by hand
// could hold one while the table holds the other — and that is not a collision
// `conflicts()` can see, it is two Shortcuts on one sequence, which Qt calls
// ambiguous and answers by firing neither. Spelled the way `keys/Capture.js`
// records a press, so a captured key is already in this form: a bare letter
// lower-case, a modified one upper. Everything else is left alone.
var MODIFIER_ORDER = ["Ctrl", "Alt", "Meta", "Shift"]

function normalizeKey(key) {
  var at = key.lastIndexOf("+")
  var base = at < 0 ? key : key.substring(at + 1)
  var mods = []
  if (at >= 0) {
    var given = key.substring(0, at).split("+")
    for (var i = 0; i < MODIFIER_ORDER.length; i++)
      for (var j = 0; j < given.length; j++)
        if (given[j].toLowerCase() === MODIFIER_ORDER[i].toLowerCase()) {
          mods.push(MODIFIER_ORDER[i])
          break
        }
    // A prefix this does not recognise is left exactly as it was: better a
    // key that does not work than one silently rewritten into another.
    if (mods.length !== given.length) mods = given
  }
  var prefix = mods.length > 0 ? mods.join("+") + "+" : ""
  if (!(/^[A-Za-z]$/).test(base)) return prefix + base
  return prefix === "" ? base.toLowerCase() : prefix + base.toUpperCase()
}

function cleanKeyList(keys) {
  var out = []
  var seen = ({})
  var list = Array.isArray(keys) ? keys : []
  for (var i = 0; i < list.length; i++) {
    var key = normalizeKey(String(list[i] || ""))
    // Case-insensitively, because Qt is: `back` is the only way out of every
    // context and an "escape" that got in by hand would make it ambiguous.
    if (key === "" || key.toLowerCase() === "escape" || seen[key]) continue
    seen[key] = true
    out.push(key)
  }
  return out
}

// The keys a row answers to now: its override when one is set, otherwise the
// keys the table declares. Everything that lists, draws, or fires a binding
// reads this rather than `.keys`, so an override reaches the router, the help
// sheet and the status hints together.
function effectiveKeys(binding) {
  if (!binding) return []
  var over = OVERRIDES[binding.id]
  if (over && over.length > 0) return over
  return binding.keys || []
}

function isOverridden(id) {
  return !!OVERRIDES[id] && OVERRIDES[id].length > 0
}

// Set or clear one row's override. An empty list, or one equal to the row's
// own keys, clears it. Call `checkBinding` first — this does not re-validate.
function applyOverride(id, keys) {
  var row = byId(id)
  if (!row || !isRebindable(row)) return
  var clean = cleanKeyList(keys)
  if (clean.length === 0 || sameKeys(clean, row.keys || [])) delete OVERRIDES[id]
  else OVERRIDES[id] = clean
}

// Replace the whole set, from a parsed keybindings.json. Silently drops an
// entry naming an unknown, structural, or text-context id, or carrying no
// usable key — a file a later version wrote, or one edited by hand, cannot
// break the keyboard by being loaded.
function setOverrides(map) {
  OVERRIDES = ({})
  if (!map || typeof map !== "object") return
  for (var id in map) {
    var row = byId(id)
    if (!row || !isRebindable(row)) continue
    var clean = cleanKeyList(map[id])
    if (clean.length > 0 && !sameKeys(clean, row.keys || [])) OVERRIDES[id] = clean
  }
}

function resetAll() {
  OVERRIDES = ({})
}

// id -> keys, only the rows that actually carry an override.
function overrideSet() {
  var out = ({})
  for (var id in OVERRIDES) out[id] = OVERRIDES[id].slice()
  return out
}

// The keybindings.json body. `version` is here so a future format change has
// something to switch on rather than guessing from shape.
function serializeOverrides() {
  return JSON.stringify({ version: 1, bindings: overrideSet() })
}

// The overrides in a keybindings.json string, or {} for anything unreadable.
// `setOverrides` still sanitises what this returns, so a malformed entry that
// parses as JSON is handled the same as one that does not.
function parseOverrides(raw) {
  var text = String(raw || "")
  if (text === "") return ({})
  var data
  try { data = JSON.parse(text) } catch (error) { return ({}) }
  if (!data || typeof data !== "object") return ({})
  if (!data.bindings || typeof data.bindings !== "object") return ({})
  return data.bindings
}

// Whether `id` may answer to exactly `keys`, asked one edit ahead of the
// table. Returns "" when it may, or a sentence naming what stops it. The
// collision half runs the same `conflicts()` scan the table already trusts —
// applied tentatively, read back, reverted — rather than a second copy of the
// context-overlap logic.
// `app/qml/Main.qml` declares StandardKey.Close as an application shortcut,
// and `KeyRouter`'s delegates are deliberately window-scoped so a mailbox key
// can never tie with it. An override is the one way a key could land on it
// anyway, and Qt answers a tie by firing neither — so the rebind would take
// the standalone window's Close with it.
var RESERVED = ["Ctrl+W", "Ctrl+F4"]

function checkBinding(id, keys) {
  var row = byId(id)
  if (!row) return "That action does not exist"
  if (!isRebindable(row)) return "This action's keys are fixed"
  var clean = cleanKeyList(keys)
  if (clean.length === 0) return "Press a key to bind it"
  for (var r = 0; r < clean.length; r++)
    if (RESERVED.indexOf(clean[r]) >= 0)
      return readableSequence(clean[r]) + " closes the window"

  var had = OVERRIDES.hasOwnProperty(id)
  var saved = OVERRIDES[id]
  OVERRIDES[id] = clean
  var clash = ""
  var list = conflicts()
  for (var i = 0; i < list.length && clash === ""; i++) {
    if (list[i].ids.indexOf(id) < 0) continue
    var otherId = list[i].ids[0] === id ? list[i].ids[1] : list[i].ids[0]
    var other = byId(otherId)
    var where = list[i].context === "list" || list[i].context === "reader"
      ? "the mailbox" : "the " + list[i].context
    var named = clean.length === 1 ? readableSequence(clean[0]) : "That key"
    clash = named + " is already "
      + (other ? other.label.toLowerCase() : otherId) + " in " + where
  }
  if (had) OVERRIDES[id] = saved
  else delete OVERRIDES[id]
  return clash
}

// Which of a row's keys fired, as a zero-based position in the row's own list.
// Derived rather than parsed: `Ctrl+3` is the third entry because the table
// says so, and changing the modifier would need nothing here.
function slotFor(id, sequence) {
  var row = byId(id)
  var keys = row ? effectiveKeys(row) : []
  return keys.indexOf(String(sequence || ""))
}

function matchesContext(binding, context) {
  if (!binding) return false
  var contexts = binding.contexts || []
  for (var i = 0; i < contexts.length; i++) {
    if (contexts[i] === "*" || contexts[i] === context) return true
  }
  return false
}

function matchesSequenceContext(binding, sequence, context) {
  if (!binding) return false
  var overrides = binding.sequenceContexts || ({})
  var contexts = overrides[String(sequence || "")] || binding.contexts || []
  for (var i = 0; i < contexts.length; i++) {
    if (contexts[i] === "*" || contexts[i] === context) return true
  }
  return false
}

// Context decides what is live, and nothing else does. There is no "are they
// typing" question left to get wrong: a text-entry context binds no bare keys,
// and Qt hands a focused field its keys before any Shortcut sees them.
function isEnabled(binding, context, overlay) {
  if (!matchesContext(binding, context)) return false
  if (overlay && !binding.survivesOverlay) return false
  return true
}

function isSequenceEnabled(binding, sequence, context, overlay) {
  if (!matchesSequenceContext(binding, sequence, context)) return false
  if (overlay && !binding.survivesOverlay) return false
  return true
}

function bindingsFor(context) {
  var out = []
  for (var i = 0; i < BINDINGS.length; i++) {
    if (matchesContext(BINDINGS[i], context)) out.push(BINDINGS[i])
  }
  return out
}

// One entry per sequence rather than per row, because that is the shape a
// Shortcut needs: each sequence is its own object, and each decides its own
// `enabled` — each sequence still carries the context that owns it.
function sequencesFor(context) {
  var out = []
  var rows = BINDINGS
  for (var i = 0; i < rows.length; i++) {
    var keys = effectiveKeys(rows[i])
    for (var k = 0; k < keys.length; k++) {
      if (matchesSequenceContext(rows[i], keys[k], context))
        out.push(({ id: rows[i].id, sequence: keys[k], binding: rows[i] }))
    }
  }
  return out
}

// Qt's sequence syntax is not the UI's. A chord is written "g,i" and read "g
// then i"; Escape and Return are named for the keycaps people look at. Written
// as rules rather than per-row overrides, so a chord added later reads properly
// without anyone remembering to spell it out.
function readableSequence(sequence) {
  var text = String(sequence || "")
  if (text.charAt(text.length - 1) === ",") return text
  if (text.indexOf(",") > 0) return text.split(",").join(" then ")
  text = text.replace("Return", "Enter")
  if (text === "Escape") return "Esc"
  return text
}

// How a row reads on the help sheet, which enumerates: every key that works is
// named, separated so a slash inside a sequence is not mistaken for the
// separator.
function displayFor(binding) {
  if (!binding) return ""
  // A row of ten keys reads as a range. Enumerating them would be ten lines of
  // sheet for one idea.
  if (binding.display) return binding.display
  var keys = effectiveKeys(binding)
  var out = []
  // Return and the numpad's Enter are two keys with one keycap name; the
  // sheet names the keycap once.
  for (var i = 0; i < keys.length; i++) {
    var readable = readableSequence(keys[i])
    if (out.indexOf(readable) < 0) out.push(readable)
  }
  return out.join(", ")
}

// How a row reads on the status bar, which is a hint rather than a reference:
// one short form, and sometimes one line standing for a pair, as "j / k" does
// for moving. These are two different jobs, and one field could not do both —
// enumerating gave the sheet "j / k  Move down", which is not true of either.
function hintKeyFor(binding) {
  if (!binding) return ""
  // The hand-written short form ("j / k") is only right while the keys it
  // names are still where it says. That is two rows for a pair — "j / k" is
  // Move down's hint and half of it is Move up's key — so a rebind of either
  // side drops it and the row falls through to its enumerated keys.
  if (binding.hintKey && !isOverridden(binding.id)
      && !(binding.hintWith && isOverridden(binding.hintWith)))
    return binding.hintKey
  return displayFor(binding)
}

// Keycaps are presentation; Qt's case-sensitive sequence names stay intact.
function keycapLabel(text) {
  return String(text || "").toLowerCase()
}

function hintTextFor(binding, context) {
  var hint = binding ? binding.hint : null
  if (!hint) return ""
  if (typeof hint === "string") return hint
  return hint[context] || ""
}

// Grouped in the order the groups first appear in the table, so the sheet's
// shape is a property of the table rather than a second list to maintain.
function helpGroups(hidden) {
  var groups = []
  var byName = ({})
  var omitted = Array.isArray(hidden) ? hidden : []
  for (var i = 0; i < BINDINGS.length; i++) {
    var binding = BINDINGS[i]
    if (omitted.indexOf(binding.id) >= 0) continue
    if (!byName[binding.group]) {
      byName[binding.group] = ({ name: binding.group, rows: [] })
      groups.push(byName[binding.group])
    }
    byName[binding.group].rows.push(({
      keys: displayFor(binding),
      action: binding.label
    }))
  }
  return groups
}

// What the status bar offers from where the user is standing.
//
// `unavailable` is the ids the active provider cannot honour — a mailbox with
// no archive, star, or named destination should not offer those actions in the
// row that says what the keyboard does here. The table itself stays whole:
// what a key means is a property of the application, and only whether it is on
// offer depends on which mailbox is open. `hasSelection` makes the few hints
// that act on a particular row contextual without changing their bindings.
function hintsFor(context, unavailable, hasSelection) {
  var out = []
  var rows = bindingsFor(context)
  var missing = Array.isArray(unavailable) ? unavailable : []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].hintNeedsSelection && hasSelection !== true) continue
    var unavailableId = rows[i].hintUnavailableId || rows[i].id
    if (missing.indexOf(unavailableId) >= 0) continue
    var text = hintTextFor(rows[i], context)
    if (text !== "") out.push(({ key: hintKeyFor(rows[i]), label: text }))
  }
  return out
}

// A heading costs a line as surely as a row does, so it counts as one.
// Balancing on rows alone put the small groups together and left the last
// column visibly short of the others.
function helpWeight(group) {
  return (group && Array.isArray(group.rows) ? group.rows.length : 0) + 1
}

// The help groups laid out in `count` columns.
//
// The sheet was one narrow column, which was taller than a short window — so it
// scrolled, and its scrollbar rode the edge of that column rather than the edge
// of the sheet, which put a scrollbar down the middle of the screen. Wide and
// short is the shape a reference sheet wants, and at two or three columns it
// usually does not scroll at all.
//
// Split in order rather than packed by size: a reader who knows the sheet finds
// a group where it has always been, and "smallest column so far" moves them
// about every time a binding is added.
function helpColumns(count, hidden) {
  var groups = helpGroups(hidden)
  var columns = Math.max(1, Math.min(groups.length, Math.floor(Number(count)) || 1))
  var out = []
  for (var c = 0; c < columns; c++) out.push([])
  if (columns === 1) {
    out[0] = groups
    return out
  }

  var total = 0
  for (var i = 0; i < groups.length; i++) total += helpWeight(groups[i])
  var at = 0
  var used = 0
  var placed = 0
  for (var g = 0; g < groups.length; g++) {
    // Groups still to place, and columns still open, this one included in both.
    var left = groups.length - g
    var free = columns - at
    var target = (total - placed) / free
    var nextWeight = helpWeight(groups[g])
    // Start the next column when adding this whole group would move farther
    // from the remaining share. A group never splits across columns.
    if (at < columns - 1 && out[at].length > 0
        && (left <= free - 1
          || Math.abs(used - target) <= Math.abs(used + nextWeight - target))) {
      placed += used
      at++
      used = 0
    }
    out[at].push(groups[g])
    used += helpWeight(groups[g])
  }
  return out
}

// Two bindings claiming one sequence in one context is a bug the table can find
// by itself. Sequences compare whole, so `s` and `g,s` are different keys
// rather than a collision.
function conflicts() {
  var found = []
  for (var c = 0; c < CONTEXTS.length; c++) {
    var seen = ({})
    var rows = sequencesFor(CONTEXTS[c])
    for (var i = 0; i < rows.length; i++) {
      if (seen[rows[i].sequence]) {
          found.push(({ context: CONTEXTS[c], keys: rows[i].sequence,
            ids: [seen[rows[i].sequence], rows[i].id] }))
        } else {
          seen[rows[i].sequence] = rows[i].id
        }
    }
  }
  return found
}

function conflictSide(id) {
  var row = byId(id)
  return ({ id: id, label: row ? row.label : id, overridden: isOverridden(id) })
}

// The live collisions, phrased for the Keyboard settings section: which key,
// where, and the two actions fighting over it.
//
// `checkBinding` keeps the capture flow from making one, but a Reset back to a
// default whose key another binding has since been moved onto — or a
// hand-edited keybindings.json — still can, and nothing was scanning for it
// afterwards. The section reads this rather than trusting every path to have
// asked `checkBinding` first, and offers to back one side out.
function conflictReport() {
  var out = []
  var seen = ({})
  var list = conflicts()
  for (var i = 0; i < list.length; i++) {
    var where = list[i].context === "list" || list[i].context === "reader"
      ? "the mailbox" : "the " + list[i].context
    var ordered = list[i].ids.slice().sort()
    // The same pair on the same key in both list and reader is one clash to a
    // reader who sees "the mailbox" for either.
    // "\u0000" rather than a literal NUL: a separator no key, context or id
    // can contain, without making this file binary to grep and the source
    // checks.
    var tag = list[i].keys + "\u0000" + where + "\u0000" + ordered.join(",")
    if (seen[tag]) continue
    seen[tag] = true
    out.push(({
      key: readableSequence(list[i].keys),
      where: where,
      actions: [conflictSide(list[i].ids[0]), conflictSide(list[i].ids[1])]
    }))
  }
  return out
}
