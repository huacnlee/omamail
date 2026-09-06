.pragma library

.import "Imap.js" as Imap
.import "ImapProtocol.js" as Protocol

// Outlook.com is an IMAP mailbox with a sign-in of its own. Keeping it as a
// provider rather than a password preset matters: Microsoft no longer accepts
// account passwords for personal mail, while the generic IMAP provider still
// needs them for servers that do.

var ID = "outlook"
var NAME = "Outlook"
var SUMMARY = "Outlook.com and Hotmail, signed in securely with Microsoft."
var AUTH = "oauth"

var CAPABILITIES = Imap.CAPABILITIES
var MAILBOXES = Imap.MAILBOXES

function searchQuery(text) {
  return Imap.searchQuery(text)
}

function cachedSummaryInSearch(sourceQuery, summary) {
  return Imap.cachedSummaryInSearch(sourceQuery, summary)
}

function labelQuery(name) {
  return Imap.labelQuery(name)
}

function webHomeUrl() {
  return "https://outlook.live.com/mail/"
}

function settings(address) {
  return Protocol.normalizeSettings({
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    username: String(address === undefined || address === null ? "" : address).trim(),
    insecure: false
  })
}
