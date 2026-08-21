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
var CONTEXTS = ["list", "reader", "search", "compose", "page"]

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
    group: "Writing", label: "Compose", hint: { list: "compose" } },
  { id: "send", keys: ["Ctrl+Return"], contexts: ["compose"],
    group: "Writing", label: "Send", hint: { compose: "send" } },

  // One row holding both, because suppression is decided per key: `/` stands
  // down inside a text field and Ctrl+K, whose whole point is reaching search
  // from inside one, does not.
  // Reachable from anywhere. `/` is a bare key, so it is only offered where
  // bare keys mean anything — inside the field it is a character being typed,
  // and Qt gives the field its keys before any Shortcut sees them.
  { id: "search", keys: ["/"], contexts: MAIL,
    group: "Finding", label: "Search" },
  { id: "searchAnywhere", keys: ["Ctrl+K"], contexts: ANY,
    group: "Finding", label: "Search from anywhere" },

  // The rail by number, and nothing to remember: hold Alt and every row says
  // which digit opens it. This replaced `g i` / `g s` / `g u` / `g t`, which
  // were two problems in one row — a chord nobody recalls under pressure, and
  // Qt's own 400ms deadline on an unfinished sequence, so half of them did
  // nothing and said nothing about why. A modifier has no deadline.
  //
  // One row, ten sequences: `slotFor` reads which one fired off this row's own
  // key list, so the `Alt+` prefix is not written down a second time.
  { id: "goMailbox",
    keys: ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5",
      "Alt+6", "Alt+7", "Alt+8", "Alt+9", "Alt+0"],
    contexts: MAIL, group: "Going", label: "Go to that mailbox",
    display: "Alt+1…0" },

  // One key, not nine, and modified rather than bare. Switching mailboxes is
  // not frequent enough to spend a letter on — the bare ones are the scarce
  // thing here — and not a chord either, because it opens a list the keyboard
  // then walks: `j`/`k` to move, `Enter` or `o` to take one.
  { id: "switchAccount", keys: ["Alt+A"], contexts: MAIL,
    group: "Going", label: "Switch account" },

  // Only where there is a message body to size. These carried no context at
  // all, which left them live on a settings form.
  { id: "zoomIn", keys: ["Ctrl++", "Ctrl+="], contexts: ["reader"],
    group: "Reading", label: "Zoom the message body in" },
  { id: "zoomOut", keys: ["Ctrl+-"], contexts: ["reader"],
    group: "Reading", label: "Zoom the message body out" },
  { id: "zoomReset", keys: ["Ctrl+0"], contexts: ["reader"],
    group: "Reading", label: "Reset the zoom" },

  { id: "refresh", keys: ["F5"], contexts: ANY,
    group: "Mailbox", label: "Check for mail" },
  // A mailbox action, not a global one: the sheet lists what the mailbox
  // answers to, and a draft or a form is neither. Esc first, then `?`.
  { id: "help", keys: ["?", "Ctrl+/", "Ctrl+?"], contexts: MAIL,
    survivesOverlay: true,
    group: "Mailbox", label: "Toggle this sheet" },
  { id: "back", keys: ["Escape"], contexts: ANY,
    survivesOverlay: true,
    group: "Mailbox", label: "Back, or close the window",
    hint: { reader: "back", page: "back", compose: "close", search: "leave" } }
]

function byId(id) {
  for (var i = 0; i < BINDINGS.length; i++) {
    if (BINDINGS[i].id === id) return BINDINGS[i]
  }
  return null
}

// Which of a row's keys fired, as a zero-based position in the row's own list.
// Derived rather than parsed: `Alt+3` is the fourth entry because the table
// says so, and changing the row to `Ctrl+1…0` would need nothing here.
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

// Context decides what is live, and nothing else does. There is no "are they
// typing" question left to get wrong: a text-entry context binds no bare keys,
// and Qt hands a focused field its keys before any Shortcut sees them.
function isEnabled(binding, context, overlay) {
  if (!matchesContext(binding, context)) return false
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
  var rows = bindingsFor(context)
  for (var i = 0; i < rows.length; i++) {
    var keys = rows[i].keys || []
    for (var k = 0; k < keys.length; k++) {
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
function hintsFor(context) {
  var out = []
  var rows = bindingsFor(context)
  for (var i = 0; i < rows.length; i++) {
    var text = hintTextFor(rows[i], context)
    if (text !== "") out.push(({ key: hintKeyFor(rows[i]), label: text }))
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
    var rows = bindingsFor(CONTEXTS[c])
    for (var i = 0; i < rows.length; i++) {
      var keys = rows[i].keys || []
      for (var k = 0; k < keys.length; k++) {
        if (seen[keys[k]]) {
          found.push(({ context: CONTEXTS[c], keys: keys[k],
            ids: [seen[keys[k]], rows[i].id] }))
        } else {
          seen[keys[k]] = rows[i].id
        }
      }
    }
  }
  return found
}
