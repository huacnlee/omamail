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

function mailboxAfterAccountSwitch(currentKey, targetMailboxes) {
  var key = String(currentKey || "")
  var mailboxes = Array.isArray(targetMailboxes) ? targetMailboxes : []
  for (var i = 0; i < mailboxes.length; i++) {
    if (mailboxes[i] && String(mailboxes[i].key || "") === key) return key
  }
  return ""
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
  // A provider whose sign-in is a program of its own says which program: the
  // generic sentence sends somebody looking through Omarchy for a package this
  // plugin never named.
  if (state === "tools_missing")
    return authKind === "cli" ? "Install the HEY CLI" : "Missing system tools"
  // Three sign-ins, three first steps: a Cloud console, a server and a
  // password, or nothing at all because the provider's own program holds it.
  if (state === "no_credentials") {
    if (authKind === "password") return "Add this mailbox"
    if (authKind === "cli") return "Sign in to " + name
    return "Connect a Google Cloud project"
  }
  if (state === "signing_in") {
    if (authKind === "password") return "Checking the mailbox…"
    if (authKind === "cli") return "Waiting for " + name + "…"
    return "Waiting for Google…"
  }
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
    if (authKind === "cli")
      return "HEY does not speak IMAP or POP, so Omamail reads it through the "
        + "HEY CLI, the client 37signals publish for exactly this. Install it, "
        + "then come back — nothing else here needs setting up."
    return "Omamail needs " + (tools || "a few base tools")
      + " on PATH before it can sign in."
  }
  if (state === "no_credentials") {
    if (authKind === "password")
      return "Enter the server and the password for this mailbox. Most providers want an app password rather than the one you sign in to the website with."
    if (authKind === "cli")
      return "The HEY CLI is installed. Signing in opens HEY in your browser; the token it comes back with is the CLI's own, and Omamail never sees it."
    return "Gmail has no shared app to sign in through, so this plugin uses an OAuth client you own. It takes about two minutes to create."
  }
  if (state === "signing_in") {
    if (authKind === "password") return "Trying the server with those details."
    if (authKind === "cli")
      return "Finish the sign-in in your browser. This window updates by itself."
    return "Finish the sign-in in your browser. This window updates by itself."
  }
  if (state === "signed_out") {
    if (authKind === "password")
      return "This mailbox is set up. Enter its password to let it read your mail."
    if (authKind === "cli")
      return "The HEY CLI is installed but signed out. Sign in to let it read this mailbox."
    return "Your OAuth client is ready. Sign in to let it read this mailbox."
  }
  return ""
}

function setupActionLabel(state, provider, authKind) {
  // Nothing to press: there is no form that would help and no browser to open.
  if (state === "unavailable") return ""
  // The CLI page prints the one line to run rather than offering a button that
  // would pipe a script from the internet into a shell on the user's behalf.
  if (state === "tools_missing")
    return authKind === "cli" ? "Check again" : "See what is missing..."
  if (state === "no_credentials") {
    if (authKind === "password") return "Add the mailbox..."
    // Nothing to configure before signing in: hey holds the whole credential.
    if (authKind === "cli") return "Sign in to " + providerName(provider) + "..."
    return "Set up the OAuth client..."
  }
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

// Which capability an action needs, or "" for the ones every provider has.
//
// The panel hides the *buttons* a provider cannot honour, and for two providers
// that was the whole of it. A key is not a button: `e` and `s` are bound in
// every mail context, so on a provider with neither archive nor star they
// reached `act` regardless — where the optimistic update removed the row from
// the Imbox and the note said "Archived", for a request no server ever saw.
function actionCapability(action) {
  var verb = String(action || "")
  if (verb === "archive" || verb === "unarchive") return "archive"
  if (verb === "star" || verb === "unstar") return "star"
  if (verb === "spam") return "spam"
  return ""
}

// What to say instead of doing it. Named after the thing the service does not
// have rather than after the key, because "e does nothing here" answers a
// question nobody asked.
function actionUnavailable(action, provider) {
  var name = providerName(provider)
  var needs = actionCapability(action)
  if (needs === "archive") return name + " has no archive"
  if (needs === "star") return name + " has no star"
  if (needs === "spam") return name + " has no junk verb to report to"
  return ""
}

// The key-bound actions this provider cannot honour, for the hint row. A hint
// that offers what the provider refuses is the same promise the button rule
// exists to stop, made one line lower down.
function unavailableActions(capabilities) {
  var caps = capabilities || {}
  var out = []
  if (caps.archive !== true) out.push("archive")
  if (caps.star !== true) out.push("star")
  return out
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
// ------------------------------------------------------------- reading zoom
//
// The body's zoom is the one size in the window that belongs to the reader
// rather than to the theme: Omarchy sets the font scale the chrome follows,
// and this is somebody leaning in to one message. It is kept because it is not
// about one message — somebody who needed the text bigger needs it bigger for
// their mail.
//
// A twentieth per step, so Ctrl+scroll lands on values it can land on again
// and a saved one reads back as what was set. The bounds are where a message
// stops being a message: a smudge below, a poster above.
var ZOOM_MIN = 0.6
var ZOOM_MAX = 2.5
var ZOOM_STEPS_PER_UNIT = 20

// What a zoom read back off disk means. Anything that is not a number is a
// file that was hand-edited or never written, and the answer to both is the
// size it shipped at.
function clampZoom(value) {
  if (value === null || value === undefined || value === "") return 1
  var zoom = Number(value)
  if (!isFinite(zoom)) return 1
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
    Math.round(zoom * ZOOM_STEPS_PER_UNIT) / ZOOM_STEPS_PER_UNIT))
}

function zoomAfterStep(zoom, step) {
  var by = Number(step)
  return clampZoom(clampZoom(zoom) + (isFinite(by) ? by : 0))
}

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

// The row a message becomes once it has been opened.
//
// A detail read is authoritative about everything it carries and silent about
// the rest, so it replaces a field rather than blanking one. HEY is where this
// stopped being theoretical: its thread read answers with the conversation's
// entries and carries no subject line of its own, so a row opened before its
// list had loaded would have had the subject the cache knew replaced with
// "(no subject)" — and kept it until the next list load.
//
// "(no subject)" rather than "" because that is what `Message.summarize` calls
// an empty subject line; the summary never reaches here with the empty one.
function detailSummary(previous, summary) {
  if (!summary) return previous
  if (!previous) return summary
  var merged = {}
  for (var key in summary) merged[key] = summary[key]
  if (merged.subject === "(no subject)" && previous.subject) merged.subject = previous.subject
  if (!merged.from || (!merged.from.name && !merged.from.email)) merged.from = previous.from
  if (!merged.snippet) merged.snippet = previous.snippet
  // The three readings of one date, kept together: a row showing yesterday's
  // relative time against today's date is worse than either alone.
  if (!merged.date && previous.date) {
    merged.date = previous.date
    merged.time = previous.time
    merged.fullTime = previous.fullTime
  }
  return merged
}

function indexById(list, id) {
  var source = Array.isArray(list) ? list : []
  for (var i = 0; i < source.length; i++) {
    if (source[i] && source[i].id === id) return i
  }
  return -1
}

function messageById(primary, fallback, id) {
  var first = Array.isArray(primary) ? primary : []
  var index = indexById(first, id)
  if (index >= 0) return first[index]
  var second = Array.isArray(fallback) ? fallback : []
  index = indexById(second, id)
  return index >= 0 ? second[index] : null
}

// The rail as one numbered list, in the order it is drawn: the provider's
// mailboxes first, then the labels or folders the server reported. Both the
// sidebar's badges and the keys that jump read this, so the number beside a row
// and the row a number opens cannot disagree — describing the order twice is
// how they would.
//
// Ten because the keys are digits. Past that a row simply has no number: a
// mailbox nobody can reach by keyboard is honest, and renumbering the rail
// every time the server reports a label would not be.
function sidebarSlots(mailboxes, labels, limit) {
  var max = Math.max(0, Math.floor(Number(limit) || 0))
  var out = []
  var boxes = Array.isArray(mailboxes) ? mailboxes : []
  for (var i = 0; i < boxes.length && out.length < max; i++) {
    if (!boxes[i] || !boxes[i].key) continue
    out.push({ kind: "mailbox", key: String(boxes[i].key), name: String(boxes[i].label || "") })
  }
  var all = Array.isArray(labels) ? labels : []
  for (var j = 0; j < all.length && out.length < max; j++) {
    if (!all[j] || all[j].system) continue
    out.push({ kind: "label", id: String(all[j].id || ""),
      name: String(all[j].rawName || all[j].name || "") })
  }
  return out
}

// What a row's badge says, and 0 for a row past the tenth. One-based, because
// the badge is read by a person rather than indexed by anything.
function slotNumberOf(slots, kind, handle) {
  var list = Array.isArray(slots) ? slots : []
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind !== kind) continue
    if (String(kind === "mailbox" ? list[i].key : list[i].id) !== String(handle)) continue
    return i + 1
  }
  return 0
}

// Where the switcher's cursor lands after a step. It wraps where the message
// list clamps, and the difference is the shape of the two things: a mailbox
// list is long and scrolls, so running off the end has to feel like an end,
// while a menu of two or three accounts that stopped at the bottom would make
// `j` do nothing on the row you use most.
function wrappedIndex(index, delta, count) {
  var total = Math.max(0, Math.floor(Number(count) || 0))
  if (total === 0) return 0
  var from = Math.floor(Number(index) || 0)
  var step = Math.floor(Number(delta) || 0)
  return ((from + step) % total + total) % total
}

// Where the list cursor lands after a step. Anchored on the cursor itself,
// because the cursor and the open message are two different things: nothing is
// open while the list is being walked, and walking must not move the reader.
// Anchoring this on the open message pinned it — every step in the list
// resolved to row 0, and in the reader the anchor never advanced.
function cursorAfterOffset(list, cursorId, delta) {
  var source = Array.isArray(list) ? list : []
  if (source.length === 0) return ""
  var step = Math.floor(Number(delta) || 0)
  var index = indexById(source, cursorId)
  // No cursor, or one whose message has left the list: start from the end the
  // move is coming from, so j opens at the top and k opens at the bottom.
  if (index < 0) return step < 0 ? source[source.length - 1].id : source[0].id
  var next = index + step
  if (next < 0) next = 0
  if (next > source.length - 1) next = source.length - 1
  return source[next].id
}

// Where the cursor goes when the row it is on is about to leave the list.
// Called with the list as it still is, so the departing row still has
// neighbours: the one below takes its place, or the one above at the end.
//
// Leaving the cursor on a row that has gone is not harmless. cursorAfterOffset
// cannot find it, so it restarts at the top — which is how archiving one
// message sent the next j back to the first row.
function cursorAfterRemoval(list, cursorId) {
  var source = Array.isArray(list) ? list : []
  var index = indexById(source, cursorId)
  if (index < 0) return ""
  if (index + 1 < source.length) return source[index + 1].id
  if (index > 0) return source[index - 1].id
  return ""
}

// Where the cursor goes when the whole list is replaced under it — a mailbox
// switch, a search, a refresh that dropped things. The message it was on keeps
// it if it survived; otherwise the top, which is where the eye goes anyway.
function cursorAfterReload(list, cursorId) {
  var source = Array.isArray(list) ? list : []
  if (source.length === 0) return ""
  if (indexById(source, cursorId) >= 0) return cursorId
  return source[0].id
}

// Where the scroller has to sit for a row to be on screen. The list is a Column
// in a Flickable rather than a ListView — the panel already owns a scroller and
// nesting a second one gives every wheel event two plausible targets — so there
// is no positionViewAtIndex, and keyboard movement has to say this itself.
//
// Unchanged while the row is already visible. Recentring on every press would
// drag the list under someone who is only stepping one row down it.
function contentYToReveal(contentY, viewportHeight, itemY, itemHeight,
                          contentHeight, margin) {
  var top = Number(contentY) || 0
  var view = Number(viewportHeight) || 0
  var y = Number(itemY) || 0
  var height = Number(itemHeight) || 0
  var pad = Number(margin) || 0
  var furthest = Math.max(0, (Number(contentHeight) || 0) - view)
  var next = top
  // A row that cannot fit shows its beginning. Aligning its bottom, which is
  // what the off-the-bottom rule would do, pushes the part being read away.
  if (height + pad + pad > view) next = y - pad
  else if (y - pad < top) next = y - pad
  else if (y + height + pad > top + view) next = y + height + pad - view
  if (next < 0) next = 0
  if (next > furthest) next = furthest
  return next
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
  var total = Math.floor(Number(estimate) || 0)
  // A provider whose listing carries no total answers with what it read, which
  // is the number already on screen. "25 of about 25" would be a claim HEY
  // never made; "so far" is the honest reading of the same two numbers, and
  // there is a Load more below it saying the rest exists.
  if (total <= shown) return pluralize(shown, "message") + " so far"
  return shown + " of about " + total
}

function statusSummary(syncLabel) {
  return String(syncLabel || "")
}

// A title cut around the one word in it that is a link.
//
// Only the brand is the link — "Add a HEY mailbox" opens HEY's website from the
// word HEY, not from the whole sentence, because a heading that is entirely a
// link reads as a heading somebody made clickable by accident.
//
// A title that does not contain the brand keeps the link on the mark alone,
// which is what the empty middle says.
function splitBrand(title, brand) {
  var text = String(title === undefined || title === null ? "" : title)
  var word = String(brand === undefined || brand === null ? "" : brand)
  var at = word === "" ? -1 : text.indexOf(word)
  if (at < 0) return { before: text, brand: "", after: "" }
  return {
    before: text.slice(0, at),
    brand: word,
    after: text.slice(at + word.length)
  }
}

function truncate(text, limit) {
  var value = String(text || "")
  var max = Math.max(4, Math.floor(Number(limit) || 80))
  return value.length <= max ? value : value.substring(0, max - 1) + "…"
}
