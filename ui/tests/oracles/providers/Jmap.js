.pragma library

.import "../../../providers/JmapProtocol.js" as Protocol

// What a JMAP mailbox is, as far as the panel is concerned.
//
// The protocol itself is `JmapProtocol.js` and the transport is
// `scripts/jmap-transport.sh` under `JmapClient.qml`. This file answers the
// same four questions `Registry.js` asks of every provider, and the answers
// differ from IMAP's in ways the panel has to respect rather than paper over:
// JMAP has a server-side thread id, a junk verb some servers really do learn
// from, and one query language for the whole account rather than a selected
// folder.

var ID = "jmap"
var NAME = "JMAP"

// One line, on the provider chooser. It names no service on purpose — the
// same instruction the setup page follows. A JMAP server is Stalwart today and
// something else next year, and a chooser that listed two of them would be
// wrong about the third.
var SUMMARY = "Any server that speaks JMAP"

// An app password or an API token, typed into a field. Which of the two it is
// decides the auth scheme, and the scheme is detected rather than asked:
// `Protocol.AUTH_SCHEME_ORDER` is Basic then Bearer.
var AUTH = "password"

// No mark and no logo. There is no JMAP brand to draw — it is a protocol, not
// a service — so a mailbox here gets the themed envelope, as IMAP does.

// The ceiling, not the guarantee. An account may refuse one of these from what
// its own session and mailbox list say — `JmapProtocol.refusals` — and nothing
// may add one back.
var CAPABILITIES = {
  // A message is in one mailbox, near enough. Both reference servers put it
  // there, and the label strip was built for Gmail's several-at-once.
  labels: false,
  // `Email.threadId` is the server's own, so threading is a fact rather than a
  // References guess.
  threads: true,
  // And a row can therefore be one conversation rather than one message.
  conversations: true,
  // Only if the account has somewhere to put it, which the client decides per
  // account from the mailbox roles it resolved.
  archive: true,
  // Unlike IMAP: a move into Junk is a verb the server acts on where the
  // session proves the server learns from it. Where it does not, the account
  // refuses this rather than the provider giving it up for everybody.
  spam: true,
  // `$flagged`, mandatory in RFC 8621.
  star: true,
  // `Email/set` changes many ids in one round trip.
  batch: true,
  // The `text` filter condition, also mandatory.
  search: true,
  // Where the account has the submission capability, which sign-in reads and
  // an account without it refuses.
  send: true,
  // No web UI this plugin could know the address of. Stalwart ships no webmail
  // at all, and a verified address for one that does is a provider-level
  // decision somebody has to make with an account in front of them.
  web: false,
  webBox: false
}

// Roles, not folder names and not queries. The `role:`, `mailbox:` and `text:`
// DSL is read by `JmapProtocol.parseQuery` and by nothing else — everywhere
// above, these strings are opaque, handed back to the client that produced
// them and used as a cache key.
//
// A role is what the rail is keyed on because it is the one stable name: the
// same row is "Junk" on one server and "Spam" on another, and RFC 8621's
// `role` is what both of them agree on. The client resolves each to a mailbox
// id per account — by role, then by the leaf-name guesses IMAP makes — and the
// three optional rows disappear on an account where that resolves to nothing.
//
// IMAP's eight rows, in IMAP's order. "Flagged" rather than "Starred": the
// keyword is `$flagged`, and the word a JMAP server's own interface uses is
// the one a user has already met. No "All mail" row — that is a Gmail idea,
// and a query across every mailbox is what search is for.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "role:inbox" },
  { key: "unread", label: "Unread", icon: "unread", query: "role:inbox unseen" },
  { key: "starred", label: "Flagged", icon: "star", query: "role:inbox flagged" },
  { key: "sent", label: "Sent", icon: "sent", query: "role:sent" },
  { key: "drafts", label: "Drafts", icon: "compose", query: "role:drafts" },
  { key: "archive", label: "Archive", icon: "archive", query: "role:archive", optional: true },
  { key: "spam", label: "Junk", icon: "spam", query: "role:junk", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "role:trash", optional: true }
]

// A typed search. The words go to the server's own `text` filter condition,
// which searches the account rather than one selected mailbox — so unlike
// IMAP's, this query names no mailbox at all, and the client excludes Junk and
// Trash when it builds the filter.
//
// No quoting: the whole of the rest of the string is the text, so a phrase, an
// apostrophe and a colon all survive to the server unaltered.
function searchQuery(text) {
  var value = Protocol.trimmed(text)
  return value === "" ? "" : "text:" + value
}

// Gmail's rule, for Gmail's reason. The local preview only understands plain
// text, so a row already known to be in Junk or Trash is outside the server
// search being previewed — and a search *of* Junk or Trash is not a search the
// client sends at all.
function cachedSummaryInSearch(sourceQuery, summary) {
  var labels = summary && Array.isArray(summary.labelIds) ? summary.labelIds : []
  for (var i = 0; i < labels.length; i++) {
    var label = String(labels[i] || "").toUpperCase()
    if (label === "SPAM" || label === "TRASH") return false
  }
  var source = Protocol.trimmed(sourceQuery).toLowerCase()
  return !/(^|\s)role:(junk|trash)(\s|$)/.test(source)
}

// Selecting one of the server's own mailboxes in the sidebar. This cannot go
// through `searchQuery`: a mailbox wrapped in a text search would look for its
// name in the message bodies rather than opening it.
//
// The id, not the name. A JMAP mailbox has a stable id and a display name that
// can change or repeat under two different parents, and the id is what
// `Mailbox/get` and every filter take.
function labelQuery(id) {
  var value = Protocol.trimmed(id)
  return value === "" ? "" : "mailbox:" + value
}

// The second line the Mailboxes settings row draws under the address. Every
// other provider has nothing to say there — a Gmail mailbox is at Gmail, and
// an IMAP one already names its server on its own page — but a JMAP account is
// a protocol plus a host, and which host is the only thing distinguishing two
// of them.
//
// The host, not the session URL: the path is this client's business, and the
// host is what somebody recognises as their server.
function detail(account) {
  var settings = (account || {}).jmap || {}
  var host = Protocol.sessionHost(settings.sessionUrl)
  return host === "" ? NAME : NAME + " · " + host
}

var NATIVE_SYNC = true
