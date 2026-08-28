.pragma library

.import "GmailApi.js" as Api

// What Gmail is, as far as the panel is concerned.
//
// Not how to talk to it — that is `GmailApi.js` for the strings and
// `GmailApiClient.qml` for the transport. This file answers the questions
// `Registry.js` asks of every provider: what mailboxes are there, what does a
// query mean, what can it be asked to do, and how does it sign in.

var ID = "gmail"
var NAME = "Gmail"

// One line, on the provider chooser. It has to say what the user is committing
// to — Gmail's is a Cloud project, which is the single most surprising thing
// about this plugin.
var SUMMARY = "Google's own API. Needs an OAuth client you create once."

var AUTH = "oauth"

// The service's own mark, in `assets/`. Drawn on the provider chooser and on
// the setup page, where the question being answered is "which mailbox am I
// adding" — and a mark answers that before any of the words do.
//
// One file for both, because Google's mark is square and reads at either size.
// HEY has a second, wider one; see `Hey.LOGO`.
var MARK = "gmail.png"

var CAPABILITIES = {
  labels: true,
  threads: true,
  archive: true,
  spam: true,
  star: true,
  batch: true,
  web: true,
  webBox: true,
  search: true,
  send: true
}

// Search queries rather than label ids: `is:unread` and `in:anywhere` have no
// label to point at, and a query keeps every entry on the same footing.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "in:inbox" },
  // Named by what it leaves out. Gmail's categories do not remove the INBOX
  // label, so "in:inbox is:unread" dredges up the whole promotional backlog —
  // measured against a real mailbox, that view came back as newsletters and
  // offers almost end to end. Excluding the three noisy categories cuts it
  // down to the same mail asking for Primary would have found.
  //
  // Asking for Primary positively is what this used to do, and Primary is the
  // one category whose search word does not name its label. The other four
  // read `promotions`, `social`, `forums`, `updates` against
  // CATEGORY_PROMOTIONS and the rest; Primary's label is CATEGORY_PERSONAL
  // and the web UI calls it `primary`. The API's `q` promises only "most of"
  // the web syntax and has never listed `category:` at all, so that one word
  // is the one with nothing holding it up — and on a real account it matched
  // nothing at all while the inbox held 201 unread.
  //
  // Which way the query fails is why this is a negation rather than a
  // narrower scope. A positive scope that stops matching empties the mailbox
  // and the badge, which is unread mail with nothing left to say so. A
  // negation that stops matching widens to every unread message in the inbox:
  // noisier, and nothing worse than noisier. That covers the account whose
  // owner turned Smart features off as well, where Gmail stops applying the
  // category labels at all and there is no Primary left to ask for.
  //
  // Updates stays in. Receipts, deliveries and GitHub's notifications land
  // there, and they are mail somebody is waiting on.
  { key: "unread", label: "Unread", icon: "unread",
    query: "in:inbox is:unread -category:promotions -category:social -category:forums" },
  { key: "starred", label: "Starred", icon: "star", query: "is:starred" },
  { key: "sent", label: "Sent", icon: "send", query: "in:sent" },
  { key: "drafts", label: "Drafts", icon: "compose", query: "in:drafts" },
  // Optional: the first to go when the row cannot hold every mailbox. Neither
  // is somewhere anyone works from — they are places you go looking for
  // something specific, and search reaches both.
  { key: "all", label: "All mail", icon: "archive", query: "in:anywhere -in:spam -in:trash", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "in:trash", optional: true }
]

// Free text goes to Gmail verbatim: its search syntax is the one the user
// already knows from the web UI, and mangling it would be a downgrade.
function searchQuery(text) {
  return String(text === undefined || text === null ? "" : text).trim()
}

// Gmail searches every ordinary mailbox but excludes Spam and Trash unless a
// query asks for them. The local preview only understands plain text, so a row
// already known to live there is outside the server search being previewed.
function cachedSummaryInSearch(sourceQuery, summary) {
  var labels = summary && Array.isArray(summary.labelIds) ? summary.labelIds : []
  for (var i = 0; i < labels.length; i++) {
    var label = String(labels[i] || "").toUpperCase()
    if (label === "SPAM" || label === "TRASH") return false
  }
  var source = String(sourceQuery || "").toLowerCase()
  return !/(^|\s)in:(spam|trash)(\s|$)/.test(source)
}

// Selecting a label in the sidebar. A Gmail label is a search operator, which
// is why this is a different string from the one a typed search produces.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "label:" + value
}

// Where a message and the current query live in Gmail's own web UI. The
// addresses are `GmailApi.js`'s, because that is the file that knows how one is
// built; this is the seam `Registry.js` reaches them through, so nothing above
// the provider boundary has to know whose web UI it is opening.
//
// Account zero: this plugin has no way to learn which of several signed-in
// Google profiles a browser will pick, and /u/0 is the one every browser has.
function webMessageUrl(messageId) {
  return Api.webMessageUrl(messageId, 0)
}

function webBoxUrl(query) {
  return Api.webSearchUrl(query, 0)
}

// The service's own front door, for the link out of a mailbox's settings row.
// Neither of the two above: not a message, and not the mailbox as it is
// filtered right now — just "open this account on the web".
function webHomeUrl() {
  return Api.webHomeUrl(0)
}
