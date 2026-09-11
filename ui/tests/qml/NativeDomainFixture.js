.pragma library
.import "../oracles/providers/Registry.js" as ProviderOracle
.import "../oracles/Conversation.js" as Conversation
.import "../oracles/Senders.js" as Senders
.import "../../../benchmarks/mail/baseline/ui/message/Message.js" as Mail
.import "../../account/Model.js" as Model
.import "../../../benchmarks/mail/baseline/ui/message/Direction.js" as Direction
.import "../../../benchmarks/mail/baseline/ui/message/Html.js" as Html

// Pure JavaScript oracles verify the UI RPC contract. Rust golden tests verify
// the native implementation independently; this helper never sends mail.
function summary(message, now) {
  var value = Mail.summarize(message, now)
  value.subjectDirection = Direction.resolveSubject(value.subject, Direction.AUTO)
  return value
}

function body(payload) {
  var value = Mail.extractBody(payload)
  value.bodyDirection = Direction.resolveBody(value.text, Direction.AUTO)
  return value
}

function conversation(params) {
  var thread = Conversation.blockOf(params.thread)
  var summaries = params.summaries || ({})
  if (params.operation === "select") thread = Conversation.threadAfterSelect(thread, params.selectedId, params.summary)
  if (params.operation === "merge") summaries = Conversation.mergedSummaries(summaries, params.additions, 500, thread ? thread.memberIds : [])
  if (params.operation === "seed") {
    var additions = ({})
    var rows = (params.messages || []).concat(params.previewMessages || [])
    var ids = thread ? thread.memberIds : []
    for (var i = 0; i < ids.length; i++) {
      if (summaries[ids[i]]) continue
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].id === ids[i]) { additions[ids[i]] = rows[j]; break }
      }
    }
    summaries = Conversation.mergedSummaries(summaries, additions, 500, ids)
  }
  var view = Conversation.viewedMailboxKey(params.mailboxKey, params.searching)
  var members = thread ? thread.memberIds : []
  var navigation = ({})
  for (var k = 0; k < members.length; k++) navigation[members[k]] = {
    previous: Conversation.memberStep(thread, members[k], -1),
    next: Conversation.memberStep(thread, members[k], 1),
    neighbor: Conversation.neighbourStop(thread, members[k])
  }
  return { thread: thread, summaries: summaries, missing: Conversation.missingMemberIds(thread, summaries),
    showsRail: Conversation.drawsRail(params.conversations, thread), viewedMailboxKey: view,
    stops: Conversation.stops(thread, summaries, params.selectedId, view, params.mailboxes),
    caption: Conversation.caption(thread, summaries), navigation: navigation, memberIds: members,
    first: members.length ? members[members.length - 1] : "", last: members.length ? members[0] : "" }
}

// Match the native reader boundary: sender HTML and ordinary MIME bytes stay
// behind the backend; only prepared display data and calendar locators cross.
function readerProjection(message, params) {
  var prepared = {summary: summary(message, new Date(params.now || Date.now())),
    body: body(message.payload), attachments: Mail.attachments(message.payload)}
  var html = Mail.extractHtml(message.payload)
  var options = Object.assign({}, params.options || {},
    {withReader: true, withPlainText: prepared.body.source === "html"})
  var rendered = Html.sanitize(html, options)
  if (rendered.plainText) {
    rendered.plainText.bodyDirection = Direction.resolveBody(rendered.plainText.text, Direction.AUTO)
    prepared.body = {text: rendered.plainText.text, source: "html", bodyDirection: rendered.plainText.bodyDirection}
  }
  var calendars = []
  function visit(part) {
    if (String(part.mimeType || "").split(";")[0].trim().toLowerCase() === "text/calendar") {
      calendars.push(part); return
    }
    var parts = part.parts || []
    for (var i = 0; i < parts.length; i++) visit(parts[i])
  }
  visit(message.payload)
  return {id: message.id, threadId: message.threadId || "", labelIds: message.labelIds || [],
    readerKey: "fixture-reader-" + String(params.accountId) + "-" + message.id,
    hasHtml: html !== "", nativeSummary: prepared.summary, nativeContent: prepared,
    nativeRender: rendered, payload: {mimeType: "multipart/mixed", headers: message.payload.headers || [], parts: calendars}}
}

function answer(method, params) {
  if (method === "providers.resolve") {
    if (params.operation === "query") return { value: ProviderOracle.query(params.provider, params.mailbox, params.search, params.defaultQuery) }
    if (params.operation === "addressQuery") return { value: ProviderOracle.addressQuery(params.provider, params.field, params.value) }
    return { value: ProviderOracle[params.operation](params.provider, params.value) }
  }
  if (method === "reader.cancel") return {cancelled: true}
  if (method === "reader.open" && params.cacheOnly) return null
  if (method === "account.conversation") return conversation(params)
  if (method === "account.identities") return { identities: Senders.identities(params.mailboxes) }
  // Default to a cache miss; cache-hit tests supply an explicit resource.
  if (method === "cache.resourceRead" || method === "message.prepareCached") return null
  if (method === "cache.resourcePut") return { stored: true }
  var now = new Date(params.now === undefined ? Date.now() : params.now)
  if (method === "message.compose") return Mail.buildSendPayload(params.fields)
  if (method === "message.summarize") return summary(params.message, now)
  if (method === "message.summaries") return { summaries: params.messages.map(function(message) { return summary(message, now) }) }
  if (method === "message.prepare") return {
    summary: summary(params.message, now), body: body(params.message.payload),
    html: Mail.extractHtml(params.message.payload), attachments: Mail.attachments(params.message.payload)
  }
  if (method === "message.composeText") {
    var quote = params.body === undefined ? String(params.quote || "") : Mail.quoteBody(params.summary, params.body)
    return { body: Mail.composeBody(params.signature, quote), quote: quote,
      replySubject: Mail.replySubject(params.subject === undefined ? (params.summary || {}).subject : params.subject) }
  }
  if (method === "model.apply") {
    if (params.operation === "batch") return params.calls.map(function(call) { return answer(method, call) })
    if (typeof Model[params.operation] !== "function") throw new Error("Unknown model fixture operation: " + params.operation)
    return Model[params.operation].apply(null, params.args || [])
  }
  return undefined
}
