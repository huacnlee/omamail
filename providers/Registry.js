.pragma library

.import "Gmail.js" as Gmail
.import "Imap.js" as Imap
.import "Hey.js" as Hey

// What kind of mail service an account is, and what the rest of the plugin may
// therefore ask of it.
//
// Each provider describes itself in a file of its own next door; this one is
// the abstraction over the three. Everything above it asks questions here and
// never branches on a provider id — that is the whole point of the seam.
//
// A provider answers four questions:
//
//   - what it is called, for the switcher and the setup page
//   - what it can do, because a panel must not offer a button the service
//     cannot honour
//   - what mailboxes it has, and what string selects each one
//   - how it signs in, which is the only part the user ever meets
//
// The query strings are opaque above this file. Gmail's are its own search
// operators; IMAP's are a small DSL that `ImapProtocol.js` translates. Anything
// upstream only passes one back down to the client that produced it, and uses
// it as a cache key.

// ------------------------------------------------------------- capabilities

// Named so a missing entry reads as "cannot", not as "unknown". A provider that
// forgets to declare something loses the button rather than showing one that
// fails when pressed.
function capabilities(values) {
  var raw = values || {}
  return {
    // Several labels on one message, rather than one folder holding it.
    labels: raw.labels === true,
    // A server-side conversation id.
    threads: raw.threads === true,
    // "Archive" means something.
    archive: raw.archive === true,
    // A junk verb the server acts on.
    spam: raw.spam === true,
    // \Flagged, or Gmail's STARRED.
    star: raw.star === true,
    // One round trip that changes many messages.
    batch: raw.batch === true,
    // A web UI worth opening a message in.
    web: raw.web === true,
    // Free-text search the server runs.
    search: raw.search === true,
    // Sends mail. A read-only provider still shows a reader; it just cannot
    // answer from it.
    send: raw.send === true
  }
}

// The shape the sidebar and the tab row already know how to draw: a key, a
// label, an icon, and an `optional` flag for the ones dropped when the row runs
// out of width. Filled in here so a provider file can be a plain list.
function mailbox(raw) {
  var entry = raw || {}
  return {
    key: String(entry.key || ""),
    label: String(entry.label || ""),
    icon: String(entry.icon || ""),
    query: String(entry.query || ""),
    optional: entry.optional === true
  }
}

// One provider, normalised. A definition file states only what is true of it;
// the defaults, and the rule that an undeclared capability is a "no", live here
// so they cannot drift between three files.
function define(source) {
  var raw = source || {}
  var boxes = []
  var list = Array.isArray(raw.MAILBOXES) ? raw.MAILBOXES : []
  for (var i = 0; i < list.length; i++) boxes.push(mailbox(list[i]))
  return {
    id: String(raw.ID || ""),
    name: String(raw.NAME || ""),
    summary: String(raw.SUMMARY || ""),
    auth: String(raw.AUTH || "none"),
    unavailable: String(raw.UNAVAILABLE || ""),
    capabilities: capabilities(raw.CAPABILITIES),
    mailboxes: boxes,
    searchQuery: typeof raw.searchQuery === "function" ? raw.searchQuery : function() { return "" },
    labelQuery: typeof raw.labelQuery === "function" ? raw.labelQuery : function() { return "" }
  }
}

// ---------------------------------------------------------------- registry

// The order the provider chooser lists them in.
var ALL = [define(Gmail), define(Imap), define(Hey)]

var DEFAULT_ID = "gmail"

function ids() {
  var out = []
  for (var i = 0; i < ALL.length; i++) out.push(ALL[i].id)
  return out
}

// An unknown id resolves to the default rather than to nothing: an account
// written by a newer build, or a hand-edited file, still has to open a window.
function get(id) {
  var wanted = String(id === undefined || id === null ? "" : id).trim().toLowerCase()
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === wanted) return ALL[i]
  }
  return ALL[0]
}

function exists(id) {
  var wanted = String(id === undefined || id === null ? "" : id).trim().toLowerCase()
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === wanted) return true
  }
  return false
}

// Whether an account of this kind can be talked to at all. The setup page
// switches on this before it asks for anything.
function isConnectable(id) {
  return !get(id).unavailable
}

function unavailableReason(id) {
  return String(get(id).unavailable || "")
}

function can(id, capability) {
  return get(id).capabilities[String(capability)] === true
}

// ---------------------------------------------------------------- queries

function mailboxes(id) {
  return get(id).mailboxes.slice()
}

function mailboxIndex(id, key) {
  var list = get(id).mailboxes
  var wanted = String(key === undefined || key === null ? "" : key)
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === wanted) return i
  }
  return 0
}

// The first mailbox is the fallback, and every provider's first mailbox is its
// inbox — so a lookup for a key belonging to another provider, which is what a
// switch between two accounts produces mid-render, lands somewhere sensible
// rather than on `undefined`.
function mailboxFor(id, key) {
  var list = get(id).mailboxes
  return list[mailboxIndex(id, key)]
}

function hasMailbox(id, key) {
  var list = get(id).mailboxes
  var wanted = String(key === undefined || key === null ? "" : key)
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === wanted) return true
  }
  return false
}

// The one place a mailbox, a typed search and the configured default query are
// resolved into the string that reaches a client.
//
// Precedence is search, then the user's own default (inbox only — it is
// described as a default *search*, and applying it to Trash would quietly
// filter a mailbox nobody asked to filter), then the mailbox's own query.
function query(id, mailboxKey, searchText, defaultQuery) {
  var provider = get(id)
  var text = String(searchText === undefined || searchText === null ? "" : searchText).trim()
  if (text !== "") return provider.searchQuery(text)

  var custom = String(defaultQuery === undefined || defaultQuery === null ? "" : defaultQuery).trim()
  if (custom !== "" && String(mailboxKey) === "inbox") return custom

  return mailboxFor(id, mailboxKey).query
}

// Selecting a label in the sidebar, which is a different act from typing in the
// search box even though both end up as a query. Each provider says what its
// own labels are — an operator for Gmail, a folder for IMAP.
function labelQuery(id, name) {
  return get(id).labelQuery(name)
}

// What the unread badge counts. A lookup rather than a second definition that
// could drift from the first.
function unreadQuery(id) {
  return mailboxFor(id, "unread").query
}

// ------------------------------------------------------------------ naming

// Shown next to the address in the switcher when more than one kind of account
// is present. One kind, and the word is noise.
function badge(id) {
  return get(id).name
}

function summary(id) {
  return String(get(id).summary || "")
}

function authKind(id) {
  return String(get(id).auth || "none")
}

function usesOAuth(id) {
  return authKind(id) === "oauth"
}

function usesPassword(id) {
  return authKind(id) === "password"
}
