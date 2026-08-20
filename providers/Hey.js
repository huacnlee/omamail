.pragma library

// HEY, as a provider with no client behind it *yet*.
//
// The file is the plan rather than an apology. Everything above routes through
// `Registry.js`, so the day there is an interface to talk to, HEY gains a
// `HeyClient.qml` and a real `CAPABILITIES` block, and nothing else changes.
//
// What is missing is that interface. 37signals publish no API, and no IMAP or
// POP either — the FAQ says "HEY doesn't support IMAP or POP" and that
// off-the-shelf apps will not work. The SMTP in their docs is HEY sending
// *through* someone else's server rather than a way in.
//
// The one surface that does exist is the private endpoint set app.hey.com
// talks to, reached by driving a session cookie. That is deliberately not used
// here: it would ask a user for their HEY password so it could be replayed
// against an interface carrying no compatibility promise, and it would break on
// a deploy nobody announced. Waiting for a supported interface is the
// difference between a provider that keeps working and one that fails silently
// on somebody else's release day.

var ID = "hey"
var NAME = "HEY"
var SUMMARY = "No public API yet, so not supported for now — ready to add when there is one."
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
var UNAVAILABLE = "HEY does not publish an API, and offers no IMAP or POP either, "
  + "so there is nothing for a mail client to sign in to yet. Support is planned "
  + "and the groundwork is here — it needs an interface from 37signals to "
  + "connect to. Until then, forwarding HEY to a mailbox you can reach over IMAP "
  + "is the way to read it here."

function searchQuery() {
  return ""
}

function labelQuery() {
  return ""
}
