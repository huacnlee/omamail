.pragma library

// Provider presentation only. NativeDomain.js supplies all mail capabilities
// and mailbox queries; providers.resolve builds dynamic queries in Rust.

.import "ImapProtocol.js" as Protocol
.import "MicrosoftOAuth.js" as Microsoft

var ID = "outlook"

var NAME = "Outlook"

var SUMMARY = "Outlook.com and Hotmail, signed in securely with Microsoft."

var AUTH = "oauth"

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

function settings(address, tenant, send) {
  var work = Microsoft.isWorkTenant(tenant)
  return Protocol.normalizeSettings({
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: work ? "smtp.office365.com" : "smtp-mail.outlook.com",
    smtpPort: 587,
    username: String(address === undefined || address === null ? "" : address).trim(),
    insecure: false,
    send: send
  })
}
