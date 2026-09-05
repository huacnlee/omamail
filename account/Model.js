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
  if (value.recoveringSession) return "reconnecting"
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
  if (state === "reconnecting") return "Reconnecting to " + name + "…"
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
  if (state === "reconnecting")
    return "The saved session is intact. Omamail will retry automatically when the network is available."
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
  if (state === "reconnecting") return ""
  if (state === "signed_out") return "Sign in to " + providerName(provider) + "..."
  return ""
}

// --------------------------------------------------------- list behaviour

// After an action the message may no longer belong in the mailbox being
// viewed. Archiving from Inbox removes the row; archiving from All mail does
// not. Getting this wrong either strands a row that is gone or hides one that
// is still there.
// The label a move is aimed at, or "" for every other verb.
//
// The destination travels inside the action string rather than beside it
// because `act` threads one verb through the capability guard, the optimistic
// edit, the cache repair and the restore on failure. A second argument would
// have had to be carried, and correctly put back, by all four.
var MOVE_PREFIX = "label:"

// Gmail's own labels are upper case with no `Label_` prefix; a user's carry one
// or are a folder name on IMAP. Only the second kind is a place a message is
// filed under and can be taken out of. `survivesAction` does not read that
// rule a second time — it asks `labelChangesFor` whether the label actually
// comes off — so the two cannot disagree about a row.
var SYSTEM_LABEL_IDS = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT",
  "DRAFT", "TRASH", "SPAM", "CHAT"]

function isSystemLabelId(id) {
  var value = String(id || "")
  if (SYSTEM_LABEL_IDS.indexOf(value) >= 0) return true
  return value.indexOf("CATEGORY_") === 0
}

function labelTarget(action) {
  var verb = String(action || "")
  if (verb.indexOf(MOVE_PREFIX) !== 0) return ""
  return verb.slice(MOVE_PREFIX.length)
}

// `labels` is whether the provider files by label rather than by folder, which
// is the one thing this cannot infer and the one thing `unarchive` turns on: a
// folder provider answers it with a UID MOVE, so the message leaves the list
// with a new id and a surviving row would point at nothing.
function survivesAction(mailboxKey, action, rawQuery, labels, sourceLabelId) {
  var key = String(mailboxKey || "inbox")
  var verb = String(action || "")
  if (verb === "trash") return key === "trash"
  if (verb === "untrash") return key !== "trash"
  if (verb === "unarchive") {
    // Moving relocates on a folder provider: the message is given a new UID in
    // INBOX, nothing parses COPYUID, and the row it left would point at a
    // message that is no longer there — opening it says so, a star succeeds
    // against nothing, and no reload corrects it.
    if (labels !== true) return false
    // On a label provider the row stays in a mailbox or a search, which still
    // contain it, and leaves a label's list because the label came off. Which
    // of those a label view is, is `labelChangesFor`'s answer rather than a
    // second reading of the same rule here: a system label is not a place a
    // message is filed under, so it stays on the message and the row stays in
    // its list.
    if (String(rawQuery || "") === "") return true
    var filed = String(sourceLabelId || "")
    // A label view with nothing naming its label cannot say the label stayed,
    // so the row goes: a row that leaves and should not have comes back on the
    // reload `invalidatesPage` asks for, and one that stays and should not
    // have is stale until something else reloads the list.
    if (filed === "") return false
    return labelChangesFor("unarchive", filed).remove.length === 0
  }
  // A move takes INBOX away exactly as archive does, so it leaves exactly the
  // lists archive leaves. Said once, because two branches with the same answer
  // are two places for it to drift.
  if (labelTarget(verb) !== "" && String(rawQuery || "") !== "") return false
  if (verb === "archive" || labelTarget(verb) !== "")
    return key !== "inbox" && key !== "unread"
  if (verb === "markRead") return key !== "unread"
  if (verb === "unstar") return key !== "starred"
  return true
}

function labelChangesFor(action, sourceLabelId) {
  if (action === "markRead") return { add: [], remove: ["UNREAD"] }
  if (action === "markUnread") return { add: ["UNREAD"], remove: [] }
  if (action === "star") return { add: ["STARRED"], remove: [] }
  if (action === "unstar") return { add: [], remove: ["STARRED"] }
  if (action === "archive") return { add: [], remove: ["INBOX"] }
  // Moving back to the inbox takes the message out of the label whose list it
  // was found in, the same way a move does and for the same reason: a label
  // somebody files things under is a queue, and one that keeps everything ever
  // put in it only grows. `sourceLabelId` is already "" on a provider whose
  // labels are folders, so a folder name never reaches a Gmail remove list.
  if (action === "unarchive") {
    var filed = String(sourceLabelId || "")
    if (filed === "" || isSystemLabelId(filed)) return { add: ["INBOX"], remove: [] }
    return { add: ["INBOX"], remove: [filed] }
  }
  if (action === "spam") return { add: ["SPAM"], remove: ["INBOX"] }
  // A move is archive with somewhere to go. Where a folder is a label, putting
  // a message in one is adding that label and taking INBOX away -- the same
  // pair archive already writes, with the destination filled in.
  var target = labelTarget(action)
  if (target !== "") {
    var remove = ["INBOX"]
    var source = String(sourceLabelId || "")
    if (source !== "" && source !== target && remove.indexOf(source) < 0)
      remove.push(source)
    return { add: [target], remove: remove }
  }
  return null
}

// The labels a message can be moved into, filtered by what has been typed.
//
// System labels are left out: INBOX, SENT, SPAM and the rest are the mailboxes
// the rail already draws, and offering them here would put two ways of saying
// "archive" in a list whose whole job is the destinations that have no key of
// their own. The label or folder already on screen is not a destination: on
// Gmail it would leave the source label attached while optimistically removing
// its row, and IMAP would be asked to UID MOVE a message into the same folder.
// Sorted by name rather than by the order the provider returned, which on
// Gmail is neither alphabetical nor stable between accounts.
function movableLabels(labels, query, currentLabelId) {
  var candidates = Array.isArray(labels) ? labels : []
  var typed = String(query || "").trim().toLowerCase()
  var current = String(currentLabelId || "")
  var destinations = []
  for (var i = 0; i < candidates.length; i++) {
    var label = candidates[i]
    if (!label || label.system === true) continue
    if (String(label.id || "") === current) continue
    var labelName = String(label.name || "")
    if (typed !== "" && labelName.toLowerCase().indexOf(typed) < 0) continue
    destinations.push(label)
  }
  destinations.sort(function(left, right) {
    var leftName = String(left.name || "").toLowerCase()
    var rightName = String(right.name || "").toLowerCase()
    return leftName < rightName ? -1 : (leftName > rightName ? 1 : 0)
  })
  return destinations
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
  if (labelTarget(verb) !== "") return "move"
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
  if (needs === "move") return name + " has no destination you can name"
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

function applyLabelChange(summary, action, sourceLabelId) {
  if (!summary) return summary
  var change = labelChangesFor(action, sourceLabelId)
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
  // Every flag that mirrors a label, rather than the three that used to be the
  // only ones read. `spam` moves a row between two of these, and a menu asking
  // a stale `inSpam` offers "Move to Inbox" on a message just reported as
  // spam — which would add INBOX and keep SPAM.
  next.inTrash = labels.indexOf("TRASH") >= 0
  next.inSpam = labels.indexOf("SPAM") >= 0
  next.isSent = labels.indexOf("SENT") >= 0
  next.isDraft = labels.indexOf("DRAFT") >= 0
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

function windowPrefs(raw) {
  var parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== "object") {
    return {
      sidebarCollapsed: false,
      bodyZoom: 1,
      bodyMode: "reader",
      alwaysShowImages: false,
      windowOpen: false
    }
  }
  var bodyMode = String(parsed.bodyMode || "")
  if (bodyMode !== "reader" && bodyMode !== "original" && bodyMode !== "plain")
    bodyMode = parsed.plainTextForced === true ? "plain" : "reader"
  return {
    sidebarCollapsed: parsed.sidebarCollapsed === true,
    bodyZoom: clampZoom(parsed.bodyZoom),
    bodyMode: bodyMode,
    alwaysShowImages: parsed.alwaysShowImages === true,
    windowOpen: parsed.windowOpen === true
  }
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

// Search starts with rows found in the query cache, then learns live rows from
// the provider. One id stays one row, live metadata replaces the cached copy,
// and a newly found message takes its chronological place instead of jumping
// around according to which parallel request happened to finish first.
function mergeSearchResults(cached, live) {
  var lists = [Array.isArray(cached) ? cached : [], Array.isArray(live) ? live : []]
  var positions = {}
  var merged = []
  var order = 0
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      var row = lists[l][i]
      var id = String(row && row.id ? row.id : "")
      if (id === "") continue
      if (positions[id] !== undefined) {
        merged[positions[id]].row = row
        continue
      }
      positions[id] = merged.length
      merged.push({ row: row, order: order++ })
    }
  }

  merged.sort(function(a, b) {
    var aTime = a.row && a.row.date && typeof a.row.date.getTime === "function"
      ? Number(a.row.date.getTime()) : 0
    var bTime = b.row && b.row.date && typeof b.row.date.getTime === "function"
      ? Number(b.row.date.getTime()) : 0
    if (aTime !== bTime) return bTime - aTime
    return a.order - b.order
  })
  var out = []
  for (var j = 0; j < merged.length; j++) out.push(merged[j].row)
  return out
}

// Cached matches are only a preview. Once the provider has answered, its ids
// are the boundary of the page: live metadata wins, a cached row may fill in
// for a confirmed id whose metadata read failed, and every unconfirmed cache
// hit disappears. Appending preserves the already settled earlier pages.
function settledSearchResults(existing, preview, live, ids, append) {
  var known = {}
  var cached = Array.isArray(preview) ? preview : []
  var fresh = Array.isArray(live) ? live : []
  for (var i = 0; i < cached.length; i++) {
    if (cached[i] && cached[i].id) known[String(cached[i].id)] = cached[i]
  }
  for (var j = 0; j < fresh.length; j++) {
    if (fresh[j] && fresh[j].id) known[String(fresh[j].id)] = fresh[j]
  }

  var page = []
  var wanted = Array.isArray(ids) ? ids : []
  for (var k = 0; k < wanted.length; k++) {
    var id = String(wanted[k] || "")
    if (known[id]) page.push(known[id])
  }
  return append === true ? mergeSearchResults(existing, page) : page
}

// Server ids without a freshly read summary are a hole in the page. Keeping
// the provider's continuation token would step over that hole forever, even if
// a cached copy can temporarily draw it, so finalisation asks this separately
// from `settledSearchResults`' display fallback.
function missingSearchSummaryIds(summaries, ids) {
  var known = {}
  var rows = Array.isArray(summaries) ? summaries : []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].id) known[String(rows[i].id)] = true
  }
  var missing = []
  var wanted = Array.isArray(ids) ? ids : []
  for (var j = 0; j < wanted.length; j++) {
    var id = String(wanted[j] || "")
    if (id !== "" && !known[id]) missing.push(id)
  }
  return missing
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
    out.push({ kind: "mailbox", key: String(boxes[i].key), name: String(boxes[i].label || ""),
      icon: String(boxes[i].icon || "mail") })
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
                          contentHeight, margin, originY, topMargin, bottomMargin) {
  var top = Number(contentY) || 0
  var view = Number(viewportHeight) || 0
  var y = Number(itemY) || 0
  var height = Number(itemHeight) || 0
  var pad = Number(margin) || 0
  var next = top
  // A row that cannot fit shows its beginning. Aligning its bottom, which is
  // what the off-the-bottom rule would do, pushes the part being read away.
  if (height + pad + pad > view) next = y - pad
  else if (y - pad < top) next = y - pad
  else if (y + height + pad > top + view) next = y + height + pad - view
  // The same range the wheel is held to. Callers that scroll a plain
  // Flickable pass no origin or margins and get the range they had.
  return clampContentY(next, contentYBounds(originY, contentHeight, view,
    topMargin, bottomMargin))
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

// The newest timestamp in a page of rows, in milliseconds, or zero if none of
// them carry one. This is the mailbox's own clock rather than this machine's,
// which is the whole point of it below.
function newestDate(summaries) {
  var list = Array.isArray(summaries) ? summaries : []
  var newest = 0
  for (var i = 0; i < list.length; i++) {
    var summary = list[i]
    if (!summary || !summary.date || typeof summary.date.getTime !== "function") continue
    var time = summary.date.getTime()
    if (isFinite(time) && time > newest) newest = time
  }
  return newest
}

// Only messages the panel has not seen before, and only ones that are actually
// new rather than merely newly fetched: the first load after start must not
// fire a notification for every message already sitting in the inbox.
//
// `seenIds` answers that for everything the first page held, and `floorMs`
// answers it for the rest — an unread message from last year that was never on
// the cached page is not an arrival just because this is the fetch that first
// returned it. The floor is the newest timestamp the mailbox itself reported
// when notifications were primed, so the comparison is the server's clock
// against the server's clock. Taking it from `Date.now()` instead is what made
// a machine whose clock ran fast stop notifying altogether, silently and for
// the whole session: every arrival was older than a "now" that had not
// happened yet on the server.
//
// It is set once and never raised, so a message that arrives out of order —
// which a mailing list does routinely — is still announced.
//
// A row with no usable date is announced rather than dropped. `seenIds` is the
// guard that matters, and a provider that does not date a summary would
// otherwise never notify at all.
function newArrivals(summaries, seenIds, primed, floorMs) {
  if (!primed) return []
  var list = Array.isArray(summaries) ? summaries : []
  var seen = seenIds || {}
  var arrivals = []
  var floor = typeof floorMs === "number" && isFinite(floorMs) && floorMs > 0 ? floorMs : 0
  for (var i = 0; i < list.length; i++) {
    var summary = list[i]
    if (!summary || !summary.unread || !summary.inInbox) continue
    if (seen[summary.id]) continue
    if (floor > 0 && summary.date && typeof summary.date.getTime === "function") {
      var time = summary.date.getTime()
      if (isFinite(time) && time < floor) continue
    }
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

// The status line at the foot of the window: the account, then how current
// its list is. The address is the long part and goes first, where it is
// read; the sync age is short and follows, because "huacnlee@gmail.com ·
// 1m ago" is one fact about one mailbox, and the mailbox is the subject.
//
// The account's own label ("Synced 1m ago") is a sentence for a place with
// room for one. After an address it is a clause, so the verb goes: the
// address is what was synced.
function syncedShort(syncLabel) {
  var label = String(syncLabel || "")
  if (label === "") return ""
  if (label === "Checking for mail") return "checking"
  var match = /^Synced (.+)$/.exec(label)
  return match ? match[1] : label
}

function accountStatusLine(email, syncLabel) {
  var address = String(email || "")
  if (address === "") return "Not connected"
  var age = syncedShort(syncLabel)
  return age === "" ? address : address + " · " + age
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

// ------------------------------------------------------- settings sidebar

// The settings page is one long scroll with a rail of its section names
// beside it. The rail is for getting about, not for splitting the page into
// several: a click scrolls, and the highlight follows the scroll. Both of
// those are decisions about numbers, so they are made here.

function sortedSections(sections) {
  var values = Array.isArray(sections) ? sections.slice() : []
  var known = []
  for (var i = 0; i < values.length; i++) {
    var entry = values[i] || {}
    var y = Number(entry.y)
    if (!isFinite(y) || String(entry.key || "") === "") continue
    known.push({ key: String(entry.key), y: y })
  }
  known.sort(function(a, b) { return a.y - b.y })
  return known
}

// The section the reader is looking at: the last heading at or above the top
// of the viewport, or the first section while the page is above them all.
// This only works because the page is padded so that every heading can reach
// the top (`settingsContentHeight`); without that the last sections could
// never be the answer, and a click on one would highlight its neighbour —
// the one annoyance everyone knows from anchor links.
function activeSettingsSection(sections, contentY) {
  var known = sortedSections(sections)
  if (known.length === 0) return ""
  var top = Number(contentY) || 0
  var active = known[0].key
  for (var i = 0; i < known.length; i++) {
    if (known[i].y <= top) active = known[i].key
  }
  return active
}

// How tall the scrollable content is: the page, or enough more of it that the
// last heading can be scrolled to the top of the viewport. The extra is empty
// space under the page, which is what lets "scroll to Calendars" mean
// Calendars at the top rather than Calendars somewhere in the bottom half.
function settingsContentHeight(sections, pageHeight, viewportHeight) {
  var known = sortedSections(sections)
  var page = Math.max(0, Number(pageHeight) || 0)
  var viewport = Math.max(0, Number(viewportHeight) || 0)
  if (known.length === 0) return page
  return Math.max(page, known[known.length - 1].y + viewport)
}

// --------------------------------------------------- what a scroller can reach
//
// `contentY` does not run from 0 to `contentHeight - height`, which is what
// three separate clamps in this repository assumed.
//
// `originY` moves the start: a `ListView` with a 200-tall header reports
// `originY == -200`, and a clamp with a floor of 0 makes the header
// unreachable and turns the first notch into a 200-pixel jump. Measured, not
// inferred — that view settles at exactly `originY` and at
// `originY + contentHeight - height`.
//
// Margins extend both ends: a `Flickable` with a `topMargin` rests at
// `-topMargin` with its content below the gap, and a clamp with a floor of 0
// answers a scroll *up* at the top by moving *down* to 0, after which the
// margin can never be seen again. (`StopAtBounds` does not correct a
// programmatic assignment, so this end comes from Qt's documented semantics
// rather than from a probe like the `originY` one.)
function contentYBounds(originY, contentHeight, viewportHeight, topMargin, bottomMargin) {
  var origin = Number(originY) || 0
  var content = Number(contentHeight) || 0
  var view = Number(viewportHeight) || 0
  var top = Number(topMargin) || 0
  var bottom = Number(bottomMargin) || 0
  var min = origin - top
  // Content shorter than its own view has one position rather than a negative
  // range, and that position is the top of it.
  var max = Math.max(min, origin + content + bottom - view)
  return { min: min, max: max }
}

function clampContentY(value, bounds) {
  var limits = bounds || { min: 0, max: 0 }
  return Math.max(limits.min, Math.min(limits.max, Number(value) || 0))
}

// ------------------------------------------------------------------ the wheel
//
// How far a wheel turn moves a Flickable, which the Flickable itself gets
// wrong on a mouse that reports finely.
//
// A Flickable answers a wheel event with a *flick* — a velocity it then
// decelerates — so the distance depends on how the turn was chopped up rather
// than on how far the wheel went. One notch arrives as `angleDelta` 120 and
// moves about 72 pixels; a high-resolution wheel reports the same physical
// notch as eight deltas of 15, each starting and damping its own little
// flick, and the same turn of the same wheel moves about 9. Eight times less
// for the same gesture, which is what "slower than every other app" is.
//
// Rotation is the thing that does not change: `angleDelta` is eighths of a
// degree, a notch is 15 degrees, and eight fractions of a notch still add up
// to 15. So the distance is computed from rotation and nothing else, in
// notches rather than in degrees — a notch is the unit a hand turns and 120
// pixels is three lines of text, which is what a GTK application moves for it.
//
// Nothing is capped. A cap on one *event* would put the chunking dependence
// straight back at the coarse end: an MX Master in free spin delivers ten
// notches as one event, and a bound would move it a notch and a half while
// the same ten notches arriving as ten events moved ten. A bound worth having
// would be per unit time, and no bound at all is honest — the wheel was
// turned that far.
var WHEEL_UNITS_PER_NOTCH = 120
var WHEEL_PIXELS_PER_NOTCH = 120

// Numerically the identity at these two values, and written as a ratio anyway:
// the constant that matters is "a notch moves 120 pixels", and it is the one a
// reader changes.
function wheelDistance(angleDelta) {
  return (Number(angleDelta) || 0) / WHEEL_UNITS_PER_NOTCH * WHEEL_PIXELS_PER_NOTCH
}

// Where the view lands, inside what it can actually reach.
function wheelScrollTarget(contentY, angleDelta, contentHeight, viewportHeight,
                           originY, topMargin, bottomMargin) {
  var bounds = contentYBounds(originY, contentHeight, viewportHeight,
    topMargin, bottomMargin)
  return clampContentY((Number(contentY) || 0) - wheelDistance(angleDelta), bounds)
}

// Where a click on a section name scrolls to: its heading, clamped into the
// range the page can actually reach, so the last section lands at the end of
// the page rather than asking for a gap under it. -1 for a name the page does
// not have, which the caller ignores.
function settingsScrollTarget(sections, key, contentHeight, viewportHeight) {
  var known = sortedSections(sections)
  var wanted = String(key || "")
  for (var i = 0; i < known.length; i++) {
    if (known[i].key !== wanted) continue
    var content = Number(contentHeight) || 0
    var viewport = Number(viewportHeight) || 0
    var limit = Math.max(0, content - viewport)
    return Math.max(0, Math.min(known[i].y, limit))
  }
  return -1
}

// ------------------------------------------------------------ the scope

// What the window is looking at, named the way the rail names it: the mailbox
// whose key is open, or the label or folder whose query is. A label is matched
// by the id the rail selected it with first, and by its query second, because
// a folder restored from the store carries the query and nothing else.
//
// The answer is never empty. A key the provider does not list — a cache from an
// older version, a mailbox removed from the provider's table — still names
// itself, capitalised, rather than leaving the header with nothing to say.
function currentScope(mailboxKey, mailboxes, labels, rawQuery, rawLabelId, labelQueryOf) {
  var query = String(rawQuery || "")
  var labelId = String(rawLabelId || "")
  var all = Array.isArray(labels) ? labels : []
  if (query !== "") {
    var i
    for (i = 0; i < all.length; i++) {
      if (!all[i] || all[i].system) continue
      if (labelId !== "" && String(all[i].id || "") === labelId)
        return { kind: "label", id: String(all[i].id || ""),
          name: String(all[i].name || all[i].rawName || ""), icon: "label" }
    }
    for (i = 0; i < all.length; i++) {
      if (!all[i] || all[i].system) continue
      var name = String(all[i].rawName || all[i].name || "")
      if (typeof labelQueryOf === "function" && labelQueryOf(name) === query)
        return { kind: "label", id: String(all[i].id || ""),
          name: String(all[i].name || name), icon: "label" }
    }
    return { kind: "label", id: labelId, name: query, icon: "label" }
  }
  var key = String(mailboxKey || "inbox")
  var boxes = Array.isArray(mailboxes) ? mailboxes : []
  for (var j = 0; j < boxes.length; j++) {
    if (boxes[j] && String(boxes[j].key) === key)
      return { kind: "mailbox", key: key, name: String(boxes[j].label || key),
        icon: String(boxes[j].icon || "mail") }
  }
  return { kind: "mailbox", key: key,
    name: key.charAt(0).toUpperCase() + key.slice(1), icon: "mail" }
}

// The rows the mailbox switcher draws: the rail's own numbered list, each row
// told whether it is the scope on screen. Same slots as the badges and the
// Ctrl digits, so the number a row shows here is the key that opens it from
// the list too.
function switcherRows(slots, labels, scope) {
  var list = Array.isArray(slots) ? slots : []
  var all = Array.isArray(labels) ? labels : []
  var current = scope || {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var slot = list[i]
    if (!slot) continue
    var row = { kind: slot.kind, name: String(slot.name || ""), number: i + 1,
      count: 0, icon: "mail", selected: false }
    if (slot.kind === "mailbox") {
      row.key = String(slot.key || "")
      row.icon = String(slot.icon || "mail")
      row.selected = current.kind === "mailbox" && current.key === row.key
    } else {
      row.id = String(slot.id || "")
      row.icon = "label"
      row.selected = current.kind === "label" && current.id !== "" && current.id === row.id
      for (var j = 0; j < all.length; j++) {
        if (all[j] && String(all[j].id || "") === row.id) {
          row.count = Math.max(0, Math.floor(Number(all[j].unread) || 0))
          if (!row.selected && current.kind === "label" && current.id === "")
            row.selected = String(all[j].rawName || all[j].name || "") === current.name
          break
        }
      }
    }
    out.push(row)
  }
  return out
}

// ------------------------------------------------------------ selection

// The rows checked for a bulk action. A list of ids rather than a flag on the
// summaries, because a summary is what the provider said about a message and
// which rows the user has ticked is not that.
function toggleId(ids, id) {
  var list = Array.isArray(ids) ? ids.slice() : []
  var key = String(id || "")
  if (key === "") return list
  var at = list.indexOf(key)
  if (at >= 0) list.splice(at, 1)
  else list.push(key)
  return list
}

// Every id from one row to another, inclusive, in list order — what a
// Shift+click means. Either end unknown to the list means just the other.
function idsBetween(list, fromId, toId) {
  var source = Array.isArray(list) ? list : []
  var a = indexById(source, fromId)
  var b = indexById(source, toId)
  if (a < 0 && b < 0) return []
  if (a < 0) a = b
  if (b < 0) b = a
  var lo = Math.min(a, b)
  var hi = Math.max(a, b)
  var out = []
  for (var i = lo; i <= hi; i++) out.push(source[i].id)
  return out
}

function unionIds(ids, more) {
  var out = Array.isArray(ids) ? ids.slice() : []
  var extra = Array.isArray(more) ? more : []
  for (var i = 0; i < extra.length; i++) {
    if (out.indexOf(extra[i]) < 0) out.push(extra[i])
  }
  return out
}

// The checked ids that are still listed. A reload, a search or an action can
// take rows away, and a selection that kept naming them would act on messages
// the user can no longer see.
function retainIds(ids, list) {
  var source = Array.isArray(list) ? list : []
  var checked = Array.isArray(ids) ? ids : []
  var out = []
  for (var i = 0; i < checked.length; i++) {
    if (indexById(source, checked[i]) >= 0) out.push(checked[i])
  }
  return out
}

function allIds(list) {
  var source = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < source.length; i++) out.push(source[i].id)
  return out
}

function summariesById(list, ids) {
  var source = Array.isArray(list) ? list : []
  var checked = Array.isArray(ids) ? ids : []
  var out = []
  for (var i = 0; i < checked.length; i++) {
    var index = indexById(source, checked[i])
    if (index >= 0) out.push(source[index])
  }
  return out
}

// Where the cursor goes when several rows leave at once: the first survivor
// after it, or the last one before it. Worked out on the list as it still is,
// like cursorAfterRemoval, and for the same reason.
function cursorAfterRemovals(list, removedIds, cursorId) {
  var source = Array.isArray(list) ? list : []
  var gone = Array.isArray(removedIds) ? removedIds : []
  var index = indexById(source, cursorId)
  if (index < 0) return ""
  var i
  for (i = index; i < source.length; i++) {
    if (gone.indexOf(source[i].id) < 0) return source[i].id
  }
  for (i = index - 1; i >= 0; i--) {
    if (gone.indexOf(source[i].id) < 0) return source[i].id
  }
  return ""
}

// One star key over several rows: they all go the way the majority has not
// gone yet. All starred means unstar; anything else means star, so a mixed
// selection lands in one state rather than swapping every row.
function starActionFor(summaries) {
  var rows = Array.isArray(summaries) ? summaries : []
  if (rows.length === 0) return "star"
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i].starred) return "star"
  }
  return "unstar"
}

// "3 messages archived": the count, then the single-message note with its
// capital taken off. One rule for every action, so a new action's note only
// has to be written once.
function batchNote(count, actionLabel) {
  var label = String(actionLabel || "")
  if (label === "") return pluralize(count, "message")
  return pluralize(count, "message") + " " + label.charAt(0).toLowerCase() + label.slice(1)
}

function selectionStatus(count) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  return n === 0 ? "" : n + " selected"
}
