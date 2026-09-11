.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

.import "JmapProtocol.js" as Protocol

var ID = "jmap"

var NAME = "JMAP"

var SUMMARY = "Any server that speaks JMAP"

var AUTH = "password"

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
    "key": "sent",
    "label": "Sent",
    "icon": "sent"
  },
  {
    "key": "drafts",
    "label": "Drafts",
    "icon": "compose"
  },
  {
    "key": "archive",
    "label": "Archive",
    "icon": "archive",
    "optional": true
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
  var settings = (account || {}).jmap || {}
  var host = Protocol.sessionHost(settings.sessionUrl)
  return host === "" ? NAME : NAME + " · " + host
}
