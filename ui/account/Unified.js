.pragma library

.import "../providers/Registry.js" as Provider

// One list out of several mailboxes.
//
// The panel already reads every list, count and capability off `Service.qml`
// rather than off an account, so a unified view is a different set of answers
// from that same façade rather than a second panel. Nothing above it learns
// that more than one mailbox is involved, which is the same seam
// `Registry.js` is one layer down and the reason these rules are plain
// JavaScript rather than part of the QML that holds the accounts.
//
// What a unified view may offer is decided by intersection throughout: a rail
// row every mailbox has, a button every provider can honour. A row only two of
// three accounts could answer is the promise `Registry.capabilities` exists to
// stop being made, and it would fail after the user had committed to it.

// ------------------------------------------------------------------ merging

// A row's own idea of when it arrived. Providers disagree about the field: a
// Gmail resource carries `internalDate` in milliseconds, an IMAP row the
// INTERNALDATE it was given, and a summarised row a Date. All three sort
// against each other here, so all three are read.
function messageTime(item) {
  var value = item ? item.date : null
  if (value && typeof value.getTime === "function") return value.getTime()
  var numeric = Number(value)
  if (isFinite(numeric) && numeric > 0) return numeric
  var parsed = Date.parse(String(value || ""))
  if (isFinite(parsed) && parsed > 0) return parsed
  return Number(item && item.internalDate) || 0
}

// What breaks a tie between two rows that arrived at the same instant: the
// account and the id together. Without it such a pair could swap places
// between one merge and the next and the cursor would move on its own, which
// is not hypothetical — one message copied to two of these mailboxes arrives
// with the same date in both. `mergeMessages` has already dropped a repeat of
// that pair, so this never answers 0 for two rows that are actually different,
// and the order it completes is total whatever `Array.prototype.sort` does
// with equal keys.
function compareTiebreak(left, right) {
  var leftKey = String(left && left.accountId || "") + " " + String(left && left.id || "")
  var rightKey = String(right && right.accountId || "") + " " + String(right && right.id || "")
  return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0)
}

// Newest first, over rows whose time has already been read.
//
// The time is read on the way into the sort rather than inside it, because
// `messageTime` is not a cheap read: the date it reaches for has crossed from
// the account that owns the row into this engine, and converting it back costs
// about a third of a millisecond. Once per row that is nothing; inside a
// comparator it was the most expensive thing the merged view did, because a
// sort asks several times as many questions as it has rows — a merge of two
// 25-row mailboxes spent 244ms in `sort` and 1ms building the rows it was
// sorting, and spent it again on every list change, of which opening one
// mailbox makes several.
//
// The rows themselves are handed on unchanged: a sort key is this file's
// business and has no place in the shape the panel reads.
function compareTimedRows(left, right) {
  var difference = right.at - left.at
  if (difference !== 0) return difference
  return compareTiebreak(left.row, right.row)
}

// ------------------------------------------------------------------- row ids
//
// A merged row is addressed by account *and* id, for the same reason an IMAP
// message is addressed by folder and UID: an id is unique inside the thing
// that issued it and nowhere else. Two accounts on one IMAP server number
// their INBOXes from 1 apiece, so a bare "42" in a merged list names two
// messages and every action on it is a coin toss.
//
// The panel treats an id as an opaque string — a cursor, a cache key, a
// comparison — so composing one costs nothing above this file, and
// `Service.qml` takes it apart again on the way down to an account. The
// account never sees this shape.
//
// The separator is a unit separator, U+001F, because it has to be a character
// no id can contain — otherwise a bare id reads as a composed one.
//
// A space was the first attempt and was wrong. An address cannot hold one, but
// the *id* can: an IMAP message is `<uid>:<folder>` and a folder is called
// things like "Sent Items", so `"42:Sent Items"` split at its first space into
// the account `"42:Sent"` and the id `"Items"`. That failed safe only because
// no account happens to be named that, which is luck rather than structure.
//
// A control character is structure. Gmail issues hex, HEY issues
// `<posting>:<topic>`, and an IMAP folder cannot carry one — the protocol
// forbids control characters in a mailbox name and `ImapProtocol.quote` drops
// the two that would end a command. So an id containing U+001F is composed and
// one without it is not, with nothing left to guess.
var ID_SEPARATOR = "\u001f"

function unifiedId(accountId, messageId) {
  var account = String(accountId === undefined || accountId === null ? "" : accountId)
  var id = String(messageId === undefined || messageId === null ? "" : messageId)
  if (account === "" || id === "") return ""
  return account + ID_SEPARATOR + id
}

function splitUnifiedId(value) {
  var text = String(value === undefined || value === null ? "" : value)
  var at = text.indexOf(ID_SEPARATOR)
  if (at <= 0) return { accountId: "", id: "" }
  return { accountId: text.substring(0, at), id: text.substring(at + 1) }
}

// Each source is `{ id, label, messages }`. Rows come back copied rather than
// referenced: the account that owns one goes on replacing its own list, and a
// merged row that was the same object would change under the panel between a
// click and the action it starts.
//
// The copy's own `id` is the composed one, so every id the panel holds in a
// unified view addresses exactly one message. `sourceId` keeps what the
// account calls it, `accountId` says whose it is, and `sourceLabel` is what
// the row draws to name the mailbox it came from.
// The oldest row the merge can show without a hole in the middle of it.
//
// Every source is asked for its own page, and the pages do not end at the same
// date. Drawing all of them puts the gap on screen rather than avoiding it: the
// tail of the list is the deepest mailbox's mail with the shallowest one's
// missing from among it, and the row that would have sat there arrives only
// when somebody scrolls further.
//
// So the merge stops at the newest of the sources' own last rows — the
// shallowest watermark. Everything above it is complete, because every source
// has reported down to at least that date. A source that has run out entirely
// sets no watermark: there is nothing more of it to come, so it cannot leave a
// hole.
function pageWatermark(sources) {
  var values = Array.isArray(sources) ? sources : []
  var watermark = 0
  for (var i = 0; i < values.length; i++) {
    var source = values[i] || ({})
    var messages = Array.isArray(source.messages) ? source.messages : []
    if (messages.length === 0) continue
    // Complete sources cannot leave a gap, so they do not hold the list back.
    if (source.hasMore !== true) continue
    var oldest = messageTime(messages[messages.length - 1])
    if (oldest > watermark) watermark = oldest
  }
  return watermark
}

// A thread as the service hands it out, with its member ids composed.
//
// The rail steps from one member to the next and the reader compares the open
// one against `selectedId`, so a raw member id reached no mailbox and the
// comparison never matched: a merged conversation could be drawn and not
// walked. The thread's own id is left alone — it is a provider's handle for a
// conversation and is never routed to a mailbox.
function composeThread(accountId, thread) {
  if (!thread || typeof thread !== "object") return thread
  if (!Array.isArray(thread.memberIds)) return thread
  var out = ({})
  for (var field in thread) out[field] = thread[field]
  var composed = []
  for (var i = 0; i < thread.memberIds.length; i++) {
    composed.push(unifiedId(accountId, thread.memberIds[i]))
  }
  out.memberIds = composed
  return out
}

// The rail's summaries, keyed and self-identifying the way every other row is.
// A stop carries its own id onward to an open and an action, so the key alone
// was not enough.
function composeMembers(accountId, summaries) {
  var source = summaries && typeof summaries === "object" ? summaries : ({})
  var out = ({})
  for (var key in source) {
    var summary = source[key]
    var copy = summary
    if (summary && typeof summary === "object") {
      copy = ({})
      for (var field in summary) copy[field] = summary[field]
      copy.sourceId = String(summary.id || "")
      copy.id = unifiedId(accountId, summary.id)
      if (summary.thread) copy.thread = composeThread(accountId, summary.thread)
    }
    out[unifiedId(accountId, key)] = copy
  }
  return out
}

function mergeMessages(sources) {
  var values = Array.isArray(sources) ? sources : []
  var out = []
  var seen = ({})
  for (var i = 0; i < values.length; i++) {
    var source = values[i] || ({})
    var accountId = String(source.id || "")
    if (accountId === "") continue
    var messages = Array.isArray(source.messages) ? source.messages : []
    for (var j = 0; j < messages.length; j++) {
      var item = messages[j]
      if (!item || String(item.id || "") === "") continue
      // An id is unique inside its own provider and nowhere else: a Gmail id
      // and an IMAP "42:INBOX" have no reason to collide, and two IMAP
      // accounts on one server have every reason to. The key is the pair.
      var key = unifiedId(accountId, item.id)
      if (seen[key] === true) continue
      seen[key] = true
      var copy = ({})
      for (var field in item) copy[field] = item[field]
      copy.sourceId = String(item.id)
      copy.id = key
      copy.accountId = accountId
      // A row's conversation members are addressed like the row: an archive
      // asks whether the reader is showing one of them, against a `selectedId`
      // that carries the mailbox.
      if (item.thread) copy.thread = composeThread(accountId, item.thread)
      copy.sourceLabel = String(source.label || "Mailbox")
      // Read off the copy, whose fields the loop above has already pulled
      // across, rather than reaching into the row a second time.
      out.push({ at: messageTime(copy), row: copy })
    }
  }
  out.sort(compareTimedRows)
  // Truncated at the shallowest watermark, so the list has no hole in the
  // middle of it. A merge of one source, or of sources that have all run out,
  // keeps everything.
  var floor = pageWatermark(values)
  var rows = []
  for (var k = 0; k < out.length; k++) {
    if (floor > 0 && out[k].at < floor) break
    rows.push(out[k].row)
  }
  return rows
}

// Which account a row belongs to. Read out of the id rather than looked up:
// the id carries it, so this answers for a row that has since scrolled out of
// the list or been replaced by a refresh — which an in-memory lookup could
// not, and an action outliving its row is the ordinary case after an archive.
function accountOf(id) {
  return splitUnifiedId(id).accountId
}

// What the owning account calls the same message.
function sourceIdOf(id) {
  return splitUnifiedId(id).id
}

// The row itself, for the reader: a merged row carries the account it came
// from and the account's own copy does not.
function rowOf(messages, id) {
  var values = Array.isArray(messages) ? messages : []
  var wanted = String(id === undefined || id === null ? "" : id)
  if (wanted === "") return null
  for (var i = 0; i < values.length; i++) {
    if (String(values[i] && values[i].id || "") === wanted) return values[i]
  }
  return null
}

// Where the cursor goes on a key press, over the merged order rather than any
// one account's. `Model.js` answers this for a single mailbox and cannot
// answer it here, because neither account knows what sits between its own
// rows.
function cursorOffset(messages, cursorId, delta) {
  var values = Array.isArray(messages) ? messages : []
  if (values.length === 0) return ""
  var step = Math.floor(Number(delta)) || 0
  var at = -1
  var wanted = String(cursorId === undefined || cursorId === null ? "" : cursorId)
  for (var i = 0; i < values.length; i++) {
    if (String(values[i] && values[i].id || "") === wanted) {
      at = i
      break
    }
  }
  // No cursor yet: the first press lands on an end rather than nowhere.
  if (at < 0) return String(values[step < 0 ? values.length - 1 : 0].id || "")
  var next = at + step
  if (next < 0 || next >= values.length) return ""
  return String(values[next].id || "")
}

// ------------------------------------------------------------------ the rail

// The rows every one of these mailboxes has, in the order the first provider
// lists them: a rail is a reading order rather than a set, and taking it from
// one provider keeps Inbox first and Trash last however the others are
// written.
//
// Asked of the provider rather than of the account, because which rows a
// service has is a fact about the service. An account still loading would
// otherwise drop rows out of the rail while it caught up.
// Whether every mailbox in the merge offers this.
//
// Asked of the mailboxes rather than of their providers. A provider id is not
// the whole answer: a host narrows it with the refusals the server reported
// and the mailboxes it turned out not to have, so an account whose server has
// no Archive folder answers `canArchive` false while its provider says yes.
// Intersecting provider ids put that button back in a merged view, and the
// account's own view is right to hide it.
function everyMailboxCan(abilities, capability) {
  var rows = Array.isArray(abilities) ? abilities : []
  if (rows.length === 0) return false
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || rows[i][capability] !== true) return false
  }
  return true
}

// The rail rows every mailbox has, in the first mailbox's order — from each
// one's own directory, for the same reason: a provider row the server does not
// have is a row that cannot be opened.
function sharedMailboxRows(abilities) {
  var rows = Array.isArray(abilities) ? abilities : []
  if (rows.length === 0) return []
  var first = rowsOf(rows[0])
  var out = []
  for (var i = 0; i < first.length; i++) {
    var key = String(first[i].key || "")
    if (key === "") continue
    var everyone = true
    for (var j = 1; j < rows.length; j++) {
      if (!holdsMailbox(rows[j], key)) {
        everyone = false
        break
      }
    }
    if (everyone) out.push(first[i])
  }
  return out
}

function rowsOf(row) {
  return row && Array.isArray(row.mailboxes) ? row.mailboxes : []
}

function holdsMailbox(row, key) {
  var list = rowsOf(row)
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].key || "") === key) return true
  }
  return false
}





// ------------------------------------------------------------------ counting

// Every mailbox's unread, added up. The bar badge already says this; in a
// unified view it is what the Inbox row says too.
function totalUnread(summaries) {
  var values = Array.isArray(summaries) ? summaries : []
  var total = 0
  for (var i = 0; i < values.length; i++) {
    var count = Math.floor(Number(values[i] && values[i].unread))
    if (isFinite(count) && count > 0) total += count
  }
  return total
}

// Loading while any of them is, because a list still gaining rows is still
// loading however many have arrived.
function anyLoading(states) {
  var values = Array.isArray(states) ? states : []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].loading === true) return true
  }
  return false
}

// A unified search asks every mailbox, so its status stays busy until all
// server-side searches have settled.
function anyServerSearchLoading(states) {
  var values = Array.isArray(states) ? states : []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].serverSearchLoading === true) return true
  }
  return false
}

// Conversation support belongs to the row's source. A mixed unified list may
// contain collapsed conversation rows beside ordinary message rows.
function rowIsConversation(row) {
  var thread = row && row.thread
  return !!thread && Number(thread.count) >= 2
}

// Loaded only once all of them are: "nothing here" is a claim about every
// mailbox, and one that has not answered is enough to make it wrong.
// Whether the list is done, which is what decides between a skeleton, an
// empty placeholder and neither.
//
// A mailbox that has stopped on an error has finished as far as the list is
// concerned: it will never set `loaded`, and requiring it to held the panel on
// a blank slot indefinitely — no skeleton, no "Nothing here", nothing — for as
// long as one account stayed signed out. What went wrong is `firstError`'s to
// say; this only answers whether anything is still on its way. A mailbox that
// is loading *and* holding an earlier error is still on its way.
function allLoaded(states) {
  var values = Array.isArray(states) ? states : []
  if (values.length === 0) return false
  for (var i = 0; i < values.length; i++) {
    var state = values[i]
    if (!state) return false
    if (state.loaded === true) continue
    if (state.loading !== true && String(state.error || "").trim() !== "") continue
    return false
  }
  return true
}

// More to fetch while any mailbox has more, since the merge cannot be complete
// until every source is.
function anyHasMore(states) {
  var values = Array.isArray(states) ? states : []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].hasMore === true) return true
  }
  return false
}

// The first error any mailbox reported, named with the mailbox it came from.
// "Fastmail: the server refused that command" is actionable where a bare
// sentence about a server is not, once three servers are involved.
function firstError(states) {
  var values = Array.isArray(states) ? states : []
  for (var i = 0; i < values.length; i++) {
    var state = values[i] || ({})
    var text = String(state.error || "").trim()
    if (text === "") continue
    var label = String(state.label || "").trim()
    return label === "" ? text : label + ": " + text
  }
  return ""
}
