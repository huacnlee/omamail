.pragma library

// Where each calendar provider keeps its calendars, and what a person needs
// to reach them. Most sit behind CalDAV at a fixed address with an app
// password; those cards prefill the address and say where the password is
// made, and end in the same discovery every CalDAV address goes through.
// Google's calendars come with the Gmail sign-in and need no card of their
// own beyond saying so.
//
// A preset is a starting point, never a lock: the address stays editable,
// because a provider moves hosts more often than this file is read.

var LIST = [
  {
    id: "icloud", name: "iCloud", kind: "caldav",
    url: "https://caldav.icloud.com/",
    usernameHint: "Apple ID email address",
    passwordHint: "App-specific password",
    note: "Two-factor authentication must be on. Make an app-specific password at appleid.apple.com under Sign-In and Security.",
    helpUrl: "https://support.apple.com/102654", helpText: "Open Apple's app-specific password help..."
  },
  {
    id: "fastmail", name: "Fastmail", kind: "caldav",
    url: "https://caldav.fastmail.com/dav/",
    usernameHint: "Fastmail address",
    passwordHint: "App password",
    note: "Make an app password with calendar access under Settings > Privacy & Security > Integrations.",
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/360058752854", helpText: "Open Fastmail's app password help..."
  },
  {
    id: "nextcloud", name: "Nextcloud", kind: "caldav",
    url: "", urlHint: "https://cloud.example.com/remote.php/dav/",
    usernameHint: "Nextcloud username",
    passwordHint: "App password",
    note: "Your server's address followed by /remote.php/dav/. Make an app password under Settings > Security > Devices & sessions.",
    helpUrl: "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html", helpText: "Open Nextcloud's app password help..."
  },
  {
    id: "yahoo", name: "Yahoo", kind: "caldav",
    url: "https://caldav.calendar.yahoo.com/",
    usernameHint: "Yahoo address",
    passwordHint: "App password",
    note: "Make an app password under Account Security > Generate app password.",
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html", helpText: "Open Yahoo's app password help..."
  },
  {
    id: "zoho", name: "Zoho", kind: "caldav",
    url: "https://calendar.zoho.com/caldav/",
    usernameHint: "Zoho address",
    passwordHint: "Application-specific password",
    note: "Make an application-specific password under My Account > Security.",
    helpUrl: "https://help.zoho.com/portal/en/kb/accounts/security/articles/application-specific-passwords", helpText: "Open Zoho's app password help..."
  },
  {
    id: "gmx", name: "GMX", kind: "caldav",
    url: "https://caldav.gmx.net/",
    usernameHint: "GMX address",
    passwordHint: "Password, or an app password if two-factor is on",
    note: "Turn on external access under E-Mail > Settings > POP3/IMAP first.",
    helpUrl: "", helpText: ""
  },
  {
    id: "mailbox-org", name: "mailbox.org", kind: "caldav",
    url: "https://dav.mailbox.org/caldav/",
    usernameHint: "mailbox.org address",
    passwordHint: "Password, or an app password if two-factor is on",
    note: "",
    helpUrl: "", helpText: ""
  },
  {
    id: "posteo", name: "Posteo", kind: "caldav",
    url: "https://posteo.de:8443/",
    usernameHint: "Posteo address",
    passwordHint: "Password",
    note: "Turn on external calendar access under Settings > My account > Calendar first.",
    helpUrl: "", helpText: ""
  },
  {
    id: "caldav", name: "Other CalDAV server", kind: "caldav",
    url: "", urlHint: "https://calendar.example.com/",
    usernameHint: "Username",
    passwordHint: "Password or app password",
    note: "The server's address is enough; the calendars it holds are found from it. Radicale, Baikal, Synology, ownCloud and most hosted mail all speak CalDAV.",
    helpUrl: "", helpText: ""
  },
  {
    id: "google", name: "Google", kind: "google",
    url: "", usernameHint: "", passwordHint: "",
    note: "Google calendars come with a Gmail mailbox: add one under Accounts and sign in, and its calendars appear here on their own.",
    helpUrl: "", helpText: ""
  }
]

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function find(id) {
  var wanted = trimmed(id)
  for (var i = 0; i < LIST.length; i++) {
    if (LIST[i].id === wanted) return LIST[i]
  }
  return null
}

// The form's starting values for a card: the fixed address where there is
// one, the placeholder where the user supplies it.
function formFor(id) {
  var preset = find(id)
  if (!preset) return { url: "", urlHint: "https://calendar.example.com/", usernameHint: "Username", passwordHint: "Password or app password", note: "", helpUrl: "", helpText: "", kind: "caldav" }
  return {
    kind: preset.kind,
    url: trimmed(preset.url),
    urlHint: trimmed(preset.urlHint) || trimmed(preset.url) || "https://calendar.example.com/",
    usernameHint: trimmed(preset.usernameHint) || "Username",
    passwordHint: trimmed(preset.passwordHint) || "Password or app password",
    note: trimmed(preset.note),
    helpUrl: trimmed(preset.helpUrl),
    helpText: trimmed(preset.helpText)
  }
}

// Every help link is one of Apple's, Fastmail's, Nextcloud's, Yahoo's or
// Zoho's own pages over HTTPS; nothing else opens a browser from here.
function isHelpUrl(value) {
  return /^https:\/\/(support\.apple\.com|www\.fastmail\.help|docs\.nextcloud\.com|help\.yahoo\.com|help\.zoho\.com)\//.test(trimmed(value))
}
