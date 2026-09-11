.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

var ID = "gmail"

var NAME = "Gmail"

var SUMMARY = "Google's own API. Needs an OAuth client you create once."

var AUTH = "oauth"

var MARK = "gmail.png"

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
    "label": "Starred",
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
    "key": "all",
    "label": "All mail",
    "icon": "archive",
    "optional": true
  },
  {
    "key": "spam",
    "label": "Spam",
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
