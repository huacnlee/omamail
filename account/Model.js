.pragma library

// View models. Anything the panel decides — what the setup card should say,
// whether a message still belongs in the list after an action, what the badge
// reads — is decided here so the QML stays a description of the screen.
//
// What is *not* here is anything that differs between mail services. That is
// `Provider.js`, and this file is the half that is the same whichever one an
// account runs on.

// The mailboxes themselves live in `Provider.js`, because which ones exist and
// what selects them is a property of the mail service rather than of the view.
// They were here first, and a copy left behind would be a second definition to
// keep in step with the first — so the account hands its list down instead.

// ------------------------------------------------------------ setup state

// A setup page opened for a known provider must not change type while saving
// rebuilds the service's current account. During that one frame the service
// reports its compatibility fallback (Gmail), not a user choice.
function setupProvider(chosen, live) {
  var stable = String(chosen === undefined || chosen === null ? "" : chosen).trim()
  if (stable !== "") return stable
  return String(live === undefined || live === null ? "" : live).trim() || "gmail"
}

// One value the panel can switch on, in the order a new user meets them.
function setupState(status) {
  var value = status || {}
  if (!value.toolsPresent) return "tools_missing"
  if (!value.credentialsPresent) return "no_credentials"
  if (value.signingIn) return "signing_in"
  if (!value.signedIn) return "signed_out"
  return "ready"
}

// The setup card, in words that fit the service the account actually runs on.
// `provider` is the display name ("Gmail", "IMAP") and `authKind` is how it
// signs in — the two things that change every sentence below. Both default to
// Gmail's, because that is what an account with no provider recorded is.
function providerName(provider) {
  var name = String(provider === undefined || provider === null ? "" : provider).trim()
  return name === "" ? "Gmail" : name
}

function setupHeadline(state, provider, authKind) {
  var name = providerName(provider)
  if (state === "unavailable") return name + " integration is coming later"
  if (state === "tools_missing") return "Missing system tools"
  // Only one of these sends the user to a Cloud console. The other needs a
  // server and a password, which is a form rather than a project.
  if (state === "no_credentials")
    return authKind === "password" ? "Add this mailbox" : "Connect a Google Cloud project"
  if (state === "signing_in")
    return authKind === "password" ? "Checking the mailbox…" : "Waiting for Google…"
  if (state === "signed_out") return "Sign in to " + name
  return ""
}

// `unavailable` carries its reason from the provider rather than from here:
// only the provider knows why it cannot be reached, and a sentence written in
// this file would go stale the day that changes.
function setupDetail(state, missingTools, reason, provider, authKind) {
  var name = providerName(provider)
  if (state === "unavailable") return String(reason || "")
  if (state === "tools_missing") {
    var tools = Array.isArray(missingTools) ? missingTools.join(", ") : ""
    return "Omamail needs " + (tools || "a few base tools")
      + " on PATH before it can sign in."
  }
  if (state === "no_credentials")
    return authKind === "password"
      ? "Enter the server and the password for this mailbox. Most providers want an app password rather than the one you sign in to the website with."
      : "Gmail has no shared app to sign in through, so this plugin uses an OAuth client you own. It takes about two minutes to create."
  if (state === "signing_in")
    return authKind === "password"
      ? "Trying the server with those details."
      : "Finish the sign-in in your browser. This window updates by itself."
  if (state === "signed_out")
    return authKind === "password"
      ? "This mailbox is set up. Enter its password to let it read your mail."
      : "Your OAuth client is ready. Sign in to let it read this mailbox."
  return ""
}

function setupActionLabel(state, provider, authKind) {
  // Nothing to press: there is no form that would help and no browser to open.
  if (state === "unavailable") return ""
  if (state === "tools_missing") return "See what is missing..."
  if (state === "no_credentials")
    return authKind === "password" ? "Add the mailbox..." : "Set up the OAuth client..."
  if (state === "signing_in") return "Cancel"
  if (state === "signed_out") return "Sign in to " + providerName(provider) + "..."
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

// Skeleton rows replace only an empty list's first fetch. Loading another page
// leaves useful messages in place and reports its progress at the list foot.
function showInitialListSkeleton(loading, messageCount) {
  return !!loading && Math.max(0, Number(messageCount) || 0) === 0
}

function showListFooter(messageCount) {
  return Math.max(0, Number(messageCount) || 0) > 0
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

function barTooltip(state, email, unread, provider, authKind) {
  var name = providerName(provider)
  if (state !== "ready")
    return name + " · " + (setupHeadline(state, name, authKind) || "Not connected")
  var address = String(email || "").trim()
  var count = Math.max(0, Math.floor(Number(unread) || 0))
  var suffix = count === 0 ? "No unread mail"
    : (count === 1 ? "1 unread message" : count + " unread messages")
  return address ? address + " · " + suffix : name + " · " + suffix
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
