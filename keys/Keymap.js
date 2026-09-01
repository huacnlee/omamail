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
var CONTEXTS = ["list", "reader", "search", "compose", "page", "calendar"]

// Shorthands, so a row says where it lives rather than restating the set.
var MAIL = ["list", "reader"]
var ANY = ["*"]

var BINDINGS = [
  // These two survive the shortcut sheet, and they are the only mailbox keys
  // that do: behind the sheet they scroll it. A reference sheet taller than the
  // window that could only be read with a mouse would be the one screen here
  // that contradicts the rest. The account switcher is not on this list — it is
  // a popup, and a popup takes every key before the shortcut map sees it, so it
  // answers `j`/`k` itself.
  { id: "cursorDown", keys: ["j", "Down"], contexts: MAIL,
    survivesOverlay: true,
    group: "Moving", label: "Move down",
    hintKey: "j / k", hint: { list: "move" } },
  { id: "cursorUp", keys: ["k", "Up"], contexts: MAIL,
    survivesOverlay: true,
    group: "Moving", label: "Move up" },
  // Live in the reader as well as the list. Moving is deliberately not opening
  // — stepping through with j used to mark half a mailbox read without anyone
  // looking at it — so with the reader up there has to be a key that says open,
  // or the only way to read the next message is to leave and come back.
  { id: "open", keys: ["Return", "o"], contexts: MAIL,
    group: "Moving", label: "Open the selected message",
    hintKey: "o", hint: { list: "open", reader: "open" } },
  { id: "backToList", keys: ["u"], contexts: ["reader"],
    group: "Moving", label: "Back to the list" },

  { id: "archive", keys: ["e"], contexts: MAIL,
    group: "Acting", label: "Archive",
    hint: { list: "archive", reader: "archive" } },
  { id: "trash", keys: ["d"], contexts: MAIL,
    group: "Acting", label: "Move to trash",
    hint: { reader: "trash" } },
  { id: "star", keys: ["s"], contexts: MAIL,
    group: "Acting", label: "Star or unstar" },
  { id: "markRead", keys: ["Shift+I"], contexts: MAIL,
    group: "Acting", label: "Mark read" },
  { id: "markUnread", keys: ["Shift+U"], contexts: MAIL,
    group: "Acting", label: "Mark unread" },

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
    hintKey: "j / k", hint: { calendar: "select" } },
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
  { id: "send", keys: ["Ctrl+Return"], contexts: ["compose"],
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
  // One row, ten sequences: `slotFor` reads which one fired off this row's own
  // key list, so the `Ctrl+` prefix is not written down a second time.
  { id: "goMailbox",
    keys: ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5",
      "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9", "Ctrl+0"],
    contexts: MAIL, group: "Going", label: "Go to that mailbox",
    display: "Ctrl+1…0" },

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
  // then walks: `j`/`k` to move, `Enter` or `o` to take one.
  { id: "switchAccount", keys: ["Alt+A"], contexts: MAIL,
    group: "Going", label: "Switch account" },

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
  { id: "zoomReset", keys: ["Ctrl+Shift+0"], contexts: ["reader"],
    group: "Reading", label: "Reset the zoom" },

  { id: "refresh", keys: ["F5"], contexts: ANY,
    group: "Mailbox", label: "Check for mail" },
  { id: "settings", keys: ["Ctrl+,"], contexts: ANY,
    group: "Mailbox", label: "Open settings" },
  // One action and one help row. The old keys remain mailbox-only. Ctrl+K
  // reaches the same action from fields, forms, drafts, and the calendar.
  { id: "help", keys: ["Ctrl+K", "?", "Ctrl+/", "Ctrl+?"], contexts: MAIL,
    sequenceContexts: { "Ctrl+K": ANY },
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

// Which of a row's keys fired, as a zero-based position in the row's own list.
// Derived rather than parsed: `Ctrl+3` is the third entry because the table
// says so, and changing the modifier would need nothing here.
function slotFor(id, sequence) {
  var row = byId(id)
  var keys = row ? row.keys || [] : []
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
// `enabled` — a row holding both `/` and Ctrl+K has them disagree while the
// user is typing.
function sequencesFor(context) {
  var out = []
  var rows = BINDINGS
  for (var i = 0; i < rows.length; i++) {
    var keys = rows[i].keys || []
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
  var keys = binding.keys || []
  var out = []
  for (var i = 0; i < keys.length; i++) out.push(readableSequence(keys[i]))
  return out.join(", ")
}

// How a row reads on the status bar, which is a hint rather than a reference:
// one short form, and sometimes one line standing for a pair, as "j / k" does
// for moving. These are two different jobs, and one field could not do both —
// enumerating gave the sheet "j / k  Move down", which is not true of either.
function hintKeyFor(binding) {
  if (!binding) return ""
  if (binding.hintKey) return binding.hintKey
  return displayFor(binding)
}

function hintTextFor(binding, context) {
  var hint = binding ? binding.hint : null
  if (!hint) return ""
  if (typeof hint === "string") return hint
  return hint[context] || ""
}

// Grouped in the order the groups first appear in the table, so the sheet's
// shape is a property of the table rather than a second list to maintain.
function helpGroups() {
  var groups = []
  var byName = ({})
  for (var i = 0; i < BINDINGS.length; i++) {
    var binding = BINDINGS[i]
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
// no archive and no star should not be offering `e` and `s` in the row that
// says what the keyboard does here. The table itself stays whole: what a key
// means is a property of the application, and only whether it is on offer
// depends on which mailbox is open.
function hintsFor(context, unavailable) {
  var out = []
  var rows = bindingsFor(context)
  var missing = Array.isArray(unavailable) ? unavailable : []
  for (var i = 0; i < rows.length; i++) {
    if (missing.indexOf(rows[i].id) >= 0) continue
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
function helpColumns(count) {
  var groups = helpGroups()
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
