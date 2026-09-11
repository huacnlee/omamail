.pragma library

// The HEY CLI, as a protocol.
//
// `hey` is the interface 37signals publish for HEY, and it is the only one this
// plugin will use: there is no IMAP, no POP and no public HTTP API, and driving
// app.hey.com's own endpoints would mean replaying a user's password against
// something carrying no compatibility promise.
//
// This file is the argument vectors and the answers, and nothing else. No
// process — `HeyClient.qml` owns that — and no message format, which is
// `Message.js`'s subject. Everything here is pure, so the node tests exercise
// the real strings that reach the real command.
//
// Every command is asked for `--json`, so nothing here ever parses a rendered
// table. The envelope is always `{ ok, data, summary, error, code }`, and a
// command that failed says so in `ok` while still exiting 0 for some errors —
// which is why `payload` checks the envelope rather than the exit status.

// ---------------------------------------------------------------- the boxes

// HEY's own boxes, by the `kind` its API answers with. `hey box` takes these
// names directly. Trash is deliberately not among them: HEY does not serve a
// trash box, and the only way to see what is in it is a search.
var BOXES = ["imbox", "feedbox", "asidebox", "laterbox", "trailbox", "bubblebox"]

// The virtual one. `box:trash` reads like the rest of the DSL and becomes
// `hey search --in trash`, which is the only thing HEY answers for it.
var TRASH = "trash"

// How many postings a query that has to count unseen mail reads. The unread
// badge is a count of unseen postings in the Imbox and HEY serves no count of
// its own, so the only way to have one is to list and tally — and a badge is
// answering "is something waiting", which a hundred answers as well as a
// thousand would.
var UNSEEN_SCAN = 100

// The ceiling `--limit` is given. HEY pages beyond this; the list asks for more
// with the cursor the last answer carried.
var MAX_LIMIT = 100

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isBox(name) {
  var wanted = trimmed(name).toLowerCase()
  for (var i = 0; i < BOXES.length; i++) {
    if (BOXES[i] === wanted) return true
  }
  return false
}

function boundedLimit(value, fallback) {
  var limit = Math.floor(Number(value))
  if (!isFinite(limit) || limit < 1) limit = fallback
  return Math.max(1, Math.min(MAX_LIMIT, limit))
}

// ------------------------------------------------------------- the id pair

// A HEY thread is addressed by two different numbers, and which one a command
// wants is not a detail anything above this file should have to know:
//
//   - the **posting** id is the thread's place in a box, and it is what
//     `seen`, `unseen`, `move`, `trash` and `spam` act on
//   - the **topic** id is the conversation, and it is what `threads`, `reply`
//     and `forward` read and write
//
// So a message id here carries both, the way an IMAP one carries its folder. A
// bare posting id could not be opened and a bare topic id could not be marked
// seen, and finding out which had been stored would be a round trip.
function messageId(postingId, topicId) {
  var posting = trimmed(postingId)
  var topic = trimmed(topicId)
  if (posting === "" && topic === "") return ""
  return posting + ":" + topic
}

function postingIdOf(id) {
  var parts = trimmed(id).split(":")
  return parts.length > 0 ? trimmed(parts[0]) : ""
}

function topicIdOf(id) {
  var parts = trimmed(id).split(":")
  // One half only is what an id written before both were stored would look
  // like; reading it as the topic would open the wrong conversation, so it is
  // read as neither.
  return parts.length > 1 ? trimmed(parts[1]) : ""
}

// ------------------------------------------------------------- the queries

// The strings `Hey.js` produces and this file reads. Opaque everywhere else:
// upstream hands one back to the client that made it and uses it as a cache
// key.
//
//   box:imbox           a box, newest first
//   box:imbox unseen    the same box, only what has not been seen
//   box:trash           the Trash, which is a search because HEY has no box
//   label:4711          one label's threads, by the id `hey labels` gave
//   search:dentist      free text, over every box
//
// `search:` takes the rest of the string verbatim, so a user who types
// `box:imbox` into the search field searches for that text rather than
// selecting a mailbox.
function parseQuery(query) {
  var text = trimmed(query)
  if (text === "drafts:") {
    return { kind: "drafts", box: "", label: "", text: "", unseen: false }
  }
  if (text.indexOf("label:") === 0) {
    return { kind: "label", box: "", label: trimmed(text.slice(6)), text: "", unseen: false }
  }
  if (text.indexOf("search:") === 0) {
    return { kind: "search", box: "", label: "", text: trimmed(text.slice(7)), unseen: false }
  }
  if (text.indexOf("box:") === 0) {
    var rest = trimmed(text.slice(4)).split(/\s+/)
    var box = trimmed(rest[0]).toLowerCase()
    var unseen = false
    for (var i = 1; i < rest.length; i++) {
      if (trimmed(rest[i]).toLowerCase() === "unseen") unseen = true
    }
    if (box === TRASH) return { kind: "trash", box: TRASH, label: "", text: "", unseen: unseen }
    if (!isBox(box)) box = "imbox"
    return { kind: "box", box: box, label: "", text: "", unseen: unseen }
  }
  // Anything unrecognised is the Imbox rather than an error: a query written by
  // a newer build, or left in a cache file, still has to open a window.
  return { kind: "box", box: "imbox", label: "", text: "", unseen: false }
}

// -------------------------------------------------------------- the paging

// A page token here is an offset into one of HEY's pages, and HEY's own cursor
// for that page: "25|eyJ...".
//
// Both halves are needed because of how `--limit` works. The CLI reads pages
// until it has the number asked for, then truncates to it **and drops the
// cursor** — so a limited listing can never be continued. Asking for no limit
// gets HEY's own page with its cursor intact, which means the page size the
// user configured has to be applied here instead. The offset is where in that
// page this request starts; the same page is read again to serve the rest of
// it, exactly as the IMAP client re-runs its SEARCH.
function pageToken(offset, cursor) {
  var at = Math.max(0, Math.floor(Number(offset)) || 0)
  var key = trimmed(cursor)
  if (at === 0 && key === "") return ""
  return at + "|" + key
}

function tokenOffset(token) {
  var text = trimmed(token)
  if (text === "") return 0
  var at = Math.floor(Number(text.split("|")[0]))
  return isFinite(at) && at > 0 ? at : 0
}

function tokenCursor(token) {
  var text = trimmed(token)
  var bar = text.indexOf("|")
  return bar < 0 ? "" : trimmed(text.slice(bar + 1))
}

// How many postings this query has to read in one command. Only the unseen
// filter names a number: the filtering happens here rather than on the server,
// so a page of one would find one unseen message at most however many are
// waiting — and that number is the unread badge. Everything else takes HEY's
// own page, because asking for a size is what throws the cursor away.
function scanLimit(parsed) {
  return parsed && parsed.unseen === true ? UNSEEN_SCAN : 0
}

// The argument vector for a list, after the binary. A box and a label take an
// opaque cursor out of the previous answer's `next_page`; a search takes a page
// number, because HEY's search is numbered and its box index is not.
function listCommand(parsed, maxResults, pageToken) {
  var query = parsed || parseQuery("")
  var limit = scanLimit(query)
  var cursor = tokenCursor(pageToken)

  if (query.kind === "drafts") {
    var drafts = ["draft", "list", "--json"]
    if (cursor !== "") drafts = drafts.concat(["--page", cursor])
    return drafts
  }

  if (query.kind === "label") {
    var label = ["label", query.label, "--json"]
    if (limit > 0) label = label.concat(["--limit", String(limit)])
    if (cursor !== "") label = label.concat(["--page", cursor])
    return label
  }
  if (query.kind === "trash") {
    var trash = ["search", "--in", "trash", "--json"]
    if (cursor !== "") trash = trash.concat(["--page", cursor])
    return trash
  }
  if (query.kind === "search") {
    var search = ["search", query.text, "--json"]
    if (cursor !== "") search = search.concat(["--page", cursor])
    return search
  }
  var box = ["box", query.box, "--json"]
  if (limit > 0) box = box.concat(["--limit", String(limit)])
  if (cursor !== "") box = box.concat(["--page", cursor])
  return box
}

// Reading one thread. `--allow-partial` because a thread too long for the
// loader's own limits is refused outright without it — and a message that
// opens with a note about what is missing beats one that does not open.
function threadCommand(id) {
  var topic = topicIdOf(id)
  if (topic === "") return []
  // Both flags are asked for optimistically, and both are boolean, which is
  // what makes `withoutFlag` a safe answer to a build that has neither.
  //
  // `--html` asks for the sender's own markup, which is what the reader wants:
  // Html.js blocks the images, and text converted to Markdown on the way out of
  // the CLI could not be un-converted here. A build that does not serve it
  // answers with the ordinary JSON envelope instead, whose `body` carries the
  // same message as text — so one invocation covers both and the richer reading
  // arrives by itself when the CLI gains it.
  //
  // `--allow-partial` takes a thread too long for the CLI's own loader limits
  // rather than being refused it. That one is newer than the release most
  // people have, and an unknown flag fails the whole command — see
  // `unknownFlag`.
  return ["threads", topic, "--allow-partial", "--html"]
}

function draftIdOf(id) {
  var match = /^draft:(\d+)$/.exec(trimmed(id))
  return match ? match[1] : ""
}

function draftShowCommand(id) {
  var draft = draftIdOf(id)
  return draft === "" ? [] : ["draft", "show", draft, "--json"]
}

// The flag `hey` said it did not know, out of its own usage error. A release
// older than a flag this plugin asks for refuses the whole command, so the
// client drops the flag and asks again — and remembers, so one round trip pays
// for the whole session rather than every read.
function unknownFlag(text) {
  var body = parseJson(text, null)
  var reported = body && typeof body === "object" ? trimmed(body.error) : trimmed(text)
  var match = /unknown flag:\s*(--[A-Za-z0-9-]+)/.exec(reported)
  return match ? match[1] : ""
}

// A command without one boolean flag. Only ever used on the optional flags
// above, all of which are booleans — dropping a flag that took a value would
// leave its value behind as a positional argument.
function withoutFlag(command, flag) {
  var list = Array.isArray(command) ? command : []
  var wanted = trimmed(flag)
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (String(list[i]) !== wanted) out.push(list[i])
  }
  return out
}

function hasFlag(command, flag) {
  return withoutFlag(command, flag).length !== (Array.isArray(command) ? command.length : 0)
}

// What an action becomes. `MailAccount` speaks Gmail's vocabulary to every
// provider, so the label ids arrive here and become HEY's own verbs.
//
// A verb HEY does not have answers with an empty command rather than with
// something close to it: the panel already hides the buttons this provider does
// not declare, and a "close enough" move is the promise `Registry.capabilities`
// exists to stop being made.
function actionCommand(verb, ids) {
  var name = trimmed(verb)
  var postings = []
  var list = Array.isArray(ids) ? ids : [ids]
  for (var i = 0; i < list.length; i++) {
    var posting = postingIdOf(list[i])
    if (posting !== "" && postings.indexOf(posting) < 0) postings.push(posting)
  }
  if (postings.length === 0) return []

  if (name === "markRead") return ["seen"].concat(postings)
  if (name === "markUnread") return ["unseen"].concat(postings)
  if (name === "trash") return ["trash"].concat(postings)
  if (name === "spam") return ["spam"].concat(postings)
  // Not an archive — HEY has none — but the one move that puts a thread back
  // where a restored message belongs.
  if (name === "untrash") return ["move"].concat(postings, ["--to", "imbox"])
  return []
}

// The label ids `MailAccount` asks for, as one verb. Only the pairs HEY can
// honour are named; everything else is nothing to do, which is what an
// undeclared capability produces anyway.
function verbForLabels(addLabelIds, removeLabelIds) {
  var add = Array.isArray(addLabelIds) ? addLabelIds : []
  var remove = Array.isArray(removeLabelIds) ? removeLabelIds : []
  if (remove.indexOf("UNREAD") >= 0) return "markRead"
  if (add.indexOf("UNREAD") >= 0) return "markUnread"
  if (add.indexOf("SPAM") >= 0) return "spam"
  return ""
}

// Sending. HEY composes and replies for the user rather than accepting a
// message: a reply's recipients are the server's to decide, which is why the
// reply command takes a topic and a body and nothing else.
//
// The body crosses on stdin rather than in `-m`, so a message never reaches the
// process table and nothing has to be escaped on the way.
function composeCommand(fields) {
  var values = fields || {}
  var thread = trimmed(values.threadId)
  var command = []
  if (thread !== "") {
    command = ["reply", thread]
  } else {
    var to = trimmed(values.to)
    if (to === "") return []
    command = ["compose", "--to", to, "--subject", String(values.subject || "")]
    var cc = trimmed(values.cc)
    if (cc !== "") command = command.concat(["--cc", cc])
    var bcc = trimmed(values.bcc)
    if (bcc !== "") command = command.concat(["--bcc", bcc])
  }
  return command.concat(attachArgs(values.attachments))
}

// Saving has the same two shapes as sending, but a new draft needs no
// recipient. HEY keeps the body on stdin and answers the draft id.
function draftCommand(fields) {
  var values = fields || {}
  var thread = trimmed(values.threadId)
  var command = []
  if (thread !== "") {
    command = ["reply", thread, "--draft"]
  } else {
    command = ["compose"]
    var to = trimmed(values.to)
    if (to !== "") command = command.concat(["--to", to])
    command = command.concat(["--subject", String(values.subject || "")])
    var cc = trimmed(values.cc)
    if (cc !== "") command = command.concat(["--cc", cc])
    var bcc = trimmed(values.bcc)
    if (bcc !== "") command = command.concat(["--bcc", bcc])
    command.push("--draft")
  }
  return command.concat(attachArgs(values.attachments))
}

function draftEditCommand(id, fields) {
  var draft = draftIdOf(id)
  if (draft === "") return []
  var values = fields || {}
  return [
    "draft", "edit", draft,
    "--to", String(values.to || ""),
    "--cc", String(values.cc || ""),
    "--bcc", String(values.bcc || ""),
    "--subject", String(values.subject || ""),
    "--message", String(values.body || "")
  ].concat(attachArgs(values.attachments))
}

function attachArgs(files) {
  var list = Array.isArray(files) ? files : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    var path = trimmed(typeof entry === "string" ? entry : (entry && entry.path))
    if (path !== "") out = out.concat(["--attach", path])
  }
  return out
}

function isDroppableFlag(flag) {
  var name = trimmed(flag)
  return name === "--allow-partial" || name === "--html"
}

function statusCommand() {
  return ["auth", "status", "--json"]
}

function loginCommand() {
  return ["auth", "login"]
}

function accountsCommand() {
  return ["accounts", "list", "--json"]
}

function labelsCommand() {
  return ["labels", "--json", "--all"]
}

// ------------------------------------------------------------- the answers

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

// The envelope, unwrapped. `ok: false` is the CLI reporting a refusal it exited
// 0 for, so this is the check rather than the exit status — and an answer that
// is not JSON at all is a `hey` that failed before it could form one.
function payload(text) {
  var body = parseJson(text, null)
  if (!body || typeof body !== "object") {
    return { ok: false, data: null, error: "HEY answered with something this could not read" }
  }
  if (body.ok === false) {
    return { ok: false, data: null, error: trimmed(body.error) || "HEY refused that request" }
  }
  return { ok: true, data: body.data === undefined ? null : body.data, error: "" }
}

function envelopeNextPage(text) {
  var body = parseJson(text, null)
  return body && body.meta ? trimmed(body.meta.next_page) : ""
}

// Whether what came back is a thread as HTML rather than the JSON envelope.
// `hey threads --html` writes a document; a build that does not serve one
// answers with the envelope, and the leading brace is the difference.
function isHtmlDocument(text) {
  var body = trimmed(text)
  return body !== "" && body.charAt(0) !== "{"
}

// One posting, in the shape the client turns into a message. Field for field
// off HEY's own JSON, with the two names a thread goes by kept together.
//
// `seen` is absent rather than false on a posting nobody has read — the API
// omits an empty field — so unread is the absence of a true, not the presence
// of a false.
function posting(raw, boxKind) {
  var entry = raw || {}
  var contacts = Array.isArray(entry.contacts) ? entry.contacts : []
  var sender = entry.creator && entry.creator.email_address ? entry.creator
    : (contacts.length > 0 ? contacts[0] : null)
  var addressed = Array.isArray(entry.addressed_contacts) ? entry.addressed_contacts : []
  var recipients = []
  for (var i = 0; i < addressed.length; i++) {
    var to = addressed[i] || {}
    if (trimmed(to.email_address) !== "")
      recipients.push({ name: trimmed(to.name), email: trimmed(to.email_address) })
  }

  return {
    id: messageId(entry.id, topicIdFromUrl(entry.app_url)),
    postingId: trimmed(entry.id),
    topicId: topicIdFromUrl(entry.app_url),
    subject: trimmed(entry.name),
    snippet: trimmed(entry.summary),
    // The name HEY shows in its own list. A newsletter sent by a machine at a
    // service's address is signed with the name the reader would recognise,
    // and that is the name the row should carry.
    from: {
      name: trimmed(entry.alternative_sender_name)
        || (sender ? trimmed(sender.name) : ""),
      email: sender ? trimmed(sender.email_address) : ""
    },
    to: recipients,
    date: trimmed(entry.active_at) || trimmed(entry.created_at),
    seen: entry.seen === true,
    box: trimmed(boxKind),
    appUrl: trimmed(entry.app_url)
  }
}

// The topic id, out of the posting's own app URL. HEY's box index answers a
// posting id and the address of the conversation it belongs to, and the number
// on the end of that address is the id every read of the thread takes.
function topicIdFromUrl(url) {
  var match = /\/topics\/(\d+)/.exec(trimmed(url))
  return match ? match[1] : ""
}

// `hey box`, `hey label` and `hey collection` all answer with a source and its
// postings; `hey search` answers with a flat list of threads. Both end up here
// as the same rows, so nothing downstream learns which command ran.
function parseListing(data) {
  var rows = []
  if (!data) return rows

  if (Array.isArray(data)) {
    // A search result: a thread, its topic id beside it, and the messages that
    // matched. There is no seen state on one, so a searched row claims none.
    for (var i = 0; i < data.length; i++) {
      var hit = data[i] || {}
      var messages = Array.isArray(hit.messages) ? hit.messages : []
      var newest = messages.length > 0 ? messages[messages.length - 1] : {}
      rows.push({
        id: messageId(hit.id, hit.topic_id),
        postingId: trimmed(hit.id),
        topicId: trimmed(hit.topic_id),
        subject: trimmed(hit.subject),
        snippet: trimmed(newest.summary),
        from: {
          name: trimmed(newest.alternative_sender_name)
            || (newest.creator ? trimmed(newest.creator.name) : ""),
          email: newest.creator ? trimmed(newest.creator.email_address) : ""
        },
        to: [],
        date: trimmed(hit.updated_at) || trimmed(newest.created_at),
        // A search says nothing about what has been read, so a row from one
        // claims to be read rather than inventing a bold line the Imbox would
        // then disagree with.
        seen: true,
        box: "",
        appUrl: trimmed(newest.app_url)
      })
    }
    return rows
  }

  var postings = Array.isArray(data.postings) ? data.postings : []
  var kind = trimmed(data.kind)
  for (var j = 0; j < postings.length; j++) rows.push(posting(postings[j], kind))
  return rows
}

function parseDraftListing(data) {
  var list = Array.isArray(data) ? data : []
  var rows = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var id = trimmed(entry.id)
    if (!/^\d+$/.test(id)) continue
    rows.push({
      id: "draft:" + id,
      draftId: id,
      subject: trimmed(entry.subject),
      snippet: trimmed(entry.summary),
      from: { name: "", email: "" },
      to: [],
      date: trimmed(entry.updated_at),
      seen: true,
      box: "",
      appUrl: "",
      isDraft: true
    })
  }
  return rows
}

function draftAddresses(values) {
  var list = Array.isArray(values) ? values : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var email = trimmed(list[i])
    if (email !== "") out.push({ name: "", email: email })
  }
  return out
}

function parseDraft(data) {
  var entry = data || {}
  var id = trimmed(entry.id)
  return {
    id: /^\d+$/.test(id) ? "draft:" + id : "",
    draftId: /^\d+$/.test(id) ? id : "",
    subject: String(entry.subject || ""),
    body: String(entry.body || ""),
    to: draftAddresses(entry.to),
    cc: draftAddresses(entry.cc),
    bcc: draftAddresses(entry.bcc),
    date: trimmed(entry.updated_at),
    isDraft: true
  }
}

// What HEY offers after the page just read, in its own terms. A box and a label
// carry an opaque cursor; a search is numbered, so the number after this one is
// the answer.
function nextCursor(parsed, data, cursor, rowCount) {
  var query = parsed || parseQuery("")
  // A scan that filtered on unseen read a fixed window rather than a page: past
  // its end there is nothing to continue with, because continuing would page
  // the box while the filter kept discarding.
  if (query.unseen === true) return ""
  if (query.kind === "drafts")
    return data && !Array.isArray(data) ? trimmed(data.next_page) : ""
  if (query.kind === "search" || query.kind === "trash") {
    if (rowCount === 0) return ""
    var page = Math.floor(Number(trimmed(cursor))) || 1
    return String(page + 1)
  }
  if (!data || Array.isArray(data)) return ""
  return trimmed(data.next_page)
}

// The rows this request is for, and the token that continues after them.
//
// HEY's page and the user's page size are two different numbers, and this is
// where they are reconciled: the command read one of HEY's pages, and the size
// the user configured decides how much of it a request gets. Load more asks for
// the same page again at a higher offset until it is used up, and only then
// moves on to HEY's next one.
function pageOf(parsed, data, rows, maxResults, token) {
  var list = Array.isArray(rows) ? rows : []
  var limit = boundedLimit(maxResults, 25)
  var offset = tokenOffset(token)
  var cursor = tokenCursor(token)
  var visible = list.slice(offset, offset + limit)
  var next = ""
  if (offset + limit < list.length) next = pageToken(offset + limit, cursor)
  else {
    var beyond = nextCursor(parsed, data, cursor, list.length)
    next = beyond === "" ? "" : pageToken(0, beyond)
  }
  return { rows: visible, nextPageToken: next, total: list.length }
}

// The rows a query actually wanted. Only the unseen filter narrows anything;
// everything else is served by the command that ran.
function filterRows(parsed, rows) {
  var list = Array.isArray(rows) ? rows : []
  if (!parsed || parsed.unseen !== true) return list
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (!list[i].seen) out.push(list[i])
  }
  return out
}

// `hey labels`, as the shape the sidebar reads. HEY calls them folders and
// addresses them by id, so the id is what `rawName` carries — selecting one in
// the sidebar has to produce `label:<id>`, which is the only thing `hey label`
// takes.
function parseLabels(data) {
  var out = []
  var list = Array.isArray(data) ? data : []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var id = trimmed(entry.id)
    var name = trimmed(entry.name)
    if (id === "" || name === "") continue
    out.push({
      id: id,
      name: name,
      rawName: id,
      system: false,
      unread: 0,
      total: 0,
      threadsUnread: 0
    })
  }
  return out
}

// `hey accounts list`, as this mailbox's address. The list holds an "all" row
// that is a filter rather than an account, and the real ones beside it; the
// first real one is the identity this plugin signed in as.
function parseAccountAddress(data) {
  var list = Array.isArray(data) ? data : []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    if (trimmed(entry.id) === "all") continue
    var email = trimmed(entry.email)
    if (email !== "") return email
  }
  return ""
}

function isAuthenticated(data) {
  var status = data || {}
  return status.authenticated === true && status.expired !== true
}

// The thread's entries, as one HTML document or as text. `--html` gives the
// sender's own markup, which is what the reader is built for; the JSON envelope
// a build without it answers with carries the same message as text.
function parseThread(text) {
  if (isHtmlDocument(text)) return { html: String(text || ""), text: "" }

  var answer = payload(text)
  if (!answer.ok) return { html: "", text: "", error: answer.error }
  var entries = Array.isArray(answer.data) ? answer.data : []
  var parts = []
  for (var i = 0; i < entries.length; i++) {
    var body = trimmed((entries[i] || {}).body)
    if (body !== "") parts.push(body)
  }
  // Oldest first, which is the order HEY serves and the order a conversation
  // reads in. The separator is what the CLI's own reader draws between entries.
  return { html: "", text: parts.join("\n\n───\n\n") }
}

// The web address of one thread. HEY's box index hands over the conversation's
// own URL, and this rebuilds it for a row that came from a search.
//
// There is no box counterpart on purpose. HEY has a URL per box and none for a
// search or a label, so one would answer the Imbox for every mailbox that is
// not the Imbox — see the `webBox` capability, which is off for this provider.
var WEB_BASE = "https://app.hey.com"

// The mailbox itself. HEY opens on the Imbox, which is where a link out of a
// settings row should land whichever mailbox the panel happens to be showing.
function webHomeUrl() {
  return WEB_BASE
}

function webMessageUrl(id) {
  var topic = topicIdOf(id)
  return topic === "" ? WEB_BASE : WEB_BASE + "/topics/" + topic
}

// ----------------------------------------------------------------- safety

// A bearer token, a cookie, or the URL either was pasted into. `hey` prints
// neither in the ordinary course of things, but a verbose failure could — and a
// notice is a place a stranger can read.
function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/(token|cookie|secret|password)([=:]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
}

// What a failed invocation says. `hey` reports its own refusals in the
// envelope; a non-zero exit with nothing to read is the process itself.
function commandError(status, text, detail, fallback) {
  // The envelope's own message when there is one. Read from the JSON directly
  // rather than through `payload`, whose "this could not be read" is about the
  // shape of the answer — and would shadow the real reason, which for a
  // command that never reached HEY is on stderr.
  var body = parseJson(text, null)
  var reported = body && typeof body === "object" ? trimmed(body.error) : ""
  if (reported !== "") return redact(reported)
  var stderr = trimmed(detail)
  if (stderr !== "") return redact(stderr)
  if (status !== 0) return String(fallback || "The hey command failed") + " (exit " + status + ")"
  return String(fallback || "The hey command failed")
}
