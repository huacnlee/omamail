.pragma library

// What kind of mail service an account is, and what the rest of the plugin may
// therefore ask of it.
//
// Until now there was one answer to that question and it was compiled in:
// `Model.MAILBOXES` held Gmail search operators, `MailAccount` constructed a
// `GmailApiClient`, and the setup page walked everyone through Google Cloud.
// Three services do not fit that shape, so the differences move here and the
// orchestration above stops knowing which service it is driving.
//
// A provider is four things:
//
//   - an identity, for the switcher and the setup page
//   - a set of capabilities, because a panel must not offer a button the
//     service cannot honour: IMAP has no "report spam" verb and no labels
//   - its mailboxes, and the query string that selects each one
//   - what its sign-in needs, which is the only part the user ever meets
//
// The query strings are deliberately opaque above this file. Gmail's are its
// own search operators; IMAP's are a small DSL that `Imap.js` translates into
// SEARCH criteria. Everything upstream only ever passes one back down to the
// client that produced it, and uses it as a cache key.

// ------------------------------------------------------------- capabilities

// Named so a missing entry reads as "cannot", not as "unknown". A provider
// that forgets to declare something loses the button rather than showing one
// that fails when pressed.
function capabilities(values) {
  var raw = values || {}
  return {
    // Several labels on one message, rather than one folder holding it.
    labels: raw.labels === true,
    // A server-side conversation id. Without it a reply threads by
    // In-Reply-To alone, which is what every other client does anyway.
    threads: raw.threads === true,
    // "Archive" means something. On IMAP it is a move to a folder that may
    // not exist, so it is only offered where one does.
    archive: raw.archive === true,
    // A junk verb the server acts on. IMAP's nearest equivalent is a move,
    // and moving mail to a folder the server does not learn from is not the
    // same promise.
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

// --------------------------------------------------------------- mailboxes

// The same shape `Model.MAILBOXES` had, because the sidebar and the tab row
// already know how to draw it: a key, a label, an icon, an `optional` flag for
// the ones that get dropped when the row runs out of width, and the query that
// selects it.
function mailbox(key, label, icon, query, optional) {
  return {
    key: String(key),
    label: String(label),
    icon: String(icon),
    query: String(query),
    optional: optional === true
  }
}

// ------------------------------------------------------------------- Gmail

// Unchanged from what shipped: these are Gmail search operators rather than
// label ids because `is:unread` and `in:anywhere` have no label to point at.
var GMAIL_MAILBOXES = [
  mailbox("inbox", "Inbox", "inbox", "in:inbox"),
  // Scoped to Primary, not just to the inbox. Gmail's category tabs do not
  // remove the INBOX label, so "in:inbox is:unread" dredges up the whole
  // promotional backlog.
  mailbox("unread", "Unread", "unread", "in:inbox is:unread category:primary"),
  mailbox("starred", "Starred", "star", "is:starred"),
  mailbox("sent", "Sent", "send", "in:sent"),
  mailbox("all", "All mail", "archive", "in:anywhere -in:spam -in:trash", true),
  mailbox("trash", "Trash", "trash", "in:trash", true)
]

var GMAIL = {
  id: "gmail",
  name: "Gmail",
  // Shown on the provider chooser. One line, and it has to say what the user
  // is committing to — Gmail's is a Cloud project, which is the single most
  // surprising thing about this plugin.
  summary: "Google's own API. Needs an OAuth client you create once.",
  auth: "oauth",
  mailboxes: GMAIL_MAILBOXES,
  capabilities: capabilities({
    labels: true, threads: true, archive: true, spam: true,
    star: true, batch: true, web: true, search: true, send: true
  }),
  // Free text goes to Gmail verbatim: its search syntax is the one the user
  // already knows from the web UI, and mangling it would be a downgrade.
  searchQuery: function(text) { return String(text || "").trim() }
}

// -------------------------------------------------------------------- IMAP

// Folders, not queries. The DSL is `folder:<name>` plus optional SEARCH
// criteria, and `Imap.js` is the only thing that reads it — the point of a
// string is that `Cache.queryKey` can key on it and `MailAccount` can hand it
// back unread.
//
// The folder names here are the fallbacks. A server that advertises SPECIAL-USE
// (RFC 6154) names its own Sent, Trash, Drafts and Junk, and `Imap.resolve`
// replaces these with what the server actually said — "Sent" is "Sent Items"
// on Exchange, "Sent Messages" on iCloud, and "[Gmail]/Sent Mail" on Gmail.
var IMAP_MAILBOXES = [
  mailbox("inbox", "Inbox", "inbox", "folder:INBOX"),
  mailbox("unread", "Unread", "unread", "folder:INBOX UNSEEN"),
  mailbox("starred", "Flagged", "star", "folder:INBOX FLAGGED"),
  mailbox("sent", "Sent", "send", "folder:\\Sent"),
  mailbox("archive", "Archive", "archive", "folder:\\Archive", true),
  mailbox("trash", "Trash", "trash", "folder:\\Trash", true)
]

var IMAP = {
  id: "imap",
  name: "IMAP",
  summary: "Any standard mailbox — Fastmail, iCloud, Outlook, Zoho, your own server.",
  auth: "password",
  mailboxes: IMAP_MAILBOXES,
  capabilities: capabilities({
    // No labels: a message is in one folder. The reader hides the label strip
    // rather than showing an empty one.
    labels: false,
    // No server-side conversation id. Threading falls back to References.
    threads: false,
    // Only if the server has somewhere to put it, which `Imap.resolve`
    // decides per account; this is the ceiling, not the guarantee.
    archive: true,
    // Deliberately off. IMAP can move a message to a Junk folder, but that
    // teaches the server nothing, and a "Report spam" button that quietly
    // means "move to a folder" is a promise the provider cannot keep.
    spam: false,
    star: true, batch: true, search: true, send: true,
    // No web UI this plugin can know the address of.
    web: false
  }),
  // IMAP SEARCH has no free-text operator that means what a user means by
  // typing words into a search box, so the text becomes a TEXT criterion —
  // headers and body, which is the closest standard equivalent. Quoting is
  // Imap.js's job; this only carries the intent.
  searchQuery: function(text) {
    var value = String(text || "").trim()
    return value === "" ? "" : "folder:INBOX TEXT " + JSON.stringify(value)
  }
}

// -------------------------------------------------------------------- HEY
//
// HEY is here as a provider with no client behind it, and that is a statement
// rather than an oversight.
//
// 37signals ship no IMAP, no POP and no public API: the FAQ says so outright
// ("HEY doesn't support IMAP or POP", "off-the-shelf 3rd party email apps
// won't work with HEY"), and DHH has said IMAP will never arrive because the
// product's changes to email depend on the vertical integration. The SMTP in
// their docs is HEY sending *through* someone else's server, not a way in.
//
// The only remaining surface is the private endpoint set app.hey.com talks to,
// reached by driving a session cookie. That is not shippable here: it would
// ask a user for their HEY password to replay it against an interface with no
// compatibility promise, and it would break on a deploy nobody told us about.
//
// So the seam exists and the entry is honest about why it is dark. The day an
// API appears, this becomes a `capabilities` block, a `Hey.js` and a
// `HeyClient.qml` — every other file already routes through the registry below
// and none of them has to change.
var HEY = {
  id: "hey",
  name: "HEY",
  summary: "No IMAP and no public API. Nothing to connect to yet.",
  auth: "none",
  mailboxes: [
    // HEY's own three, so the shape is on record. Nothing selects them today.
    mailbox("imbox", "Imbox", "inbox", ""),
    mailbox("feed", "The Feed", "unread", ""),
    mailbox("papertrail", "Paper Trail", "archive", "")
  ],
  capabilities: capabilities({}),
  searchQuery: function() { return "" },
  // What the setup page shows instead of a form, and what stops `MailAccount`
  // from ever calling a client that is not there.
  unavailable: "HEY has no IMAP, POP or public API, so no third-party client "
    + "can sign in to it. Forwarding HEY to a mailbox you can reach over IMAP "
    + "is the only route that does not depend on 37signals changing their mind."
}

// ---------------------------------------------------------------- registry

var ALL = [GMAIL, IMAP, HEY]

var DEFAULT_ID = GMAIL.id

function ids() {
  var out = []
  for (var i = 0; i < ALL.length; i++) out.push(ALL[i].id)
  return out
}

// An unknown id resolves to Gmail rather than to nothing: an account written
// by a newer build, or a hand-edited file, still has to open a window.
function get(id) {
  var wanted = String(id === undefined || id === null ? "" : id).trim().toLowerCase()
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === wanted) return ALL[i]
  }
  return GMAIL
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
  var caps = get(id).capabilities
  return caps[String(capability)] === true
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
// inbox — a lookup for a key that belongs to another provider (which is what a
// switch between two accounts produces mid-render) lands somewhere sensible
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
// search box even though both end up as a query.
//
// It cannot go through `query` above: that shapes a typed string into a search,
// and an IMAP folder wrapped in a TEXT search would look for the folder's name
// inside the inbox. So this returns a finished query, and `MailAccount` keeps
// it apart from `searchQuery` for the same reason.
function labelQuery(id, name) {
  var provider = get(id)
  var value = String(name === undefined || name === null ? "" : name).trim()
  if (value === "") return ""
  // Gmail's labels are search operators; IMAP's "labels" are folders, and a
  // folder name with a space in it has to arrive quoted.
  if (provider.id === "imap") return "folder:" + JSON.stringify(value)
  if (provider.id === "gmail") return "label:" + value
  return ""
}

// What the unread badge counts. Every provider has an unread mailbox and it is
// always the cheapest thing to ask for, so this is a lookup rather than a
// second definition that could drift from the first.
function unreadQuery(id) {
  return mailboxFor(id, "unread").query
}

// ------------------------------------------------------------------ naming

// The switcher shows a provider next to the address when more than one kind of
// account is present. One kind, and the word is noise.
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
