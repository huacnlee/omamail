.pragma library

// What a JMAP mailbox is, as far as the panel is concerned.
//
// The protocol is `JmapProtocol.js` and the transport is `JmapClient.qml`.
// This file answers the four questions `Registry.js` asks of every provider.
//
// It sits beside `imap` rather than replacing it. Both are protocols rather
// than services, and most mailboxes still speak only the older one — but where
// a server speaks JMAP, three of the compromises `Imap.js` documents stop
// being necessary.

var ID = "jmap"
var NAME = "JMAP"
var SUMMARY = "A mailbox that speaks JMAP — Fastmail, or a server of your own."
var AUTH = "password"

var CAPABILITIES = {
  // A message is in a set of mailboxes and carries arbitrary keywords, so a
  // labels-style reader is defensible. Not yet: Fastmail presents folders, and
  // a reader that drew a label strip would draw an empty one.
  labels: false,
  // The reason to prefer this provider. `Imap.js` declares false and threads on
  // References, which is what every IMAP client has to do; JMAP gives every
  // message a server-side `threadId`.
  threads: true,
  // Only if the account has a mailbox with the Archive role, which the client
  // learns from `Mailbox/get`. This is the ceiling, not the guarantee.
  archive: true,
  // The ceiling, not the guarantee. `Imap.js` refuses this outright because
  // moving a message to a folder teaches an arbitrary server nothing, and a
  // "Report spam" button that quietly means "move" is a promise a provider
  // cannot keep. That is still true of a JMAP server we know nothing about —
  // so the client withdraws it per account, from `JmapProtocol.junkTrains`,
  // and only a host known to learn from its Junk mailbox keeps the button.
  spam: true,
  // `$flagged` is the keyword every JMAP server agrees on.
  star: true,
  move: true,
  // Not a concession to batching but the shape of the protocol: a request is a
  // list of method calls, and one `Email/set` moves as many messages as fit.
  batch: true,
  // `Email/query` filters server-side, so this is a real search rather than
  // IMAP's TEXT criterion over headers and body.
  search: true,
  // The ceiling. Whether this account may actually send is a property of the
  // token rather than of the protocol: a token minted without the submission
  // scope reports `canSend: false` from the session, and the client answers
  // accordingly rather than offering a button the server would refuse.
  send: true,
  // Still false, and not for want of knowing the address: `Registry.webMessageUrl`
  // takes a provider id and a message id, with no account and therefore no host
  // in scope. A generic JMAP provider cannot answer it honestly for one host
  // and not another through that seam, and widening the seam for an "open in
  // the browser" link is not worth what it would cost everything above it.
  web: false,
  webBox: false
}

// Roles, not folder names. RFC 8621 gives a mailbox an optional role, and
// `JmapProtocol.filterFor` swaps the role for the id this account uses — the
// same move `Imap.js` makes with its SPECIAL-USE placeholders, without needing
// a fallback name, because a role is not a name a server may translate.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "role:inbox" },
  { key: "unread", label: "Unread", icon: "unread", query: "role:inbox unread" },
  { key: "starred", label: "Flagged", icon: "star", query: "role:inbox flagged" },
  { key: "sent", label: "Sent", icon: "sent", query: "role:sent" },
  { key: "drafts", label: "Drafts", icon: "compose", query: "role:drafts" },
  { key: "archive", label: "Archive", icon: "archive", query: "role:archive", optional: true },
  // Browsable as a mailbox even though `spam` is declared false: the capability
  // is about offering a "Report spam" verb, not about being able to read the
  // folder the server already files things into.
  { key: "spam", label: "Junk", icon: "spam", query: "role:junk", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "role:trash", optional: true }
]

// The search box. `Email/query`'s `text` condition is what the user means by
// typing words — the server decides what it matches — so unlike IMAP this
// needs no argument about which headers count.
//
// JSON.stringify does the quoting because `JmapProtocol.parseQuery` reads the
// same two escapes back out.
function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "role:inbox text " + JSON.stringify(value)
}

// Choosing a mailbox in the sidebar, which is not a search for its name.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "mailbox:" + JSON.stringify(value)
}
