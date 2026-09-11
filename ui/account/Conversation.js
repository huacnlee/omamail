.pragma library

.import "../message/Message.js" as Mail

// The conversation the reader is inside, as the rail draws it.
//
// A row stands for a conversation and opens its representative in the
// single-message reader; the rail beside the body is the rest of it — every
// counted member, newest first, as a stop that opens in the same reader. What a
// stop shows, which stops are still owed a summary, where `n` and `p` land, and
// which conversation survives a move between members are all decisions rather
// than drawing, so they live here and the view binds to them.
//
// The `thread` block is `Message.threadOf`'s: `{ id, count, unread, flagged,
// memberIds }`, with `count` always `memberIds.length` and 0 meaning *unknown*
// rather than empty — which is what every provider that does not collapse its
// listing reports, HEY included. Nothing here draws anything for an unknown
// conversation, and that is what keeps the rail off HEY's reader.

// Two is the floor. One message has nowhere to go, and a count of 0 is a
// provider that never grouped its listing rather than a conversation with
// nothing in it.
var MINIMUM_MEMBERS = 2

// How many member summaries are worth keeping. A long session opens many
// conversations and every stop it drew is a summary that will never be asked
// for again; this is a cache of the recent ones rather than a record of the
// mailbox, so the bound is a reset rather than an eviction queue.
var MAX_REMEMBERED = 500

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/^\s+|\s+$/g, "")
}

// A block, whatever shape it arrived in, or null when there is none. Read
// rather than trusted: a summary restored from the cache predates blocks
// entirely, and `thread` is simply absent on it. The normalisation is
// `Message.normalizeThread`'s, the one every row's block goes through.
function blockOf(value) {
  if (!value || typeof value !== "object") return null
  return Mail.normalizeThread(value, "")
}

// Whether one member, on its own, carries a label. A summary's `unread` and
// `starred` are `Message.summarize`'s reading of the *row*: the label, or any
// counted member's — so a representative that has been read while a reply has
// not is still an unread row. A stop in the rail is one message, and asking
// the row's flag drew a dot on the representative for every unread reply and
// counted it in the caption. The label list is the member's own; the flag is
// only the fallback for a summary that carries none, and the flag's name is
// the label's — `UNREAD` is `unread`, `STARRED` is `starred` — so the label
// alone says which.
var FLAG_OF_LABEL = { UNREAD: "unread", STARRED: "starred" }

function memberHasLabel(summary, label) {
  if (!summary || typeof summary !== "object") return false
  var wanted = trimmed(label).toUpperCase()
  if (Array.isArray(summary.labelIds)) return summary.labelIds.indexOf(wanted) >= 0
  var flag = FLAG_OF_LABEL[wanted]
  return flag !== undefined && summary[flag] === true
}

function threadOfSummary(summary) {
  if (!summary || typeof summary !== "object") return null
  return blockOf(summary.thread)
}

// Whether this conversation is one the rail has anything to say about. The
// provider's `conversations` capability is the gate above it: a listing that
// was never collapsed has no members to draw.
function drawsRail(conversations, block) {
  if (conversations !== true) return false
  var thread = blockOf(block)
  return !!thread && thread.count >= MINIMUM_MEMBERS
}

function holdsMember(block, id) {
  var thread = blockOf(block)
  if (!thread) return false
  return thread.memberIds.indexOf(trimmed(id)) >= 0
}

// The conversation the reader is inside after a message is opened.
//
// Held across a move rather than re-read from the message: a member opened on
// its own carries no block at all — a detail read is one message and says
// nothing about the thread it belongs to — so recomputing here would empty the
// rail underneath the person walking it. Opening anything that is not a member
// of the held conversation is leaving it, and then the new message's own block
// is the answer.
function threadAfterSelect(current, id, summary) {
  if (holdsMember(current, id)) return current
  var block = threadOfSummary(summary)
  return block && block.count >= MINIMUM_MEMBERS ? block : null
}

// ------------------------------------------------------------ the summaries

// Message id to summary, merged with what a read just answered. Bounded the way
// the client's own thread maps are: past the ceiling the store is dropped
// whole, because an entry old enough to be evicted belongs to a conversation
// closed long ago.
//
// Except the conversation on screen. `kept` is its member ids, and they
// survive the reset: the read that tips the store over the ceiling is usually
// the one for the rail being drawn, and dropping the stops it had already
// seeded — the representative's, a member opened before — redrew them as
// skeletons that nothing would ever fill in again.
function mergedSummaries(existing, additions, limit, kept) {
  var source = existing && typeof existing === "object" ? existing : {}
  var extra = additions && typeof additions === "object" ? additions : {}
  var cap = Math.floor(Number(limit))
  if (isFinite(cap) && cap > 0) {
    var held = 0
    for (var counted in source) {
      held = held + 1
      if (held >= cap) break
    }
    if (held >= cap) {
      var survivors = {}
      var ids = Array.isArray(kept) ? kept : []
      for (var k = 0; k < ids.length; k++) {
        var wanted = trimmed(ids[k])
        if (wanted !== "" && source[wanted]) survivors[wanted] = source[wanted]
      }
      source = survivors
    }
  }
  var out = {}
  for (var key in source) out[key] = source[key]
  for (var added in extra) {
    var id = trimmed(added)
    if (id !== "" && extra[added]) out[id] = extra[added]
  }
  return out
}

// The one summary this id resolves to, or null.
function summaryFor(summaries, id) {
  var store = summaries && typeof summaries === "object" ? summaries : {}
  var found = store[trimmed(id)]
  return found && typeof found === "object" ? found : null
}

// The members the rail has no summary for, in `memberIds` order.
//
// Asked before a read rather than after it: `memberIds` is known the moment the
// row is opened and a summary is not, which is why the rail draws a skeleton
// stop per id and nothing moves when the summaries land.
function missingMemberIds(block, summaries) {
  var thread = blockOf(block)
  if (!thread) return []
  var out = []
  for (var i = 0; i < thread.memberIds.length; i++) {
    if (summaryFor(summaries, thread.memberIds[i])) continue
    out.push(thread.memberIds[i])
  }
  return out
}

// ------------------------------------------------------------ where it sits

// A label the shared message resource carries, to the rail row that is the
// mailbox it means. Drafts before Inbox because a draft answering a thread sits
// in both and "Drafts" is the one that says where to find it; Trash and Junk
// before either for the same reason.
var MAILBOX_OF_LABEL = [
  { label: "TRASH", key: "trash" },
  { label: "SPAM", key: "spam" },
  { label: "DRAFT", key: "drafts" },
  { label: "SENT", key: "sent" },
  { label: "INBOX", key: "inbox" }
]

// Which of the account's mailboxes a member sits in, or "" when its labels name
// none of them — a message filed somewhere with no rail row of its own. Unknown
// is drawn as nothing rather than guessed at: naming the wrong mailbox under a
// sender is worse than naming none.
function mailboxKeyOf(summary) {
  var labels = summary && Array.isArray(summary.labelIds) ? summary.labelIds : []
  for (var i = 0; i < MAILBOX_OF_LABEL.length; i++) {
    if (labels.indexOf(MAILBOX_OF_LABEL[i].label) >= 0) return MAILBOX_OF_LABEL[i].key
  }
  return ""
}

// The mailbox the reader is looking at, as a member would name it. Unread and
// Flagged are two readings of the Inbox rather than mailboxes of their own, so
// a member in the Inbox is inside both of them; a search is a view of the
// account rather than of any mailbox, which is why every member carries a name
// there.
function viewedMailboxKey(mailboxKey, searching) {
  if (searching === true) return ""
  var key = trimmed(mailboxKey)
  if (key === "unread" || key === "starred") return "inbox"
  return key
}

function mailboxLabel(mailboxes, key) {
  var list = Array.isArray(mailboxes) ? mailboxes : []
  var wanted = trimmed(key)
  if (wanted === "") return ""
  for (var i = 0; i < list.length; i++) {
    if (list[i] && trimmed(list[i].key) === wanted) return String(list[i].label || "")
  }
  return ""
}

// The mailbox name a stop carries under its sender, and "" when it carries
// none. The name is the account's own — the one the sidebar draws — rather than
// the server's, so a member says where to go and find it.
function mailboxNameFor(summary, viewKey, mailboxes) {
  var key = mailboxKeyOf(summary)
  if (key === "") return ""
  if (key === trimmed(viewKey)) return ""
  return mailboxLabel(mailboxes, key)
}

// ----------------------------------------------------------------- the stops

function senderOf(summary) {
  var from = summary && summary.from ? summary.from : null
  if (!from) return ""
  var display = trimmed(from.display)
  return display !== "" ? display : trimmed(from.email)
}

// The rail's order: newest at the top. `memberIds` is `Thread/get`'s own
// order, `receivedAt` ascending, and stays that way as data; the rail reads it
// the other way up, because the newest message is the one a long conversation
// is opened for and the oldest are the ones worth a scroll to reach.
function railOrder(thread) {
  var ids = thread.memberIds.slice()
  ids.reverse()
  return ids
}

// Every member as a stop, newest first, with the open message in its place
// rather than lifted out of the timeline.
//
// A stop whose summary has not arrived is `known` false and carries nothing
// else: the view draws a skeleton in the date and sender lanes, in a stop of
// the same height — the mailbox name shares the date's line for that reason —
// so the rail does not move when the read answers.
function stops(block, summaries, openId, viewKey, mailboxes) {
  var thread = blockOf(block)
  if (!thread) return []
  var open = trimmed(openId)
  var out = []
  var ids = railOrder(thread)
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    var summary = summaryFor(summaries, id)
    out.push({
      id: id,
      known: !!summary,
      open: id === open,
      sender: summary ? senderOf(summary) : "",
      time: summary ? String(summary.time || "") : "",
      fullTime: summary ? String(summary.fullTime || "") : "",
      unread: memberHasLabel(summary, "UNREAD"),
      flagged: memberHasLabel(summary, "STARRED"),
      mailbox: summary ? mailboxNameFor(summary, viewKey, mailboxes) : ""
    })
  }
  return out
}

function pluralize(count, singular, plural) {
  return String(count) + " " + (count === 1 ? singular : plural)
}

// What the rail is captioned with: how long the conversation is, and how much
// of it is still unread.
//
// The unread count is of the members whose summaries have arrived, so it grows
// with them rather than claiming a number before it can be known. The length
// never does: `memberIds` is complete from the moment the row was read.
function caption(block, summaries) {
  var thread = blockOf(block)
  if (!thread || thread.count < MINIMUM_MEMBERS) return ""
  var unread = 0
  for (var i = 0; i < thread.memberIds.length; i++) {
    if (memberHasLabel(summaryFor(summaries, thread.memberIds[i]), "UNREAD"))
      unread = unread + 1
  }
  var text = pluralize(thread.count, "message", "messages")
  return unread > 0 ? text + " · " + unread + " unread" : text
}

// ----------------------------------------------------------------- moving

// Where `n` and `p` land, and "" when there is nowhere to go.
//
// `n` is the next stop down the rail as it is drawn, which is the older
// message, and `p` the one above, which is the newer: the keys follow the
// picture, the way `j` and `k` follow the list.
//
// Stops at the ends rather than wrapping. The rail is a timeline and a
// conversation has a first message and a last one; walking off either end and
// arriving at the other says the thread is a ring, which it is not — and the
// list cursor, which does wrap, is a different thing being moved.
// The stop the reader moves to when this member leaves the rail: the newer
// one above it, else the older one below, else "" for a conversation with no
// other stop. Asked before the action, while the member is still a stop —
// afterwards the block has been recomputed without it and there is nothing to
// be beside.
function neighbourStop(block, memberId) {
  var thread = blockOf(block)
  if (!thread || thread.count === 0) return ""
  var ids = railOrder(thread)
  var index = ids.indexOf(trimmed(memberId))
  if (index < 0) return ""
  if (index > 0) return ids[index - 1]
  return ids.length > 1 ? ids[1] : ""
}

function memberStep(block, openId, delta) {
  var thread = blockOf(block)
  if (!thread || thread.count === 0) return ""
  var step = Math.floor(Number(delta) || 0)
  var ids = railOrder(thread)
  var index = ids.indexOf(trimmed(openId))
  // The open message is not a member of this conversation, which is a rail
  // drawn for a message that left it. `n` takes the top stop and `p` the
  // bottom, the way a list cursor with nowhere to be starts from the end the
  // move came from.
  if (index < 0) return step < 0 ? ids[ids.length - 1] : ids[0]
  var next = index + step
  if (next < 0 || next > ids.length - 1) return ""
  return ids[next]
}
