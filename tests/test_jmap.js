const assert = require("assert")
const { load } = require("./load")

const jmap = load("providers/JmapProtocol.js")

// --------------------------------------------------------- transport errors
//
// curl's exit code first: a request that never reached the server has no
// status to report, and saying "the server refused this" about a dropped
// handshake sends somebody to change a password that was never the problem.

assert.strictEqual(jmap.transportError(6, 0, null, "curl: (6) Could not resolve host"),
  "Could not reach the mail server")
assert.strictEqual(jmap.transportError(7, 0, null, ""), "Could not reach the mail server")
assert.strictEqual(jmap.transportError(28, 0, null, ""), "The mail server took too long to answer")
assert.strictEqual(jmap.transportError(35, 0, null, ""),
  "Could not make a secure connection to the mail server")
assert.strictEqual(jmap.transportError(63, 200, null, ""), "This attachment is larger than 20 MB")

// Exit 2 is the script refusing before curl ran, and it has already said why
// in words about this request.
assert.strictEqual(jmap.transportError(2, 0, null, "jmap-transport.sh: refusing a URL that is not https"),
  "jmap-transport.sh: refusing a URL that is not https")
assert.strictEqual(jmap.transportError(2, 0, null, ""),
  "The mail server could not be reached (curl 2)")
assert.strictEqual(jmap.transportError(47, 0, null, ""),
  "The mail server could not be reached (curl 47)")

// The stream's --fail exit 22 carries a status, and the status is what says
// whether the credential was rejected or the connection failed. Only the 401
// raises `credentialsRejected`; the rest back off like a network failure.
assert.strictEqual(jmap.transportError(22, 401, null, ""),
  "The server rejected that username or password")
assert.strictEqual(jmap.transportError(22, 503, null, ""), "The mail server had a problem")
assert.strictEqual(jmap.transportError(22, 0, null, ""),
  "The mail server could not be reached (curl 22)")

// Then the status.
assert.strictEqual(jmap.transportError(0, 401, '{"type":"about:blank","status":401}', ""),
  "The server rejected that username or password")
assert.strictEqual(jmap.transportError(0, 403, '{"detail":"Account is suspended"}', ""),
  "Account is suspended", "a 403 says what the server said when it said anything")
assert.strictEqual(jmap.transportError(0, 403, "", ""), "The server refused that request")
assert.strictEqual(jmap.transportError(0, 404, "", ""),
  "The server has no such mailbox or message")
assert.strictEqual(jmap.transportError(0, 429, "", ""), "The server asked to slow down")
assert.strictEqual(jmap.transportError(0, 429, "", "", "45"),
  "The server asked to slow down (retry in 45s)")
assert.strictEqual(jmap.transportError(0, 429, "", "", "600"),
  "The server asked to slow down (retry in 10 min)")
assert.strictEqual(jmap.transportError(0, 301, "", ""),
  "The server tried to redirect, which this client refuses")
assert.strictEqual(jmap.transportError(0, 302, "", ""),
  "The server tried to redirect, which this client refuses")
assert.strictEqual(jmap.transportError(0, 500, "", ""), "The mail server had a problem")
assert.strictEqual(jmap.transportError(0, 502, "", ""), "The mail server had a problem")

// A 200 that is not a JMAP document is not an answer. A download hands over no
// body at all, because its bytes are not a document to inspect.
assert.strictEqual(jmap.transportError(0, 200, '{"methodResponses":[]}', ""), "")
assert.strictEqual(jmap.transportError(0, 200, "<html>Sign in</html>", ""),
  "The server sent an answer this client could not read")
assert.strictEqual(jmap.transportError(0, 200, "", ""),
  "The server sent an answer this client could not read")
assert.strictEqual(jmap.transportError(0, 200, "42", ""),
  "The server sent an answer this client could not read",
  "valid JSON that is not an object is not a JMAP answer")
assert.strictEqual(jmap.transportError(0, 200, null, ""), "",
  "a blob download passes no body and is not asked to be JSON")
assert.strictEqual(jmap.transportError(0, 204, null, ""), "")

// A 400 carrying a JMAP problem type is a request-level error rather than an
// HTTP one, and is read as the one it is.
assert.strictEqual(
  jmap.transportError(0, 400,
    '{"type":"urn:ietf:params:jmap:error:limit","limit":"maxSizeRequest","status":400}', ""),
  "The server's limit for maxSizeRequest was hit")
assert.strictEqual(jmap.transportError(0, 405, "", ""), "The server refused that request")

// Nothing that could carry a credential reaches a label.
// The token's own closing quote goes with it: over-redacting is the safe
// direction, and a sentence that still held half a bearer token would not be.
assert.strictEqual(jmap.transportError(2, 0, null, 'curl: (2) header "Authorization: Bearer abc.def"'),
  'curl: (2) header "Authorization: Bearer [redacted]')
assert.ok(!/hunter2/.test(jmap.transportError(0, 403, '{"detail":"password=hunter2 rejected"}', "")))

// ----------------------------------------------------------- request errors

assert.strictEqual(
  jmap.requestError({ type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest" }),
  "The server's limit for maxCallsInRequest was hit")
assert.strictEqual(jmap.requestError({ type: "urn:ietf:params:jmap:error:limit" }),
  "The server's limit was hit")
assert.strictEqual(jmap.requestError({ type: "limit", limit: "maxObjectsInGet" }),
  "The server's limit for maxObjectsInGet was hit", "a bare type name reads the same as the URN")
assert.strictEqual(
  jmap.requestError({
    type: "urn:ietf:params:jmap:error:unknownCapability",
    detail: "The Request object used capability 'urn:example:x'"
  }),
  "The mail server had a problem (The Request object used capability 'urn:example:x')")
assert.strictEqual(jmap.requestError({ type: "urn:ietf:params:jmap:error:notJSON" }),
  "The mail server had a problem")
assert.strictEqual(jmap.requestError({ type: "urn:ietf:params:jmap:error:notRequest" }),
  "The mail server had a problem")
assert.strictEqual(jmap.requestError('{"type":"urn:ietf:params:jmap:error:limit","limit":"maxSizeUpload"}'),
  "The server's limit for maxSizeUpload was hit", "an unparsed body is parsed here")
assert.strictEqual(jmap.requestError("not json at all"), "The mail server had a problem")
assert.strictEqual(jmap.requestError(null), "The mail server had a problem")

// ------------------------------------------------------------ method errors

const readOnly = [["error", { type: "accountReadOnly" }, "c0"]]
const notFound = [["Email/get", { list: [] }, "c0"], ["error", { type: "notFound" }, "c1"]]

assert.strictEqual(jmap.methodError([]), "", "no error invocation is no error")
assert.strictEqual(jmap.methodError([["Email/get", { list: [] }, "c0"]]), "")
assert.strictEqual(jmap.methodError(null), "")
assert.strictEqual(jmap.methodError(readOnly), "This account is read-only on the server")
assert.strictEqual(jmap.methodError([["error", { type: "forbidden" }, "c0"]]),
  "The server refused that request")
assert.strictEqual(jmap.methodError([["error", { type: "unsupportedFilter" }, "c0"]]),
  "The server cannot run that search")
assert.strictEqual(jmap.methodError([["error", { type: "unsupportedSort" }, "c0"]]),
  "The server cannot run that search")
assert.strictEqual(jmap.methodError([["error", { type: "requestTooLarge" }, "c0"]]),
  "That request is too large for the server")
assert.strictEqual(
  jmap.methodError([["error", { type: "serverFail", description: "Database is locked" }, "c0"]]),
  "Database is locked", "a server that explained itself is quoted")
assert.strictEqual(jmap.methodError([["error", { type: "serverFail" }, "c0"]]),
  "The mail server had a problem")
assert.strictEqual(jmap.methodError([["error", { type: "invalidArguments" }, "c0"]]),
  "The mail server had a problem")

// The first one wins: a document with several invocations reports the failure
// that came first rather than the last one to be looked at.
assert.strictEqual(jmap.methodError(notFound), "The mail server had a problem")

// A caller that expects an error type has a branch for it, and asking for the
// sentence must not take that branch away. Ticket 05's anchorNotFound retry
// and ticket 06's tolerated notFound are both this.
assert.strictEqual(jmap.methodError(notFound, "notFound"), "")
assert.strictEqual(jmap.methodError(notFound, "anchorNotFound"),
  "The mail server had a problem", "expecting a different type does not silence this one")
assert.strictEqual(jmap.methodError(readOnly, ["notFound", "accountReadOnly"]), "",
  "a caller may expect more than one")
assert.strictEqual(jmap.methodError(readOnly, ["notFound"]),
  "This account is read-only on the server")

// Which error it was, so the branch can act rather than only stay quiet.
assert.strictEqual(jmap.methodErrorType(notFound), "notFound")
assert.strictEqual(jmap.methodErrorType([]), "")
assert.strictEqual(jmap.methodErrorType([["error", {}, "c0"]]), "")

// -------------------------------------------------------------------- queue

const queue = jmap.makeQueue(2)
const a = { id: "a" }
const b = { id: "b" }
const c = { id: "c" }

assert.strictEqual(queue.limit, 2)
assert.strictEqual(queue.admit(a), true, "the first is under the limit")
assert.strictEqual(queue.admit(b), true)
assert.strictEqual(queue.admit(c), false, "the third waits")
assert.strictEqual(queue.running, 2)
assert.strictEqual(queue.waiting.length, 1)

assert.strictEqual(queue.release(), c, "finishing one starts the one that waited")
assert.strictEqual(queue.running, 2, "the released slot is taken by the admitted entry")
assert.strictEqual(queue.waiting.length, 0)
assert.strictEqual(queue.release(), null, "nothing waiting is nothing to start")
assert.strictEqual(queue.release(), null)
assert.strictEqual(queue.running, 0)
assert.strictEqual(queue.release(), null, "releasing more than was admitted does not go negative")
assert.strictEqual(queue.running, 0)

// An aborted handle that never started is withdrawn from the FIFO and calls
// back nothing.
const withdrawal = jmap.makeQueue(1)
assert.strictEqual(withdrawal.admit(a), true)
assert.strictEqual(withdrawal.admit(b), false)
assert.strictEqual(withdrawal.admit(c), false)
assert.strictEqual(withdrawal.withdraw(b), true)
assert.strictEqual(withdrawal.waiting.length, 1)
assert.strictEqual(withdrawal.withdraw(b), false, "withdrawing twice removes nothing twice")
assert.strictEqual(withdrawal.release(), c, "the withdrawn entry is never started")
assert.strictEqual(withdrawal.withdraw(a), false, "a running entry is released, not withdrawn")

// The session's limit, or the floor under a server that did not name one.
assert.strictEqual(jmap.makeQueue(4).limit, 4)
assert.strictEqual(jmap.makeQueue(undefined).limit, jmap.DEFAULT_CONCURRENCY)
assert.strictEqual(jmap.makeQueue(0).limit, jmap.DEFAULT_CONCURRENCY)
assert.strictEqual(jmap.makeQueue(-3).limit, jmap.DEFAULT_CONCURRENCY)
assert.strictEqual(jmap.makeQueue("8").limit, 8)
assert.strictEqual(jmap.DEFAULT_CONCURRENCY, 4)

// ------------------------------------------------------------ download URLs

const template = "https://mx2.depodra.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}"

assert.strictEqual(
  jmap.downloadUrl(template, "t", "b-1", "report.pdf", "application/pdf"),
  "https://mx2.depodra.com/jmap/download/t/b-1/report.pdf?accept=application%2Fpdf")

// The blob id and the filename are the server's choices, not this client's. A
// `/` in either would open a path of its own and a `?` would end the path and
// start a query, so both are encoded and the request stays on the template.
assert.strictEqual(
  jmap.downloadUrl(template, "t", "../../admin", "a/b?c=d", "text/plain"),
  "https://mx2.depodra.com/jmap/download/t/..%2F..%2Fadmin/a%2Fb%3Fc%3Dd?accept=text%2Fplain")
assert.ok(jmap.downloadUrl(template, "t", "x", "a/b", "text/plain").indexOf("/a/b") < 0,
  "a filename may not add a path segment")
assert.ok(jmap.downloadUrl(template, "t", "x", "n?a=1", "text/plain").indexOf("n?a=1") < 0,
  "a filename may not start a query")
assert.strictEqual(
  jmap.downloadUrl(template, "t/other", "x", "n", "text/plain").indexOf("/t/other/") < 0, true,
  "the account id is encoded too")

// `$&` in a filename is data. String.replace would otherwise expand it into
// whatever surrounded the placeholder, and encodeURIComponent leaves `$` alone.
assert.strictEqual(
  jmap.downloadUrl("https://h/{name}", "t", "b", "$&$'x", "text/plain"),
  "https://h/%24%26%24'x")

assert.strictEqual(jmap.downloadUrl("", "t", "b", "n", "text/plain"), "")
assert.strictEqual(jmap.downloadUrl(null, "t", "b", "n", "text/plain"), "")
assert.strictEqual(jmap.downloadUrl("https://h/{blobId}/{blobId}", "t", "b b", "n", "x"),
  "https://h/b%20b/b%20b", "a template may name a value twice")
assert.strictEqual(jmap.downloadUrl("https://h/{name}", "t", "b", undefined, "x"),
  "https://h/", "a value nobody supplied is empty rather than the word undefined")

// ---------------------------------------------------------------- constants

assert.strictEqual(jmap.MAX_BLOB_BYTES, 20971520, "20 MB, the same figure attachment.sh sends up to")
assert.strictEqual(jmap.AUTH_BASIC, "basic")
assert.strictEqual(jmap.AUTH_BEARER, "bearer")
assert.strictEqual(jmap.AUTH_NONE, "none")

console.log("jmap ok")
