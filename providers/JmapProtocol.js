.pragma library

// What a JMAP server is spoken to with.
//
// The transport is `JmapClient.qml` and the description the panel reads is
// `Jmap.js`. This file is the part worth testing: what a session resource
// means, what one of this provider's query strings decomposes into, and how a
// batch of method calls is assembled. It knows nothing about QML.
//
// JMAP differs from IMAP in one way that shapes everything here: a request is
// a *list* of method calls, and a later call may name an earlier one's result
// instead of waiting for it. A page of mail is therefore one round trip rather
// than a list call plus a fetch per message — which is the whole reason this
// provider exists alongside `imap`.

var SESSION_PATH = "/jmap/session"

// The capability URNs this provider asks about by name. A server advertises
// what it supports in the session resource; anything not advertised is a verb
// the panel must not offer.
var CORE = "urn:ietf:params:jmap:core"
var MAIL = "urn:ietf:params:jmap:mail"
var SUBMISSION = "urn:ietf:params:jmap:submission"

// Servers we know something about that the protocol cannot tell us: where the
// session lives when the user typed a bare domain, and whether a verb this
// plugin would otherwise refuse is honest here.
//
// `junkTrains` is the interesting field. `Imap.js` declines a spam verb
// outright because moving a message to a folder teaches a generic server
// nothing, and a button that quietly means "move" is a promise the provider
// cannot keep. On a host that learns from its Junk mailbox the button is
// honest, so the knowledge lives here rather than being assumed of everyone.
var PRESETS = [
  {
    id: "fastmail",
    label: "Fastmail",
    hosts: ["fastmail.com", "api.fastmail.com", "fastmail.fm", "messagingengine.com"],
    sessionHost: "api.fastmail.com",
    junkTrains: true,
    tokenUrl: "https://app.fastmail.com/settings/security/tokens",
    tokenHint: "Settings → Privacy & Security → Manage API tokens",
    webMessage: "https://app.fastmail.com/mail/search:id%3A",
    webHome: "https://app.fastmail.com/mail/"
  }
]

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// ------------------------------------------------------------------- hosts

// A host is what the user typed into the setup page, so it may be a bare
// domain, a host with a scheme in front of it, or a whole session URL pasted
// out of a wiki. All three are the same server.
function normalizeHost(value) {
  var text = trimmed(value).toLowerCase()
  if (text === "") return ""
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  text = text.replace(/\/.*$/, "")
  text = text.replace(/:\d+$/, "")
  return text
}

function isValidHost(value) {
  var host = normalizeHost(value)
  if (host === "") return false
  if (host.indexOf(".") < 0) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
}

// Matches on the host itself and on any parent of it, so a preset naming
// "fastmail.com" also answers for "api.fastmail.com" without listing every
// subdomain a server might answer on.
function presetFor(value) {
  var host = normalizeHost(value)
  if (host === "") return null
  for (var i = 0; i < PRESETS.length; i++) {
    var hosts = PRESETS[i].hosts
    for (var j = 0; j < hosts.length; j++) {
      if (host === hosts[j] || host.length > hosts[j].length + 1
          && host.substring(host.length - hosts[j].length - 1) === "." + hosts[j]) {
        return PRESETS[i]
      }
    }
  }
  return null
}

// Where to ask for the session. A preset redirects to the host that actually
// serves it — mail arrives at fastmail.com, the API does not live there.
function sessionUrl(value) {
  var preset = presetFor(value)
  var host = preset ? preset.sessionHost : normalizeHost(value)
  return host === "" ? "" : "https://" + host + SESSION_PATH
}

// ----------------------------------------------------------------- session

// The session resource answers four questions at once: whether the token
// works, which account it is for, where method calls go, and whether push is
// available at all. Setup asks it before saving anything, so a token missing a
// scope is reported as the missing scope rather than as a failure later on.
function parseSession(raw, host) {
  var body = raw && typeof raw === "object" ? raw : null
  if (!body) return { ok: false, error: "The server did not answer with a JMAP session." }

  var capabilities = body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {}
  if (!capabilities[CORE]) return { ok: false, error: "The server does not advertise JMAP core." }
  if (!capabilities[MAIL]) return { ok: false, error: "This token has no access to mail." }

  var accounts = body.primaryAccounts && typeof body.primaryAccounts === "object" ? body.primaryAccounts : {}
  var accountId = trimmed(accounts[MAIL])
  if (accountId === "") return { ok: false, error: "The session names no mail account." }

  var core = capabilities[CORE] && typeof capabilities[CORE] === "object" ? capabilities[CORE] : {}

  return {
    ok: true,
    error: "",
    accountId: accountId,
    apiUrl: trimmed(body.apiUrl),
    downloadUrl: trimmed(body.downloadUrl),
    uploadUrl: trimmed(body.uploadUrl),
    // Absent on a server with no push at all, which is why the client must
    // keep the polling path rather than treating SSE as the normal case.
    eventSourceUrl: trimmed(body.eventSourceUrl),
    username: trimmed(body.username),
    state: trimmed(body.state),
    canSend: !!capabilities[SUBMISSION],
    canPush: trimmed(body.eventSourceUrl) !== "",
    junkTrains: !!(presetFor(host) && presetFor(host).junkTrains),
    // Honoured on every batch: a request over the server's stated ceiling is
    // rejected whole, so the client splits rather than discovering this per call.
    maxCallsInRequest: typeof core.maxCallsInRequest === "number" ? core.maxCallsInRequest : 16,
    maxObjectsInGet: typeof core.maxObjectsInGet === "number" ? core.maxObjectsInGet : 500
  }
}

// ------------------------------------------------------------------ queries

// This provider's query strings, decomposed. The strings are opaque above
// `Registry.js` — handed back to the client that produced them and used as a
// cache key — so this grammar is read here and nowhere else.
//
//   role:inbox            the inbox, whatever this server calls it
//   role:inbox unread     and only what has not been seen
//   role:inbox flagged
//   mailbox:"Receipts"    a mailbox chosen by name in the sidebar
//   role:inbox text "..." what the search box produced
function parseQuery(query) {
  var text = trimmed(query)
  var out = { role: "inbox", mailbox: "", unread: false, flagged: false, text: "" }
  if (text === "") return out

  var scope = text.match(/^role:(\S+)\s*([\s\S]*)$/)
  if (scope) {
    out.role = scope[1].toLowerCase()
    text = trimmed(scope[2])
  } else {
    var named = text.match(/^mailbox:(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*([\s\S]*)$/)
    if (named) {
      out.mailbox = named[1] !== undefined ? named[1].replace(/\\(.)/g, "$1") : named[2]
      out.role = ""
      text = trimmed(named[3])
    }
  }

  var words = text.match(/^([\s\S]*?)\btext\s+"((?:[^"\\]|\\.)*)"\s*$/)
  if (words) {
    out.text = words[2].replace(/\\(.)/g, "$1")
    text = trimmed(words[1])
  }

  var flags = text.split(/\s+/)
  for (var i = 0; i < flags.length; i++) {
    if (flags[i].toLowerCase() === "unread") out.unread = true
    if (flags[i].toLowerCase() === "flagged") out.flagged = true
  }

  return out
}

// A parsed query plus the mailbox ids this account actually has becomes the
// filter `Email/query` takes. Returns null when the query names a mailbox the
// account does not have — the caller shows an empty mailbox rather than
// sending a filter the server would reject.
function filterFor(parsed, mailboxes) {
  var wanted = parsed || parseQuery("")
  var map = mailboxes && typeof mailboxes === "object" ? mailboxes : {}
  var byRole = map.roles && typeof map.roles === "object" ? map.roles : {}
  var byName = map.names && typeof map.names === "object" ? map.names : {}

  var id = ""
  if (wanted.mailbox !== "") id = trimmed(byName[wanted.mailbox])
  else if (wanted.role !== "" && wanted.role !== "all") id = trimmed(byRole[wanted.role])

  if (wanted.mailbox !== "" && id === "") return null
  if (wanted.role !== "" && wanted.role !== "all" && id === "") return null

  var conditions = []
  if (id !== "") conditions.push({ inMailbox: id })
  // `$seen` and `$flagged` are keywords rather than fields, so "unread" is the
  // absence of one. `notKeyword` says that in one term; a client that fetched
  // and filtered would page through mail it then threw away.
  if (wanted.unread) conditions.push({ notKeyword: "$seen" })
  if (wanted.flagged) conditions.push({ hasKeyword: "$flagged" })
  if (wanted.text !== "") conditions.push({ text: wanted.text })

  if (conditions.length === 0) return {}
  if (conditions.length === 1) return conditions[0]
  return { operator: "AND", conditions: conditions }
}

// ------------------------------------------------------------ method calls

// The properties a list row draws. Asked for by name because `Email/get` with
// no `properties` returns every header and the whole body structure for each
// message, which is most of a megabyte for a page nobody has opened yet.
var LIST_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
  "from", "to", "cc", "replyTo", "subject", "preview", "hasAttachment"
]

// One request, three calls: what mailboxes exist, which messages match, and
// the headers of those messages. The third names the second's result rather
// than waiting for it, which is the round trip this provider is here to save.
function pageRequest(accountId, filter, limit, position) {
  var account = trimmed(accountId)
  var count = typeof limit === "number" && limit > 0 ? limit : 25
  var start = typeof position === "number" && position > 0 ? position : 0

  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Mailbox/get", { accountId: account, ids: null }, "mailboxes"],
      ["Email/query", {
        accountId: account,
        filter: filter || {},
        sort: [{ property: "receivedAt", isAscending: false }],
        position: start,
        limit: count,
        calculateTotal: true
      }, "query"],
      ["Email/get", {
        accountId: account,
        "#ids": { resultOf: "query", name: "Email/query", path: "/ids" },
        properties: LIST_PROPERTIES
      }, "messages"]
    ]
  }
}

// Just the mailboxes. Issued once per session, before the first page: a query
// names a role, and the id that role belongs to is not known until this has
// answered. Every later page carries `Mailbox/get` along anyway, so this runs
// exactly once on a cold client.
function mailboxesRequest(accountId) {
  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Mailbox/get", { accountId: trimmed(accountId), ids: null }, "mailboxes"]
    ]
  }
}

// What changed since a state string. The reply is small when nothing has, which
// is what makes polling a reasonable stage rather than a placeholder for push.
function changesRequest(accountId, sinceState, maxChanges) {
  var account = trimmed(accountId)
  var limit = typeof maxChanges === "number" && maxChanges > 0 ? maxChanges : 50
  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/changes", { accountId: account, sinceState: trimmed(sinceState), maxChanges: limit }, "changes"],
      ["Email/get", {
        accountId: account,
        "#ids": { resultOf: "changes", name: "Email/changes", path: "/created" },
        properties: LIST_PROPERTIES
      }, "created"]
    ]
  }
}

// ---------------------------------------------------------------- responses

// A JMAP request answers 200 while individual calls inside it failed, so the
// status code is not the answer the way it is for Gmail's REST endpoints.
// Every reader goes through here rather than indexing into the array, because
// a server may return the calls in any order and may return fewer than were
// asked for.
function responseFor(body, callId) {
  var responses = body && Array.isArray(body.methodResponses) ? body.methodResponses : []
  var wanted = trimmed(callId)
  for (var i = 0; i < responses.length; i++) {
    var entry = responses[i]
    if (Array.isArray(entry) && entry.length >= 3 && trimmed(entry[2]) === wanted) {
      return { name: trimmed(entry[0]), payload: entry[1] || {} }
    }
  }
  return null
}

// The first call that came back as an error, described the way the panel shows
// it. "error" is JMAP's name for a failed call, so a response of that name is
// the failure regardless of which call produced it.
function methodError(body) {
  var responses = body && Array.isArray(body.methodResponses) ? body.methodResponses : []
  for (var i = 0; i < responses.length; i++) {
    var entry = responses[i]
    if (Array.isArray(entry) && trimmed(entry[0]) === "error") {
      var payload = entry[1] || {}
      var type = trimmed(payload.type)
      if (type === "unknownMethod") return "This server does not support one of the methods used."
      if (type === "accountNotFound") return "The account is no longer on this server."
      if (type === "forbidden") return "This token is not allowed to do that."
      if (type === "rateLimit") return "The server is rate limiting; try again shortly."
      return trimmed(payload.description) || (type === "" ? "The server rejected the request." : type)
    }
  }
  return ""
}

// `Email/set` reports failure per object, so a batch of twenty-five can half
// succeed. The ids that did not move are named so the list can put them back
// rather than showing an archive that did not happen.
function setFailures(payload) {
  var body = payload && typeof payload === "object" ? payload : {}
  var notUpdated = body.notUpdated && typeof body.notUpdated === "object" ? body.notUpdated : {}
  var out = []
  for (var id in notUpdated) {
    if (!notUpdated.hasOwnProperty(id)) continue
    var reason = notUpdated[id] && typeof notUpdated[id] === "object" ? notUpdated[id] : {}
    out.push({ id: id, type: trimmed(reason.type), description: trimmed(reason.description) })
  }
  return out
}

// HTTP-level failures, which are the ones a method response never sees.
function responseError(status, payload, fallback) {
  var code = typeof status === "number" ? status : 0
  var body = payload && typeof payload === "object" ? payload : {}
  var detail = trimmed(body.detail) || trimmed(body.description)

  if (code === 401) return "The token was refused. It may have been revoked."
  if (code === 403) return detail || "The token is missing a scope this needs."
  if (code === 404) return "No JMAP service answered at that address."
  if (code === 429) return "The server is rate limiting; try again shortly."
  if (code === 0) return trimmed(fallback) || "The server could not be reached."
  if (code >= 500) return "The server failed to answer (" + code + ")."
  return detail || trimmed(fallback) || "The request failed (" + code + ")."
}

// ------------------------------------------------------------- messages

// JMAP hands back structured fields; everything above a provider reads the
// shape Gmail's API returns, which `ImapClient` also builds. So a JMAP message
// is adapted here rather than the panel learning a second shape.
//
// A list row gets synthesised headers and no body: the fields JMAP already
// sent are exactly the headers a row draws, and asking for the body of
// twenty-five messages nobody has opened would undo the round trip this
// provider exists to save. The body arrives later, as the raw message, so
// `Message.parseRfc822` handles it unchanged.

function addressText(list) {
  var entries = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {}
    var email = trimmed(entry.email)
    if (email === "") continue
    var name = trimmed(entry.name)
    // JSON.stringify quotes and escapes exactly what a display name needs.
    out.push(name === "" ? email : JSON.stringify(name) + " <" + email + ">")
  }
  return out.join(", ")
}

// Unread is the absence of `$seen`, which is the one inversion in the mapping
// and the easiest thing to get backwards.
function labelIdsFor(email, rolesById) {
  var message = email || {}
  var keywords = message.keywords && typeof message.keywords === "object" ? message.keywords : {}
  var ids = []
  if (!keywords["$seen"]) ids.push("UNREAD")
  if (keywords["$flagged"]) ids.push("STARRED")
  if (keywords["$draft"]) ids.push("DRAFT")

  var byId = rolesById && typeof rolesById === "object" ? rolesById : {}
  var boxes = message.mailboxIds && typeof message.mailboxIds === "object" ? message.mailboxIds : {}
  for (var id in boxes) {
    if (!boxes.hasOwnProperty(id) || !boxes[id]) continue
    var role = String(byId[id] || "")
    if (role === "inbox") ids.push("INBOX")
    else if (role === "sent") ids.push("SENT")
    else if (role === "trash" && ids.indexOf("TRASH") < 0) ids.push("TRASH")
    else if (role === "drafts" && ids.indexOf("DRAFT") < 0) ids.push("DRAFT")
    else if (role === "junk") ids.push("SPAM")
  }
  return ids
}

function headersFor(email) {
  var message = email || {}
  var headers = []
  function push(name, value) {
    var text = trimmed(value)
    if (text !== "") headers.push({ name: name, value: text })
  }
  push("From", addressText(message.from))
  push("To", addressText(message.to))
  push("Cc", addressText(message.cc))
  push("Reply-To", addressText(message.replyTo))
  push("Subject", message.subject)
  push("Date", message.receivedAt)
  // `messageId` is a list in JMAP because the header may legitimately repeat.
  var ids = Array.isArray(message.messageId) ? message.messageId : []
  if (ids.length > 0) push("Message-ID", "<" + trimmed(ids[0]) + ">")
  return headers
}

// `receivedAt` is ISO 8601; the panel sorts and groups on milliseconds.
function receivedMs(value) {
  var parsed = Date.parse(String(value || ""))
  return isFinite(parsed) ? parsed : 0
}

function messageFrom(email, rolesById) {
  var message = email || {}
  return {
    id: trimmed(message.id),
    // The reason this provider exists: the server says which conversation a
    // message belongs to, so nothing has to be reconstructed from References.
    threadId: trimmed(message.threadId) || trimmed(message.id),
    labelIds: labelIdsFor(message, rolesById),
    internalDate: receivedMs(message.receivedAt),
    sizeEstimate: typeof message.size === "number" ? message.size : 0,
    // JMAP sends a preview with every row, so unlike IMAP nothing has to be
    // built out of a body that was not fetched.
    snippet: trimmed(message.preview),
    blobId: trimmed(message.blobId),
    hasAttachment: message.hasAttachment === true,
    payload: {
      partId: "",
      mimeType: "text/plain",
      headers: headersFor(message),
      body: {},
      parts: []
    }
  }
}

function messagesFrom(list, rolesById) {
  var entries = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < entries.length; i++) out.push(messageFrom(entries[i], rolesById))
  return out
}

// ---------------------------------------------------------------- actions

// What an action asks the server to change. JMAP makes this uniform in a way
// IMAP does not: a keyword and a move are both `Email/set`, so one request
// shape covers starring, marking read, archiving and trashing alike.
//
// `roles` maps a role name to this account's mailbox id.
function actionPlan(action, roles) {
  var verb = String(action || "")
  var map = roles && typeof roles === "object" ? roles : {}
  // `moveRole` is what the caller asked for; `moveTo` is what this account
  // could resolve it to. They differ exactly when the server has no mailbox
  // for that role — which must not read as "nothing to do".
  var plan = { keywords: {}, moveTo: "", removeFrom: "", moveRole: "" }

  if (verb === "read") { plan.keywords["$seen"] = true; return plan }
  if (verb === "unread") { plan.keywords["$seen"] = null; return plan }
  if (verb === "star") { plan.keywords["$flagged"] = true; return plan }
  if (verb === "unstar") { plan.keywords["$flagged"] = null; return plan }
  if (verb === "archive") { plan.moveRole = "archive"; plan.moveTo = trimmed(map.archive); plan.removeFrom = trimmed(map.inbox); return plan }
  if (verb === "trash") { plan.moveRole = "trash"; plan.moveTo = trimmed(map.trash); return plan }
  if (verb === "untrash") { plan.moveRole = "inbox"; plan.moveTo = trimmed(map.inbox); return plan }
  if (verb === "spam") { plan.moveRole = "junk"; plan.moveTo = trimmed(map.junk); return plan }
  return plan
}

// One `Email/set` for as many messages as the caller has. A move replaces
// `mailboxIds` outright rather than patching it: a message in Inbox and a
// user folder that was archived should leave the inbox, and a patch that only
// added Archive would leave it in both.
function updateRequest(accountId, ids, plan) {
  var account = trimmed(accountId)
  var list = Array.isArray(ids) ? ids : []
  var wanted = plan || { keywords: {}, moveTo: "", removeFrom: "" }
  var update = {}

  for (var i = 0; i < list.length; i++) {
    var id = trimmed(list[i])
    if (id === "") continue
    var patch = {}
    var keywords = wanted.keywords || {}
    for (var word in keywords) {
      if (!keywords.hasOwnProperty(word)) continue
      // A JSON pointer patch, which is how JMAP sets one keyword without
      // sending the whole set back. null removes it.
      patch["keywords/" + word] = keywords[word]
    }
    if (trimmed(wanted.moveTo) !== "") {
      var boxes = {}
      boxes[trimmed(wanted.moveTo)] = true
      patch["mailboxIds"] = boxes
    }
    update[id] = patch
  }

  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/set", { accountId: account, update: update }, "update"]
    ]
  }
}

// `MailAccount` speaks Gmail's vocabulary to every client: add these label ids,
// remove those. IMAP translates that into flags and a folder; JMAP translates
// it into keywords and a mailbox. Doing it here rather than in the client keeps
// the translation testable without a compositor.
function planFromLabels(addLabelIds, removeLabelIds, roles) {
  var added = Array.isArray(addLabelIds) ? addLabelIds : []
  var removed = Array.isArray(removeLabelIds) ? removeLabelIds : []
  var map = roles && typeof roles === "object" ? roles : {}
  var plan = { keywords: {}, moveTo: "", removeFrom: "", moveRole: "" }

  function has(list, name) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toUpperCase() === name) return true
    }
    return false
  }

  // Marking read REMOVES the UNREAD label, which sets `$seen` — the inversion
  // again, now in the other direction.
  if (has(removed, "UNREAD")) plan.keywords["$seen"] = true
  if (has(added, "UNREAD")) plan.keywords["$seen"] = null
  if (has(added, "STARRED")) plan.keywords["$flagged"] = true
  if (has(removed, "STARRED")) plan.keywords["$flagged"] = null

  // A move is exclusive, so only one destination is honoured. Trash wins over
  // junk and junk over archive: the more destructive reading of an ambiguous
  // request is the one the user is least surprised by, because they can see it.
  if (has(added, "TRASH")) plan.moveRole = "trash"
  else if (has(added, "SPAM")) plan.moveRole = "junk"
  else if (has(removed, "INBOX")) plan.moveRole = "archive"
  else if (has(removed, "TRASH") || has(removed, "SPAM")) plan.moveRole = "inbox"
  else if (has(added, "INBOX")) plan.moveRole = "inbox"
  if (plan.moveRole !== "") plan.moveTo = trimmed(map[plan.moveRole])

  return plan
}

// A move was asked for and this account has nowhere to put it. Distinct from
// an empty plan, and the distinction is the whole point: `planIsEmpty` would
// say true for both, and a caller that treats "nothing to do" as success
// reports an archive that never happened — the row leaves the list, the note
// says "Archived", and the server was never asked. That is the fault AGENTS.md
// records against HEY, and a per-account capability ceiling reintroduces it
// unless this is checked first.
function planUnresolved(plan) {
  var wanted = plan || {}
  return trimmed(wanted.moveRole) !== "" && trimmed(wanted.moveTo) === ""
}

// What to call the mailbox that is missing, for the note the user reads.
var ROLE_NAMES = { archive: "Archive", trash: "Trash", junk: "Junk", inbox: "Inbox", sent: "Sent", drafts: "Drafts" }

function roleName(role) {
  var key = trimmed(role)
  return ROLE_NAMES[key] || key
}

// Whether a plan asks for anything at all. A caller that would otherwise send
// an `Email/set` with an empty patch for twenty-five messages checks this first.
function planIsEmpty(plan) {
  var wanted = plan || {}
  if (trimmed(wanted.moveTo) !== "") return false
  var keywords = wanted.keywords || {}
  for (var word in keywords) {
    if (keywords.hasOwnProperty(word)) return false
  }
  return true
}

// The session's `downloadUrl` is a URI template, not a URL: it names where the
// four values go and expects the client to put them there. Used for the raw
// message behind a list row and for an attachment's octets.
//
// Fetching the raw message rather than mapping `bodyStructure` is deliberate:
// it is the same bytes IMAP hands over, so `Message.parseRfc822` reads it
// unchanged and every part, attachment and calendar entry is handled by code
// that already works.
function downloadUrlFor(session, blobId, type, name) {
  var state = session || {}
  var template = trimmed(state.downloadUrl)
  var id = trimmed(blobId)
  if (template === "" || id === "") return ""
  return template
    .split("{accountId}").join(encodeURIComponent(trimmed(state.accountId)))
    .split("{blobId}").join(encodeURIComponent(id))
    .split("{type}").join(encodeURIComponent(trimmed(type) || "application/octet-stream"))
    .split("{name}").join(encodeURIComponent(trimmed(name) || "message"))
}

// A get of specific messages, for ids a list has already named.
function getRequest(accountId, ids, properties) {
  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/get", {
        accountId: trimmed(accountId),
        ids: Array.isArray(ids) ? ids : [],
        properties: Array.isArray(properties) && properties.length > 0 ? properties : LIST_PROPERTIES
      }, "messages"]
    ]
  }
}

// ------------------------------------------------------------------ sending
//
// The panel hands every client the same thing: a finished RFC822 message,
// base64url encoded, with any attachments already inside it. IMAP appends it
// and hands it to SMTP. JMAP has no "send this text" method — a submission
// names an `Email` the server already holds — so the raw message is uploaded
// as a blob, imported, and then submitted.
//
// Three round trips where SMTP takes one, and worth it for the same reason the
// read path downloads raw: `Message.buildRawMessage` already produces a correct
// message with its alternatives, its attachments and its headers, and
// rebuilding that as a structured `Email` object would be a second
// implementation of MIME that could disagree with the first.

function uploadUrlFor(session) {
  var state = session || {}
  var template = trimmed(state.uploadUrl)
  if (template === "") return ""
  return template.split("{accountId}").join(encodeURIComponent(trimmed(state.accountId)))
}

function identitiesRequest(accountId) {
  return {
    using: [CORE, MAIL, SUBMISSION],
    methodCalls: [
      ["Identity/get", { accountId: trimmed(accountId), ids: null }, "identities"]
    ]
  }
}

// Which identity a message is sent as. The one whose address is the mailbox's
// own, then any that may send, then nothing — because a submission with the
// wrong identity is refused by the server rather than quietly rewritten.
function pickIdentity(list, email) {
  var entries = Array.isArray(list) ? list : []
  var wanted = trimmed(email).toLowerCase()
  for (var i = 0; i < entries.length; i++) {
    if (trimmed(entries[i].email).toLowerCase() === wanted) return entries[i]
  }
  for (var j = 0; j < entries.length; j++) {
    if (entries[j].mayDelete !== undefined || trimmed(entries[j].email) !== "") return entries[j]
  }
  return null
}

function identitiesFrom(list) {
  var entries = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {}
    var address = trimmed(entry.email)
    if (address === "") continue
    out.push({
      id: trimmed(entry.id),
      email: address,
      name: trimmed(entry.name),
      isDefault: i === 0,
      isPrimary: i === 0
    })
  }
  return out
}

// An uploaded blob becomes a message the account holds. A draft keeps
// `$draft`; something about to be sent does not, because the submission is
// what files it and a message that failed to send should not be left looking
// like one that never was.
function importRequest(accountId, blobId, mailboxId, asDraft, receivedAt) {
  var keywords = { "$seen": true }
  if (asDraft) keywords["$draft"] = true
  var boxes = {}
  if (trimmed(mailboxId) !== "") boxes[trimmed(mailboxId)] = true
  var email = {
    blobId: trimmed(blobId),
    mailboxIds: boxes,
    keywords: keywords
  }
  if (trimmed(receivedAt) !== "") email.receivedAt = trimmed(receivedAt)
  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/import", { accountId: trimmed(accountId), emails: { draft: email } }, "import"]
    ]
  }
}

// The submission, and what to do to the message once it has gone.
//
// `onSuccessUpdateEmail` is the part worth getting right: it files the sent
// copy and clears `$draft` in the same request, so there is no window in which
// a sent message is still sitting in Drafts. The key is the creation id with a
// "#" in front, which is how JMAP refers to something this request is making.
function submitRequest(accountId, identityId, emailId, sentMailboxId) {
  var update = { "keywords/$draft": null, "keywords/$seen": true }
  if (trimmed(sentMailboxId) !== "") {
    var boxes = {}
    boxes[trimmed(sentMailboxId)] = true
    update["mailboxIds"] = boxes
  }
  var onSuccess = {}
  onSuccess["#send"] = update

  return {
    using: [CORE, MAIL, SUBMISSION],
    methodCalls: [
      ["EmailSubmission/set", {
        accountId: trimmed(accountId),
        create: {
          send: {
            emailId: trimmed(emailId),
            identityId: trimmed(identityId)
          }
        },
        onSuccessUpdateEmail: onSuccess
      }, "submit"]
    ]
  }
}

// A draft that replaced an earlier one leaves the earlier one behind unless it
// is said so explicitly.
function destroyRequest(accountId, ids) {
  return {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/set", { accountId: trimmed(accountId), destroy: Array.isArray(ids) ? ids : [] }, "destroy"]
    ]
  }
}

// The id of the one thing a create-shaped request made.
function createdId(payload, creationId) {
  var body = payload && typeof payload === "object" ? payload : {}
  var created = body.created && typeof body.created === "object" ? body.created : {}
  var entry = created[trimmed(creationId)]
  return entry && entry.id ? trimmed(entry.id) : ""
}

// Why a create was refused, in the words the panel shows. `notCreated` is keyed
// by the same creation id the request used.
function createError(payload, creationId) {
  var body = payload && typeof payload === "object" ? payload : {}
  var refused = body.notCreated && typeof body.notCreated === "object" ? body.notCreated : {}
  var entry = refused[trimmed(creationId)]
  if (!entry) return ""
  var type = trimmed(entry.type)
  if (type === "forbiddenFrom") return "That address is not one this mailbox may send from."
  if (type === "forbiddenToSend") return "The server refused to send this message."
  if (type === "tooLarge") return "That message is too large to send."
  if (type === "rateLimit") return "Too many messages sent just now; try again shortly."
  if (type === "invalidEmail") return "The server would not accept that message."
  return trimmed(entry.description) || (type === "" ? "The message could not be sent." : type)
}

// -------------------------------------------------------------------- push
//
// The session's `eventSourceUrl` is a URI template like the others. A client
// connects to it and the server holds the connection open, writing a
// `StateChange` whenever something the client asked about moves.
//
// This replaces waiting for the next poll, not the poll itself: a server may
// expose no event source at all, and a held connection drops. The panel's own
// refresh timer stays exactly as it was, and this only makes it fire sooner.

// The types worth waking for. `Email` covers new mail and anything that
// changes a message; `Mailbox` covers a count moving without a message
// arriving, which is what a read on another device looks like.
var PUSH_TYPES = "Email,Mailbox"

// `ping` asks the server to write a keepalive every so many seconds, which is
// what stops a NAT or a proxy from silently discarding an idle connection —
// the failure mode where push looks like it is working and simply never
// delivers anything again.
function pushUrlFor(session, pingSeconds) {
  var state = session || {}
  var template = trimmed(state.eventSourceUrl)
  if (template === "") return ""
  var ping = Math.floor(Number(pingSeconds))
  if (!isFinite(ping) || ping < 30) ping = 300
  return template
    .split("{types}").join(encodeURIComponent(PUSH_TYPES))
    .split("{closeafter}").join("no")
    .split("{ping}").join(String(ping))
}

// One line of the event stream. Only `data:` lines carry anything; the rest is
// framing, and a `:` comment is how some servers write a keepalive.
//
// Returns whether this line means *this* account has something new. A change
// for another account on the same connection is not this mailbox's business.
function pushChange(line, accountId) {
  var text = String(line === undefined || line === null ? "" : line)
  var out = { isData: false, changed: false, state: "" }
  if (text.substring(0, 5) !== "data:") return out
  out.isData = true

  var body = null
  try {
    body = JSON.parse(text.substring(5))
  } catch (e) {
    return out
  }
  if (!body || typeof body !== "object") return out
  // A ping is a data line too, and carries no `changed` at all.
  var changed = body.changed && typeof body.changed === "object" ? body.changed : null
  if (!changed) return out

  var wanted = trimmed(accountId)
  var mine = changed[wanted]
  if (!mine || typeof mine !== "object") return out

  for (var type in mine) {
    if (!mine.hasOwnProperty(type)) continue
    if (type === "Email" || type === "Mailbox") {
      out.changed = true
      out.state = trimmed(mine[type])
      return out
    }
  }
  return out
}

// How long to wait before reconnecting a stream that dropped. Doubling, and
// capped: a server that is down should not be reconnected to twice a second,
// and one that blipped should not be waited on for an hour.
function pushBackoffMs(attempt) {
  var tries = Math.floor(Number(attempt))
  if (!isFinite(tries) || tries < 1) tries = 1
  var delay = 2000 * Math.pow(2, tries - 1)
  return delay > 300000 ? 300000 : delay
}
