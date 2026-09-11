.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

var ID = "hey"

var NAME = "HEY"

var SUMMARY = "37signals' own mailbox, read through the HEY CLI they publish."

var AUTH = "cli"

var MARK = "hey-mark.png"

var LOGO = "hey.png"

var CLIENT_URL = "https://github.com/basecamp/hey-cli"

var MAILBOXES = [
  {
    "key": "inbox",
    "label": "Imbox",
    "icon": "inbox"
  },
  {
    "key": "unread",
    "label": "New for you",
    "icon": "unread"
  },
  {
    "key": "drafts",
    "label": "Drafts",
    "icon": "compose"
  },
  {
    "key": "later",
    "label": "Reply Later",
    "icon": "reply"
  },
  {
    "key": "aside",
    "label": "Set Aside",
    "icon": "pin"
  },
  {
    "key": "feed",
    "label": "The Feed",
    "icon": "label"
  },
  {
    "key": "papertrail",
    "label": "Paper Trail",
    "icon": "archive",
    "optional": true
  },
  {
    "key": "trash",
    "label": "Trash",
    "icon": "trash",
    "optional": true
  }
]
