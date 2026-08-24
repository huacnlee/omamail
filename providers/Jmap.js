.pragma library

// What a JMAP mailbox is, as far as the panel is concerned.
//
// The protocol and response shaping live in `JmapApi.js`; authenticated
// transport lives in `JmapClient.qml`. This descriptor keeps only the provider
// decisions the registry asks for.

var ID = "jmap"
var NAME = "JMAP"
var SUMMARY = "Fastmail over JMAP, using a mail-scoped API token."

// The existing password setup seam means "a secret typed into a form and kept
// in the keyring". The JMAP page names that secret accurately as an API token.
var AUTH = "password"

// These are ceilings. Mutation support exists behind the provider boundary,
// but stays undeclared until it has been demonstrated with a write-scoped test
// account. The current live account is deliberately read-only, and a button is
// a promise this repository does not make on fixture coverage alone.
var CAPABILITIES = {
  labels: true,
  threads: true,
  archive: false,
  // Moving to a mailbox with the junk role does not prove the server trained
  // its filter, so it is not offered as "Report spam".
  spam: false,
  star: false,
  batch: false,
  // A protocol does not imply a particular vendor's web URL.
  web: false,
  webBox: false,
  search: true,
  // EmailSubmission is deliberately a follow-up.
  send: false
}

// An opaque, deliberately small DSL read only by `JmapApi.filterForQuery`.
// Roles are resolved from Mailbox/get; no server's mailbox ids or names are
// guessed here.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "role:inbox" },
  { key: "unread", label: "Unread", icon: "unread", query: "role:inbox unread" },
  { key: "starred", label: "Flagged", icon: "star", query: "keyword:$flagged" },
  { key: "sent", label: "Sent", icon: "send", query: "role:sent" },
  { key: "archive", label: "Archive", icon: "archive", query: "role:archive", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "role:trash", optional: true }
]

function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "text:" + JSON.stringify(value)
}

// JMAP addresses a mailbox by id. The sidebar keeps the human name for display
// and carries this id as rawName, just as HEY carries its label id.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "mailbox:" + JSON.stringify(value)
}
