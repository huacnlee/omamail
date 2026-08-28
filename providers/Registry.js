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
    // And one whose addresses can express the mailbox *currently on screen*.
    // Not the same question: HEY gives every thread an address of its own, but
    // a search, a label or a filtered view has no URL — so "Open web inbox"
    // there would open the Imbox whatever you were looking at, which is the
    // "close enough" this whole file exists to refuse. Gmail's search URL
    // carries any query, so it keeps the row.
    webBox: raw.webBox === true,
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
    // Two file names in `assets/`, or "" for a provider with no artwork of its
    // own. `mark` is the square icon a list row wants; `logo` is the lockup a
    // setup page opens with, which for HEY is a wordmark twice as wide as it is
    // tall. A provider with only one has the one used for both.
    mark: String(raw.MARK || ""),
    logo: String(raw.LOGO || raw.MARK || ""),
    unavailable: String(raw.UNAVAILABLE || ""),
    capabilities: capabilities(raw.CAPABILITIES),
    mailboxes: boxes,
    searchQuery: typeof raw.searchQuery === "function" ? raw.searchQuery : function() { return "" },
    cachedSummaryInSearch: typeof raw.cachedSummaryInSearch === "function"
      ? raw.cachedSummaryInSearch : function() { return false },
    labelQuery: typeof raw.labelQuery === "function" ? raw.labelQuery : function() { return "" },
    // Where a message and a mailbox live on the web, for the provider that has
    // a web UI worth opening. A provider that declares no `web` capability
    // never reaches these, and answers "" if something asks anyway.
    webMessageUrl: typeof raw.webMessageUrl === "function" ? raw.webMessageUrl : function() { return "" },
    webBoxUrl: typeof raw.webBoxUrl === "function" ? raw.webBoxUrl : function() { return "" },
    // The service's front door. A provider with no web UI at all has none, and
    // that empty string is what removes the link from a mailbox's settings row.
    webHomeUrl: typeof raw.webHomeUrl === "function" ? raw.webHomeUrl : function() { return "" },
    // Where the program a provider runs on lives, for the providers that run on
    // one. Only HEY does: the other two are spoken to directly.
    clientUrl: String(raw.CLIENT_URL || "")
  }
}

// ---------------------------------------------------------------- registry

// The order the provider chooser lists them in: the two hosted mailboxes with a
// service of their own first, then the one that is every other mailbox. IMAP is
// last because it is the answer for a server this list does not name, and a
// chooser that opened with it would ask the question backwards.
var ALL = [define(Gmail), define(Hey), define(Imap)]

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
  // The manifest's shipped default predates providers and is Gmail syntax.
  // Applying it to IMAP produces `UID SEARCH in:inbox`, which no IMAP server
  // understands, and to HEY a search for the words. A user-supplied criterion
  // still passes through; only the inherited Gmail default gives way to the
  // provider's own Inbox query.
  if (provider.id !== "gmail" && custom === "in:inbox") custom = ""
  if (custom !== "" && String(mailboxKey) === "inbox") return custom

  return mailboxFor(id, mailboxKey).query
}

function cachedSummaryInSearch(id, sourceQuery, summary) {
  return get(id).cachedSummaryInSearch(sourceQuery, summary)
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

// The file in `assets/` that shows what this service is, or "" for one with no
// artwork of its own. A name rather than a path: where `assets/` sits is the
// view's business, and it differs between a component and the notifier.
//
// `mark` is the square one, for a row in a list. `logo` is what a page about
// this service opens with, and is the same file where a service has only one.
function mark(id) {
  return String(get(id).mark || "")
}

function logo(id) {
  return String(get(id).logo || "")
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

// A sign-in this plugin does not perform itself: the provider's own program
// owns the browser, the token and where it is kept. Nothing is asked of the
// user here but the press of a button.
function usesCli(id) {
  return authKind(id) === "cli"
}

// ------------------------------------------------------------------- the web

// The one place a message id or a query becomes an address for the browser.
// It used to be a Gmail call in `MailAccount`, which is exactly the kind of
// provider knowledge nothing above this file is supposed to hold — and it meant
// a second provider with a web UI opened Gmail.
function webMessageUrl(id, messageId) {
  return get(id).webMessageUrl(messageId)
}

function webBoxUrl(id, query) {
  return get(id).webBoxUrl(query)
}

function webHomeUrl(id) {
  return get(id).webHomeUrl()
}

function clientUrl(id) {
  return String(get(id).clientUrl || "")
}
