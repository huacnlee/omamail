.pragma library

// HEY, as a provider with no client behind it *yet*.
//
// The file is the plan rather than an apology. Everything above routes through
// `Registry.js`, so the day there is an interface to talk to, HEY gains a
// `HeyClient.qml` and a real `CAPABILITIES` block, and nothing else changes.
//
// A HEY CLI is reportedly in development. Once it provides a supported way to
// reach the service, this provider seam is ready for a client behind it.

var ID = "hey"
var NAME = "HEY"
var SUMMARY = "A HEY CLI is reportedly in development — support can follow when it is ready."
var AUTH = "none"

// Everything off. `Registry.capabilities` reads a missing entry as "cannot",
// so an empty object would do the same thing; it is written out because this
// is the file somebody will edit when the answer changes.
var CAPABILITIES = {}

// HEY's own three, so the shape is on record. Nothing selects them today.
var MAILBOXES = [
  { key: "imbox", label: "Imbox", icon: "inbox", query: "" },
  { key: "feed", label: "The Feed", icon: "unread", query: "" },
  { key: "papertrail", label: "Paper Trail", icon: "archive", query: "" }
]

// What the setup page shows instead of a form, and what stops `MailAccount`
// from ever building a client that is not there.
var UNAVAILABLE = "A HEY CLI is reportedly in development. Once it is ready, "
  + "Omamail can add HEY support through this provider integration."

function searchQuery() {
  return ""
}

function labelQuery() {
  return ""
}
