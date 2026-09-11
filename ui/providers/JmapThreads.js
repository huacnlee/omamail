.pragma library

.import "JmapProtocol.js" as Protocol

// One row per conversation.
//
// `JmapProtocol.js` is the protocol — every string sent to a server and every
// decision about what came back. This is one job done with it, and it is a file
// of its own for the reason `HeyCli.js` is: the four-call chain, the rule about
// which members a row counts and the block a row draws from are one subject,
// and they are the only part of a JMAP list that is about a conversation rather
// than about a message.
//
// A *conversation* is what a row stands for: a server thread as seen from one
// query. Its *representative* is the message the server returns for it, the
// newest member matching the query — so in the Unread view a thread is
// represented by its unread reply rather than by its first message. Its
// *counted members* are the members the row counts and reads flags from.
//
// Four chained calls, one POST, measured at 21 ms against the reference server:
//
//   0  Email/query  collapsed, so its ids are one representative per thread
//   1  Email/get    those ids, for `threadId` alone
//   2  Thread/get   those thread ids, for every member id, oldest first
//   3  Email/get    every member, for `mailboxIds` and `keywords`
//
// The back-references are what make it one request rather than four: a page's
// ids are not known here until the server answers, and a client that waited to
// learn them would pay a round trip per link in that chain. That is the whole
// of why the product spec's "one row per message" — which rested on thread
// aggregation costing an extra round trip per page — does not bind here.

var CALL_QUERY = "0"
var CALL_REPRESENTATIVES = "1"
var CALL_THREADS = "2"
var CALL_MEMBERS = "3"

// The representative read asks for `threadId` and nothing else. The row's own
// summary is fetched by `getMessages` with the full list property set a moment
// later, so asking for it twice would double the page's cost to save nothing.
var REPRESENTATIVE_PROPERTIES = ["id", "threadId"]

// What a member is counted and read by: which mailboxes it sits in, for the
// Gmail rule below, and its keywords, for the row's unread and flagged. Not its
// subject, its sender or its preview — a member is a number on a row here, and
// the conversation rail asks for what it draws, when it draws it.
var MEMBER_PROPERTIES = ["id", "threadId", "mailboxIds", "keywords"]

// A JMAP back-reference: "the value at this path in the result of that call".
// RFC 8620 section 3.7. `/list/*/threadId` is every `threadId` in a `/get`'s
// list, flattened, which is exactly the argument the next call wants.
function backReference(callId, name, path) {
  return { resultOf: String(callId), name: String(name), path: String(path) }
}

// The four calls one collapsed page is read with.
function listCalls(accountId, filter, limit, token, byPosition) {
  var account = Protocol.trimmed(accountId)
  return [
    ["Email/query", Protocol.emailQuery(account, filter, limit, token, byPosition), CALL_QUERY],
    ["Email/get", {
      accountId: account,
      "#ids": backReference(CALL_QUERY, "Email/query", "/ids"),
      properties: REPRESENTATIVE_PROPERTIES
    }, CALL_REPRESENTATIVES],
    ["Thread/get", {
      accountId: account,
      "#ids": backReference(CALL_REPRESENTATIVES, "Email/get", "/list/*/threadId")
    }, CALL_THREADS],
    ["Email/get", {
      accountId: account,
      "#ids": backReference(CALL_THREADS, "Thread/get", "/list/*/emailIds"),
      properties: MEMBER_PROPERTIES
    }, CALL_MEMBERS]
  ]
}

// The member read again, by id, for the follow-up after the server refused to
// answer the whole of it in one call.
function memberGet(accountId, ids) {
  return {
    accountId: Protocol.trimmed(accountId),
    ids: Array.isArray(ids) ? ids : [],
    properties: MEMBER_PROPERTIES
  }
}

// The invocation the request labelled `callId`, as `{ name, arguments }`, or
// null when the reply carries none.
//
// Read by the label rather than by the method name, because two calls in this
// request are both `Email/get` and `responseArguments` would answer with the
// first of them for either question. A call the server refused answers under
// the same label with the name `error`, which is how the too-large member read
// is told from one that came back empty.
function invocationAt(responses, callId) {
  var list = Protocol.invocations(responses)
  var wanted = Protocol.trimmed(callId)
  for (var i = 0; i < list.length; i++) {
    if (list[i].callId === wanted) return { name: list[i].name, arguments: list[i].arguments }
  }
  return null
}

// The arguments of that invocation when it answered, and null when it was
// refused or is absent — so a caller never reads an `error`'s arguments as if
// they were a result.
function argumentsAt(responses, callId) {
  var found = invocationAt(responses, callId)
  if (!found || found.name === "" || found.name === "error") return null
  return found.arguments
}

// The `list` of a `/get` reply, as an array.
function getList(args) {
  var body = args && typeof args === "object" ? args : {}
  return Array.isArray(body.list) ? body.list : []
}

// Every representative on the page and the thread it stands for, in page order:
//
//   [{ id: "maaaaaf", threadId: "d" }, ...]
function representativeThreads(responses) {
  var list = getList(argumentsAt(responses, CALL_REPRESENTATIVES))
  var out = []
  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {}
    var id = Protocol.trimmed(row.id)
    var threadId = Protocol.trimmed(row.threadId)
    if (id === "" || threadId === "") continue
    out.push({ id: id, threadId: threadId })
  }
  return out
}

// Thread id to its member ids, oldest first — which is the order `Thread/get`
// answers in (RFC 8621 section 3, `receivedAt` ascending). The conversation
// rail draws them the other way up; that is `Conversation.railOrder`'s
// decision, not this list's.
function threadMembers(responses) {
  var list = getList(argumentsAt(responses, CALL_THREADS))
  var out = {}
  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {}
    var id = Protocol.trimmed(row.id)
    if (id === "") continue
    var ids = Array.isArray(row.emailIds) ? row.emailIds : []
    var members = []
    for (var j = 0; j < ids.length; j++) {
      var member = Protocol.trimmed(ids[j])
      if (member !== "") members.push(member)
    }
    out[id] = members
  }
  return out
}

// Every member id the threads on this page name, once each, in page order.
// This is what the fourth call asks for through its back-reference, and what
// the follow-up asks for by id when the server refuses to answer it in one go.
function memberIdsOf(representatives, threads) {
  var reps = Array.isArray(representatives) ? representatives : []
  var map = threads && typeof threads === "object" ? threads : {}
  var seen = {}
  var out = []
  for (var i = 0; i < reps.length; i++) {
    var members = map[reps[i].threadId]
    if (!Array.isArray(members)) continue
    for (var j = 0; j < members.length; j++) {
      if (seen[members[j]]) continue
      seen[members[j]] = true
      out.push(members[j])
    }
  }
  return out
}

// Member id to the member itself.
function memberIndex(list) {
  var rows = Array.isArray(list) ? list : []
  var out = {}
  for (var i = 0; i < rows.length; i++) {
    var id = Protocol.trimmed((rows[i] || {}).id)
    if (id !== "") out[id] = rows[i]
  }
  return out
}

// The one mailbox a query is a view of, or "" for a search — which is a view of
// the account rather than of a mailbox. `filterFor` already decides this for
// the request; asking it again is what keeps the counted-members rule and the
// filter from ever disagreeing about which mailbox is open.
function viewedMailbox(parsed, roles) {
  var filter = Protocol.filterFor(parsed, roles)
  if (!filter || typeof filter.inMailbox !== "string") return ""
  return Protocol.trimmed(filter.inMailbox)
}

// Gmail's rule: every member of the thread not in Junk or Trash, and in the
// Junk and Trash views only the members in that mailbox.
//
// `Thread/get` answers with the whole thread across every mailbox — the seeded
// thread's first message sits in the Inbox and in Drafts and is listed once —
// so a rule is needed and this is it. A sent reply counts, which is what makes
// the Sent view one row for a thread answered three times. A trashed message
// neither counts nor keeps a conversation unread.
//
// The view is taken from the query rather than from a role, so selecting the
// Junk mailbox out of the folder list means the same thing as the rail's own
// Junk row: both resolve to the same mailbox id.
function countedMembers(members, roles, query) {
  var list = Array.isArray(members) ? members : []
  var map = roles || {}
  var parsed = query && typeof query === "object" ? query : Protocol.parseQuery(query)
  var viewed = viewedMailbox(parsed, map)
  var junk = Protocol.trimmed(map.junk)
  var trash = Protocol.trimmed(map.trash)
  var only = viewed !== "" && (viewed === junk || viewed === trash) ? viewed : ""

  var out = []
  for (var i = 0; i < list.length; i++) {
    var member = list[i]
    if (!member || typeof member !== "object") continue
    if (only !== "") {
      if (Protocol.inMailbox(member, only)) out.push(member)
      continue
    }
    if (junk !== "" && Protocol.inMailbox(member, junk)) continue
    if (trash !== "" && Protocol.inMailbox(member, trash)) continue
    out.push(member)
  }
  return out
}

// The `thread` block a row carries:
//
//   { id, count, unread, flagged, memberIds }
//
// `memberIds` are the counted members oldest first and `count` is their length.
// A count of 0 means unknown and draws no badge, which is what every provider
// that does not collapse its listing reports. `unread` is true when any counted
// member lacks `$seen`, `flagged` when any has `$flagged` — so the row tells the
// truth about the whole conversation rather than about the one message the
// server happened to return for it.
function threadBlockFor(threadId, members, roles, query) {
  var counted = countedMembers(members, roles, query)
  var ids = []
  var unread = false
  var flagged = false
  for (var i = 0; i < counted.length; i++) {
    ids.push(Protocol.trimmed(counted[i].id))
    if (!Protocol.hasKeyword(counted[i], "$seen")) unread = true
    if (Protocol.hasKeyword(counted[i], "$flagged")) flagged = true
  }
  return {
    id: Protocol.trimmed(threadId),
    count: ids.length,
    unread: unread,
    flagged: flagged,
    memberIds: ids
  }
}

// Representative id to its block, for every row on the page.
//
// A member id the read did not answer for is dropped rather than counted as
// unknown: `Thread/get` and the member read are the same request, so the only
// way one goes missing is a message destroyed between the two calls, and a row
// counting a message that no longer exists is worse than a row counting one
// fewer.
function threadBlocks(representatives, threads, members, roles, query) {
  var reps = Array.isArray(representatives) ? representatives : []
  var map = threads && typeof threads === "object" ? threads : {}
  var index = members && typeof members === "object" ? members : {}
  var out = {}
  for (var i = 0; i < reps.length; i++) {
    var ids = Array.isArray(map[reps[i].threadId]) ? map[reps[i].threadId] : []
    var list = []
    for (var j = 0; j < ids.length; j++) {
      if (index[ids[j]]) list.push(index[ids[j]])
    }
    out[reps[i].id] = threadBlockFor(reps[i].threadId, list, roles, query)
  }
  return out
}

// The mailboxes one member sits in, as a plain list of ids.
function mailboxIdsOf(email) {
  var ids = (email || {}).mailboxIds
  var out = []
  if (!ids || typeof ids !== "object") return out
  for (var key in ids) {
    if (!Protocol.isSet(ids[key])) continue
    var id = Protocol.trimmed(key)
    if (id !== "") out.push(id)
  }
  return out
}

// Message id to the mailboxes it sits in, for every member the read answered
// with. The client keeps this across reads: an action on a conversation acts on
// members the list never drew a row for, and where each of them sits is what
// decides whether archiving the conversation should move it at all.
function membershipsFrom(list) {
  var rows = Array.isArray(list) ? list : []
  var out = {}
  for (var i = 0; i < rows.length; i++) {
    var id = Protocol.trimmed((rows[i] || {}).id)
    if (id === "") continue
    out[id] = mailboxIdsOf(rows[i])
  }
  return out
}

// What the client keeps of the pages it has read, in entries. Both maps below
// are caches of the recent pages rather than a record of the account, so the
// bound is a reset rather than an eviction queue: an entry old enough to be
// dropped belongs to a row that left the window long ago.
var MAX_REMEMBERED = 2000

// One of those maps, merged with what a page just read.
function mergedInto(existing, additions, limit) {
  var source = existing && typeof existing === "object" ? existing : {}
  var extra = additions && typeof additions === "object" ? additions : {}
  var cap = Math.floor(Number(limit))
  if (isFinite(cap) && cap > 0) {
    var held = 0
    for (var counted in source) {
      held = held + 1
      if (held >= cap) break
    }
    if (held >= cap) source = {}
  }
  var out = {}
  for (var key in source) out[key] = source[key]
  for (var added in extra) out[added] = extra[added]
  return out
}

// ------------------------------------------------------ acting on a row

// The `Email/set` groups one action over one or many ids amounts to.
//
// A batch is not always one patch. An action on a conversation is sent for
// every counted member, and `patchFor` answers per member — so archiving a
// thread whose reply is in Sent yields the archive patch for the members that
// were in the Inbox and nothing at all for the reply. Grouping by the patch,
// rather than sending one request per id, keeps "mark these read" over a page
// at one request per chunk and leaves the single-message case exactly one call.
//
// Returns an array of `{ ids, patch }` in first-appearance order, or the
// refusal sentence `patchFor` answered with — the same two types the caller
// already tells apart. Ids are deduped, a member the map excludes is dropped
// rather than sent an empty patch, and an action every member is excluded from
// is an empty plan and no request at all.
function patchPlan(ids, addLabelIds, removeLabelIds, roles, memberships) {
  var map = memberships && typeof memberships === "object" ? memberships : {}
  var list = Protocol.uniqueIds(ids)
  // The membership map keeps archive and spam off the members a *row* action
  // reached without being asked about — a sent reply, a message a filter
  // filed — and that is the only thing it is for. One id is the message the
  // user acted on, whether it came from a row of one or from the reader, and
  // its move is sent whatever the map says: otherwise the same key on the same
  // message archived it when the last read had not carried it and quietly did
  // nothing when it had, and said "Archived" both times.
  var expanded = list.length > 1
  var groups = []
  var byPatch = {}
  for (var i = 0; i < list.length; i++) {
    var id = list[i]
    var known = expanded && Array.isArray(map[id]) ? map[id] : null
    var patch = Protocol.patchFor(addLabelIds, removeLabelIds, roles, known)
    // One refusal is the whole action's: the destination mailbox is missing
    // from the account rather than from this member.
    if (typeof patch === "string") return patch
    if (Protocol.patchIsEmpty(patch)) continue
    var key = JSON.stringify(patch)
    if (byPatch[key] === undefined) {
      byPatch[key] = groups.length
      groups.push({ ids: [id], patch: patch })
    } else {
      groups[byPatch[key]].ids.push(id)
    }
  }
  return groups
}

// One collapsed page reply, read whole:
//
//   { page, blocks, memberships, pending }
//
// `page` is what `listMessages` answers with. `blocks` is representative id to
// the row's `thread` block, `memberships` is member id to its mailbox ids, and
// `pending` is the member ids still owed — non-empty only when the server
// refused the member call while answering the other three, which is what
// `requestTooLarge` on a page of long threads looks like. The client then
// fetches those ids in chunks and reads the same reply again with `members`
// supplied, so the page is delivered only once every row has its block.
function collapsedPage(responses, limit, roles, query, members) {
  var page = Protocol.queryPage(argumentsAt(responses, CALL_QUERY), limit)
  var reps = representativeThreads(responses)
  var threads = threadMembers(responses)
  var supplied = Array.isArray(members) ? members : null
  var answered = argumentsAt(responses, CALL_MEMBERS)
  // Refused, not empty: `argumentsAt` answers null for a call that came back an
  // `error` and for one the reply never carried, and either is a member read
  // this page has not had.
  var owed = supplied === null && answered === null ? memberIdsOf(reps, threads) : []
  var list = supplied !== null ? supplied : getList(answered)
  return {
    page: page,
    blocks: owed.length > 0 ? {}
      : threadBlocks(reps, threads, memberIndex(list), roles, query),
    memberships: membershipsFrom(list),
    pending: owed
  }
}
