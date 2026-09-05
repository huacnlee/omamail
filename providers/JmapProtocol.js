.pragma library

.import "../message/Message.js" as Mail

// JMAP's own rules, and nothing else. No transport lives here —
// `scripts/jmap-transport.sh` runs the curl process and `JmapClient.qml` owns
// it — and no MIME parsing either: an RFC 822 message is `Message.js`'s
// subject, and this file never sees one. What it does own is the other
// direction, `toMessage`: a JMAP Email *composed* into the shared message
// resource, the way `HeyClient.toMessage` composes rather than parses.
//
// This is the whole of the JMAP seam and the one place a rule about JMAP goes.
// `Jmap.js` beside it is the provider *description* the registry reads — a
// name, a ceiling, the rail's rows — and holds no protocol. The client imports
// this file as `Jmap`, so every call in it reads as the decision tickets wrote
// it: `Jmap.parseQuery`, `Jmap.toMessage`, `Jmap.refusals`.
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

// --------------------------------------------------------------- discovery
//
// Finding the server is its own problem, and on the reference server it is the
// one that fails: that Stalwart answers 403 at the well-known path and
// publishes no `_jmap._tcp` record, so every account on it is reached by a host
// somebody typed. Fastmail is the other end — nothing typed at all, an SRV
// record naming `api.fastmail.com`. Both paths are here because both are real.

// The order the setup page tries the two credential schemes in.
//
// Basic first: RFC 8620 section 8.2 names an app password as the Basic-auth
// credential, and a token sent as Basic is a rarer mistake than a password
// sent as Bearer. A server that takes only a token answers the first attempt
// with a 401 and the second one succeeds. Two requests with two credentials,
// from the setup page and nowhere else — it is a detection, not a retry, and a
// 401 from both is the rejected state.
var AUTH_SCHEME_ORDER = [AUTH_BASIC, AUTH_BEARER]

// What a discovery step is. `typed` is the URL built from what the user wrote,
// and it is the only step there is when they wrote something; `srv` is the
// `_jmap._tcp` record for the address's domain, which has to be looked up
// before it has a URL; `well-known` is a well-known URL to GET.
var STEP_TYPED = "typed"
var STEP_SRV = "srv"
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

// The well-known URL on a host the SRV record named. The port is written only
// when it is not 443: a record saying 443 and a URL saying `:443` are the same
// address, and the shorter one is what a user is shown afterwards.
function wellKnownUrl(host, port) {
  var name = bareHost(host)
  if (!isValidHost(name)) return ""
  var suffix = isValidPort(port) && Math.floor(Number(port)) !== 443
    ? ":" + Math.floor(Number(port)) : ""
  return "https://" + name + suffix + WELL_KNOWN_PATH
}

// What the user typed in the "Server settings" field, as a URL — or "" when it
// is not one this client will send a password to.
//
// A full HTTPS URL is used verbatim, because a session object living somewhere
// this client would never have guessed is exactly why the field exists. A bare
// host gains the session path. Anything else — `http://`, a scheme that is not
// HTTP at all, a value with a space in it — is refused rather than repaired.
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

// Where this address's JMAP server is looked for, and in what order.
//
//   { error, domain, steps: [ { kind, url } ] }
//
// `error` is the one refusal this can answer, and an errored plan has no
// steps. A typed server wins outright: somebody who filled that field in is
// answering a discovery that already failed, and walking the domain again
// afterwards would only fail again more slowly.
//
// The SRV step carries no URL because it has not been looked up yet. The
// caller runs `scripts/jmap-srv.sh` for `domain`, hands what it printed to
// `parseSrv`, and GETs the URL that comes back; a record that names no service
// simply leaves that step with nothing to try.
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
      { kind: STEP_SRV, url: "" },
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
  return /^https:\/\//i.test(url) ? url : ""
}

// The `_jmap._tcp` SRV answer, as the one record to try:
//
//   { target, port, url }
//
// `scripts/jmap-srv.sh` prints whatever `resolvectl` or `dig` said, and the
// two disagree about everything but the four fields that matter: resolvectl
// writes `_jmap._tcp.example.org IN SRV 0 1 443 api.example.org  -- link: wlan0`
// and `dig +short` writes `0 1 443 api.example.org.`. So a record is found by
// its shape — three small numbers in a row and a name after them — rather than
// by counting fields from either end, which is what the interface suffix
// resolvectl appends would break.
//
// RFC 2782 picks the lowest priority, then the highest weight. Weight is a
// share of a random draw among equals; a client fetching one session object
// has nothing to spread, so the heaviest wins and a tie takes the first.
function parseSrv(text) {
  var lines = String(text === undefined || text === null ? "" : text).split("\n")
  var best = null
  for (var i = 0; i < lines.length; i++) {
    var record = srvRecord(lines[i])
    if (!record) continue
    if (!best || record.priority < best.priority
      || (record.priority === best.priority && record.weight > best.weight)) {
      best = record
    }
  }
  // A target of "." is RFC 2782's way of saying the service is decidedly not
  // available here, which is a different thing from no record at all — and the
  // same answer to the one question this client asks.
  if (!best || best.target === "") return { target: "", port: 0, url: "" }
  return { target: best.target, port: best.port, url: wellKnownUrl(best.target, best.port) }
}

function srvRecord(line) {
  var fields = trimmed(line).split(/\s+/)
  for (var i = 0; i + 3 < fields.length; i++) {
    if (!/^[0-9]{1,5}$/.test(fields[i])) continue
    if (!/^[0-9]{1,5}$/.test(fields[i + 1])) continue
    if (!/^[0-9]{1,5}$/.test(fields[i + 2]) || !isValidPort(fields[i + 2])) continue
    var target = bareHost(fields[i + 3])
    // "." strips to "", and a target that is not a hostname is not a record
    // this client can act on either.
    if (target !== "" && !isValidHost(target)) continue
    return {
      priority: Number(fields[i]),
      weight: Number(fields[i + 1]),
      port: Math.floor(Number(fields[i + 2])),
      target: target
    }
  }
  return null
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
  return { error: "", accountId: primary }
}

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

// Where every method call goes. Read from the session rather than assumed:
// on the reference account the session is on one host and this URL is on
// another, and it is the second of the two places a credential may go.
function apiUrl(session) {
  var doc = parseJson(session)
  return doc ? trimmed(doc.apiUrl) : ""
}

// The server's own word for "nothing has changed". A cached session is good
// for as long as this matches, and a push telling the client the state moved
// is what makes it refetch — so it is what a cache entry is keyed on.
function sessionState(session) {
  var doc = parseJson(session)
  return doc ? trimmed(doc.state) : ""
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

// A positive whole number from the session's core capability, or the fallback.
function sessionLimit(session, name, fallback) {
  var doc = parseJson(session)
  var core = doc && doc.capabilities && typeof doc.capabilities === "object"
    ? doc.capabilities[CAPABILITY_CORE] : null
  var value = core && typeof core === "object" ? Math.floor(Number(core[trimmed(name)])) : NaN
  if (isFinite(value) && value > 0) return value
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
  var list = Array.isArray(responses) ? responses : []
  var wanted = trimmed(name)
  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    if (!row || typeof row !== "object" || row.length < 2) continue
    if (trimmed(row[0]) !== wanted) continue
    return row[1] && typeof row[1] === "object" ? row[1] : {}
  }
  return null
}

// ------------------------------------------------------------- known states
//
// The newest state the server has reported for each type, from any reply:
//
//   { Email: "s41", Mailbox: "s7" }
//
// Push (ticket 09) is the only reader. A `StateChange` naming a state this
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

  var list = Array.isArray(responses) ? responses : []
  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    if (!row || typeof row !== "object" || row.length < 2) continue
    var name = trimmed(row[0])
    var slash = name.indexOf("/")
    if (slash <= 0) continue
    var args = row[1] && typeof row[1] === "object" ? row[1] : {}
    // `newState` is where a `/set` left the type; `state` is where a `/get`
    // read it. Either is the newest this client has been told about.
    var state = trimmed(args.newState) !== "" ? trimmed(args.newState) : trimmed(args.state)
    if (state !== "") out[name.substring(0, slash)] = state
  }
  return out
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
// reference Stalwart's Archive folders are exactly that.
var ROLE_NAME_GUESSES = {
  sent: /^sent( mail| items| messages)?$/,
  trash: /^(trash|deleted( items| messages)?)$/,
  drafts: /^drafts?$/,
  junk: /^(junk|spam|bulk mail)$/,
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

// One row per message. Ticket 11 of the build flips this to true and gives the
// summary its thread block; `total` then counts conversations rather than
// messages, which is why the flip is one constant here rather than an argument
// every caller would have to agree about.
var COLLAPSE_THREADS = false

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
// `threadIds` is empty here. The query runs uncollapsed in this ticket, so a
// row is a message and nothing above groups them; ticket 11 chains an
// `Email/get` through a `#ids` back-reference and fills it.
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
// verbatim, and a `Date` header is what a reply quotes. `hasAttachment` is
// asked for because the decision recorded it and it is one boolean the server
// already holds; nothing reads it yet.
var LIST_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
  "from", "to", "cc", "subject", "preview", "hasAttachment",
  "messageId", "inReplyTo", "references",
  "header:List-Unsubscribe:asRaw", "header:List-Unsubscribe-Post:asRaw",
  "header:Date:asRaw"
]

function keywordSet(email) {
  var keywords = (email || {}).keywords
  return keywords && typeof keywords === "object" ? keywords : {}
}

function hasKeyword(email, name) {
  var value = keywordSet(email)[name]
  return value !== undefined && value !== null && value !== false
}

function inMailbox(email, mailboxId) {
  var id = trimmed(mailboxId)
  if (id === "") return false
  var ids = (email || {}).mailboxIds
  if (!ids || typeof ids !== "object") return false
  var value = ids[id]
  return value !== undefined && value !== null && value !== false
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
// the labels and the snippet. Ticket 07 adds the parts a full read walks out of
// `bodyStructure`.
//
// Raw header values arrive from Stalwart with the leading space RFC 5322 puts
// after the colon, and under a key that drops the form they were asked for
// with. `rawHeader` handles both; nothing else here reads one.
function toMessage(email, roles) {
  var source = email && typeof email === "object" ? email : {}
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

  return {
    // The bare Email id, unique per account and stable across a move, so it
    // needs no mailbox suffix as an IMAP UID does.
    id: trimmed(source.id),
    threadId: trimmed(source.threadId),
    labelIds: labelIdsFor(source, roles),
    internalDate: receivedMillis(source.receivedAt),
    sizeEstimate: countOf(source.size),
    payload: {
      mimeType: "text/plain",
      headers: headers,
      body: { size: 0 },
      parts: []
    },
    snippet: escapedPreview(source.preview)
  }
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
