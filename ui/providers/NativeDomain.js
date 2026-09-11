.pragma library

// Generated from Rust providers::domain::snapshot; parity is verified by Rust tests.
var FACTS = {
  "gmail": {
    "addressSearch": true,
    "capabilities": {
      "archive": true,
      "batch": true,
      "conversations": false,
      "labels": true,
      "manageLabels": true,
      "move": true,
      "search": true,
      "send": true,
      "spam": true,
      "star": true,
      "threads": true,
      "web": true,
      "webBox": true
    },
    "inheritedDefault": "in:inbox",
    "nativeSync": true,
    "queries": {
      "all": "in:anywhere -in:spam -in:trash",
      "drafts": "in:drafts",
      "inbox": "in:inbox",
      "sent": "in:sent",
      "spam": "in:spam",
      "starred": "is:starred",
      "trash": "in:trash",
      "unread": "in:inbox is:unread -category:promotions -category:social -category:forums"
    },
    "webHomeUrl": "https://mail.google.com/mail/u/0/"
  },
  "hey": {
    "addressSearch": true,
    "capabilities": {
      "archive": false,
      "batch": true,
      "conversations": true,
      "labels": true,
      "manageLabels": false,
      "move": false,
      "search": true,
      "send": true,
      "spam": true,
      "star": false,
      "threads": true,
      "web": true,
      "webBox": false
    },
    "inheritedDefault": "in:inbox",
    "nativeSync": true,
    "queries": {
      "aside": "box:asidebox",
      "drafts": "drafts:",
      "feed": "box:feedbox",
      "inbox": "box:imbox",
      "later": "box:laterbox",
      "papertrail": "box:trailbox",
      "trash": "box:trash",
      "unread": "box:imbox unseen"
    },
    "webHomeUrl": "https://app.hey.com"
  },
  "imap": {
    "addressSearch": true,
    "capabilities": {
      "archive": true,
      "batch": true,
      "conversations": false,
      "labels": false,
      "manageLabels": true,
      "move": true,
      "search": true,
      "send": true,
      "spam": false,
      "star": true,
      "threads": false,
      "web": false,
      "webBox": false
    },
    "inheritedDefault": "in:inbox",
    "nativeSync": true,
    "queries": {
      "archive": "folder:\\Archive",
      "drafts": "folder:\\Drafts",
      "inbox": "folder:INBOX",
      "sent": "folder:\\Sent",
      "spam": "folder:\\Junk",
      "starred": "folder:INBOX FLAGGED",
      "trash": "folder:\\Trash",
      "unread": "folder:INBOX UNSEEN"
    },
    "webHomeUrl": ""
  },
  "jmap": {
    "addressSearch": false,
    "capabilities": {
      "archive": true,
      "batch": true,
      "conversations": true,
      "labels": false,
      "manageLabels": false,
      "move": false,
      "search": true,
      "send": true,
      "spam": true,
      "star": true,
      "threads": true,
      "web": false,
      "webBox": false
    },
    "inheritedDefault": "in:inbox",
    "nativeSync": true,
    "queries": {
      "archive": "role:archive",
      "drafts": "role:drafts",
      "inbox": "role:inbox",
      "sent": "role:sent",
      "spam": "role:junk",
      "starred": "role:inbox flagged",
      "trash": "role:trash",
      "unread": "role:inbox unseen"
    },
    "webHomeUrl": ""
  },
  "outlook": {
    "addressSearch": false,
    "capabilities": {
      "archive": true,
      "batch": true,
      "conversations": false,
      "labels": false,
      "manageLabels": true,
      "move": true,
      "search": true,
      "send": true,
      "spam": false,
      "star": true,
      "threads": false,
      "web": false,
      "webBox": false
    },
    "inheritedDefault": "in:inbox",
    "nativeSync": true,
    "queries": {
      "archive": "folder:\\Archive",
      "drafts": "folder:\\Drafts",
      "inbox": "folder:INBOX",
      "sent": "folder:\\Sent",
      "spam": "folder:\\Junk",
      "starred": "folder:INBOX FLAGGED",
      "trash": "folder:\\Trash",
      "unread": "folder:INBOX UNSEEN"
    },
    "webHomeUrl": "https://outlook.live.com/mail/"
  }
}
