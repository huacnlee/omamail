.pragma library

// View models. Anything the panel decides — which mailbox is selected, what the
// setup card should say, whether a message still belongs in the list after an
// action — is decided here so the QML stays a description of the screen.

// The mailboxes are Gmail search queries rather than label ids: `is:unread`
// and `in:anywhere` have no label to point at, and a query keeps every entry
// on the same footing.
// `icon` names an ActionIcon glyph. The sidebar is icon-first and collapsed by
// default, so a mailbox without a drawing would simply be invisible.
var MAILBOXES = [
  { key: "inbox", label: "Inbox", query: "in:inbox", labelId: "INBOX", icon: "inbox" },
  // Scoped to Primary, not just to the inbox. Gmail's category tabs do not
  // remove the INBOX label, so "in:inbox is:unread" dredges up the whole
  // promotional backlog — measured against a real mailbox, that view came back
  // as newsletters and offers almost end to end while the inbox itself was
  // ordinary mail. Gmail has no standalone unread view for the same reason.
  { key: "unread", label: "Unread", query: "in:inbox is:unread category:primary", labelId: "UNREAD", icon: "unread" },
  { key: "starred", label: "Starred", query: "is:starred", labelId: "STARRED", icon: "star" },
  { key: "sent", label: "Sent", query: "in:sent", labelId: "SENT", icon: "send" },
  // Optional: the first to go when the row cannot hold every mailbox. Neither
  // is somewhere anyone works from — they are places you go looking for
  // something specific, and search reaches both.
  { key: "all", label: "All mail", query: "in:anywhere -in:spam -in:trash", labelId: "", icon: "archive", optional: true },
  { key: "trash", label: "Trash", query: "in:trash", labelId: "TRASH", icon: "trash", optional: true }
]

function mailboxIndex(key) {
  for (var i = 0; i < MAILBOXES.length; i++) {
    if (MAILBOXES[i].key === String(key || "")) return i
  }
  return 0
}

function mailbox(key) {
  return MAILBOXES[mailboxIndex(key)]
}

function mailboxQuery(key, extraQuery) {
  var base = mailbox(key).query
  var extra = String(extraQuery || "").trim()
  return extra ? extra : base
}

// ------------------------------------------------------------ setup state

// One value the panel can switch on, in the order a new user meets them.
function setupState(status) {
  var value = status || {}
  if (!value.toolsPresent) return "tools_missing"
  if (!value.credentialsPresent) return "no_credentials"
  if (value.signingIn) return "signing_in"
  if (!value.signedIn) return "signed_out"
  return "ready"
}

function setupHeadline(state) {
  if (state === "tools_missing") return "Missing system tools"
  if (state === "no_credentials") return "Connect a Google Cloud project"
  if (state === "signing_in") return "Waiting for Google…"
  if (state === "signed_out") return "Sign in to Gmail"
  return ""
}

function setupDetail(state, missingTools) {
  if (state === "tools_missing") {
    var tools = Array.isArray(missingTools) ? missingTools.join(", ") : ""
    return "Omamail needs " + (tools || "a few base tools")
      + " on PATH before it can sign in."
  }
  if (state === "no_credentials")
    return "Gmail has no shared app to sign in through, so this plugin uses an OAuth client you own. It takes about two minutes to create."
  if (state === "signing_in")
    return "Finish the sign-in in your browser. This window updates by itself."
  if (state === "signed_out")
    return "Your OAuth client is ready. Sign in to let it read this mailbox."
  return ""
}

function setupActionLabel(state) {
  if (state === "tools_missing") return "See what is missing..."
  if (state === "no_credentials") return "Set up the OAuth client..."
  if (state === "signing_in") return "Cancel"
  if (state === "signed_out") return "Sign in with Google..."
  return ""
}

// --------------------------------------------------------- list behaviour

// After an action the message may no longer belong in the mailbox being
// viewed. Archiving from Inbox removes the row; archiving from All mail does
// not. Getting this wrong either strands a row that is gone or hides one that
// is still there.
function survivesAction(mailboxKey, action) {
  var key = String(mailboxKey || "inbox")
  var verb = String(action || "")
  if (verb === "trash") return key === "trash"
  if (verb === "untrash") return key !== "trash"
  if (verb === "archive") return key !== "inbox" && key !== "unread"
  if (verb === "markRead") return key !== "unread"
  if (verb === "unstar") return key !== "starred"
  return true
}

function labelChangesFor(action) {
  if (action === "markRead") return { add: [], remove: ["UNREAD"] }
  if (action === "markUnread") return { add: ["UNREAD"], remove: [] }
  if (action === "star") return { add: ["STARRED"], remove: [] }
  if (action === "unstar") return { add: [], remove: ["STARRED"] }
  if (action === "archive") return { add: [], remove: ["INBOX"] }
  if (action === "unarchive") return { add: ["INBOX"], remove: [] }
  if (action === "spam") return { add: ["SPAM"], remove: ["INBOX"] }
  return null
}

function applyLabelChange(summary, action) {
  if (!summary) return summary
  var change = labelChangesFor(action)
  if (!change) return summary
  var next = {}
  for (var key in summary) next[key] = summary[key]
  var labels = Array.isArray(summary.labelIds) ? summary.labelIds.slice() : []
  for (var i = 0; i < change.remove.length; i++) {
    var at = labels.indexOf(change.remove[i])
    if (at >= 0) labels.splice(at, 1)
  }
  for (var j = 0; j < change.add.length; j++) {
    if (labels.indexOf(change.add[j]) < 0) labels.push(change.add[j])
  }
  next.labelIds = labels
  next.unread = labels.indexOf("UNREAD") >= 0
  next.starred = labels.indexOf("STARRED") >= 0
  next.inInbox = labels.indexOf("INBOX") >= 0
  return next
}

function removeById(list, id) {
  var source = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < source.length; i++) {
    if (source[i] && source[i].id === id) continue
    out.push(source[i])
  }
  return out
}

function replaceById(list, summary) {
  var source = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < source.length; i++) {
    out.push(source[i] && summary && source[i].id === summary.id ? summary : source[i])
  }
  return out
}

function indexById(list, id) {
  var source = Array.isArray(list) ? list : []
  for (var i = 0; i < source.length; i++) {
    if (source[i] && source[i].id === id) return i
  }
  return -1
}

function unreadCount(list) {
  var source = Array.isArray(list) ? list : []
  var count = 0
  for (var i = 0; i < source.length; i++) {
    if (source[i] && source[i].unread) count++
  }
  return count
}

// The bar has room for a number, not for a number of digits. Past 99 the exact
// value has stopped being information anyone acts on.
function badgeText(count, cap) {
  var value = Math.max(0, Math.floor(Number(count) || 0))
  var limit = Math.max(1, Math.floor(Number(cap) || 99))
  if (value === 0) return ""
  return value > limit ? limit + "+" : String(value)
}

function barTooltip(state, email, unread) {
  if (state !== "ready") return "Gmail · " + (setupHeadline(state) || "Not connected")
  var address = String(email || "").trim()
  var count = Math.max(0, Math.floor(Number(unread) || 0))
  var suffix = count === 0 ? "No unread mail"
    : (count === 1 ? "1 unread message" : count + " unread messages")
  return address ? address + " · " + suffix : "Gmail · " + suffix
}

// ------------------------------------------------------------ new mail

// Only messages the panel has not seen before, and only ones that are actually
// new rather than merely newly fetched: the first load after start must not
// fire a notification for every message already sitting in the inbox.
function newArrivals(summaries, seenIds, primed) {
  if (!primed) return []
  var list = Array.isArray(summaries) ? summaries : []
  var seen = seenIds || {}
  var arrivals = []
  for (var i = 0; i < list.length; i++) {
    var summary = list[i]
    if (!summary || !summary.unread || !summary.inInbox) continue
    if (seen[summary.id]) continue
    arrivals.push(summary)
  }
  return arrivals
}

// The desktop notification spec says a body may carry a small markup subset,
// and the daemons that implement it read one out of whatever they are handed.
// A subject is a stranger's sentence, so its angle brackets are its own — and
// an <img> left in one is a fetch made by the notification rather than by the
// reader, which is the same beacon by a different door.
//
// A leading "-" is stripped for a different reason: these values become
// arguments to notify-send, and one that starts with a dash is read as an
// option there.
function notificationText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^[-\s]+/, "")
}

function notificationTitle(summary) {
  var title = summary && summary.from ? notificationText(summary.from.display) : ""
  return title === "" ? "New message" : title
}

function notificationBody(summary) {
  if (!summary) return ""
  var subject = notificationText(String(summary.subject || "").trim())
  var snippet = notificationText(String(summary.snippet || "").trim())
  if (!snippet) return subject
  return subject + "\n" + (snippet.length > 140 ? snippet.substring(0, 139) + "…" : snippet)
}

// ------------------------------------------------------------- formatting

function pluralize(count, singular, plural) {
  var value = Math.max(0, Math.floor(Number(count) || 0))
  return value + " " + (value === 1 ? singular : (plural || singular + "s"))
}

function resultSummary(list, estimate, hasMore) {
  var shown = Array.isArray(list) ? list.length : 0
  if (shown === 0) return "No messages"
  if (!hasMore) return pluralize(shown, "message")
  var total = Math.max(shown, Math.floor(Number(estimate) || 0))
  return shown + " of about " + total
}

function statusSummary(syncLabel, resultLabel, loading) {
  var sync = String(syncLabel || "")
  var result = String(resultLabel || "")
  if (loading) return sync
  if (!sync) return result
  if (!result) return sync
  return sync + "  ·  " + result
}

function truncate(text, limit) {
  var value = String(text || "")
  var max = Math.max(4, Math.floor(Number(limit) || 80))
  return value.length <= max ? value : value.substring(0, max - 1) + "…"
}
