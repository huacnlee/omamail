.pragma library

.import "ImapProtocol.js" as Protocol

// What an IMAP mailbox is, as far as the panel is concerned.
//
// The protocol itself is `ImapProtocol.js` and the transport is
// `ImapClient.qml`. This file answers the same four questions `Registry.js`
// asks of every provider, and the answers differ from Gmail's in ways the
// panel has to respect rather than paper over.

var ID = "imap"
var NAME = "IMAP"
var SUMMARY = "Any standard mailbox — Fastmail, iCloud, Outlook, Zoho, your own server."
var AUTH = "password"

var CAPABILITIES = {
  // No labels: a message is in one folder. The reader hides the label strip
  // rather than showing an empty one.
  labels: false,
  // No server-side conversation id. Threading falls back to References, which
  // is what every other IMAP client does.
  threads: false,
  // Only if the server has somewhere to put it, which the client decides per
  // account from what LIST reported; this is the ceiling, not the guarantee.
  archive: true,
  // Deliberately off. IMAP can move a message to a Junk folder, but that
  // teaches the server nothing, and a "Report spam" button that quietly means
  // "move to a folder" is a promise the provider cannot keep.
  spam: false,
  star: true,
  batch: true,
  search: true,
  send: true,
  // No web UI this plugin could know the address of.
  web: false
}

// Folders, not queries. The `folder:` DSL is read by `ImapProtocol.parseQuery`
// and by nothing else — everywhere above, these strings are opaque, handed
// back to the client that produced them and used as a cache key.
//
// The names here are fallbacks. A server that advertises SPECIAL-USE (RFC 6154)
// names its own Sent, Trash and Archive, and `ImapProtocol.resolveFolder`
// replaces the placeholder with whatever the server actually said.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "folder:INBOX" },
  { key: "unread", label: "Unread", icon: "unread", query: "folder:INBOX UNSEEN" },
  { key: "starred", label: "Flagged", icon: "star", query: "folder:INBOX FLAGGED" },
  { key: "sent", label: "Sent", icon: "send", query: "folder:\\Sent" },
  { key: "drafts", label: "Drafts", icon: "compose", query: "folder:\\Drafts" },
  { key: "archive", label: "Archive", icon: "archive", query: "folder:\\Archive", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "folder:\\Trash", optional: true }
]

// IMAP SEARCH has no free-text operator that means what a user means by typing
// words into a search box, so the text becomes a TEXT criterion — headers and
// body, the closest standard equivalent. JSON.stringify is used for the quoting
// because it escapes exactly the two characters IMAP escapes.
function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "folder:INBOX TEXT " + JSON.stringify(value)
}

// Standard IMAP SEARCH has one selected folder. A typed search selects INBOX,
// so a cached Sent, Trash or user-folder row cannot be an early result however
// well its subject happens to match.
function cachedSummaryInSearch(sourceQuery, summary) {
  return Protocol.parseQuery(sourceQuery).folder.toUpperCase() === "INBOX"
}

// Selecting a folder in the sidebar. This cannot go through `searchQuery`: a
// folder wrapped in a TEXT search would look for the folder's own name inside
// the inbox rather than opening it.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "folder:" + JSON.stringify(value)
}
