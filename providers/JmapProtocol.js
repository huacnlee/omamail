.pragma library

.import "../message/Message.js" as Mail

// JMAP's own rules, and nothing else. No transport lives here —
// `scripts/jmap-transport.sh` runs the curl process and `JmapClient.qml` owns
// it — and no MIME parsing either: an RFC 822 message is `Message.js`'s
// subject, and this file never sees one. What it does own is the other
// direction, `toMessage`: a JMAP Email *composed* into the shared message
// resource, the way `HeyClient.toMessage` composes rather than parses.
//
// This is the JMAP seam and the one place a rule about JMAP goes, with one job
// beside it: `JmapThreads.js` holds the collapsed list read — the four chained
// calls a page of conversations is, the rule about which members a row counts,
// and the block a row draws from. `Jmap.js` is the provider *description* the
// registry reads — a name, a ceiling, the rail's rows — and holds no protocol.
// The client imports this file as `Jmap`, which is the name every call in it
// is read under: `Jmap.parseQuery`, `Jmap.toMessage`, `Jmap.refusals`.
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

// Ids as a list — trimmed, without blanks or repeats, in first-appearance
// order. One id or an array of them, which is what every action takes.
function uniqueIds(ids) {
  var source = Array.isArray(ids) ? ids : [ids]
  var out = []
  for (var i = 0; i < source.length; i++) {
    var id = trimmed(source[i])
    if (id !== "" && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

// A value that is there. JMAP's maps of keywords and of mailbox ids carry
// `true` for a member; RFC 8620 patches one out with `null`, and the reference
// server also accepts `false` — so all three read as absent.
function isSet(value) {
  return value !== undefined && value !== null && value !== false
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
  if (code === 63) return "The server's answer was larger than 20 MB"
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

// The same, for the reply object the transport hands the client — `{ exit,
// status, redirect, body, stderr }` — so a caller does not spell the four
// fields out.
function replyError(reply, retryAfter) {
  var source = reply && typeof reply === "object" ? reply : {}
  return transportError(source.exit, source.status, source.body, source.stderr, retryAfter)
}

// A blob download's failure, which is `replyError` with the one answer that is
// about the attachment rather than the server: curl exit 63 is the 20 MB
// ceiling the script fixes. `body` is the problem document a failed download
// answers with, decoded by the caller from the bytes the verb answers in.
var BLOB_TOO_LARGE = "This attachment is larger than 20 MB"

function downloadError(reply, body) {
  var source = reply && typeof reply === "object" ? reply : {}
  if (Math.floor(Number(source.exit)) === 63) return BLOB_TOO_LARGE
  return transportError(source.exit, source.status, body, source.stderr, "")
}

// ------------------------------------------------------------ request level

// The server read the document and refused the whole of it. `payload` is the
// problem-details object, parsed or not.
function requestError(payload) {
  var body = parseJson(payload)
  if (!body) return "The mail server had a problem"
  // A request that worked is not an error, and this is reached with one
  // whenever a caller asks about a document before looking inside it. A JMAP
  // problem-details object always names a `type`; a successful reply never
  // does and carries `methodResponses` instead — so a document with the one
  // and not the other is the request that succeeded, and saying "the mail
  // server had a problem" about it would invent a failure out of a full
  // mailbox. Callers still branch on `Array.isArray(payload.methodResponses)`
  // first; this is the second half of the same rule, in the one place a
  // caller who forgets will land.
  if (trimmed(body.type) === "" && Array.isArray(body.methodResponses)) return ""
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

// Every invocation in a reply, as `{ name, arguments, callId }`. A JMAP
// response is a list of `[name, arguments, callId]` triples, and this is the
// one walk over it: a row that is not a triple is skipped rather than read,
// and an error is an invocation named `error` rather than a failure of the
// request that carried it.
function invocations(responses) {
  var list = responses && typeof responses === "object" && responses.length !== undefined
    ? responses : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    if (!row || typeof row !== "object" || row.length < 2) continue
    out.push({
      name: trimmed(row[0]),
      arguments: row[1] && typeof row[1] === "object" ? row[1] : {},
      callId: row.length > 2 ? trimmed(row[2]) : ""
    })
  }
  return out
}

// The first `error` invocation in a `methodResponses` array, or null.
function firstMethodError(responses) {
  var list = invocations(responses)
  for (var i = 0; i < list.length; i++) {
    if (list[i].name !== "error") continue
    return {
      type: errorType(list[i].arguments.type),
      arguments: list[i].arguments,
      callId: list[i].callId
    }
  }
  return null
}

// The type of that error, so a caller with a branch for one can take it. The
// paging retry on `anchorNotFound` and the batch that tolerates `notFound` both
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

// The waiting list behind a read many callers need and one performs — the
// session, the mailbox list, the identities. Pure, for the reason the queue
// is.
//
//   join(callback)  queues the callback; true for the caller that should
//                   perform the read, which is the first since the last
//                   `finish`, false for one that only waits
//   finish(error)   calls every waiter once with the answer, "" for none,
//                   and empties the list
function makeWaiters() {
  var gate = { loading: false, waiting: [] }

  gate.join = function (callback) {
    if (typeof callback === "function") gate.waiting.push(callback)
    if (gate.loading) return false
    gate.loading = true
    return true
  }

  gate.finish = function (error) {
    gate.loading = false
    var pending = gate.waiting
    gate.waiting = []
    for (var i = 0; i < pending.length; i++) pending[i](String(error || ""))
  }

  return gate
}

// The credential as the transport takes it: three fields rather than one
// string, because the script builds the `Authorization` value itself and
// nothing in QML ever assembles one. `none` is discovery's well-known GET.
function credential(scheme, username, secret) {
  var kind = trimmed(scheme).toLowerCase()
  return {
    scheme: kind === AUTH_BEARER || kind === AUTH_NONE ? kind : AUTH_BASIC,
    username: String(username === undefined || username === null ? "" : username),
    secret: String(secret === undefined || secret === null ? "" : secret)
  }
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

// --------------------------------------------------------------- discovery
//
// Discovery starts at the address domain over HTTPS. A server without that
// endpoint is reached through the explicit server field.

// The order the setup page tries the two credential schemes in.
//
// Basic first: RFC 8620 section 8.2 names an app password as the Basic-auth
// credential, and a token sent as Basic is a rarer mistake than a password
// sent as Bearer. A server that takes only a token answers the first attempt
// with a 401 and the second one succeeds. Two requests with two credentials,
// from the setup page and nowhere else — it is a detection, not a retry, and a
// 401 from both is the rejected state.
var AUTH_SCHEME_ORDER = [AUTH_BASIC, AUTH_BEARER]

// The same order for an account that has signed in before: the scheme it
// recorded first, then the rest. "Save changes" on a signed-in page re-verifies,
// and starting at Basic on a token-only server would buy a 401 before the
// scheme that has been working all along is tried. A scheme that is not one of
// the two — nothing recorded yet, or `none` — is the default order.
function schemeOrder(recorded) {
  var first = trimmed(recorded).toLowerCase()
  var out = []
  if (first === AUTH_BASIC || first === AUTH_BEARER) out.push(first)
  for (var i = 0; i < AUTH_SCHEME_ORDER.length; i++) {
    if (out.indexOf(AUTH_SCHEME_ORDER[i]) < 0) out.push(AUTH_SCHEME_ORDER[i])
  }
  return out
}

// What a discovery step is. `typed` is the URL built from what the user wrote,
// and it is the only step when supplied; `well-known` starts at the address
// domain so HTTPS authenticates any delegation to a different host.
var STEP_TYPED = "typed"
var STEP_WELL_KNOWN = "well-known"

// RFC 8620 section 2.2. The well-known URL is not the session object: it is
// expected to redirect to one, which is the hop `redirectHop` allows.
var WELL_KNOWN_PATH = "/.well-known/jmap"

// What a bare typed host means. Discovery has already failed by the time
// anybody types a host into that field, so this is a guess — but it is the path
// the reference Stalwart serves, and that is the server the field exists for.
var SESSION_PATH = "/jmap/session"

// A hostname, optionally with a port; not a URL and not a path. Everything
// here ends up in a URL an account password is sent to, so a value carrying a
// slash, a space, an "@" or a second colon could point the authenticated
// client somewhere else entirely.
//
// Deliberately a second copy of `ImapProtocol.isValidHost` rather than an
// import of it: one provider's rules are not the other's to change, and the
// day either grows a case the other must not follow, a shared function is the
// thing that carries it across.
function isValidHost(value) {
  var host = trimmed(value)
  if (host === "" || host.length > 253) return false
  if (/[\s/\\@:?#"'<>]/.test(host)) return false
  // An IP literal is legitimate — a JMAP server on a machine with no name yet.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)
}

// A trailing dot is a fully qualified name to DNS and noise in a URL, and
// `dig` writes one on every target it prints.
function bareHost(value) {
  return trimmed(value).toLowerCase().replace(/\.+$/, "")
}

function isValidPort(value) {
  var port = Math.floor(Number(value))
  return isFinite(port) && port >= 1 && port <= 65535
}

// The domain half of an address, which is the whole of what discovery has to
// go on. An address that is not one has no domain rather than a wrong one:
// the setup page validates the address before it ever gets here.
function addressDomain(address) {
  var text = trimmed(address)
  var at = text.lastIndexOf("@")
  if (at < 0) return ""
  var domain = bareHost(text.substring(at + 1))
  return isValidHost(domain) ? domain : ""
}

function typedSessionUrl(server) {
  var text = trimmed(server)
  if (text === "") return ""
  if (/^https:\/\//i.test(text)) return text
  if (text.indexOf("://") >= 0) return ""
  // A host with a path already says where the session is; only a bare host is
  // guessed at.
  var slash = text.indexOf("/")
  if (slash >= 0) {
    var written = bareHost(text.substring(0, slash))
    return isValidHost(written) ? "https://" + written + text.substring(slash) : ""
  }
  var colon = text.lastIndexOf(":")
  if (colon >= 0) {
    var host = bareHost(text.substring(0, colon))
    var port = text.substring(colon + 1)
    if (!/^[0-9]{1,5}$/.test(port) || !isValidPort(port) || !isValidHost(host)) return ""
    return "https://" + host + ":" + Math.floor(Number(port)) + SESSION_PATH
  }
  var bare = bareHost(text)
  return isValidHost(bare) ? "https://" + bare + SESSION_PATH : ""
}

// Which server, and as whom: the two settings that decide what a session is
// worth. A different URL is a different server and a different username is a
// different account on it, so a session read under one pair says nothing
// under another. The scheme and the account id are what sign-in *learns* from
// that pair, so a change to them alone — which is exactly what sign-in writes
// onto the account — is the same mailbox, and the session it just fetched
// still describes it.
function serverIdentity(settings) {
  var values = settings || {}
  return trimmed(values.sessionUrl) + "\n" + trimmed(values.username)
}

// Where this address's JMAP server is looked for, and in what order.
//
//   { error, domain, steps: [ { kind, url } ] }
//
// `error` is the one refusal this can answer, and an errored plan has no
// steps. A typed server wins outright: somebody who filled that field in is
// answering a discovery that already failed, and walking the domain again
// afterwards would only fail again more slowly.
//
// Only HTTPS on the original address domain may delegate discovery. An
// unsigned SRV record cannot authorize sending a credential to another host.
function discoveryPlan(address, server) {
  var domain = addressDomain(address)
  if (trimmed(server) !== "") {
    var typed = typedSessionUrl(server)
    if (typed === "") {
      return { error: "The server must be reached over HTTPS", domain: domain, steps: [] }
    }
    return { error: "", domain: domain, steps: [{ kind: STEP_TYPED, url: typed }] }
  }
  // No server and no domain is nothing to look for. The page asks for the
  // address first and validates it, so this is the empty form rather than a
  // failure worth a sentence.
  if (domain === "") return { error: "", domain: "", steps: [] }
  return {
    error: "",
    domain: domain,
    steps: [
      { kind: STEP_WELL_KNOWN, url: "https://" + domain + WELL_KNOWN_PATH }
    ]
  }
}

// Every step tried and none of them a session. The sentence names no provider,
// by the same instruction the setup page follows, and says what the server
// field wants rather than only that something failed.
function discoveryFailure(domain) {
  var name = trimmed(domain)
  return "No JMAP server answered for " + name
    + ". Enter the server yourself — usually the host you sign in to on the web,"
    + " such as mail.example.org."
}

// The one redirect hop discovery follows, taken from the reply's second line.
//
// The well-known URL is *expected* to redirect — Stalwart answers 307 to its
// own session path — and the transport follows nothing, so the decision is
// made here instead of by curl: exactly one hop, HTTPS only, and nothing at
// all from a status that is not a redirect. The unauthenticated GET is what
// makes that safe to follow; the credential goes only to the URL that finally
// answered with a session.
function redirectHop(status, redirectUrl) {
  var code = Number(status)
  if (!isFinite(code) || code < 300 || code >= 400) return ""
  var url = trimmed(redirectUrl)
  if (!/^https:\/\//i.test(url)) return ""
  // Userinfo in the hop is the server's own string, and curl sends it as a
  // Basic credential when the request carries none — which the unauthenticated
  // probe does not. Nothing of the user's could get there, but a URL that
  // carries a credential is not one this client follows.
  if (/^https:\/\/[^/?#]*@/i.test(url)) return ""
  return url
}

// ------------------------------------------------------------ the session

// The two capabilities a mailbox needs the server to have, and the key
// `primaryAccounts` names the mail account under.
var CAPABILITY_CORE = "urn:ietf:params:jmap:core"
var CAPABILITY_MAIL = "urn:ietf:params:jmap:mail"
var CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission"

// The `using` array of every request this client sends, which is the list of
// capabilities the *request* needs rather than the list the server has. Named
// here and built nowhere else: a vendor URN in one of these would make every
// request refuseable by a server that had never heard of it, and a missing one
// comes back `unknownCapability` on a document the server otherwise read fine.
//
// Reading mail is core and mail. Sending is core, mail and submission — mail
// as well, because a send request also imports the message into a mailbox.
var USING_MAIL = [CAPABILITY_CORE, CAPABILITY_MAIL]
var USING_SUBMISSION = [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION]

function hasCapability(capabilities, urn) {
  if (!capabilities || typeof capabilities !== "object") return false
  return capabilities[urn] !== undefined && capabilities[urn] !== null
}

function countKeys(object) {
  if (!object || typeof object !== "object") return 0
  var total = 0
  for (var key in object) total = total + 1
  return total
}

function containsValue(list, value) {
  if (!Array.isArray(list)) return false
  for (var i = 0; i < list.length; i++) {
    if (String(list[i]) === value) return true
  }
  return false
}

// Whether a 200 from the session URL is a mailbox this client can sign in to:
//
//   { error, accountId }
//
// A 200 is not "signed in" by itself. Stalwart answers one with an empty
// `accounts` object when the Authorization header never arrives, so a check
// that stopped at the status would record an account with nothing in it and
// fail later, somewhere with no field to correct.
//
// Three refusals, each a sentence about what is missing rather than about
// JMAP. `accountId` on success is `primaryAccounts` for the mail capability,
// which is the id every later request names.
function verifySession(session) {
  var doc = parseJson(session)
  var notMail = { error: "The server answered, but not as a JMAP mail server", accountId: "" }
  if (!doc) return notMail
  var capabilities = doc.capabilities
  if (!hasCapability(capabilities, CAPABILITY_CORE)) return notMail
  if (!hasCapability(capabilities, CAPABILITY_MAIL)) return notMail

  var accounts = doc.accounts && typeof doc.accounts === "object" ? doc.accounts : null
  var primary = doc.primaryAccounts && typeof doc.primaryAccounts === "object"
    ? trimmed(doc.primaryAccounts[CAPABILITY_MAIL]) : ""
  var account = accounts && primary !== "" ? accounts[primary] : null
  var noMailbox = { error: "The server has no mailbox for this account", accountId: "" }
  if (!accounts || countKeys(accounts) === 0 || !account) return noMailbox
  if (!hasCapability(account.accountCapabilities, CAPABILITY_MAIL)) return noMailbox

  // Every query this client sends sorts by `receivedAt` descending, so an
  // account that cannot is one where every list would come back
  // `unsupportedSort` — refused here, where there is still a field to change,
  // rather than on the first mailbox anybody opens. RFC 8621 makes the list
  // mandatory, so an absent one is not a server keeping quiet about a sort it
  // supports.
  var mail = account.accountCapabilities[CAPABILITY_MAIL]
  var sortOptions = mail && typeof mail === "object" ? mail.emailQuerySortOptions : null
  if (!containsValue(sortOptions, "receivedAt")) {
    return { error: "The server cannot sort mail by date, which this client needs", accountId: "" }
  }
  // The four addresses a credential is sent to, and every one of them written
  // by the server. The transport refuses anything but HTTPS before curl runs,
  // so nothing would have been sent either way; refusing here is the same
  // rule one gate earlier, where the session is still being judged and the
  // sentence is this client's rather than the script's stderr.
  for (var i = 0; i < SESSION_ADDRESSES.length; i++) {
    var address = trimmed(doc[SESSION_ADDRESSES[i]])
    if (address !== "" && !/^https:\/\//i.test(address)) {
      return { error: "The server's session names an address that is not HTTPS", accountId: "" }
    }
  }
  return { error: "", accountId: primary }
}

var SESSION_ADDRESSES = ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"]

// Sending is the one capability sign-in reads and does not refuse the account
// over. A credential that cannot submit still reads mail perfectly well, so
// the account signs in and loses its send button instead.
//
// Asked of the *account* and not of the session, and this is the one place
// where the two must not be confused. The session's top-level list says the
// server was built with submission in it; `accountCapabilities` says this
// credential may use it, and RFC 8620 makes the second a subset of the first.
// Falling back to the session's list would answer yes for a read-only app
// password on a server that can submit for somebody else — a Send button that
// fails after the message is written, which is the promise this whole seam
// exists to stop being made.
//
// `accountId` is optional and names the account when the caller has one; with
// nothing it is the session's own primary mail account, which is the account
// every request from this client names anyway.
function hasSubmission(session, accountId) {
  var account = accountFor(parseJson(session), accountId)
  return !!account && hasCapability(account.accountCapabilities, CAPABILITY_SUBMISSION)
}

// The primary mail account of a session, which is the id `verifySession`
// records and every method call carries.
function primaryAccountId(session) {
  var doc = parseJson(session)
  if (!doc || !doc.primaryAccounts || typeof doc.primaryAccounts !== "object") return ""
  return trimmed(doc.primaryAccounts[CAPABILITY_MAIL])
}

// One account object out of a parsed session, by id or by primary. Null when
// the session names no such account, which is what a stale account id on a
// server that has been rebuilt looks like.
function accountFor(doc, accountId) {
  if (!doc || typeof doc !== "object") return null
  var accounts = doc.accounts && typeof doc.accounts === "object" ? doc.accounts : null
  if (!accounts) return null
  var wanted = trimmed(accountId)
  if (wanted === "") wanted = primaryAccountId(doc)
  if (wanted === "") return null
  var account = accounts[wanted]
  return account && typeof account === "object" ? account : null
}

// One string off the session object, or "" — the shape every URL, template
// and state the session publishes is read in, and read by name here so the
// five readers below cannot disagree about what an absent one means.
function sessionField(session, name) {
  var doc = parseJson(session)
  return doc ? trimmed(doc[name]) : ""
}

// Where every method call goes. Read from the session rather than assumed:
// on the reference account the session is on one host and this URL is on
// another, and it is the second of the two places a credential may go.
function apiUrl(session) {
  return sessionField(session, "apiUrl")
}

// The template every blob is fetched through, read from the session for the
// same reason the API URL is: it is the third of the places a credential may
// go, and on the reference account it is a different host from the session's
// own. `downloadUrl` fills it; nothing else builds a download address.
function downloadTemplate(session) {
  return sessionField(session, "downloadUrl")
}

// The server's own word for "nothing has changed". A cached session is good
// for as long as this matches, and a push telling the client the state moved
// is what makes it refetch — so it is what a cache entry is keyed on.
function sessionState(session) {
  return sessionField(session, "state")
}

// The state a reply says the session has moved to, or "" when it has not.
//
// Every API reply carries `sessionState` (RFC 8620 section 3.4), and one that
// differs from the held session's is the server saying its URLs, its limits or
// its accounts changed — so the held one is refetched. A reply carrying none
// says nothing, and a held session with no state of its own has nothing to
// compare, so neither moves anything.
function movedSessionState(session, payload) {
  var doc = parseJson(payload)
  var reported = doc ? trimmed(doc.sessionState) : ""
  if (reported === "") return ""
  var held = sessionState(session)
  return held !== "" && held !== reported ? reported : ""
}

// The host a session URL names, which is what a user is shown afterwards: the
// mailboxes row's second line and the "Signed in" line both say the host
// rather than the whole URL, because the path is this client's business and
// the host is the thing somebody recognises.
//
// The port survives when there is one — `mail.example.org:8443` is a different
// server from `mail.example.org` and a line that hid the difference would be
// wrong on the machine most likely to need it. Any userinfo is dropped: it is
// not part of the address, and it is the half that could carry a secret.
function sessionHost(url) {
  var text = trimmed(url)
  var match = /^https:\/\/([^/?#]+)/i.exec(text)
  if (!match) return ""
  var authority = match[1]
  var at = authority.lastIndexOf("@")
  if (at >= 0) authority = authority.substring(at + 1)
  return authority.toLowerCase()
}

// What the user calls the credential that worked. The scheme is detected, so
// this is the page telling them which of the two things they pasted turned out
// to be right — and it names no provider, as the rest of the page does not.
function schemeLabel(scheme) {
  return trimmed(scheme).toLowerCase() === AUTH_BEARER ? "API token" : "app password"
}

// ------------------------------------------------------------ session limits

// What `maxObjectsInGet` is worth when the session does not say. RFC 8620
// makes the figure mandatory, so this is the floor under a server that omitted
// it rather than an assumption about one that stated it — the reference
// Stalwart says 500 and Fastmail says something else, and neither is guessed.
var DEFAULT_OBJECTS_IN_GET = 100

// A positive whole number off the session's core capability, or 0 for one the
// session does not state.
function coreLimit(session, name) {
  var doc = parseJson(session)
  var core = doc && doc.capabilities && typeof doc.capabilities === "object"
    ? doc.capabilities[CAPABILITY_CORE] : null
  var value = core && typeof core === "object" ? Math.floor(Number(core[trimmed(name)])) : NaN
  return isFinite(value) && value > 0 ? value : 0
}

// The same, with the fallback for a session that does not state it.
function sessionLimit(session, name, fallback) {
  var value = coreLimit(session, name)
  if (value > 0) return value
  var floor = Math.floor(Number(fallback))
  return isFinite(floor) && floor > 0 ? floor : 1
}

// Ids split into requests no larger than the server will answer. One `Email/get`
// of 500 ids is one round trip; 500 of one id each is 500, and a page above the
// limit comes back `requestTooLarge` rather than short.
function chunked(ids, size) {
  var list = Array.isArray(ids) ? ids : []
  var limit = Math.max(1, Math.floor(Number(size)) || 1)
  var out = []
  for (var i = 0; i < list.length; i += limit) out.push(list.slice(i, i + limit))
  return out
}

// The arguments of the first invocation with this name in a reply. A JMAP
// response is a list of `[name, arguments, callId]` triples; the call id is the
// caller's own label and a request of one call is read by its method name.
// Null when the reply does not carry it, which is a different thing from an
// invocation that answered with an empty list.
function responseArguments(responses, name) {
  var list = invocations(responses)
  var wanted = trimmed(name)
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === wanted) return list[i].arguments
  }
  return null
}

// ------------------------------------------------------------- known states
//
// The newest state the server has reported for each type, from any reply:
//
//   { Email: "s41", Mailbox: "s7" }
//
// Push is the only reader. A `StateChange` naming a state this
// client has already been told is the echo of its own write, and refreshing the
// list on it is a round trip to fetch what is already on screen.
//
// `Email/query`'s `queryState` is deliberately not recorded here. That is the
// state of one query rather than of the type, a `StateChange` never names one,
// and filing it under `Email` would silence a real change.

function recordStates(known, responses) {
  var out = {}
  var source = known && typeof known === "object" ? known : {}
  for (var key in source) out[key] = String(source[key])

  var list = invocations(responses)
  for (var i = 0; i < list.length; i++) {
    var name = list[i].name
    var slash = name.indexOf("/")
    if (slash <= 0) continue
    var args = list[i].arguments
    // `newState` is where a `/set` left the type; `state` is where a `/get`
    // read it. Either is the newest this client has been told about.
    var state = trimmed(args.newState) !== "" ? trimmed(args.newState) : trimmed(args.state)
    if (state !== "") out[name.substring(0, slash)] = state
  }
  return out
}

// ------------------------------------------------------------ the event stream
//
// The stream is one `stream` request held open per account, and everything it
// costs is decided here: which URL it opens, what a line off it means, what a
// change notification amounts to for this account, and how long to wait before
// opening it again.
//
// RFC 8620 section 7.3 gives the resource three template variables. `types` is
// `Email,Mailbox` and nothing else: `Thread` never moves without an `Email`
// change, `EmailSubmission` has no consumer here, and `Identity` is read once
// per session. `closeafter` is `no` — the `state` form is a poll with a long
// wait, for proxies that will not pass a persistent response, and rotation is
// curl's `max-time` instead. `ping` is the floor the RFC makes every server
// accept; a server that clamps it up says so in the ping's own `interval`.

var EVENT_TYPES = "Email,Mailbox"
var EVENT_CLOSE_AFTER = "no"
var EVENT_PING_SECONDS = 30

// The two types a `StateChange` may name that this account acts on.
var TYPE_EMAIL = "Email"
var TYPE_MAILBOX = "Mailbox"

// The template the session published, which is the only place an event-source
// address comes from — the same rule the API URL and the download template
// follow, and for the same reason: it is a URL a credential is sent to.
function eventSourceTemplate(session) {
  return sessionField(session, "eventSourceUrl")
}

// The template, filled. Percent-encoded through `fillTemplate` exactly as a
// download URL is: `types` is a comma list and a server is free to publish a
// template whose variables sit in the path rather than the query, so a value
// that carried a `&`, a `/` or a `?` could otherwise steer the request off the
// address the session named.
function eventSourceUrl(template, types, ping) {
  var filled = String(template === undefined || template === null ? "" : template)
  if (filled === "") return ""
  var seconds = Math.floor(Number(ping))
  if (!isFinite(seconds) || seconds < 0) seconds = EVENT_PING_SECONDS
  filled = fillTemplate(filled, "types", trimmed(types) !== "" ? trimmed(types) : EVENT_TYPES)
  filled = fillTemplate(filled, "closeafter", EVENT_CLOSE_AFTER)
  filled = fillTemplate(filled, "ping", String(seconds))
  return filled
}

// ------------------------------------------------------------- event lines
//
// `text/event-stream` is a line grammar: `field: value` lines, then a blank
// line that ends the event. curl hands the transport's stdout over one line at
// a time, so this is fed one line at a time and carries the half-read event
// between calls rather than buffering the connection.
//
// The state it takes and the state it returns are the same object shape, and
// the answer is in it: `kind` is "" while an event is still being read and the
// event's own name once a blank line has ended one. That is one value to carry
// and one to branch on, rather than a parser plus a queue.
//
//   { event: "", data: "", kind: "", changed: null, interval: 0 }
//
// `id:` lines are dropped because Stalwart sends none and there is therefore
// nothing to replay; comment lines (`:` first) are dropped because the spec
// says they are keep-alives; `retry:` is dropped because the reconnect table
// below is this client's own and not the server's to set.

// A `StateChange` for one account naming two types is a few hundred bytes. The
// ceiling is not about Stalwart — it is that a half-read event is held in the
// process that draws the desktop, and a server or a proxy that never sends the
// blank line would otherwise grow it without end.
var MAX_EVENT_CHARS = 65536

function emptyEventState() {
  return { event: "", data: "", kind: "", changed: null, interval: 0 }
}

function parseEventLine(state, line) {
  var previous = state && typeof state === "object" ? state : emptyEventState()
  var next = {
    event: String(previous.event || ""),
    data: String(previous.data || ""),
    kind: "",
    changed: null,
    interval: 0
  }
  // SplitParser splits on "\n", so a server writing CRLF leaves the CR on the
  // end of every line — including the blank one that ends an event, which
  // would then never be recognised as blank.
  var text = String(line === undefined || line === null ? "" : line).replace(/\r+$/, "")

  if (text === "") {
    // A blank line with nothing before it is the keep-alive between events,
    // not an event with no name.
    if (next.event === "" && next.data === "") return next
    next.kind = next.event !== "" ? next.event : "message"
    if (next.kind === "state") {
      var payload = parseJson(next.data)
      var changed = payload ? payload.changed : null
      next.changed = changed && typeof changed === "object" && !Array.isArray(changed)
        ? changed : null
    } else if (next.kind === "ping") {
      var ping = parseJson(next.data)
      var seconds = ping ? Math.floor(Number(ping.interval)) : 0
      next.interval = isFinite(seconds) && seconds > 0 ? seconds : 0
    }
    next.event = ""
    next.data = ""
    return next
  }

  if (text.charAt(0) === ":") return next

  var colon = text.indexOf(":")
  var field = colon < 0 ? text : text.substring(0, colon)
  // "A single leading space after the colon is ignored", and only one.
  var value = colon < 0 ? "" : text.substring(colon + 1)
  if (value.charAt(0) === " ") value = value.substring(1)

  if (field === "event") {
    next.event = value
  } else if (field === "data") {
    // Data lines are joined with a newline, which is what the spec says and
    // what keeps a JSON document split across lines readable.
    next.data = next.data === "" ? value : next.data + "\n" + value
    if (next.data.length > MAX_EVENT_CHARS) {
      next.event = ""
      next.data = ""
    }
  }
  // `id`, `retry` and any field this client has not heard of fall through.
  return next
}

// ---------------------------------------------------------- what a push means
//
// One rule over a `StateChange`'s `changed` map, and the whole of what the
// panel does with a push:
//
//   null            this event is not about this account, or the panel already
//                   holds every state it names — its own write, echoed back
//   { mail, mailboxes }
//
// `mailboxes` re-reads the mailbox list, which is what re-binds the rail rows,
// the per-account refusals and the absent mailboxes; `mail` runs the account's
// own refresh, the same door the poll knocks on.
function refreshPlan(changed, accountId, knownStates) {
  var map = changed && typeof changed === "object" && !Array.isArray(changed) ? changed : null
  var wanted = trimmed(accountId)
  if (!map || wanted === "") return null
  var types = map[wanted]
  if (!types || typeof types !== "object" || Array.isArray(types)) return null

  var known = knownStates && typeof knownStates === "object" ? knownStates : {}
  var mail = false
  var mailboxes = false
  for (var type in types) {
    var state = trimmed(types[type])
    if (state === "") continue
    // The echo. The server tells every connection about the panel's own write
    // about a second after the action's callback has already revalidated, and
    // a state this client was handed by the reply it is the echo of is the one
    // thing a push can be that is worth nothing.
    if (trimmed(known[type]) === state) continue
    if (type === TYPE_EMAIL) mail = true
    else if (type === TYPE_MAILBOX) mailboxes = true
  }
  if (!mail && !mailboxes) return null
  return { mail: mail, mailboxes: mailboxes }
}

// --------------------------------------------------------------- reconnect
//
// curl's exit code says what happened to the stream, and the `http <code>`
// trailer the `stream` verb prints says what the server answered before it
// did. Together they are the whole of the decision:
//
//   0    the server ended the response — a restart, a proxy cutting an idle
//        connection, or `closeafter=state` if it were ever asked for
//   28   `max-time`, which is the planned hourly rotation
//   22   `--fail` on a 4xx or 5xx. A 401 is a revoked app password and there
//        is nothing to retry: the flag is raised, the setup card draws, and
//        this stops until a sign-in clears it. Every other status is the
//        server having a bad minute and backs off like a dropped socket.
//   any  6, 7, 35, 52, 56 and the rest: the network. Back off.
//
// `attempt` is how many failures have already been backed off from; the caller
// resets it to zero on the first event or ping of a connection, which is the
// only evidence that a connection is working.

var RECONNECT_BASE_MS = 1000
var RECONNECT_CAP_MS = 300000
var RECONNECT_AT_ONCE_MS = 0

// Not a curl exit code: what the owner reports when it stopped a connection
// curl was still perfectly happy with — the watchdog's two silent ping
// intervals, or a credential that could not be read. curl's own code for a
// process it was told to end says nothing about which of them ended it, and
// "the server stopped answering" has to back off rather than reconnect at once.
// Negative so it can never collide with one.
var EXIT_STREAM_SILENT = -1

// curl's own trailer, told from an event line. The `stream` verb ends its
// output with `http <code>`, printed by `--write-out` once the transfer has
// ended, and it arrives on the same stdout as the events — so it has to be
// recognised, and it has to be recognised as *not* being the server talking.
// Reading it as a line off a working connection is what resets the backoff on
// every failed connection, which is a reconnect every second for as long as
// the server is down; that was measured before this rule existed.
//
// **-1 is "not the trailer", and zero is a real answer.** curl writes `000`
// when there was no HTTP response at all — a refused connection, a failed
// handshake — which is the most common trailer of all and exactly what
// `reconnectDelay` reads as "no status". Folding the two together is the bug
// this return value exists to prevent.
var NOT_A_TRAILER = -1

function streamTrailerStatus(line) {
  var match = /^http[ \t]+(\d+)$/.exec(trimmed(line))
  if (!match) return NOT_A_TRAILER
  var code = Math.floor(Number(match[1]))
  return isFinite(code) && code > 0 ? code : 0
}

// What the table below should read for a connection that has just ended.
//
// `heard` is whether the server said anything at all on it — an event, a ping,
// even a comment. A connection that ended having heard nothing is not a clean
// close, whatever curl exited with: the two at-once exits are the ones that
// mean "the server finished with this connection", and a server or a proxy
// answering 200 and closing immediately would otherwise be reopened every few
// milliseconds for as long as it kept doing it. Reading the decision's own
// "reset on the first event or ping" the other way round is what this is: a
// connection that never got one has nothing to reset.
//
// Every other exit keeps its meaning, which is what leaves the 401 alone —
// `--fail` writes no body, so a rejected credential is *always* a connection
// that heard nothing.
// Whether a connection has lived long enough to be believed.
//
// "Reset on the first line" read one way is the busy loop the table above
// exists to prevent: a server — or a proxy in front of one — that answers a
// comment and closes cleanly gives curl exit 0 in the time a TLS handshake
// takes, and a line arrived, so the backoff reset and the table said "at
// once". Measured: about sixty milliseconds per connection, with the
// per-connect refresh behind every one of them. A connection is settled once
// it has lasted a whole ping interval, which is the first moment the server
// has had to prove it will keep it open; until then a line is a line, and
// not a reason to forget how many times this has just failed.
function connectionSettled(connectedAtMs, nowMs, pingSeconds) {
  var since = Number(nowMs) - Number(connectedAtMs)
  var interval = Math.floor(Number(pingSeconds))
  if (!isFinite(since) || !isFinite(interval) || interval <= 0) return false
  return since >= interval * 1000
}

function streamExit(exit, heard) {
  var code = Math.floor(Number(exit))
  if (!isFinite(code)) return EXIT_STREAM_SILENT
  if (heard === true) return code
  return code === 0 || code === 28 ? EXIT_STREAM_SILENT : code
}

function reconnectDelay(exit, status, attempt) {
  var code = Math.floor(Number(exit))
  var http = Math.floor(Number(status))
  var tries = Math.floor(Number(attempt))
  if (!isFinite(tries) || tries < 0) tries = 0

  if (code === 22 && http === 401)
    return { delay: 0, attempt: tries, stop: true, rejected: true }

  if (code === 0 || code === 28)
    return { delay: RECONNECT_AT_ONCE_MS, attempt: tries, stop: false, rejected: false }

  // Doubling from a second, capped. `Math.pow` rather than a running multiply
  // so the caller holds a count rather than a duration, and a reset is one
  // assignment.
  var delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, tries), RECONNECT_CAP_MS)
  return { delay: delay, attempt: tries + 1, stop: false, rejected: false }
}

// A resume from suspend, told from a timer that simply fired late.
//
// Qt's timers run on the monotonic clock, which stops while the machine is
// suspended: a thirty-second timer that fires after a four-hour sleep has
// counted thirty seconds of running time and knows nothing has happened. The
// wall clock does know, so the two are compared — and the connection sitting
// underneath is dead however alive the socket still looks, because the server
// gave up on it hours ago.
//
// Twice the interval rather than any advance at all: a busy GUI thread delays
// a timer by tens of milliseconds routinely, and reconnecting the stream every
// time the desktop was busy would be worse than the problem.
function clockJumped(lastMs, nowMs, intervalMs) {
  var last = Number(lastMs)
  var now = Number(nowMs)
  var interval = Number(intervalMs)
  if (!isFinite(last) || !isFinite(now) || !isFinite(interval) || interval <= 0) return false
  return now - last > interval * 2
}

// ------------------------------------------------------------ mailbox roles
//
// A rail row is keyed on an RFC 8621 *role* rather than on a folder name,
// because the role is the one stable name: the same row is "Junk Mail" on one
// server and "Spam" on another, and both agree the role is `junk`.

// The six roles the rail resolves per account. RFC 8621 registers more —
// `important`, `all`, `subscribed` — and a mailbox carrying one of those is
// drawn as an ordinary label under its own name.
var RAIL_ROLES = ["inbox", "sent", "drafts", "archive", "junk", "trash"]

// What a sentence calls the row whose mailbox is missing.
var ROLE_LABELS = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash"
}

// The three rows that may be absent, and the rail *key* each answers to —
// which is not the role's own name. The row keyed "spam" is the mailbox whose
// role is `junk`, and `Registry.mailboxes` takes keys.
var OPTIONAL_RAIL_ROWS = [
  { role: "archive", key: "archive" },
  { role: "junk", key: "spam" },
  { role: "trash", key: "trash" }
]

// The same leaf-name guesses `ImapProtocol.specialFolders` makes, and
// deliberately a second copy rather than an import of them: one provider's
// guesses are not the other's to change, and a shared function is what would
// carry the first divergence across. They are needed because a server may
// publish no `role` at all on a mailbox it plainly means as one — the
// reference Stalwart's Archive folders are exactly that. "Junk Email" is
// Exchange's name for the one folder the bare word cannot stand in for, and
// IMAP's copy learned it first.
var ROLE_NAME_GUESSES = {
  sent: /^sent( mail| items| messages)?$/,
  trash: /^(trash|deleted( items| messages)?)$/,
  drafts: /^drafts?$/,
  junk: /^(junk([ -]?e-?mail)?|spam|bulk mail)$/,
  archive: /^(archive|all mail)$/
}

function mailboxArray(mailboxes) {
  return Array.isArray(mailboxes) ? mailboxes : []
}

// Which mailbox a rail role means on this account: the one carrying that role,
// else a top-level mailbox whose name is one of the guesses, else nothing.
//
// Inbox is never guessed. `role: "inbox"` is the one role RFC 8621 requires a
// server to set, so a name match there could only ever find a *second* folder
// somebody called "Inbox" — which is a folder, not the inbox.
//
// Top-level only for the guesses: an "Archive" under "Projects" is somebody's
// filing, and archiving into it because the account has no Archive role would
// be filing their mail for them.
function resolveRole(role, mailboxes) {
  var wanted = trimmed(role).toLowerCase()
  if (wanted === "") return ""
  var list = mailboxArray(mailboxes)
  for (var i = 0; i < list.length; i++) {
    var box = list[i] || {}
    if (trimmed(box.role).toLowerCase() === wanted) return trimmed(box.id)
  }
  var guess = ROLE_NAME_GUESSES[wanted]
  if (!guess) return ""
  for (var j = 0; j < list.length; j++) {
    var candidate = list[j] || {}
    if (trimmed(candidate.parentId) !== "") continue
    if (guess.test(trimmed(candidate.name).toLowerCase())) return trimmed(candidate.id)
  }
  return ""
}

// Every rail role resolved once, which is what a filter and a label id are both
// read through. A page of fifty messages then resolves six roles rather than
// three hundred, and the role a query names cannot disagree with the role a row
// was labelled from.
//
//   { inbox, sent, drafts, archive, junk, trash }
//
// Each value is a mailbox id, or "" for a role this account has no mailbox for.
function roleMap(mailboxes) {
  var map = {}
  for (var i = 0; i < RAIL_ROLES.length; i++) {
    map[RAIL_ROLES[i]] = resolveRole(RAIL_ROLES[i], mailboxes)
  }
  return map
}

// The rail rows this account has no mailbox for, as `Registry.mailboxes` takes
// them — and `null` while nothing has been read.
//
// Null rather than an empty list, because the two mean opposite things: with
// null the registry draws every row, which is right for a mailbox list still on
// its way, and an empty list is the positive answer that this account has all
// three. The client's list starts empty, so empty is "not read yet" here.
function absentMailboxes(mailboxes) {
  var list = mailboxArray(mailboxes)
  if (list.length === 0) return null
  var out = []
  for (var i = 0; i < OPTIONAL_RAIL_ROWS.length; i++) {
    var row = OPTIONAL_RAIL_ROWS[i]
    if (resolveRole(row.role, list) === "") out.push(row.key)
  }
  return out
}

// The sentence a user reads when a row, a button or a request needs a mailbox
// this account has not got. One wording wherever it is caught: the registry
// refuses the button with it and the client refuses the request with it, so the
// answer reads the same from either layer.
function missingMailboxError(role) {
  var label = ROLE_LABELS[trimmed(role).toLowerCase()]
  return "This account has no " + (label ? label : "such") + " mailbox"
}

// ------------------------------------------------------------- the query DSL
//
// `Registry.js` hands down strings like "role:inbox unseen". They are opaque
// everywhere else — a cache key and the client's instruction, nothing more —
// and this is the only reader.
//
// Three prefixes and no more:
//
//   role:<role> [unseen|flagged]   a rail row
//   mailbox:<id>                   one of the server's own folders
//   text:<words verbatim>          a typed search, account-wide
//
// The mailbox form takes an id rather than a name because a JMAP mailbox has a
// stable id and a display name that can change under it or repeat under another
// parent — and the id is what every filter takes.

var QUERY_UNSEEN = "unseen"
var QUERY_FLAGGED = "flagged"

function inboxQuery() {
  return { role: "inbox", mailboxId: "", criteria: "", text: "" }
}

// The parse:
//
//   { role, mailboxId, criteria, text }
//
// Exactly one of `role`, `mailboxId` and `text` is ever set; `criteria` is
// "unseen", "flagged" or "" and only ever accompanies a role.
//
// A prefix with nothing after it, and an empty string, are the inbox. That is
// not a case the panel produces — `searchQuery`, `labelQuery` and the rail's
// own rows write all three prefixes and never write an empty one — but a query
// that names nothing has to name something, and the inbox is the mailbox every
// other provider falls back to as well.
//
// A string that is none of the three is read as a search for those words. The
// only way to make one is a default query typed into settings, which is Gmail
// syntax by inheritance; searching for what somebody wrote shows them mail,
// where an inbox filtered by an operator this server never heard of shows them
// nothing and looks broken.
function parseQuery(query) {
  var text = trimmed(query)
  var match = /^(role|mailbox|text):([\s\S]*)$/.exec(text)
  if (!match) return text === "" ? inboxQuery()
    : { role: "", mailboxId: "", criteria: "", text: text }

  var value = trimmed(match[2])
  if (value === "") return inboxQuery()
  if (match[1] === "text") return { role: "", mailboxId: "", criteria: "", text: value }
  if (match[1] === "mailbox")
    return { role: "", mailboxId: value.split(/\s+/)[0], criteria: "", text: "" }

  var parts = value.split(/\s+/)
  var criteria = parts.length > 1 ? parts[1].toLowerCase() : ""
  return {
    role: parts[0].toLowerCase(),
    mailboxId: "",
    criteria: criteria === QUERY_UNSEEN || criteria === QUERY_FLAGGED ? criteria : "",
    text: ""
  }
}

// The parse plus the account's role map, as the JSON filter that goes to the
// server — or null when this account has no mailbox for the role, which the
// caller turns into `queryError`'s sentence and no rows.
//
// A search names no mailbox and excludes two: Junk and Trash. That is Gmail's
// rule and Fastmail's own web default, and it is why a typed search has to be
// built here rather than by the row that typed it. An account with neither
// mailbox needs no exclusion at all, and an empty `inMailboxOtherThan` is a
// condition some servers refuse.
function filterFor(parsed, roles) {
  var query = parsed || {}
  var map = roles || {}

  var words = trimmed(query.text)
  if (words !== "") {
    var exclude = []
    if (trimmed(map.junk) !== "") exclude.push(trimmed(map.junk))
    if (trimmed(map.trash) !== "") exclude.push(trimmed(map.trash))
    if (exclude.length === 0) return { text: words }
    return {
      operator: "AND",
      conditions: [{ text: words }, { inMailboxOtherThan: exclude }]
    }
  }

  var mailboxId = trimmed(query.mailboxId)
  if (mailboxId !== "") return { inMailbox: mailboxId }

  var role = trimmed(query.role).toLowerCase()
  if (role === "") return null
  var resolved = trimmed(map[role])
  if (resolved === "") return null

  var filter = { inMailbox: resolved }
  // Unread is the absence of `$seen`, which is the one inversion in the whole
  // vocabulary and the easiest thing to write backwards.
  if (query.criteria === QUERY_UNSEEN) filter.notKeyword = "$seen"
  if (query.criteria === QUERY_FLAGGED) filter.hasKeyword = "$flagged"
  return filter
}

// Why `filterFor` answered nothing. Only an unresolved role can produce one — a
// search and a mailbox id always build a filter — so the wording is the
// missing-mailbox sentence the button and the row already use.
function queryError(parsed, roles) {
  if (filterFor(parsed, roles)) return ""
  return missingMailboxError((parsed || {}).role)
}

// ------------------------------------------------------------------ paging

// RFC 8621 section 4.4.2 makes `receivedAt` the one sort a server MUST support,
// and sign-in refuses an account whose `emailQuerySortOptions` does not list it
// — so this cannot come back `unsupportedSort` at runtime.
var EMAIL_SORT = [{ property: "receivedAt", isAscending: false }]

// One row per conversation, on every query: rail rows, user folders and search
// alike. `total` therefore counts conversations rather than messages, which is
// what makes the Unread badge agree with the rows the Unread view draws.
//
// One constant rather than an argument because every query collapses, and a
// caller free to disagree would be a caller free to make the badge lie. What a
// collapsed page is then read as is `JmapThreads.js`.
var COLLAPSE_THREADS = true

function pageLimit(limit) {
  var value = Math.floor(Number(limit))
  return isFinite(value) && value > 0 ? value : 25
}

// `<nextPosition>|<lastId>`, and it carries two values because the next page is
// *fetched* by anchor and *recovered* by position.
//
// Newest-first with mail arriving between pages is the common case, and an
// anchor keeps the seam exact through it where a bare position would repeat or
// skip a row. The one thing an anchor cannot survive is the anchor itself
// moving or being deleted, which the server answers `anchorNotFound` — so the
// position travels beside it and the retry costs a request only then.
//
// A JMAP id is `A-Za-z0-9_-` by RFC 8620, so the `|` can never be part of one.
function pageToken(position, ids) {
  var list = Array.isArray(ids) ? ids : []
  if (list.length === 0) return ""
  var start = Math.max(0, Math.floor(Number(position)) || 0)
  return String(start + list.length) + "|" + String(list[list.length - 1])
}

function parsePageToken(token) {
  var match = /^(\d+)\|([\s\S]+)$/.exec(trimmed(token))
  if (!match) return { position: 0, anchor: "" }
  return { position: Math.floor(Number(match[1])), anchor: match[2] }
}

// The `Email/query` arguments for one page. `byPosition` is the retry after an
// `anchorNotFound`, and is the only thing that reads the token's first half.
function emailQuery(accountId, filter, limit, token, byPosition) {
  var page = parsePageToken(token)
  var args = {
    accountId: trimmed(accountId),
    filter: filter,
    sort: EMAIL_SORT,
    collapseThreads: COLLAPSE_THREADS,
    limit: pageLimit(limit),
    // On every page, on both reference servers, and exact on both. RFC 8620
    // lets a server decline it, which is what `queryPage`'s second reading is
    // for rather than a reason not to ask.
    calculateTotal: true
  }
  if (page.anchor !== "" && byPosition !== true) {
    args.anchor = page.anchor
    args.anchorOffset = 1
  } else {
    args.position = page.position
  }
  return args
}

// One `Email/query` reply as the page `listMessages` answers with:
//
//   { ids, threadIds, nextPageToken, estimate }
//
// `estimate` is `total` where the server calculated one. Where it declined it
// is what has been seen so far plus one for a page that came back full — the
// same lower bound `ImapProtocol.searchPage` reports, and the reason the panel
// already words a provider total as "about".
//
// The token is empty at the end of the result under either reading: a page
// shorter than the limit, or a total already reached. A position past the end
// is an empty page rather than an error, which is verified on the server.
//
// `threadIds` stays empty, as IMAP's and HEY's do. The collapsed read knows
// every representative's thread id and hands it over on the summary instead;
// nothing above the seam reads the parallel array, and a second place to state
// a thread id is a second place for it to be wrong.
function queryPage(args, limit) {
  var body = args && typeof args === "object" ? args : {}
  var ids = []
  var source = Array.isArray(body.ids) ? body.ids : []
  for (var i = 0; i < source.length; i++) {
    var id = trimmed(source[i])
    if (id !== "") ids.push(id)
  }
  var position = Math.max(0, Math.floor(Number(body.position)) || 0)
  var wanted = pageLimit(limit)
  var end = position + ids.length
  var counted = typeof body.total === "number" && isFinite(body.total) && body.total >= 0
  var full = ids.length >= wanted
  var more = counted ? end < Math.floor(body.total) : full
  return {
    ids: ids,
    threadIds: [],
    nextPageToken: more ? pageToken(position, ids) : "",
    estimate: counted ? Math.floor(body.total) : end + (full ? 1 : 0)
  }
}

// -------------------------------------------------------- mailboxes as labels

// What one `Mailbox/get` asks for: what the rail resolves roles from, what the
// sidebar prints, and what the counts are read out of, in one read rather than
// three.
var MAILBOX_PROPERTIES = [
  "id", "name", "parentId", "role", "sortOrder",
  "totalEmails", "unreadEmails", "unreadThreads"
]

// A parent chain that loops is a server bug; here it would be an infinite loop
// on the thread that draws the user's whole desktop.
var MAX_MAILBOX_DEPTH = 16

function countOf(value) {
  var number = Math.floor(Number(value))
  return isFinite(number) && number > 0 ? number : 0
}

// "Parent / Child", walked up through `parentId`. The sidebar draws a flat
// list, so a nested folder that printed only its leaf would be two rows called
// "Receipts" with nothing to tell them apart.
function mailboxPath(box, byId) {
  var entry = box || {}
  var names = [trimmed(entry.name)]
  var seen = {}
  seen[trimmed(entry.id)] = true
  var current = entry
  for (var depth = 0; depth < MAX_MAILBOX_DEPTH; depth++) {
    var parentId = trimmed(current.parentId)
    if (parentId === "" || seen[parentId] === true) break
    seen[parentId] = true
    var parent = byId[parentId]
    if (!parent) break
    names.unshift(trimmed(parent.name))
    current = parent
  }
  return names.join(" / ")
}

// Every mailbox as a label, in the shape the sidebar and the cache already read
// Gmail's in.
//
// Every one of them, including the six the rail already draws: `system` says
// which those are and the sidebar lists the rest below, so a client that hid
// them here would have nothing to hand a view that wanted them. Subscription
// state is ignored, as IMAP ignores LSUB.
//
// `id` and `rawName` are both the mailbox id: one is the cache key, the other
// is what goes back in a filter, and only the printed name is a path — which is
// why nothing here has to be taken apart again on the way out.
//
// Ordered by the server's own `sortOrder` and then by the printed path, which
// puts a parent's children directly under it while a server that sorts nothing
// still comes back in a stable order rather than in hash order.
function mailboxLabels(mailboxes, roles) {
  var list = mailboxArray(mailboxes)
  var map = roles || {}
  var byId = {}
  var systemIds = {}
  var i
  for (i = 0; i < list.length; i++) {
    var box = list[i] || {}
    var key = trimmed(box.id)
    if (key !== "") byId[key] = box
  }
  for (var role in map) {
    var resolved = trimmed(map[role])
    if (resolved !== "") systemIds[resolved] = true
  }

  var rows = []
  for (i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var id = trimmed(entry.id)
    if (id === "") continue
    rows.push({
      order: countOf(entry.sortOrder),
      label: {
        id: id,
        name: mailboxPath(entry, byId),
        rawName: id,
        system: systemIds[id] === true,
        unread: countOf(entry.unreadEmails),
        total: countOf(entry.totalEmails),
        threadsUnread: countOf(entry.unreadThreads)
      }
    })
  }
  rows.sort(function (a, b) {
    if (a.order !== b.order) return a.order - b.order
    if (a.label.name === b.label.name) return 0
    return a.label.name < b.label.name ? -1 : 1
  })

  var out = []
  for (i = 0; i < rows.length; i++) out.push(rows[i].label)
  return out
}

// One mailbox's counts, in the shape `getLabelCounts` answers with.
function labelCounts(mailbox) {
  var box = mailbox && typeof mailbox === "object" ? mailbox : {}
  return {
    id: trimmed(box.id),
    unread: countOf(box.unreadEmails),
    total: countOf(box.totalEmails),
    threadsUnread: countOf(box.unreadThreads)
  }
}

// ------------------------------------------------ an Email as a message row
//
// Every client hands back Gmail's message resource, and this composes one
// rather than parsing it — the way `HeyClient.toMessage` composes. The server
// has already parsed the message; asking it for the raw blob as well would cost
// a second round trip and a MIME parse to rebuild what is in hand.

// What a list row needs and nothing more.
//
// The three `header:…:asRaw` values are asked for by name because JMAP's parsed
// fields do not carry them: the unsubscribe path reads the two `List-` lines
// verbatim, and a `Date` header is what a reply quotes. Nothing is asked for
// that no row reads — `hasAttachment` was, for a badge nothing drew.
var LIST_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
  "from", "to", "cc", "subject", "preview",
  "messageId", "inReplyTo", "references",
  "header:List-Unsubscribe:asRaw", "header:List-Unsubscribe-Post:asRaw",
  "header:Date:asRaw"
]

function keywordSet(email) {
  var keywords = (email || {}).keywords
  return keywords && typeof keywords === "object" ? keywords : {}
}

function hasKeyword(email, name) {
  return isSet(keywordSet(email)[name])
}

function inMailbox(email, mailboxId) {
  var id = trimmed(mailboxId)
  if (id === "") return false
  var ids = (email || {}).mailboxIds
  if (!ids || typeof ids !== "object") return false
  return isSet(ids[id])
}

// The Gmail label ids a JMAP message amounts to, so a row, a star and an unread
// dot work unchanged above the seam. `roles` is the account's role map, which
// is the whole of what a membership means: a mailbox the rail does not draw —
// a user folder, or a role that resolved to nothing — contributes no id.
//
// A message in several mailboxes gets every matching id, as Gmail's does.
function labelIdsFor(email, roles) {
  var map = roles || {}
  var ids = []
  // Unread is the *absence* of `$seen`.
  if (!hasKeyword(email, "$seen")) ids.push("UNREAD")
  if (hasKeyword(email, "$flagged")) ids.push("STARRED")
  if (hasKeyword(email, "$draft") || inMailbox(email, map.drafts)) ids.push("DRAFT")
  if (inMailbox(email, map.inbox)) ids.push("INBOX")
  if (inMailbox(email, map.sent)) ids.push("SENT")
  if (inMailbox(email, map.trash)) ids.push("TRASH")
  if (inMailbox(email, map.junk)) ids.push("SPAM")
  return ids
}

function addressHeaderValue(values) {
  var list = Array.isArray(values) ? values : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var address = trimmed(entry.email)
    if (address === "") continue
    out.push(Mail.addressHeader(address, trimmed(entry.name)))
  }
  return out.join(", ")
}

// `messageId`, `inReplyTo` and `references` are bare ids in JMAP and
// angle-bracketed in a header. The bracketed form is what every reply writes
// back and what `Message.parseRfc822` reads, so the composer restores it.
function angleBracketed(values) {
  var list = Array.isArray(values) ? values : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var id = trimmed(list[i])
    if (id === "") continue
    out.push(/^<[\s\S]*>$/.test(id) ? id : "<" + id + ">")
  }
  return out.join(" ")
}

// A raw header value, whichever key the server filed it under.
//
// RFC 8621 section 4.1.1 names the property `header:{field}:{form}` and a
// server is expected to echo that back — but the reference Stalwart answers
// `header:Date` for a request for `header:Date:asRaw`, dropping the form. Both
// are read because both are real, and a client that read only the asked-for
// name got no Date, no List-Unsubscribe and no unsubscribe link on the server
// this provider was written against.
function rawHeader(email, name) {
  var source = email && typeof email === "object" ? email : {}
  var asked = trimmed(source["header:" + name + ":asRaw"])
  return asked !== "" ? asked : trimmed(source["header:" + name])
}

// `Mail.decodeSnippet` unescapes Gmail's HTML-escaped snippet on the way to a
// row. A JMAP `preview` is plain text, so it is escaped on the way in or a
// sender writing "<3" loses it to a tag that never existed.
function escapedPreview(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// `receivedAt` is a UTC date-time string and `internalDate` is epoch
// milliseconds in a string, which is what every date in the panel is read from.
function receivedMillis(value) {
  var text = trimmed(value)
  if (text === "") return ""
  var parsed = Date.parse(text)
  return isFinite(parsed) && parsed > 0 ? String(parsed) : ""
}

// A JMAP Email as the shared message resource, for a list row.
//
// The body is empty and the mime type is `text/plain` with no data, which is
// what Gmail's own metadata format hands over: a row draws from the headers,
// the labels and the snippet. A full read replaces that placeholder with the
// parts `toPart` walks out of `bodyStructure`, below.
//
// Raw header values arrive from Stalwart with the leading space RFC 5322 puts
// after the colon, and under a key that drops the form they were asked for
// with. `rawHeader` handles both; nothing else here reads one.
//
// The ten names JMAP splits into parsed fields, in the order a message writes
// them. A full read appends every *other* header the server reported, so these
// ten keep the one reading the list row already drew — `Message.headerValue`
// takes the first match, and a row and its reader disagreeing about who a
// message is from is worse than either answer alone.
var COMPOSED_HEADERS = [
  "From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To",
  "References", "List-Unsubscribe", "List-Unsubscribe-Post"
]

function composedHeaders(source) {
  var headers = []
  function push(name, value) {
    var text = trimmed(value)
    if (text !== "") headers.push({ name: name, value: text })
  }

  push("From", addressHeaderValue(source.from))
  push("To", addressHeaderValue(source.to))
  push("Cc", addressHeaderValue(source.cc))
  push("Subject", source.subject)
  push("Date", rawHeader(source, "Date"))
  push("Message-ID", angleBracketed(source.messageId))
  push("In-Reply-To", angleBracketed(source.inReplyTo))
  push("References", angleBracketed(source.references))
  push("List-Unsubscribe", rawHeader(source, "List-Unsubscribe"))
  push("List-Unsubscribe-Post", rawHeader(source, "List-Unsubscribe-Post"))
  return headers
}

// Everything else the message carried, which is what `headers` is asked for on
// a full read and the reason a reply can find a `Reply-To` at all: JMAP has no
// parsed field for one, and `Message.summarize` reads it out of this array.
// Values are trimmed for the same reason the raw ones are — Stalwart writes the
// leading space RFC 5322 puts after the colon into the value.
//
// A name the composed list already wrote is dropped rather than repeated: a
// second `From` would be found by nothing and read by nobody, and a duplicate
// is how a header array starts disagreeing with itself.
function extraHeaders(email) {
  var list = email && Array.isArray(email.headers) ? email.headers : []
  var written = {}
  for (var c = 0; c < COMPOSED_HEADERS.length; c++)
    written[COMPOSED_HEADERS[c].toLowerCase()] = true
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var name = trimmed(entry.name)
    if (name === "" || written[name.toLowerCase()]) continue
    out.push({ name: name, value: trimmed(entry.value) })
  }
  return out
}

function toMessage(email, roles, full) {
  var source = email && typeof email === "object" ? email : {}
  var headers = composedHeaders(source)
  var payload = {
    mimeType: "text/plain",
    headers: headers,
    body: { size: 0 },
    parts: []
  }

  // A full read replaces that placeholder with the message's own MIME tree —
  // and only when the server actually sent one, so a server that answered a
  // full read with list properties still opens as a row rather than as
  // nothing at all.
  if (full === true && source.bodyStructure) {
    var built = toPart(source.bodyStructure, source.bodyValues, 0)
    payload = {
      partId: built.partId,
      mimeType: built.mimeType,
      filename: built.filename,
      // The structure's root repeats the message's headers verbatim; the
      // composed ones are used instead so the reader and the row agree, with
      // the rest appended.
      headers: headers.concat(extraHeaders(source)),
      body: built.body,
      parts: built.parts
    }
  }

  return {
    // The bare Email id, unique per account and stable across a move, so it
    // needs no mailbox suffix as an IMAP UID does.
    id: trimmed(source.id),
    threadId: trimmed(source.threadId),
    labelIds: labelIdsFor(source, roles),
    internalDate: receivedMillis(source.receivedAt),
    sizeEstimate: countOf(source.size),
    payload: payload,
    // The preview again, never rebuilt from the body: a reader that recomputed
    // it would show a different snippet from the row it was opened out of.
    snippet: escapedPreview(source.preview)
  }
}

// ------------------------------------------------------------- a full read
//
// What the reader needs on top of a row: the message's own headers, the MIME
// tree, and the text of the parts that are text. Never `fetchAllBodyValues` —
// it also ships every text *attachment* inline, which the probe measured
// (`notes.txt` arrived whole), and a text attachment may be 20 MB of somebody
// else's log file that nothing on screen would ever show.
//
// `maxBodyValueBytes` is left unset. RFC 8621 makes no truncation the default
// and the reference server honours it; a server that truncates anyway says so
// on the value, and `truncatedParts` is what the client then fetches whole.
var FULL_PROPERTIES = LIST_PROPERTIES.concat(["headers", "bodyStructure", "bodyValues"])

// The part fields the composer builds a Gmail part out of. `cid` and `headers`
// are both asked for: `cid` is the field a `cid:` source would one day be
// resolved through, and `headers` is where `Content-ID` lives for anything
// that looks for it there instead — so a JMAP message behaves as an IMAP one
// does rather than being the one provider that lost the link.
var BODY_PROPERTIES = [
  "partId", "blobId", "size", "name", "type", "charset", "disposition", "cid",
  "headers"
]

// Deep enough for any message a human wrote and shallow enough that a hostile
// one cannot walk the stack out. `Message.js` uses the same figure on the
// parsing side.
var MAX_PART_DEPTH = 12

// The `Email/get` arguments for a list read or a full one, so the two requests
// are described in one place and a test can read exactly what crosses.
function emailGet(accountId, ids, full) {
  var args = {
    accountId: trimmed(accountId),
    ids: Array.isArray(ids) ? ids : [],
    properties: full === true ? FULL_PROPERTIES : LIST_PROPERTIES
  }
  if (full !== true) return args
  args.bodyProperties = BODY_PROPERTIES
  args.fetchTextBodyValues = true
  args.fetchHTMLBodyValues = true
  return args
}

function isTextType(type) {
  return trimmed(type).toLowerCase().indexOf("text/") === 0
}

// A part's MIME type as a Gmail part states it, charset included, because
// `Message.decodePart` reads the charset off this string before it reads a
// header. Which charset that is depends on where the octets came from, and
// getting it wrong is a body of question marks:
//
//   - a body value JMAP handed over has already been decoded, so it is UTF-8
//     whatever the sender wrote
//   - a part delivered as a blob is the raw octets after content-transfer
//     decoding, so it is still in the charset the sender declared
function partMimeType(type, charset) {
  var mime = trimmed(type).toLowerCase()
  if (mime === "") mime = "application/octet-stream"
  if (!isTextType(mime)) return mime
  var set = trimmed(charset)
  return set === "" ? mime : mime + "; charset=" + set
}

// The part's headers as a Gmail part carries them: names and values, values
// trimmed of the leading space the server writes after the colon.
function partHeaders(part) {
  var list = part && Array.isArray(part.headers) ? part.headers : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var name = trimmed(entry.name)
    if (name === "") continue
    out.push({ name: name, value: trimmed(entry.value) })
  }
  return out
}

function bodyValueFor(values, partId) {
  var id = trimmed(partId)
  if (id === "" || !values || typeof values !== "object") return null
  var found = values[id]
  return found && typeof found === "object" ? found : null
}

// How many bytes a base64 string stands for, without decoding it. The value
// has just been encoded from the body, and decoding it again to count the
// bytes would walk the whole message a second time for a number that is
// arithmetic. Both alphabets and either padding: the transport's answer is
// padded standard base64 and the composer's own is unpadded base64url.
function base64ByteLength(text) {
  var input = String(text === undefined || text === null ? "" : text)
    .replace(/=+$/, "")
  var whole = Math.floor(input.length / 4) * 3
  var rest = input.length % 4
  if (rest === 2) return whole + 1
  if (rest === 3) return whole + 2
  return whole
}

// One node of `bodyStructure` as a Gmail part.
//
// A container keeps its children and nothing else. A leaf is one of two things
// and never both:
//
//   - text whose value arrived, which gets `body.data` as base64url of the
//     UTF-8 re-encoding and no attachment id — the reader decodes it in place
//   - everything else, which gets `body.size` and `body.attachmentId` set to
//     the part's `blobId` and no data at all. That is exactly the shape
//     `Message.attachments`, `Calendar.pendingPart` and the open-attachment
//     path already consume from Gmail, so a text attachment the server did not
//     inline is listed as a file rather than drawn as the body.
function toPart(part, values, depth) {
  var source = part && typeof part === "object" ? part : {}
  var type = trimmed(source.type)
  var children = Array.isArray(source.subParts) ? source.subParts : []
  var node = {
    partId: trimmed(source.partId),
    mimeType: partMimeType(type, ""),
    filename: trimmed(source.name),
    headers: partHeaders(source),
    body: { size: 0 },
    parts: []
  }
  // Kept for the day a `cid:` source is resolved to bytes. Nothing reads it
  // today — no provider resolves one, and `Html.imageSourceKind` calls it
  // inline and keeps the tag — and keeping it here is what makes that a change
  // above the seam rather than a change to this provider.
  var cid = trimmed(source.cid)
  if (cid !== "") node.cid = cid

  if (children.length > 0 && depth < MAX_PART_DEPTH) {
    for (var i = 0; i < children.length; i++)
      node.parts.push(toPart(children[i], values, depth + 1))
    return node
  }

  var value = isTextType(type) ? bodyValueFor(values, source.partId) : null
  if (value && typeof value.value === "string") {
    // `isEncodingProblem` is accepted as it stands: the server has already put
    // U+FFFD where the sender's octets were not what they claimed to be, and
    // there is nothing better this end could do with them.
    var data = Mail.encodeBase64Url(value.value)
    node.mimeType = partMimeType(type, "utf-8")
    node.body = { size: base64ByteLength(data), data: data }
    return node
  }

  node.mimeType = partMimeType(type, source.charset)
  node.body = { size: countOf(source.size) }
  var blob = trimmed(source.blobId)
  if (blob !== "") node.body.attachmentId = blob
  return node
}

// The text parts a server truncated, which RFC 8621 lets it do whatever this
// client asked for. Each is fetched whole through the same download the
// attachment path uses and put back before the message is delivered, so the
// reader never shows a body that stops mid-sentence.
//
// A part with no `blobId` is not listed: there would be nothing to fetch.
function truncatedParts(email) {
  var source = email && typeof email === "object" ? email : {}
  var values = source.bodyValues
  var out = []

  function walk(part, depth) {
    var entry = part && typeof part === "object" ? part : null
    if (!entry || depth > MAX_PART_DEPTH) return
    var children = Array.isArray(entry.subParts) ? entry.subParts : []
    if (children.length > 0) {
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
      return
    }
    if (!isTextType(entry.type)) return
    var value = bodyValueFor(values, entry.partId)
    if (!value || value.isTruncated !== true) return
    var blob = trimmed(entry.blobId)
    if (blob === "") return
    out.push({
      partId: trimmed(entry.partId),
      blobId: blob,
      size: countOf(entry.size),
      type: trimmed(entry.type),
      charset: trimmed(entry.charset)
    })
  }

  walk(source.bodyStructure, 0)
  return out
}

// The octets of a truncated part, put back where the short value was.
//
// The charset moves with them. The value that was there had been decoded to
// UTF-8 by the server; these are the sender's own octets in the sender's own
// charset, so a part that declared `iso-8859-1` has to go back to declaring it
// or the repair would read worse than the truncation.
//
// The size is what actually arrived rather than what the structure promised:
// the number on the part is the one the reader should be able to trust.
//
// Returns whether the part was found, so a caller can tell a substitution that
// happened from one that quietly did not.
function substitutePart(payload, part, data) {
  var wanted = trimmed(part && part.partId)
  var encoded = String(data === undefined || data === null ? "" : data)
  if (wanted === "" || encoded === "") return false
  var done = false

  function walk(node, depth) {
    if (!node || typeof node !== "object" || done || depth > MAX_PART_DEPTH) return
    var children = Array.isArray(node.parts) ? node.parts : []
    if (children.length === 0) {
      if (trimmed(node.partId) !== wanted) return
      node.mimeType = partMimeType(
        trimmed(part.type) !== "" ? part.type : node.mimeType,
        trimmed(part.charset) !== "" ? part.charset : "utf-8")
      node.body = { size: base64ByteLength(encoded), data: encoded }
      done = true
      return
    }
    for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
  }

  walk(payload, 0)
  return done
}

// ------------------------------------------------------ actions as patches
//
// `MailAccount` does not know which provider it is driving: it asks for a
// *label change*, in Gmail's vocabulary, because that is the vocabulary every
// view already speaks. This is where that request becomes JMAP, exactly as
// `ImapProtocol.flagPlanForLabels` is where it becomes IMAP.
//
// The unit is a **patch**: one RFC 8620 update object for one Email, keyword
// keys and mailbox keys together, sent under `Email/set`'s `update` map. Two of
// the mappings are not keywords at all — Gmail archives by removing the INBOX
// label, while a JMAP message holds a *set* of mailboxes — so those become
// `mailboxIds` keys instead.

// How a key is taken out of a patch — a keyword, or a mailbox membership. RFC
// 8620 patches a value out with `null`; the reference server also accepts
// `false`, which is not used, because `null` is the form the RFC names and a
// server entitled to refuse the other one is entitled to.
var PATCH_REMOVE = null

// What `maxObjectsInSet` is worth when the session does not say, for the same
// reason `DEFAULT_OBJECTS_IN_GET` exists: RFC 8620 makes the figure mandatory,
// so this is the floor under a server that omitted it rather than an assumption
// about one that stated it. The reference server says 500.
var DEFAULT_OBJECTS_IN_SET = 100

// Where each move goes and what it leaves behind.
//
//   to       the destination role, which has to resolve or the whole request
//            fails here, before anything is sent.
//   from     the role the message stops being in, skipped when it resolves to
//            nothing — leaving a mailbox this account has not got is not a
//            thing that can happen, and `null` on an absent key is harmless.
//   replace  true where `mailboxIds` is written *whole* rather than patched, so
//            the message is in exactly the one mailbox afterwards.
//
// Archive and unarchive are patches on purpose: a message may legitimately sit
// in a user folder as well as the Inbox, and archiving it should swap the one
// membership rather than file away the other. Trash and spam are replaces,
// which is what `Model.survivesAction` and `cachedSummaryInSearch` already
// assume about a message that has been thrown away or reported.
var MOVES = {
  archive: { to: "archive", from: "inbox", replace: false },
  unarchive: { to: "inbox", from: "archive", replace: false },
  untrash: { to: "inbox", from: "trash", replace: false },
  trash: { to: "trash", from: "", replace: true },
  spam: { to: "junk", from: "", replace: true }
}

function hasLabel(list, id) {
  var source = Array.isArray(list) ? list : []
  for (var i = 0; i < source.length; i++) {
    if (trimmed(source[i]).toUpperCase() === id) return true
  }
  return false
}

// Which move a set of label changes amounts to, or "" for a change that is only
// keywords.
//
// Named in the table's own order so a later move overrides an earlier one, and
// that is a rule rather than a tie-break: "report spam" arrives as add SPAM
// *and* remove INBOX, and reading the first of those as an archive would file
// the message on an account with an Archive mailbox and refuse the request on
// one without — for a user who asked to report junk.
function moveFor(added, removed) {
  var move = ""
  if (hasLabel(removed, "INBOX")) move = "archive"
  if (hasLabel(added, "INBOX")) move = "unarchive"
  // Untrash arrives as its own verb rather than as a label change, and this is
  // the Gmail vocabulary for it: a restored message is one the TRASH label came
  // off. JMAP remembers no previous mailbox — a trashed Email carries
  // `mailboxIds` and keywords and nothing else — so it goes to the Inbox, which
  // is where `ImapClient.untrashMessage` moves one.
  if (hasLabel(removed, "TRASH")) move = "untrash"
  if (hasLabel(added, "TRASH")) move = "trash"
  if (hasLabel(added, "SPAM")) move = "spam"
  return move
}

// Which members a move must leave alone, given where the message currently
// sits.
//
// An action on a conversation row is sent for every counted member, and two of
// these moves are wrong on a member that was never in the Inbox: archiving
// would *add* a sent reply — or a message a filter put in a user folder — to
// the Archive mailbox, and reporting spam would move the account's own replies
// into Junk and train the classifier on them. Gmail's archive is "remove
// INBOX", which does nothing to a message that has not got it; this is that
// rule written out, because JMAP's archive has to name a destination.
//
// `mailboxIds` is the client's membership map for this one id, and `null` means
// *unknown* rather than "not in the Inbox": an id the last list read did not
// carry gets the plain single-message patch, which is also the right answer
// for a lone message — a search hit in a user folder is "add Archive".
//
// A role that does not resolve skips nothing. There is no membership to test
// against, and a request that quietly did nothing is worse than one the server
// answers for.
function movesMember(move, mailboxIds, map) {
  if (!Array.isArray(mailboxIds)) return true
  var held = []
  for (var i = 0; i < mailboxIds.length; i++) {
    var id = trimmed(mailboxIds[i])
    if (id !== "") held.push(id)
  }
  if (move === "archive") {
    var inbox = trimmed(map.inbox)
    return inbox === "" || held.indexOf(inbox) >= 0
  }
  if (move === "spam") {
    var sent = trimmed(map.sent)
    return sent === "" || held.indexOf(sent) < 0
  }
  return true
}

// One patch for one message, from the label ids to add and remove, the
// account's role map and — for a member of a conversation — where that message
// currently sits — **or an error sentence**, when the account has no mailbox
// for the move being asked for. The two are told apart by type: a patch is an
// object and a refusal is a string.
//
// The refusal is the point. IMAP's plan yields no move on an account with no
// Archive folder and the request quietly succeeds, having done nothing; here a
// destination that does not resolve is a failure before any request, so the
// account puts the row back and says which mailbox is missing. The alternative
// the server offers is worse: a `mailboxIds/<inbox>: null` with nothing to take
// its place is refused as "Message has to belong to at least one mailbox".
function patchFor(addLabelIds, removeLabelIds, roles, mailboxIds) {
  var added = Array.isArray(addLabelIds) ? addLabelIds : []
  var removed = Array.isArray(removeLabelIds) ? removeLabelIds : []
  var map = roles && typeof roles === "object" ? roles : {}
  var patch = {}

  // The inversion: Gmail's UNREAD is a label you *add*, JMAP's `$seen` is a
  // keyword you *take away*. Getting this backwards marks read what the user
  // has just marked unread.
  if (hasLabel(added, "UNREAD")) patch["keywords/$seen"] = PATCH_REMOVE
  if (hasLabel(removed, "UNREAD")) patch["keywords/$seen"] = true
  if (hasLabel(added, "STARRED")) patch["keywords/$flagged"] = true
  if (hasLabel(removed, "STARRED")) patch["keywords/$flagged"] = PATCH_REMOVE

  var move = moveFor(added, removed)
  if (move === "") return patch

  var plan = MOVES[move]
  var to = trimmed(map[plan.to])
  if (to === "") return missingMailboxError(plan.to)

  // Where this member sits decides whether the move reaches it at all. The
  // refusal above comes first on purpose: an account with no Archive mailbox is
  // told so whichever members the row counted.
  if (!movesMember(move, mailboxIds, map)) return patch

  if (plan.replace) {
    var only = {}
    only[to] = true
    patch.mailboxIds = only
  } else {
    patch["mailboxIds/" + to] = true
    var from = plan.from === "" ? "" : trimmed(map[plan.from])
    if (from !== "" && from !== to) patch["mailboxIds/" + from] = PATCH_REMOVE
  }

  // Reporting spam says something about the message as well as moving it. RFC
  // 8621 registers both keywords and the reference server writes `$junk` on a
  // message its own classifier caught; a server that ignores them loses
  // nothing, and one that learns from them is told. Nothing sets `$notjunk`,
  // because no action moves a message back out of Junk.
  if (move === "spam") {
    patch["keywords/$junk"] = true
    patch["keywords/$notjunk"] = PATCH_REMOVE
  }
  return patch
}

// A patch that would change nothing, which is a request worth not making: a
// label change this provider has no mapping for should not cost a round trip
// and an `Email/set` that names every id and then asks for nothing.
function patchIsEmpty(patch) {
  if (!patch || typeof patch !== "object") return true
  for (var key in patch) return false
  return true
}

// The `Email/set` arguments for one patch over a list of ids, so the request an
// action becomes is described in one place and a test can read exactly what
// crosses.
//
// No `ifInState`, ever. A value the server never issued comes back as a
// request-level 400 `notRequest` on the reference server rather than the
// `stateMismatch` RFC 8620 describes, so a client that guessed one would fail
// every action outright; and an action is a change the user asked for rather
// than one conditional on the list being current. If refresh-by-delta ever
// adopts it, it may only ever carry a state the server returned.
function emailSet(accountId, ids, patch) {
  var update = {}
  var list = Array.isArray(ids) ? ids : []
  for (var i = 0; i < list.length; i++) {
    var id = trimmed(list[i])
    if (id !== "") update[id] = patch
  }
  return { accountId: trimmed(accountId), update: update }
}

// One `notUpdated` entry as a sentence, in the style of
// `ImapProtocol.responseError`: the server's own words are written for whoever
// reads its logs, and these are the ones a user can act on.
function setError(entry) {
  var source = entry && typeof entry === "object" ? entry : {}
  var type = errorType(source.type)
  if (type === "notFound") return "That message is no longer on the server"
  if (type === "forbidden") return "The server refused that change"
  if (type === "tooLarge" || type === "overQuota") return "The mailbox is over its storage quota"
  if (type === "rateLimit") return "The mail server is busy. Try again shortly"
  // `invalidProperties`, `invalidPatch` and whatever a server invents: its own
  // description if it wrote one, because a type name is not a sentence.
  var described = describedBy(source)
  if (described !== "") return redact(described)
  return "The mail server could not complete this request"
}

// What an `Email/set` reply amounts to: "" when everything the request named
// was updated, else the sentence for the first entry that was not.
//
// `tolerateNotFound` is the whole difference between a batch and one message.
// "Mark these read" over a page somebody else has been deleting from is not a
// failed request — what is still there was marked, and the next list load drops
// the rest — so a `notFound` inside a batch is passed over. One message the
// user pointed at is a different thing: there is nothing to report but the
// failure, and reporting success would leave the row moved.
//
// Application is per object, so the objects that were not refused have already
// been changed. The account restores its whole list on the error and the next
// poll or push corrects the rows that did change, which is the contract it
// already keeps for every provider.
function notUpdatedError(args, tolerateNotFound) {
  var source = args && typeof args === "object" ? args.notUpdated : null
  if (!source || typeof source !== "object") return ""
  for (var id in source) {
    var entry = source[id] && typeof source[id] === "object" ? source[id] : {}
    if (tolerateNotFound === true && errorType(entry.type) === "notFound") continue
    return setError(entry)
  }
  return ""
}

// -------------------------------------------------------- sending and drafts
//
// A message leaves this client the way it arrived: as the raw RFC 5322 bytes
// `Message.buildRawMessage` produced. They are uploaded as a blob and turned
// into an Email with `Email/import`, and no Email is ever built from parts —
// which is what keeps the direction twin, the calendar reply and every nested
// boundary byte for byte, and lets the server thread the import by its own
// References header.
//
// A send uploads and submits before a separate draft cleanup. The submission
// request carries, in order:
//
//   0. `Email/import` of the blob into the Drafts role's mailbox, with
//      `$draft` and `$seen`. `$seen` is what keeps Sent from showing an unread
//      message.
//   1. `EmailSubmission/set` creating from the import's *creation id*, with
//      the chosen identity and an `onSuccessUpdateEmail` that moves the copy
//      into Sent and clears `$draft`. Nothing appends to Sent by hand.
// The client removes an existing draft only after a successful response, since
// a failed method does not stop the remaining calls in a request.
//
// No `envelope`. The server derives the sender from the identity and the
// recipients from To, Cc and Bcc, strips Bcc on delivery and keeps it on the
// Sent copy — the same recipient set the IMAP client reads off the same
// headers, and one this client cannot disagree with.
//
// A refused submission leaves the import standing, so the client destroys the
// imported id itself before reporting the error. A leftover would show up as a
// duplicate draft on the next refresh.

// How many uploads may be in flight at once when the session did not say. RFC
// 8620 makes `maxConcurrentUpload` mandatory and requires at least one, so one
// is the floor under a server that omitted it rather than a guess about one
// that stated it. The reference server says four.
var DEFAULT_CONCURRENT_UPLOAD = 1

// The two creation ids the send request uses. They are this client's own
// labels, referenced as `#m` by the submission's `emailId` and as `#s` by the
// `onSuccessUpdateEmail` key — which is keyed on the *submission's* creation
// id, not the email's.
var CREATE_EMAIL = "m"
var CREATE_SUBMISSION = "s"

// The session's upload endpoint, read from the session for the same reason the
// API URL is: it is a fourth place a credential may go, and on the reference
// account it is a different host from the session's own.
function uploadTemplate(session) {
  return sessionField(session, "uploadUrl")
}

// The template filled, with the account id percent-encoded on the way in — the
// same rule `downloadUrl` follows, for the same reason.
function uploadUrl(template, accountId) {
  var filled = String(template === undefined || template === null ? "" : template)
  if (filled === "") return ""
  return fillTemplate(filled, "accountId", accountId)
}

// What an upload answers with: a small JSON object naming the blob the import
// then names. Anything else is an answer this client cannot use.
function uploadedBlobId(body) {
  var doc = parseJson(body)
  return doc ? trimmed(doc.blobId) : ""
}

// The server's own ceiling on an upload, or 0 for a server that did not say.
// RFC 8620 makes the figure mandatory, so 0 means "no ceiling was published"
// rather than "nothing may be sent" — refusing every message because a server
// omitted a number would be this client's failure, not the server's.
function uploadCeiling(session) {
  return coreLimit(session, "maxSizeUpload")
}

// The three refusals that happen before any request, so a message too large or
// an account with nowhere to put the copy costs no round trip and leaves
// nothing behind. "" means nothing is wrong.
//
// Both roles exist on both target servers, so the mailbox pair guards
// misconfiguration — an account whose Sent folder was deleted since the last
// read — rather than a server this client expects to meet.
function sizeGuard(session, byteLength) {
  var ceiling = uploadCeiling(session)
  if (ceiling <= 0) return ""
  var bytes = Math.floor(Number(byteLength))
  if (!isFinite(bytes) || bytes <= ceiling) return ""
  return "This message is larger than the server accepts"
}

function sendGuard(session, roles, byteLength) {
  var refusal = sizeGuard(session, byteLength)
  if (refusal !== "") return refusal
  var map = roles && typeof roles === "object" ? roles : {}
  if (trimmed(map.sent) === "") return missingMailboxError("sent")
  if (trimmed(map.drafts) === "") return missingMailboxError("drafts")
  return ""
}

// A draft never reaches Sent, so the Sent role is not its business.
function saveGuard(session, roles, byteLength) {
  var refusal = sizeGuard(session, byteLength)
  if (refusal !== "") return refusal
  var map = roles && typeof roles === "object" ? roles : {}
  if (trimmed(map.drafts) === "") return missingMailboxError("drafts")
  return ""
}

// One header off a message this client just built, read without parsing it.
//
// The header block ends at the first blank line and an attachment is
// everything after that, so a full MIME parse to read one address would walk
// tens of megabytes for a value that is in the first few hundred bytes.
// Folded continuations are joined, because a long From list is folded.
function messageHeader(message, name) {
  var text = String(message === undefined || message === null ? "" : message)
  var wanted = trimmed(name).toLowerCase()
  if (wanted === "") return ""
  var end = text.search(/\r?\n\r?\n/)
  var lines = (end < 0 ? text : text.substring(0, end)).split(/\r?\n/)
  var value = ""
  var found = false
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (found) {
      if (/^[ \t]/.test(line)) {
        value = trimmed(value + " " + trimmed(line))
        continue
      }
      break
    }
    var colon = line.indexOf(":")
    if (colon < 0) continue
    if (trimmed(line.substring(0, colon)).toLowerCase() !== wanted) continue
    found = true
    value = trimmed(line.substring(colon + 1))
  }
  return value
}

// The address inside a From header, lower-cased for comparison. `Name <a@b>`
// and a bare `a@b` are both written by `Mail.addressHeader`, and the phrase it
// quotes may itself contain an `@`, so the angle brackets win where there are
// any.
function headerAddress(header) {
  var text = trimmed(header)
  if (text === "") return ""
  var angled = /<([^<>]*)>/.exec(text)
  if (angled) return trimmed(angled[1]).toLowerCase()
  var comma = text.indexOf(",")
  if (comma >= 0) text = trimmed(text.substring(0, comma))
  return text.toLowerCase()
}

// The server's identities as the send-as list every composer already reads —
// Gmail's alias shape, so nothing above the provider boundary learns the word
// "identity". The one this account is signed in as is both primary and
// default; on Fastmail the list is every alias and the same code serves it.
//
// The rows keep the identity's `id`, which is the field `identityFor` chooses
// on and the only value `EmailSubmission/set` will take. Nothing above the
// seam reads it — the composer wants an address and a name — but a send that
// had to look the id up again would need a second copy of this decision.
function identityAliases(identities, address) {
  var list = Array.isArray(identities) ? identities : []
  var own = trimmed(address).toLowerCase()
  var out = []
  for (var i = 0; i < list.length; i++) {
    var row = list[i] && typeof list[i] === "object" ? list[i] : {}
    var id = trimmed(row.id)
    var email = trimmed(row.email)
    if (id === "" || email === "") continue
    var mine = own !== "" && email.toLowerCase() === own
    out.push({
      id: id,
      email: email,
      displayName: trimmed(row.name),
      isPrimary: mine,
      isDefault: mine
    })
  }
  return out
}

// Which identity a message goes out under: the one whose address the From
// header names, else the default, else the first there is.
//
// **A send never refuses for want of a match.** The RSVP and the unsubscribe
// both send from the address the mail arrived at, which may be an alias this
// server has no identity for; the server forces the envelope sender to the
// identity and delivers the header as written, which is what those two paths
// need. An empty list answers "" and the server refuses the submission with a
// sentence of its own, which is the honest answer for an account with no
// identity at all.
function identityFor(identities, fromHeader) {
  var list = Array.isArray(identities) ? identities : []
  var wanted = headerAddress(fromHeader)
  var first = ""
  var fallback = ""
  for (var i = 0; i < list.length; i++) {
    var row = list[i] && typeof list[i] === "object" ? list[i] : {}
    var id = trimmed(row.id)
    if (id === "") continue
    if (first === "") first = id
    if (wanted !== "" && trimmed(row.email).toLowerCase() === wanted) return id
    if (fallback === "" && row.isDefault === true) fallback = id
  }
  return fallback !== "" ? fallback : first
}

// The import every outgoing message begins as: the blob, the Drafts mailbox,
// and the two keywords. A draft stops here; a send has the submission move it.
function importCall(accountId, blobId, draftsId, callId) {
  var mailboxes = {}
  var drafts = trimmed(draftsId)
  if (drafts !== "") mailboxes[drafts] = true
  var keywords = {}
  keywords["$draft"] = true
  keywords["$seen"] = true
  var emails = {}
  emails[CREATE_EMAIL] = {
    blobId: trimmed(blobId),
    mailboxIds: mailboxes,
    keywords: keywords
  }
  return ["Email/import", { accountId: trimmed(accountId), emails: emails }, callId]
}

// The whole send, in the order the server applies it.
function sendRequest(accountId, blobId, identityId, roles) {
  var map = roles && typeof roles === "object" ? roles : {}
  var account = trimmed(accountId)
  var drafts = trimmed(map.drafts)
  var sent = trimmed(map.sent)

  // Where the copy ends up once the submission has been accepted: in Sent,
  // out of Drafts and no longer a draft. Written as a patch rather than a
  // whole `mailboxIds`, because the import put it in exactly one mailbox and
  // this is the pair of memberships that changes.
  var moved = {}
  moved["mailboxIds/" + sent] = true
  moved["mailboxIds/" + drafts] = PATCH_REMOVE
  moved["keywords/$draft"] = PATCH_REMOVE

  var success = {}
  success["#" + CREATE_SUBMISSION] = moved
  var create = {}
  create[CREATE_SUBMISSION] = {
    emailId: "#" + CREATE_EMAIL,
    identityId: trimmed(identityId)
  }

  var calls = [
    importCall(account, blobId, drafts, "0"),
    ["EmailSubmission/set", {
      accountId: account,
      create: create,
      onSuccessUpdateEmail: success
    }, "1"]
  ]
  return calls
}

// A draft save imports only. The client destroys the old copy in a separate
// call after confirming creation: method batches continue after failures.
//
// An Email is immutable apart from its keywords and its mailboxes — a subject
// patch is refused `invalidProperties` — so a saved draft is always a new id,
// as it is on IMAP. There is no `updateDraft`.
function saveRequest(accountId, blobId, roles) {
  var map = roles && typeof roles === "object" ? roles : {}
  var account = trimmed(accountId)
  var calls = [importCall(account, blobId, trimmed(map.drafts), "0")]
  return calls
}

// The follow-up a refused submission needs: the import stands, and nothing
// else will remove it.
function destroyRequest(accountId, ids) {
  return [["Email/set", { accountId: trimmed(accountId), destroy: uniqueIds(ids) }, "0"]]
}

// What a `create` map answered for one creation id: the new object's id, or
// the entry saying why there is none. Null rather than an empty object for the
// second, so "was it refused" is a question with an answer.
function createdId(args, creationId) {
  var source = args && typeof args === "object" ? args.created : null
  var entry = source && typeof source === "object" ? source[trimmed(creationId)] : null
  return entry && typeof entry === "object" ? trimmed(entry.id) : ""
}

function notCreatedEntry(args, creationId) {
  var source = args && typeof args === "object" ? args.notCreated : null
  var entry = source && typeof source === "object" ? source[trimmed(creationId)] : null
  return entry && typeof entry === "object" ? entry : null
}

// One refused `create` as a sentence, in `setError`'s style: the server's own
// words are written for whoever reads its logs, and these are the ones a user
// can act on.
//
// `invalidEmail` is the import's refusal rather than the submission's — the
// blob was not a message the server could read — and it is answered here
// because both failures reach the user through the same call. `fallback` is
// what a draft save says instead of "could not be sent", which is not what
// happened to a draft.
var SEND_FAILED = "The message could not be sent"

function submissionError(entry, fallback) {
  var source = entry && typeof entry === "object" ? entry : {}
  var type = errorType(source.type)
  if (type === "forbiddenFrom") return "This account may not send as that address"
  // Also the server's answer to a malformed recipient address when the request
  // carries no envelope, which is every request this client sends.
  if (type === "noRecipients") return "Add a recipient first"
  if (type === "tooLarge") return "The message is too large for this server"
  if (type === "tooManyRecipients") return "Too many recipients for this server"
  if (type === "forbiddenToSend") return "This account is not allowed to send mail"
  if (type === "rateLimit") return "The mail server is busy. Try again shortly"
  if (type === "invalidEmail") return "The server could not read the message"
  var described = describedBy(source)
  if (described !== "") return redact(described)
  var last = trimmed(fallback)
  return last !== "" ? last : SEND_FAILED
}

// What a save's reply amounts to, in `ImapProtocol.draftSaveResult`'s shape.
//
// The draft was saved either way — the import is the first call and it
// succeeded — so an old copy that would not go is a warning rather than a
// failure. `notFound` is not even that: somebody else deleted it, which is the
// outcome that was wanted.
var DRAFT_COPY_WARNING = "Draft saved, but the older copy could not be removed"

function draftSaveResult(args) {
  var source = args && typeof args === "object" ? args.notDestroyed : null
  if (!source || typeof source !== "object") return { saved: true, warning: "" }
  for (var id in source) {
    var entry = source[id] && typeof source[id] === "object" ? source[id] : {}
    if (errorType(entry.type) === "notFound") continue
    var described = describedBy(entry)
    return {
      saved: true,
      warning: described !== "" ? DRAFT_COPY_WARNING + ": " + redact(described) : DRAFT_COPY_WARNING
    }
  }
  return { saved: true, warning: "" }
}

// --------------------------------------------------- per-account refusals
//
// The provider's capability list is a ceiling and an account may withdraw from
// it, never add to it. `refusals` is that withdrawal: a plain object whose
// *presence* of a key is the refusal and whose value is the sentence a user
// reads. An absent key means "as the ceiling says".

var REFUSAL_NO_ARCHIVE = missingMailboxError("archive")
var REFUSAL_NO_JUNK = missingMailboxError("junk")
var REFUSAL_NO_LEARNING = "This server is not known to learn from its Junk mailbox"
var REFUSAL_NO_SEND = "This account cannot send mail"

// Where a move into Junk is known to train the server, and nowhere else.
//
// RFC 8621 registers `$junk` and promises no training whatsoever, so a generic
// JMAP server gets IMAP's answer: no button, because a button that quietly
// filed a message and taught nothing is exactly the promise this seam exists to
// stop being made. Two servers are the exception, both verified:
//
//   - Stalwart trains on a move into the Junk-role mailbox and on `$junk`
//     (`crates/jmap/src/email/set.rs`; the changelog's "training spam/ham when
//     moving between inbox and spam folders").
//   - Fastmail's own help says a message moved into Spam "will be learned as
//     spam", from a third-party client included. It publishes no vendor URN
//     naming itself, so the API host is what identifies it.
//
// A third server is a row here once somebody has verified it.
//
// The Stalwart row is matched on the *account's* `accountCapabilities` first
// and the session's top-level `capabilities` second — in that order, and this
// is measured rather than assumed. On the reference server the URN is in the
// account's list and absent from the session's seventeen, so a rule written to
// the session alone would refuse spam on the very server it was written for.
var STALWART_CAPABILITY = "urn:stalwart:jmap"
var FASTMAIL_API_HOST_SUFFIX = ".fastmail.com"

var LEARNS_FROM_JUNK = [
  { server: "Stalwart", capability: STALWART_CAPABILITY, apiHostSuffix: "" },
  { server: "Fastmail", capability: "", apiHostSuffix: FASTMAIL_API_HOST_SUFFIX }
]

// The API URL's host without its port: `api.fastmail.com:443` is the same
// server as `api.fastmail.com`, and a bracketed IPv6 literal ends in "]" so it
// keeps every colon it has.
function apiHost(session) {
  return sessionHost(apiUrl(session)).replace(/:\d+$/, "")
}

function endsWithHost(host, suffix) {
  if (host === "" || suffix === "" || host.length <= suffix.length) return false
  return host.substring(host.length - suffix.length) === suffix
}

function learnsFromJunk(session, accountId) {
  var doc = parseJson(session)
  if (!doc) return false
  var account = accountFor(doc, accountId)
  var host = apiHost(doc)
  for (var i = 0; i < LEARNS_FROM_JUNK.length; i++) {
    var row = LEARNS_FROM_JUNK[i]
    if (row.capability !== "") {
      if (account && hasCapability(account.accountCapabilities, row.capability)) return true
      if (hasCapability(doc.capabilities, row.capability)) return true
    }
    if (row.apiHostSuffix !== "" && endsWithHost(host, row.apiHostSuffix)) return true
  }
  return false
}

// What this account withdraws from the provider's ceiling, or null.
//
// Null until both a session and a mailbox list are in hand, and that is the
// whole of the timing rule: with null the registry answers the ceiling, which
// is the right thing for a button while the list is still on its way. Between
// reads a button reflects the last known list, and a press against a mailbox
// deleted elsewhere lands on the client's own refusal at request time — two
// layers saying the same sentence, which is why the wording is shared.
function refusals(session, accountId, mailboxes) {
  var list = mailboxArray(mailboxes)
  var doc = parseJson(session)
  if (!doc || list.length === 0) return null

  var out = {}
  if (resolveRole("archive", list) === "") out.archive = REFUSAL_NO_ARCHIVE
  if (resolveRole("junk", list) === "") out.spam = REFUSAL_NO_JUNK
  else if (!learnsFromJunk(doc, accountId)) out.spam = REFUSAL_NO_LEARNING
  if (!hasSubmission(doc, accountId)) out.send = REFUSAL_NO_SEND
  return out
}
