.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

.import "ExchangeProtocol.js" as Protocol

var ID = "exchange"

var NAME = "Exchange"

var SUMMARY = "On-premises Exchange, for a server that offers no IMAP."

var AUTH = "password"

// No Archive row: Microsoft documents no plain archive folder name, and a folder
// is only named when it does. The last two are optional because the server decides
// whether they exist.
var MAILBOXES = [
  {
    "key": "inbox",
    "label": "Inbox",
    "icon": "inbox"
  },
  {
    "key": "unread",
    "label": "Unread",
    "icon": "unread"
  },
  {
    "key": "starred",
    "label": "Flagged",
    "icon": "star"
  },
  {
    "key": "drafts",
    "label": "Drafts",
    "icon": "compose"
  },
  {
    "key": "sent",
    "label": "Sent",
    "icon": "sent"
  },
  {
    "key": "spam",
    "label": "Junk",
    "icon": "spam",
    "optional": true
  },
  {
    "key": "trash",
    "label": "Trash",
    "icon": "trash",
    "optional": true
  }
]

function detail(account) {
  var settings = (account || {}).exchange || {}
  var host = Protocol.serverHost(settings)
  return host === "" ? NAME : NAME + " · " + host
}
