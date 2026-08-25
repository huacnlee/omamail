.pragma library

// What a JMAP mailbox is, as far as the panel is concerned.
//
// The protocol and response shaping live in `JmapApi.js`; authenticated
// transport lives in `JmapClient.qml`. This descriptor keeps only the provider
// decisions the registry asks for.

var ID = "jmap"
var NAME = "Fastmail"
var SUMMARY = "Fastmail's own API, using a mail-scoped API token."

// The existing password setup seam means "a secret typed into a form and kept
// in the keyring". The JMAP page names that secret accurately as an API token.
var AUTH = "password"

// The public id remains the protocol name so account and keyring ids stay
// stable. The person adding one chooses Fastmail, so the chooser gets the
// service's own mark and name rather than the transport underneath it.
var MARK = "fastmail.png"

// This first contribution is deliberately a reader. Labels are narrowed from
// the session's maxMailboxesPerEmail value; every mutation stays undeclared
// and unimplemented until its own follow-up.
var CAPABILITIES = {
  // A ceiling only: the session decides whether more than one mailbox may be
  // assigned to an Email.
  labels: true,
  // A server id alone is not conversation UI. Omamail remains message-shaped.
  threads: false,
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

function webHomeUrl() {
  return "https://app.fastmail.com"
}
