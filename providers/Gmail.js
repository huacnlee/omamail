.pragma library

// What Gmail is, as far as the panel is concerned.
//
// Not how to talk to it — that is `GmailApi.js` for the strings and
// `GmailApiClient.qml` for the transport. This file answers the questions
// `Registry.js` asks of every provider: what mailboxes are there, what does a
// query mean, what can it be asked to do, and how does it sign in.

var ID = "gmail"
var NAME = "Gmail"

// One line, on the provider chooser. It has to say what the user is committing
// to — Gmail's is a Cloud project, which is the single most surprising thing
// about this plugin.
var SUMMARY = "Google's own API. Needs an OAuth client you create once."

var AUTH = "oauth"

var CAPABILITIES = {
  labels: true,
  threads: true,
  archive: true,
  spam: true,
  star: true,
  batch: true,
  web: true,
  search: true,
  send: true
}

// Search queries rather than label ids: `is:unread` and `in:anywhere` have no
// label to point at, and a query keeps every entry on the same footing.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "in:inbox" },
  // Scoped to Primary, not just to the inbox. Gmail's category tabs do not
  // remove the INBOX label, so "in:inbox is:unread" dredges up the whole
  // promotional backlog — measured against a real mailbox, that view came back
  // as newsletters and offers almost end to end.
  { key: "unread", label: "Unread", icon: "unread", query: "in:inbox is:unread category:primary" },
  { key: "starred", label: "Starred", icon: "star", query: "is:starred" },
  { key: "sent", label: "Sent", icon: "send", query: "in:sent" },
  // Optional: the first to go when the row cannot hold every mailbox. Neither
  // is somewhere anyone works from — they are places you go looking for
  // something specific, and search reaches both.
  { key: "all", label: "All mail", icon: "archive", query: "in:anywhere -in:spam -in:trash", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "in:trash", optional: true }
]

// Free text goes to Gmail verbatim: its search syntax is the one the user
// already knows from the web UI, and mangling it would be a downgrade.
function searchQuery(text) {
  return String(text === undefined || text === null ? "" : text).trim()
}

// Selecting a label in the sidebar. A Gmail label is a search operator, which
// is why this is a different string from the one a typed search produces.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "label:" + value
}
