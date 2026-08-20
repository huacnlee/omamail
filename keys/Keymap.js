.pragma library

// Every key this window answers to, in one table.
//
// Three descriptions of this list used to exist — the Shortcut declarations in
// App.qml, the help sheet, and the status-bar hints — and they had already
// drifted: the sheet listed Esc twice, was missing `u` and `?`, and carried a
// mouse gesture among the keys. Anything that shows or fires a binding now
// reads this file, so there is nothing left to keep in step by hand.

// The window is in exactly one of these at a time, resolved by precedence in
// App.qml: a page beats composing, composing beats the reader, the reader beats
// the list.
var CONTEXTS = ["list", "reader", "compose", "page"]

// Shorthands, so a row says where it lives rather than restating the set.
var MAIL = ["list", "reader"]
var ANY = ["*"]

var BINDINGS = [
  { id: "cursorDown", keys: ["j", "Down"], contexts: MAIL,
    group: "Moving", label: "Move down",
    display: "j / k", hint: { list: "move" } },
  { id: "cursorUp", keys: ["k", "Up"], contexts: MAIL,
    group: "Moving", label: "Move up" },
  { id: "open", keys: ["Return", "o"], contexts: ["list"],
    group: "Moving", label: "Open the selected message",
    hint: { list: "open" } },
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

  { id: "reply", keys: ["r"], contexts: ["reader"],
    group: "Writing", label: "Reply", hint: { reader: "reply" } },
  { id: "replyAll", keys: ["a"], contexts: ["reader"],
    group: "Writing", label: "Reply to all" },
  { id: "forward", keys: ["f"], contexts: ["reader"],
    group: "Writing", label: "Forward" },
  { id: "compose", keys: ["c"], contexts: MAIL,
    group: "Writing", label: "Compose", hint: { list: "compose" } },
  { id: "send", keys: ["Ctrl+Return"], contexts: ["compose"],
    group: "Writing", label: "Send", hint: { compose: "send" } },

  // One row holding both, because suppression is decided per key: `/` stands
  // down inside a text field and Ctrl+K, whose whole point is reaching search
  // from inside one, does not.
  { id: "search", keys: ["/", "Ctrl+K"], contexts: ANY,
    group: "Finding", label: "Search" },

  { id: "goInbox", keys: ["g,i"], contexts: MAIL,
    group: "Going", label: "Go to the inbox" },
  { id: "goStarred", keys: ["g,s"], contexts: MAIL,
    group: "Going", label: "Go to starred" },
  { id: "goUnread", keys: ["g,u"], contexts: MAIL,
    group: "Going", label: "Go to unread" },
  { id: "goSent", keys: ["g,t"], contexts: MAIL,
    group: "Going", label: "Go to sent" },

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
  { id: "help", keys: ["?", "Ctrl+/", "Ctrl+?"], contexts: ANY,
    survivesOverlay: true,
    group: "Mailbox", label: "Toggle this sheet" },
  { id: "back", keys: ["Escape"], contexts: ANY,
    survivesTyping: true, survivesOverlay: true,
    group: "Mailbox", label: "Back, or close the window",
    hint: { reader: "back", page: "back", compose: "close" } }
]

// A sequence is bare when typing it into a text field is a thing a person would
// do. Shift is not a modifier for this purpose: Shift+I is simply how a capital
// I is typed. Ctrl, Alt and Meta are unreachable that way, and so are the
// function keys.
function isBareSequence(sequence) {
  var text = String(sequence || "")
  if (text.indexOf("Ctrl+") >= 0) return false
  if (text.indexOf("Alt+") >= 0) return false
  if (text.indexOf("Meta+") >= 0) return false
  if (/^F[0-9]+$/.test(text)) return false
  return true
}

// Derived, never declared. A new binding cannot forget its typing guard,
// because there is no guard to write — which is the whole point, since the
// hand-written guard is what missed nine text fields.
//
// Decided per key rather than per row, so one row can hold `/` and Ctrl+K and
// have each behave as its own shape demands.
function suppressedByTyping(binding, sequence) {
  if (!binding) return false
  if (binding.survivesTyping) return false
  return isBareSequence(sequence)
}

function matchesContext(binding, context) {
  if (!binding) return false
  var contexts = binding.contexts || []
  for (var i = 0; i < contexts.length; i++) {
    if (contexts[i] === "*" || contexts[i] === context) return true
  }
  return false
}

function isEnabled(binding, sequence, context, typing, overlay) {
  if (!matchesContext(binding, context)) return false
  if (overlay && !binding.survivesOverlay) return false
  if (typing && suppressedByTyping(binding, sequence)) return false
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

// How a row reads. Usually its own keys; `display` overrides it where one line
// stands for a pair, as "j / k" does for moving.
function displayFor(binding) {
  if (!binding) return ""
  if (binding.display) return binding.display
  return (binding.keys || []).join(" / ")
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
    if (text !== "") out.push(({ key: displayFor(rows[i]), label: text }))
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
