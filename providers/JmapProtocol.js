.pragma library

// JMAP's own rules, and nothing else. No transport lives here —
// `scripts/jmap-transport.sh` runs the curl process and `JmapClient.qml` owns
// it — and no message format either: an RFC 822 message is `Message.js`'s
// subject and a JMAP Email object is turned into the shared message resource
// beside it.
//
// What this file owns is every decision about what came back, which is what
// the node tests reach without a compositor or a mailbox.
//
// ## Three levels of failure, and they are not the same question
//
// JMAP fails in three places and a client that flattened them would report the
// wrong thing at least a third of the time:
//
//   - the *transport*: curl never connected, or the server answered with a
//     status. `transportError` turns a curl exit and an HTTP status into a
//     sentence.
//   - the *request*: the server read the JSON and refused the whole document —
//     an unknown capability, a size limit. `requestError` reads the
//     problem-details object those come back as.
//   - the *method*: the document was accepted and one invocation inside it
//     answered `error`. `methodError` reads the first of those, unless the
//     caller was expecting that type and has a branch for it.
//
// Every sentence is written for somebody who just clicked Archive rather than
// for somebody reading a server log, and anything that could carry a
// credential passes through `redact` before it can reach a label.

// The ceiling on a blob download, fixed in the transport script as well: the
// same figure `attachment.sh` will send up to. Exceeding it is curl exit 63
// rather than a 20 MB base64 line crossing a pipe.
var MAX_BLOB_BYTES = 20971520

// The three values the `authScheme` field may hold. The script builds the
// credential from one of these and refuses anything else, so QML never
// assembles an Authorization value of its own. `none` is discovery's
// well-known GET, on a URL the user did not type.
var AUTH_BASIC = "basic"
var AUTH_BEARER = "bearer"
var AUTH_NONE = "none"

// What `maxConcurrentRequests` is worth when the session does not say. Read
// from the session whenever it does; this is the floor under a server that
// omits it, not an assumption about one that does.
var DEFAULT_CONCURRENCY = 4

// ------------------------------------------------------------------ redaction

// A secret can end up in a curl error line, in a URL's userinfo, or in a
// server's echo of what it was sent. Nothing that could carry one reaches a
// label without passing through here — the same gate `OAuth.redact` is for
// Google and `Imap.redact` is for a password.
function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+\S+/gi, "Basic [redacted]")
    .replace(/(https?:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@")
    .replace(/("?)(password|secret|token|apiKey)\1\s*[=:]\s*"?[^\s",}]*/gi, "$2=[redacted]")
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

// A JMAP answer is an object or it is not an answer. `JSON.parse` accepting
// `4` or `"x"` is the difference between "the server sent JSON" and "the
// server sent a JMAP document".
function parseJson(text) {
  if (text === null || text === undefined) return null
  if (typeof text === "object") return text
  try {
    var parsed = JSON.parse(String(text))
    return parsed !== null && typeof parsed === "object" ? parsed : null
  } catch (e) {
    return null
  }
}

// JMAP names an error type with a URN — `urn:ietf:params:jmap:error:limit` at
// the request level, a bare `accountReadOnly` at the method level. The last
// segment is the name in both.
function errorType(value) {
  var text = trimmed(value)
  if (text === "") return ""
  var parts = text.split(":")
  return parts[parts.length - 1]
}

// RFC 7807 calls it `detail` and RFC 8620's method errors call it
// `description`. Both are read, because a server that chose the other word is
// still telling the user something.
function describedBy(payload) {
  if (!payload || typeof payload !== "object") return ""
  var described = trimmed(payload.description)
  if (described !== "") return described
  return trimmed(payload.detail)
}

// The existing suffix rule, in the words the Gmail client already uses: a
// number of seconds is not a sentence, and "try again shortly" without one is
// not an answer.
function rateLimitSuffix(retryAfter) {
  var seconds = Math.ceil(Number(retryAfter))
  if (!isFinite(seconds) || seconds <= 0) return ""
  if (seconds < 60) return " (retry in " + seconds + "s)"
  return " (retry in " + Math.ceil(seconds / 60) + " min)"
}

// --------------------------------------------------------------- transport

// The error for a finished transport call, whichever part of it failed.
//
// `exit` is curl's, `httpStatus` the code the script read with `--write-out`,
// `body` the response text (or null when there is none to read, which is what
// a blob download hands over), `stderr` whatever curl or the script itself
// said, and `retryAfter` the header value when a caller has one. An empty
// string means nothing went wrong.
//
// The exit code is asked first because a curl that never connected has no
// status to report — but a non-zero exit that *does* carry one defers to it,
// which is how the stream's `--fail` exit 22 becomes "the server rejected that
// username or password" on a 401 and a connection failure on anything else.
function transportError(exit, httpStatus, body, stderr, retryAfter) {
  var code = Number(exit)
  if (!isFinite(code)) code = 0
  var status = Number(httpStatus)
  if (!isFinite(status)) status = 0
  var reported = trimmed(stderr)

  if (code === 6 || code === 7) return "Could not reach the mail server"
  if (code === 28) return "The mail server took too long to answer"
  if (code === 35) return "Could not make a secure connection to the mail server"
  if (code === 63) return "This attachment is larger than 20 MB"
  // Exit 2 is the script's own refusal — a URL that is not https, an auth
  // scheme it does not build — and it says so on stderr in words that are
  // already about this request.
  if (code === 2) {
    return reported !== "" ? redact(reported) : "The mail server could not be reached (curl 2)"
  }
  if (code !== 0 && status < 100) return "The mail server could not be reached (curl " + code + ")"

  if (status === 401) return "The server rejected that username or password"
  if (status === 403) {
    var refused = describedBy(parseJson(body))
    return refused !== "" ? redact(refused) : "The server refused that request"
  }
  if (status === 404) return "The server has no such mailbox or message"
  if (status === 429) return "The server asked to slow down" + rateLimitSuffix(retryAfter)
  // Never followed, so a redirect is reported as one. The credential goes to
  // the session URL the user typed and to the URLs read from the session
  // fetched with it, and an address the server named at request time is
  // neither.
  if (status >= 300 && status < 400) return "The server tried to redirect, which this client refuses"
  if (status >= 500) return "The mail server had a problem"
  if (status >= 400) {
    // A request-level error is a 400 with a problem-details body. It is a
    // JMAP failure rather than an HTTP one, so it is read as one.
    var payload = parseJson(body)
    if (payload && trimmed(payload.type) !== "") return requestError(payload)
    var detail = describedBy(payload)
    return detail !== "" ? redact(detail) : "The server refused that request"
  }
  if (status >= 200 && status < 300) {
    // A download's body is bytes rather than a document, and its caller passes
    // nothing here. Anything that did pass a body expected JSON back.
    if (body === null || body === undefined) return ""
    if (!parseJson(body)) return "The server sent an answer this client could not read"
    return ""
  }
  if (code !== 0) return "The mail server could not be reached (curl " + code + ")"
  return "Could not reach the mail server"
}

// ------------------------------------------------------------ request level

// The server read the document and refused the whole of it. `payload` is the
// problem-details object, parsed or not.
function requestError(payload) {
  var body = parseJson(payload)
  if (!body) return "The mail server had a problem"
  var type = errorType(body.type)
  if (type === "limit") {
    var limit = trimmed(body.limit)
    if (limit !== "") return "The server's limit for " + redact(limit) + " was hit"
    return "The server's limit was hit"
  }
  // `notRequest`, `notJSON` and `unknownCapability` are all this client
  // sending something the server could not use, which is a bug here rather
  // than anything the reader can act on. The server's own words follow, so a
  // report of one carries what it said.
  var described = describedBy(body)
  if (described !== "") return "The mail server had a problem (" + redact(described) + ")"
  return "The mail server had a problem"
}

// ------------------------------------------------------------- method level

// The first `error` invocation in a `methodResponses` array, or null. A JMAP
// response is a list of `[name, arguments, callId]` triples and an error is
// one of them rather than a failure of the request that carried it.
function firstMethodError(responses) {
  if (!responses || typeof responses !== "object" || !responses.length) return null
  for (var i = 0; i < responses.length; i++) {
    var row = responses[i]
    if (!row || typeof row !== "object" || row.length < 2) continue
    if (String(row[0]) !== "error") continue
    var args = row[1] && typeof row[1] === "object" ? row[1] : {}
    return {
      type: errorType(args.type),
      arguments: args,
      callId: row.length > 2 ? String(row[2]) : ""
    }
  }
  return null
}

// The type of that error, so a caller with a branch for one can take it.
// Ticket 05's `anchorNotFound` retry and ticket 06's tolerated `notFound` both
// need to know which error it was, not only that there was one.
function methodErrorType(responses) {
  var found = firstMethodError(responses)
  return found ? found.type : ""
}

// The sentence for the first error invocation, or "" when there is none — or
// when it is one the caller said it expects. `expected` is a type name or an
// array of them.
function methodError(responses, expected) {
  var found = firstMethodError(responses)
  if (!found) return ""
  if (expectsType(found.type, expected)) return ""

  var type = found.type
  if (type === "accountReadOnly") return "This account is read-only on the server"
  if (type === "forbidden") return "The server refused that request"
  if (type === "unsupportedFilter" || type === "unsupportedSort") return "The server cannot run that search"
  if (type === "requestTooLarge") return "That request is too large for the server"
  // `serverFail`, `invalidArguments` and whatever a server invents: its own
  // description if it wrote one, because a type name is not a sentence.
  var described = describedBy(found.arguments)
  if (described !== "") return redact(described)
  return "The mail server had a problem"
}

function expectsType(type, expected) {
  if (expected === undefined || expected === null) return false
  if (typeof expected === "object" && expected.length !== undefined) {
    for (var i = 0; i < expected.length; i++) {
      if (String(expected[i]) === type) return true
    }
    return false
  }
  return String(expected) === type
}

// ------------------------------------------------------------------- queue

// The FIFO that keeps `call` and `upload` requests under the session's own
// concurrency limit. Pure, so the client holds one queue per limit and this
// file holds no processes.
//
//   admit(entry)  true when the entry starts now, false when it was queued
//   release()     one finished; returns the entry to start next, or null
//   withdraw(e)   removes a queued entry, so an aborted handle calls back
//                 nothing; false when it was not waiting
//
// An aborted in-flight request goes through `release` instead, because its
// process exit is what frees the slot.
function makeQueue(limit) {
  var cap = Math.floor(Number(limit))
  if (!isFinite(cap) || cap < 1) cap = DEFAULT_CONCURRENCY

  var queue = {
    limit: cap,
    running: 0,
    waiting: []
  }

  queue.admit = function (entry) {
    if (queue.running < queue.limit) {
      queue.running = queue.running + 1
      return true
    }
    queue.waiting.push(entry)
    return false
  }

  queue.release = function () {
    if (queue.running > 0) queue.running = queue.running - 1
    if (queue.waiting.length === 0) return null
    if (queue.running >= queue.limit) return null
    queue.running = queue.running + 1
    return queue.waiting.shift()
  }

  queue.withdraw = function (entry) {
    for (var i = 0; i < queue.waiting.length; i++) {
      if (queue.waiting[i] === entry) {
        queue.waiting.splice(i, 1)
        return true
      }
    }
    return false
  }

  return queue
}

// ------------------------------------------------------------ download URLs

// The session's `downloadUrl` template, filled. Every value is percent-encoded
// on the way in, so a blob id or a filename holding `/` or `?` — both of which
// a server may legitimately choose — cannot steer the request off the template
// and onto another path or another query.
function downloadUrl(template, accountId, blobId, name, type) {
  var filled = String(template === undefined || template === null ? "" : template)
  if (filled === "") return ""
  filled = fillTemplate(filled, "accountId", accountId)
  filled = fillTemplate(filled, "blobId", blobId)
  filled = fillTemplate(filled, "name", name)
  filled = fillTemplate(filled, "type", type)
  return filled
}

// A replacement is data, not a pattern. `$&` and `$'` inside a filename would
// otherwise be expanded by `String.replace` into whatever surrounded the
// placeholder — and `encodeURIComponent` leaves `$` alone, so they survive
// that far. A function replacement is returned verbatim.
function fillTemplate(template, key, value) {
  var encoded = encodeURIComponent(String(value === undefined || value === null ? "" : value))
  return template.replace(new RegExp("\\{" + key + "\\}", "g"), function () { return encoded })
}
