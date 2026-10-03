.pragma library

.import "Imap.js" as Imap

// What a personal Outlook mailbox is, as far as the panel is concerned.
//
// It is IMAP and SMTP underneath, so the protocol, the folder DSL and the
// transport are IMAP's own — reused rather than copied. What differs is the
// sign-in: Microsoft turned basic authentication off for personal accounts, so
// the password is dead and the account is reached with an XOAUTH2 bearer token
// from a browser sign-in. That is the one thing this file states, plus the two
// servers that token is presented to.

var ID = "outlook"
var NAME = "Outlook"

// One line, on the provider chooser. It has to say that this is a hosted
// mailbox of Microsoft's and that the sign-in is a browser rather than a
// password or a Cloud project.
var SUMMARY = "Microsoft's own mailbox \u2014 outlook.com, hotmail.com, live.com. Sign in with your browser."

// A browser this plugin drives, exactly as Gmail's is. The difference is whose
// authorization server and which client: Microsoft owns both.
var AUTH = "oauth"

// The service's artwork, in `assets/`. Outlook's mark reads at either size, so
// one file serves both the chooser row and the setup page lockup.
var MARK = "outlook.svg"
var LOGO = "outlook.svg"

var CAPABILITIES = Imap.CAPABILITIES

// Folders, resolved from what the server reports exactly as IMAP's are. An
// Exchange mailbox calls its Sent folder "Sent Items", so a list written here
// would be a guess; the placeholders are the same ones `Imap.js` resolves.
var MAILBOXES = Imap.MAILBOXES

// The servers a personal account speaks to. Fixed by Microsoft rather than
// typed by the user: there is no setup form here, only a browser button.
var IMAP_HOST = "outlook.office365.com"
var IMAP_PORT = 993
var SMTP_HOST = "smtp.office365.com"
var SMTP_PORT = 587

// The session's own server settings, in the shape `Imap.js` validates and
// `ImapClient.qml` dials. The username is the mailbox address — for XOAUTH2
// that is the identity the token is presented as, not a login name.
function settingsFor(email) {
  return {
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    username: String(email === undefined || email === null ? "" : email),
    aliases: "",
    insecure: false
  }
}

// IMAP's own query shaping, because the folders are IMAP's.
function searchQuery(text) {
  return Imap.searchQuery(text)
}

function cachedSummaryInSearch(sourceQuery, summary) {
  return Imap.cachedSummaryInSearch(sourceQuery, summary)
}

function labelQuery(name) {
  return Imap.labelQuery(name)
}

// The service's own front door, for the link out of the setup page's hero.
// Personal Outlook has a web UI; the protocol does not, which is why no
// `webBox` capability is declared.
function webHomeUrl() {
  return "https://outlook.live.com/mail/"
}
