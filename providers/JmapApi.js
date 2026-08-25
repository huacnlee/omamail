.pragma library

// JMAP method construction and response shaping. No transport lives here:
// `JmapClient.qml` owns XMLHttpRequest, deadlines, and credentials.

var SESSION_URL = "https://api.fastmail.com/jmap/session"
var CORE = "urn:ietf:params:jmap:core"
var MAIL = "urn:ietf:params:jmap:mail"

var SUMMARY_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size",
  "receivedAt", "sentAt", "preview", "subject", "from", "to", "cc",
  "bcc", "replyTo", "messageId", "inReplyTo", "references"
]

var DETAIL_PROPERTIES = SUMMARY_PROPERTIES.concat([
  "bodyStructure", "bodyValues", "textBody", "htmlBody", "attachments"
])

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(token|accessToken|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
}

function responseError(status, payload, fallback) {
  var type = String(payload && payload.type ? payload.type : "")
  var detail = String(payload && payload.description ? payload.description : "")
  if (status === 401) return "The JMAP server rejected this token. Sign in again"
  if (status === 403 || type === "forbidden") return "This token does not permit that mail action"
  if (status === 429 || type === "rateLimit") return "The JMAP server is rate limiting this account. Try again shortly"
  if (status === 0) return "Could not reach the JMAP server. Check the network connection"
  if (status >= 500) return "The JMAP server is having trouble right now. Try again shortly"
  if (type === "notFound") return "That message is no longer in the mailbox"
  if (type === "accountNotFound") return "This token has no usable mail account"
  if (detail) return redact(detail)
  return fallback || "The JMAP server could not complete this request"
}

function isHttpsUrl(value) {
  var text = String(value || "")
  return /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/|$)/.test(text)
    && !/[\s<>"'\\]/.test(text)
}

function validateSession(payload) {
  var body = payload && typeof payload === "object" ? payload : {}
  var capabilities = body.capabilities || {}
  if (!capabilities[CORE] || !capabilities[MAIL])
    return { ok: false, error: "This server does not offer JMAP Mail" }
  if (!isHttpsUrl(body.apiUrl))
    return { ok: false, error: "The JMAP session did not provide a safe API address" }

  var accounts = body.accounts && typeof body.accounts === "object" ? body.accounts : {}
  var primary = body.primaryAccounts && typeof body.primaryAccounts === "object"
    ? String(body.primaryAccounts[MAIL] || "") : ""
  var accountId = primary
  if (!accountId || !accounts[accountId]) {
    accountId = ""
    for (var key in accounts) {
      var account = accounts[key] || {}
      if (account.accountCapabilities && account.accountCapabilities[MAIL]) {
        accountId = key
        break
      }
    }
  }
  if (!accountId || !accounts[accountId])
    return { ok: false, error: "This token has no JMAP Mail account" }

  var selected = accounts[accountId] || {}
  var accountCapabilities = selected.accountCapabilities || {}
  var mailAccountCapabilities = accountCapabilities[MAIL]
    && typeof accountCapabilities[MAIL] === "object" ? accountCapabilities[MAIL] : {}
  var reportsMailboxLimit = Object.prototype.hasOwnProperty.call(
    mailAccountCapabilities, "maxMailboxesPerEmail")
  var mailboxLimit = mailAccountCapabilities.maxMailboxesPerEmail
  var canLabels = reportsMailboxLimit && (mailboxLimit === null
    || (isFinite(Number(mailboxLimit)) && Number(mailboxLimit) > 1))
  return {
    ok: true,
    error: "",
    accountId: accountId,
    name: String(selected.name || ""),
    isReadOnly: selected.isReadOnly === true,
    canLabels: canLabels,
    apiUrl: String(body.apiUrl || ""),
    downloadUrl: isHttpsUrl(body.downloadUrl) ? String(body.downloadUrl) : "",
    uploadUrl: isHttpsUrl(body.uploadUrl) ? String(body.uploadUrl) : "",
    eventSourceUrl: isHttpsUrl(body.eventSourceUrl) ? String(body.eventSourceUrl) : "",
    state: String(body.state || "")
  }
}

function methodRequest(calls) {
  return { using: [CORE, MAIL], methodCalls: Array.isArray(calls) ? calls : [] }
}

function mailboxGetCall(accountId, tag) {
  return ["Mailbox/get", { accountId: String(accountId || "") }, String(tag || "mailboxes")]
}

function parseLiteral(text) {
  var raw = String(text || "").trim()
  if (raw.charAt(0) === "\"") {
    var value = parseJson(raw, null)
    return typeof value === "string" ? value : ""
  }
  return raw
}

function mailboxForRole(mailboxes, role) {
  var wanted = String(role || "").toLowerCase()
  var list = Array.isArray(mailboxes) ? mailboxes : []
  for (var i = 0; i < list.length; i++) {
    if (String((list[i] || {}).role || "").toLowerCase() === wanted)
      return String(list[i].id || "")
  }
  return ""
}

function filterForQuery(query, mailboxes) {
  var text = String(query || "").trim()
  var filter = {}
  if (text.indexOf("role:") === 0) {
    var space = text.indexOf(" ")
    var role = text.substring(5, space < 0 ? text.length : space)
    var mailboxId = mailboxForRole(mailboxes, role)
    if (!mailboxId) return { ok: false, error: "This account has no " + role + " mailbox", filter: {} }
    filter.inMailbox = mailboxId
    if (space >= 0 && text.substring(space + 1).trim() === "unread")
      filter.notKeyword = "$seen"
  } else if (text.indexOf("keyword:") === 0) {
    var keyword = text.substring(8).trim()
    if (keyword) filter.hasKeyword = keyword
  } else if (text.indexOf("mailbox:") === 0) {
    var selected = parseLiteral(text.substring(8))
    if (!selected) return { ok: false, error: "That mailbox is not available", filter: {} }
    filter.inMailbox = selected
  } else if (text.indexOf("text:") === 0) {
    var words = parseLiteral(text.substring(5))
    if (words) filter.text = words
  } else if (text !== "") {
    filter.text = text
  }
  return { ok: true, error: "", filter: filter }
}

function pagePosition(token) {
  var value = Math.floor(Number(token))
  return isFinite(value) && value >= 0 ? value : 0
}

function listCalls(accountId, filter, limit, pageToken) {
  var size = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 25))
  var query = {
    accountId: String(accountId || ""),
    filter: filter || {},
    sort: [{ property: "receivedAt", isAscending: false }],
    position: pagePosition(pageToken),
    limit: size,
    calculateTotal: true
  }
  return [
    ["Email/query", query, "query"],
    ["Email/get", {
      accountId: String(accountId || ""),
      "#ids": { resultOf: "query", name: "Email/query", path: "/ids" },
      properties: SUMMARY_PROPERTIES
    }, "messages"]
  ]
}

function detailCall(accountId, id, tag) {
  return ["Email/get", {
    accountId: String(accountId || ""),
    ids: [String(id || "")],
    properties: DETAIL_PROPERTIES,
    fetchAllBodyValues: true
  }, String(tag || "message")]
}

function emailGetCall(accountId, ids, full, tag) {
  var values = Array.isArray(ids) ? ids : []
  var args = {
    accountId: String(accountId || ""),
    ids: values.slice(),
    properties: full === true ? DETAIL_PROPERTIES : SUMMARY_PROPERTIES
  }
  if (full === true) args.fetchAllBodyValues = true
  return ["Email/get", args, String(tag || "messages")]
}

function responseByTag(payload, tag) {
  var calls = payload && Array.isArray(payload.methodResponses) ? payload.methodResponses : []
  var wanted = String(tag || "")
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i] || []
    if (String(call[2] || "") !== wanted) continue
    return { name: String(call[0] || ""), body: call[1] || {} }
  }
  return null
}

function methodError(payload) {
  var calls = payload && Array.isArray(payload.methodResponses) ? payload.methodResponses : []
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i] || []
    if (String(call[0] || "") === "error") return responseError(200, call[1], "The JMAP request failed")
  }
  return ""
}

function parseMailboxList(payload) {
  var response = responseByTag(payload, "mailboxes")
  if (!response || response.name !== "Mailbox/get") return []
  var list = Array.isArray(response.body.list) ? response.body.list : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var box = list[i] || {}
    var id = String(box.id || "")
    if (!id) continue
    out.push({
      id: id,
      name: String(box.name || id),
      role: String(box.role || "").toLowerCase(),
      parentId: String(box.parentId || ""),
      sortOrder: Math.floor(Number(box.sortOrder) || 0),
      totalEmails: Math.max(0, Math.floor(Number(box.totalEmails) || 0)),
      unreadEmails: Math.max(0, Math.floor(Number(box.unreadEmails) || 0)),
      totalThreads: Math.max(0, Math.floor(Number(box.totalThreads) || 0)),
      unreadThreads: Math.max(0, Math.floor(Number(box.unreadThreads) || 0)),
      myRights: box.myRights || {}
    })
  }
  out.sort(function(a, b) { return a.sortOrder - b.sortOrder })
  return out
}

function headerSafe(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " ").trim()
}

function addressValue(address) {
  var item = address || {}
  var email = headerSafe(item.email)
  var name = headerSafe(item.name).replace(/([\\"])/g, "\\$1")
  if (!name) return email
  return "\"" + name + "\" <" + email + ">"
}

function addressList(values) {
  var list = Array.isArray(values) ? values : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var value = addressValue(list[i])
    if (value) out.push(value)
  }
  return out.join(", ")
}

function firstValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] || "") : ""
  return String(value || "")
}

function emailHeaders(email) {
  var source = email || {}
  var headers = []
  function add(name, value) {
    var text = headerSafe(value)
    if (text !== "") headers.push({ name: name, value: text })
  }
  add("From", addressList(source.from))
  add("To", addressList(source.to))
  add("Cc", addressList(source.cc))
  add("Bcc", addressList(source.bcc))
  add("Reply-To", addressList(source.replyTo))
  add("Subject", source.subject)
  add("Date", source.sentAt || source.receivedAt)
  add("Message-ID", firstValue(source.messageId))
  add("In-Reply-To", firstValue(source.inReplyTo))
  var references = Array.isArray(source.references) ? source.references.join(" ") : source.references
  add("References", references)
  var structureHeaders = source.bodyStructure && Array.isArray(source.bodyStructure.headers)
    ? source.bodyStructure.headers : []
  for (var i = 0; i < structureHeaders.length; i++) {
    var field = structureHeaders[i] || {}
    if (String(field.name || "").toLowerCase() === "list-unsubscribe")
      add("List-Unsubscribe", field.value)
  }
  return headers
}

function utf8Bytes(text) {
  var source = String(text || "")
  var bytes = []
  for (var i = 0; i < source.length; i++) {
    var code = source.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      var low = source.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function base64UrlText(text) {
  var bytes = utf8Bytes(text)
  var out = ""
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i]
    var hasB = i + 1 < bytes.length
    var hasC = i + 2 < bytes.length
    var b = hasB ? bytes[i + 1] : 0
    var c = hasC ? bytes[i + 2] : 0
    out += BASE64.charAt(a >> 2)
    out += BASE64.charAt(((a & 3) << 4) | (b >> 4))
    if (hasB) out += BASE64.charAt(((b & 15) << 2) | (c >> 6))
    if (hasC) out += BASE64.charAt(c & 63)
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_")
}

function base64UrlBytes(bytes) {
  var source = bytes && typeof bytes.length === "number" ? bytes : []
  var out = ""
  for (var i = 0; i < source.length; i += 3) {
    var a = Number(source[i]) & 255
    var hasB = i + 1 < source.length
    var hasC = i + 2 < source.length
    var b = hasB ? Number(source[i + 1]) & 255 : 0
    var c = hasC ? Number(source[i + 2]) & 255 : 0
    out += BASE64.charAt(a >> 2)
    out += BASE64.charAt(((a & 3) << 4) | (b >> 4))
    if (hasB) out += BASE64.charAt(((b & 15) << 2) | (c >> 6))
    if (hasC) out += BASE64.charAt(c & 63)
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_")
}

function parseMessages(payload, mailboxes, tag) {
  var error = methodError(payload)
  if (error) return { messages: [], error: error }
  var response = responseByTag(payload, String(tag || "messages"))
  if (!response || response.name !== "Email/get")
    return { messages: [], error: "The JMAP server returned no messages" }
  var list = Array.isArray(response.body.list) ? response.body.list : []
  var out = []
  for (var i = 0; i < list.length; i++) out.push(normalizeEmail(list[i], mailboxes))
  return { messages: out, error: "" }
}

function partHeaders(part) {
  var source = part || {}
  var headers = []
  var type = String(source.type || "application/octet-stream")
  if (source.charset) type += "; charset=" + String(source.charset)
  headers.push({ name: "Content-Type", value: type })
  if (source.disposition)
    headers.push({ name: "Content-Disposition", value: String(source.disposition) })
  if (source.cid) headers.push({ name: "Content-ID", value: String(source.cid) })
  return headers
}

function bodyPart(part, values, depth) {
  var source = part || {}
  var level = Math.max(0, Math.floor(Number(depth)) || 0)
  var bodyValues = values && typeof values === "object" ? values : {}
  var children = Array.isArray(source.subParts) ? source.subParts : []
  var built = {
    partId: String(source.partId || ""),
    mimeType: String(source.type || "application/octet-stream"),
    filename: String(source.name || ""),
    headers: partHeaders(source),
    body: { size: Math.max(0, Math.floor(Number(source.size) || 0)) }
  }
  if (children.length > 0 && level < 12) {
    built.parts = []
    for (var i = 0; i < children.length; i++)
      built.parts.push(bodyPart(children[i], bodyValues, level + 1))
  } else {
    var value = bodyValues[String(source.partId || "")]
    if (value && value.value !== undefined) built.body.data = base64UrlText(value.value)
    else if (source.blobId) built.body.attachmentId = String(source.blobId)
  }
  return built
}

function mailboxRoleMap(mailboxes) {
  var map = {}
  var list = Array.isArray(mailboxes) ? mailboxes : []
  for (var i = 0; i < list.length; i++) {
    var box = list[i] || {}
    var id = String(box.id || "")
    if (id) map[id] = String(box.role || "").toLowerCase()
  }
  return map
}

function labelIds(email, mailboxes) {
  var source = email || {}
  var labels = []
  var roles = mailboxRoleMap(mailboxes)
  var system = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", junk: "SPAM", trash: "TRASH" }
  var assigned = source.mailboxIds && typeof source.mailboxIds === "object" ? source.mailboxIds : {}
  for (var id in assigned) {
    if (assigned[id] !== true) continue
    labels.push(id)
    var role = roles[id]
    if (system[role] && labels.indexOf(system[role]) < 0) labels.push(system[role])
  }
  var keywords = source.keywords && typeof source.keywords === "object" ? source.keywords : {}
  if (keywords.$seen !== true) labels.push("UNREAD")
  if (keywords.$flagged === true) labels.push("STARRED")
  if (keywords.$draft === true && labels.indexOf("DRAFT") < 0) labels.push("DRAFT")
  if (keywords.$important === true) labels.push("IMPORTANT")
  return labels
}

function normalizeEmail(email, mailboxes) {
  var source = email || {}
  var received = Date.parse(String(source.receivedAt || source.sentAt || ""))
  var payload = source.bodyStructure
    ? bodyPart(source.bodyStructure, source.bodyValues, 0)
    : { partId: "", mimeType: "multipart/mixed", filename: "", body: { size: 0 }, parts: [] }
  payload.headers = emailHeaders(source)
  return {
    id: String(source.id || ""),
    threadId: String(source.threadId || source.id || ""),
    labelIds: labelIds(source, mailboxes),
    internalDate: isFinite(received) ? String(received) : "0",
    sizeEstimate: Math.max(0, Math.floor(Number(source.size) || 0)),
    snippet: String(source.preview || ""),
    payload: payload,
    blobId: String(source.blobId || "")
  }
}

function parseListPage(payload, mailboxes, requestedLimit) {
  var error = methodError(payload)
  if (error) return { page: null, messages: [], error: error }
  var query = responseByTag(payload, "query")
  var messages = responseByTag(payload, "messages")
  if (!query || query.name !== "Email/query" || !messages || messages.name !== "Email/get")
    return { page: null, messages: [], error: "The JMAP server returned an incomplete mail page" }
  var ids = Array.isArray(query.body.ids) ? query.body.ids : []
  var position = Math.max(0, Math.floor(Number(query.body.position) || 0))
  var total = Math.max(0, Math.floor(Number(query.body.total) || 0))
  var limit = Math.max(1, Math.floor(Number(requestedLimit)) || ids.length || 1)
  var normalized = []
  var list = Array.isArray(messages.body.list) ? messages.body.list : []
  for (var i = 0; i < list.length; i++) normalized.push(normalizeEmail(list[i], mailboxes))
  return {
    page: {
      ids: ids.slice(),
      threadIds: normalized.map(function(item) { return item.threadId }),
      nextPageToken: position + ids.length < total ? String(position + limit) : "",
      estimate: total
    },
    messages: normalized,
    error: ""
  }
}

function parseMessage(payload, mailboxes, tag) {
  var error = methodError(payload)
  if (error) return { message: null, error: error }
  var response = responseByTag(payload, String(tag || "message"))
  var list = response && response.name === "Email/get" && Array.isArray(response.body.list)
    ? response.body.list : []
  if (list.length === 0) return { message: null, error: "That message is no longer in the mailbox" }
  return { message: normalizeEmail(list[0], mailboxes), error: "" }
}

function labelsFromMailboxes(mailboxes) {
  var list = Array.isArray(mailboxes) ? mailboxes : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var box = list[i] || {}
    out.push({
      id: String(box.id || ""),
      name: String(box.name || box.id || ""),
      rawName: String(box.id || ""),
      system: String(box.role || "") !== "",
      unread: Math.max(0, Math.floor(Number(box.unreadEmails) || 0)),
      total: Math.max(0, Math.floor(Number(box.totalEmails) || 0)),
      threadsUnread: Math.max(0, Math.floor(Number(box.unreadThreads) || 0))
    })
  }
  return out
}

function labelCounts(mailboxes, id) {
  var wanted = String(id || "")
  var list = Array.isArray(mailboxes) ? mailboxes : []
  for (var i = 0; i < list.length; i++) {
    if (String((list[i] || {}).id || "") !== wanted) continue
    return {
      id: wanted,
      unread: Math.max(0, Math.floor(Number(list[i].unreadEmails) || 0)),
      total: Math.max(0, Math.floor(Number(list[i].totalEmails) || 0)),
      threadsUnread: Math.max(0, Math.floor(Number(list[i].unreadThreads) || 0))
    }
  }
  return null
}

function downloadAddress(template, accountId, blobId, name, type) {
  var url = String(template || "")
  if (!isHttpsUrl(url)) return ""
  var values = {
    accountId: encodeURIComponent(String(accountId || "")),
    blobId: encodeURIComponent(String(blobId || "")),
    name: encodeURIComponent(String(name || "attachment")),
    type: encodeURIComponent(String(type || "application/octet-stream"))
  }
  for (var key in values) url = url.replace(new RegExp("\\{" + key + "\\}", "g"), values[key])
  return isHttpsUrl(url) ? url : ""
}
