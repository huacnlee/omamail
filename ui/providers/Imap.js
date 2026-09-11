.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

var ID = "imap"

var NAME = "IMAP"

var SUMMARY = "Any standard mailbox — Fastmail, iCloud, Zoho, your own server."

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
