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
var CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission"

function hasSubmission(session) {
  var doc = parseJson(session)
  if (!doc) return false
  var primary = doc.primaryAccounts && typeof doc.primaryAccounts === "object"
    ? trimmed(doc.primaryAccounts[CAPABILITY_MAIL]) : ""
  var account = doc.accounts && typeof doc.accounts === "object" && primary !== ""
    ? doc.accounts[primary] : null
  return !!account && hasCapability(account.accountCapabilities, CAPABILITY_SUBMISSION)
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
