const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapProtocol.js")
const description = load("providers/Jmap.js")
const registry = load("providers/Registry.js")
const message = load("message/Message.js")
const calendar = load("message/Calendar.js")

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
assert.strictEqual(jmap.transportError(63, 200, null, ""), "The server's answer was larger than 20 MB")

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

// A successful reply is not a request error, and this function is where a
// caller who forgot to look inside first lands. A problem-details object always
// names a `type`; a reply that worked never does and carries `methodResponses`
// instead — so asking about a full mailbox has to answer "nothing went wrong"
// rather than inventing a failure out of it.
assert.strictEqual(jmap.requestError({ methodResponses: [["Mailbox/get", { list: [] }, "0"]] }), "")
assert.strictEqual(jmap.requestError({ methodResponses: [] }), "",
  "a reply with no invocations in it is still a reply")
assert.strictEqual(jmap.requestError('{"methodResponses":[["Email/query",{"ids":[]},"0"]]}'), "")
assert.strictEqual(jmap.requestError({ sessionState: "s1", methodResponses: [] }), "")
// A document naming both is a refusal that happens to echo something back, and
// the type is what says so.
assert.strictEqual(
  jmap.requestError({ type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest",
    methodResponses: [] }),
  "The server's limit for maxCallsInRequest was hit")
assert.strictEqual(jmap.requestError({}), "The mail server had a problem",
  "and a document that is neither is still unreadable")

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

const template = "https://api.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}"

assert.strictEqual(
  jmap.downloadUrl(template, "t", "b-1", "report.pdf", "application/pdf"),
  "https://api.example.org/jmap/download/t/b-1/report.pdf?accept=application%2Fpdf")

// The blob id and the filename are the server's choices, not this client's. A
// `/` in either would open a path of its own and a `?` would end the path and
// start a query, so both are encoded and the request stays on the template.
assert.strictEqual(
  jmap.downloadUrl(template, "t", "../../admin", "a/b?c=d", "text/plain"),
  "https://api.example.org/jmap/download/t/..%2F..%2Fadmin/a%2Fb%3Fc%3Dd?accept=text%2Fplain")
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

// The `using` array of every request, built here and nowhere else: a vendor URN
// in one of them would make every request refuseable by a server that never
// heard of it, and a missing one comes back `unknownCapability`.
deepEqual(jmap.USING_MAIL, ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"])
deepEqual(jmap.USING_SUBMISSION, ["urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  "mail as well as submission: a send also imports the message into a mailbox")

// --------------------------------------------------------------- discovery
//
// HTTPS on the address domain establishes discovery authority. Servers that
// do not publish the well-known endpoint need an explicit server address.

// A typed server wins outright, and a bare host means the session path.
deepEqual(jmap.discoveryPlan("ada@example.org", "mail.example.org"), {
  error: "",
  domain: "example.org",
  steps: [{ kind: "typed", url: "https://mail.example.org/jmap/session" }]
})

// A full HTTPS URL is used exactly as written: a session object living
// somewhere this client would never have guessed is why the field exists.
deepEqual(jmap.discoveryPlan("ada@example.org", "https://mx2.example.org/jmap/session"), {
  error: "",
  domain: "example.org",
  steps: [{ kind: "typed", url: "https://mx2.example.org/jmap/session" }]
})

// A host with a port keeps it; a host with a path already says where the
// session is, so nothing is appended to it.
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "mail.example.org:8443").steps[0].url,
  "https://mail.example.org:8443/jmap/session")
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "mail.example.org/jmap/").steps[0].url,
  "https://mail.example.org/jmap/")

// An account password may not go out over plaintext, and a value that is not a
// server at all is refused rather than repaired into one.
const plain = jmap.discoveryPlan("ada@example.org", "http://mail.example.org")
assert.strictEqual(plain.error, "The server must be reached over HTTPS")
assert.strictEqual(plain.steps.length, 0, "a refused plan has nothing to try")
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "ftp://mail.example.org").error,
  "The server must be reached over HTTPS")
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "mail example org").error,
  "The server must be reached over HTTPS")
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "user@mail.example.org").error,
  "The server must be reached over HTTPS")
assert.strictEqual(jmap.discoveryPlan("ada@example.org", "mail.example.org:70000").error,
  "The server must be reached over HTTPS")

// Without a typed server, only the original domain can delegate credentials.
deepEqual(jmap.discoveryPlan("Ada@Example.ORG", ""), {
  error: "",
  domain: "example.org",
  steps: [
    { kind: "well-known", url: "https://example.org/.well-known/jmap" }
  ]
})
deepEqual(jmap.discoveryPlan("ada@example.org", "   "), jmap.discoveryPlan("ada@example.org", ""),
  "a field with only spaces in it is an empty field")

// Nothing to look for is not a failure worth a sentence: the page validates
// the address before discovery runs at all.
deepEqual(jmap.discoveryPlan("", ""), { error: "", domain: "", steps: [] })
deepEqual(jmap.discoveryPlan("not-an-address", ""), { error: "", domain: "", steps: [] })

// Every step tried and none of them a session.
assert.strictEqual(jmap.discoveryFailure("example.org"),
  "No JMAP server answered for example.org. Enter the server yourself — usually"
  + " the host you sign in to on the web, such as mail.example.org.")

// One hop, HTTPS only, and only from a redirect. Stalwart's well-known path
// answers 307 to its own session URL, and curl follows nothing.
assert.strictEqual(jmap.redirectHop(307, "https://mail.example.org/jmap/session"),
  "https://mail.example.org/jmap/session")
assert.strictEqual(jmap.redirectHop(301, "http://mail.example.org/jmap/session"), "",
  "a redirect to plaintext is not followed")
assert.strictEqual(jmap.redirectHop(200, "https://mail.example.org/jmap/session"), "",
  "an answer is not a hop")
assert.strictEqual(jmap.redirectHop(307, ""), "")
assert.strictEqual(jmap.redirectHop(0, "https://mail.example.org/"), "")
assert.strictEqual(jmap.discoveryHop(307, "https://mail.example.org/jmap/session", "example.org"),
  "https://mail.example.org/jmap/session")
assert.strictEqual(jmap.discoveryHop(307, "https://api.mailhost.example/jmap/session", "customer.example"),
  "https://api.mailhost.example/jmap/session",
  "the address domain's authenticated well-known response may delegate to its provider")

assert.strictEqual(jmap.sessionProbeAccepts(200, "<html>Sign in</html>"), false,
  "a web page is not a session")
assert.strictEqual(jmap.sessionProbeAccepts(200, JSON.stringify({
  capabilities: { "urn:ietf:params:jmap:core": {} },
  accounts: {}
})), true, "an unauthenticated session document is a candidate")
assert.strictEqual(jmap.sessionProbeAccepts(401, ""), false,
  "an empty 401 is not a JMAP challenge")
assert.strictEqual(jmap.sessionProbeAccepts(401, "<html>Sign in</html>"), false,
  "an HTML 401 is not a JMAP challenge")
assert.strictEqual(jmap.sessionProbeAccepts(401, JSON.stringify({ status: 401 })), false,
  "generic JSON 401 is not a JMAP challenge")
assert.strictEqual(jmap.sessionProbeAccepts(401, JSON.stringify({
  type: "urn:ietf:params:jmap:error:limit", status: 401
})), true)
assert.strictEqual(jmap.sessionProbeAccepts(401, "No Authorization header"), true,
  "Fastmail's session challenge is text/plain")

// --------------------------------------------------------- session object
//
// The shape is the reference Stalwart's, measured through the transport on
// 2026-09-05. Worth knowing for whichever rule reads it next: that server puts
// `urn:stalwart:jmap` in the *account's* capabilities and not in the session's,
// where the session's own list is the nine standard URNs plus its extensions.

function session(overrides) {
  const base = {
    capabilities: {
      "urn:ietf:params:jmap:core": { maxCallsInRequest: 16, maxObjectsInGet: 500 },
      "urn:ietf:params:jmap:mail": {},
      "urn:ietf:params:jmap:submission": {}
    },
    accounts: {
      t: {
        name: "ada@example.org",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          "urn:ietf:params:jmap:mail": {
            emailQuerySortOptions: ["receivedAt", "size", "from", "to", "subject"],
            mayCreateTopLevelMailbox: true
          },
          "urn:ietf:params:jmap:submission": {},
          "urn:stalwart:jmap": {}
        }
      }
    },
    primaryAccounts: {
      "urn:ietf:params:jmap:core": "t",
      "urn:ietf:params:jmap:mail": "t"
    },
    apiUrl: "https://api.example.org/jmap/",
    state: "abc"
  }
  return Object.assign(base, overrides || {})
}

deepEqual(jmap.verifySession(session()), { error: "", accountId: "t" },
  "a good session hands back the account id every later request names")
deepEqual(jmap.verifySession(JSON.stringify(session())), { error: "", accountId: "t" },
  "the document may still be text")

// Not a JMAP mail server: no capabilities at all, or core without mail.
assert.strictEqual(jmap.verifySession(null).error,
  "The server answered, but not as a JMAP mail server")
assert.strictEqual(jmap.verifySession("<html>Not here</html>").error,
  "The server answered, but not as a JMAP mail server")
assert.strictEqual(jmap.verifySession(session({ capabilities: {} })).error,
  "The server answered, but not as a JMAP mail server")
assert.strictEqual(
  jmap.verifySession(session({ capabilities: { "urn:ietf:params:jmap:core": {} } })).error,
  "The server answered, but not as a JMAP mail server",
  "core alone is a server that does not carry mail")

// No mailbox for this account. Stalwart answers 200 with an empty `accounts`
// when the Authorization header never arrives, so this is the check that stops
// a 200 from being read as "signed in".
assert.strictEqual(jmap.verifySession(session({ accounts: {} })).error,
  "The server has no mailbox for this account")
assert.strictEqual(jmap.verifySession(session({ primaryAccounts: {} })).error,
  "The server has no mailbox for this account")
assert.strictEqual(
  jmap.verifySession(session({ primaryAccounts: { "urn:ietf:params:jmap:mail": "other" } })).error,
  "The server has no mailbox for this account",
  "a primary naming an account the session does not carry is not one to sign in to")
assert.strictEqual(
  jmap.verifySession(session({
    accounts: { t: { accountCapabilities: { "urn:ietf:params:jmap:submission": {} } } }
  })).error,
  "The server has no mailbox for this account",
  "an account that carries no mail capability is not a mailbox")

// Sorting by date is what every query this client sends asks for, so an
// account that cannot is refused here — where there is still a field to
// change — rather than on the first mailbox anybody opens.
assert.strictEqual(
  jmap.verifySession(session({
    accounts: {
      t: {
        accountCapabilities: {
          "urn:ietf:params:jmap:mail": { emailQuerySortOptions: ["size", "subject"] }
        }
      }
    }
  })).error,
  "The server cannot sort mail by date, which this client needs")
assert.strictEqual(
  jmap.verifySession(session({
    accounts: { t: { accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } }
  })).error,
  "The server cannot sort mail by date, which this client needs",
  "RFC 8621 makes the list mandatory, so an absent one is not a quiet yes")

// The scheme is detected rather than asked, and this is the order: an app
// password is RFC 8620's Basic credential, and only a 401 buys the second try.
deepEqual(jmap.AUTH_SCHEME_ORDER, ["basic", "bearer"])

// Where every method call goes, read from the session rather than assumed: on
// the reference account the session is on one host and this URL is on another.
assert.strictEqual(jmap.apiUrl(session()), "https://api.example.org/jmap/")
assert.strictEqual(jmap.apiUrl(JSON.stringify(session())), "https://api.example.org/jmap/")
assert.strictEqual(jmap.apiUrl(session({ apiUrl: undefined })), "")
assert.strictEqual(jmap.apiUrl("not a session"), "")

// The server's own word for "nothing has changed", which is what a cached
// session is keyed on.
assert.strictEqual(jmap.sessionState(session()), "abc")
assert.strictEqual(jmap.sessionState(session({ state: undefined })), "")
assert.strictEqual(jmap.sessionState(null), "")

// A reply naming a state the held session does not have is the server saying
// the session moved, and the state it names is what the refetch is keyed on. A
// reply carrying none, or a held session with none, moves nothing.
assert.strictEqual(jmap.movedSessionState(session(), { sessionState: "abd", methodResponses: [] }), "abd")
assert.strictEqual(jmap.movedSessionState(session(), '{"sessionState":"abd","methodResponses":[]}'), "abd")
assert.strictEqual(jmap.movedSessionState(session(), { sessionState: "abc", methodResponses: [] }), "",
  "the state the session already has")
assert.strictEqual(jmap.movedSessionState(session(), { methodResponses: [] }), "",
  "a reply that names no state says nothing")
assert.strictEqual(jmap.movedSessionState(session({ state: undefined }), { sessionState: "abd" }), "",
  "and a held session with no state has nothing to compare")
assert.strictEqual(jmap.movedSessionState(null, { sessionState: "abd" }), "")

// Sending does not gate sign-in: a credential that cannot submit still reads
// mail. Asked of the mail account first and of the session second, because the
// two really do disagree — a per-account permission is stated on the account.
assert.strictEqual(jmap.hasSubmission(session()), true)
assert.strictEqual(jmap.hasSubmission(JSON.stringify(session())), true)
assert.strictEqual(
  jmap.hasSubmission(session({
    accounts: {
      t: {
        accountCapabilities: {
          "urn:ietf:params:jmap:mail": { emailQuerySortOptions: ["receivedAt"] }
        }
      }
    }
  })),
  false,
  "the session saying the server can submit is not this credential being allowed to")
assert.strictEqual(
  jmap.hasSubmission(session({ primaryAccounts: { "urn:ietf:params:jmap:mail": "other" } })),
  false,
  "no primary mail account is no account that may submit")
assert.strictEqual(jmap.hasSubmission(null), false)
assert.strictEqual(jmap.hasSubmission("<html>"), false)

// The host a session URL names, which is the whole of what a user is shown
// afterwards: the mailboxes row's second line and the "Signed in" line.
assert.strictEqual(jmap.sessionHost("https://mail.example.org/jmap/session"), "mail.example.org")
assert.strictEqual(jmap.sessionHost("https://Mail.Example.ORG/jmap/session"), "mail.example.org")
assert.strictEqual(jmap.sessionHost("https://mail.example.org:8443/jmap/session"),
  "mail.example.org:8443", "a port is part of the address and hiding it would be wrong")
assert.strictEqual(jmap.sessionHost("https://mail.example.org"), "mail.example.org")
assert.strictEqual(jmap.sessionHost("https://mail.example.org?x=1"), "mail.example.org")
assert.strictEqual(jmap.sessionHost("https://ada:hunter2@mail.example.org/jmap/session"),
  "mail.example.org", "userinfo is not the address, and it is the half that could carry a secret")
assert.strictEqual(jmap.sessionHost("http://mail.example.org/jmap/session"), "",
  "nothing here is ever reached over plain HTTP, so nothing here reports one")
assert.strictEqual(jmap.sessionHost("mail.example.org"), "")
assert.strictEqual(jmap.sessionHost(""), "")
assert.strictEqual(jmap.sessionHost(null), "")

// What the user calls the credential that worked. The scheme is detected, so
// this is the page reporting which of the two things they pasted it was.
assert.strictEqual(jmap.schemeLabel("basic"), "app password")
assert.strictEqual(jmap.schemeLabel("bearer"), "API token")
assert.strictEqual(jmap.schemeLabel("Bearer"), "API token")
assert.strictEqual(jmap.schemeLabel(""), "app password",
  "an account with nothing recorded is Basic, which is what sign-in tries first")
assert.strictEqual(jmap.schemeLabel(null), "app password")

// ------------------------------------------------------ mailboxes and roles
//
// The list is the reference test account's, read from the server with the
// client's own property list: an Inbox, a Junk, a Drafts, a Trash and a Sent,
// and no Archive at all — which is the account the absent-row and refusal rules
// below have to be right about.

const boxes = [
  { id: "a", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0,
    totalEmails: 7, unreadEmails: 2, unreadThreads: 2 },
  { id: "c", name: "Junk Mail", parentId: null, role: "junk", sortOrder: 0,
    totalEmails: 1, unreadEmails: 0, unreadThreads: 0 },
  { id: "d", name: "Drafts", parentId: null, role: "drafts", sortOrder: 0,
    totalEmails: 1, unreadEmails: 0, unreadThreads: 0 },
  { id: "b", name: "Deleted Items", parentId: null, role: "trash", sortOrder: 0,
    totalEmails: 1, unreadEmails: 0, unreadThreads: 0 },
  { id: "e", name: "Sent Items", parentId: null, role: "sent", sortOrder: 0,
    totalEmails: 0, unreadEmails: 0, unreadThreads: 0 }
]

// By role first, which is the answer on every mailbox this account has.
assert.strictEqual(jmap.resolveRole("inbox", boxes), "a")
assert.strictEqual(jmap.resolveRole("junk", boxes), "c")
assert.strictEqual(jmap.resolveRole("trash", boxes), "b")
assert.strictEqual(jmap.resolveRole("drafts", boxes), "d")
assert.strictEqual(jmap.resolveRole("sent", boxes), "e")
assert.strictEqual(jmap.resolveRole("archive", boxes), "",
  "and nothing at all where the account has no such mailbox")
assert.strictEqual(jmap.resolveRole("INBOX", boxes), "a", "the role is matched case-insensitively")
assert.strictEqual(jmap.resolveRole("", boxes), "")
assert.strictEqual(jmap.resolveRole("archive", null), "")

// Then by the leaf name, which is what a server that publishes no role on a
// mailbox it plainly means as one needs — the reference Stalwart's own Archive
// folders are exactly that.
const unrolled = [
  { id: "1", name: "Inbox", parentId: null, role: "inbox" },
  { id: "2", name: "Archive", parentId: null, role: null },
  { id: "3", name: "Deleted Items", parentId: null, role: null },
  { id: "4", name: "Sent Mail", parentId: null, role: null },
  { id: "5", name: "Drafts", parentId: null, role: null },
  { id: "6", name: "Bulk Mail", parentId: null, role: null }
]
assert.strictEqual(jmap.resolveRole("archive", unrolled), "2")
assert.strictEqual(jmap.resolveRole("trash", unrolled), "3")
assert.strictEqual(jmap.resolveRole("sent", unrolled), "4")
assert.strictEqual(jmap.resolveRole("drafts", unrolled), "5")
assert.strictEqual(jmap.resolveRole("junk", unrolled), "6")
assert.strictEqual(jmap.resolveRole("archive", [{ id: "9", name: "All Mail", parentId: null }]), "9")
// Exchange's name for the junk folder, which the bare word cannot stand in for
// — the same guess IMAP makes, so an account reads the same over either.
assert.strictEqual(jmap.resolveRole("junk", [{ id: "j", name: "Junk Email", parentId: null }]), "j")
assert.strictEqual(jmap.resolveRole("junk", [{ id: "j", name: "Junk E-mail", parentId: null }]), "j")
assert.strictEqual(jmap.resolveRole("junk", [{ id: "j", name: "Junk-Email", parentId: null }]), "j")
assert.strictEqual(jmap.resolveRole("junk", [{ id: "j", name: "Junky", parentId: null }]), "")

// A role wins over a name, wherever both are on offer.
assert.strictEqual(jmap.resolveRole("archive",
  [{ id: "n", name: "Archive", parentId: null }, { id: "r", name: "Filed", role: "archive" }]),
  "r", "the mailbox carrying the role, not the one merely named like it")

// Never guessed: the inbox, because `role: "inbox"` is the one role RFC 8621
// requires and a name match could only ever find a second folder called Inbox.
assert.strictEqual(jmap.resolveRole("inbox", [{ id: "x", name: "Inbox", parentId: null }]), "",
  "a mailbox named Inbox with no role is a folder, not the inbox")

// And never a nested one: an "Archive" under "Projects" is somebody's filing.
assert.strictEqual(jmap.resolveRole("archive",
  [{ id: "p", name: "Projects", parentId: null }, { id: "n", name: "Archive", parentId: "p" }]),
  "", "archiving into somebody's own Archive folder is filing their mail for them")

// The map every filter and every label id is read through.
deepEqual(jmap.roleMap(boxes),
  { inbox: "a", sent: "e", drafts: "d", archive: "", junk: "c", trash: "b" })
deepEqual(jmap.roleMap([]),
  { inbox: "", sent: "", drafts: "", archive: "", junk: "", trash: "" })

// The rows the rail drops, keyed as `Registry.mailboxes` takes them — so the
// row for the `junk` role answers to "spam".
deepEqual(jmap.absentMailboxes(boxes), ["archive"])
deepEqual(jmap.absentMailboxes([{ id: "a", name: "Inbox", role: "inbox" }]),
  ["archive", "spam", "trash"])
deepEqual(jmap.absentMailboxes(unrolled), [])
assert.strictEqual(jmap.absentMailboxes([]), null,
  "nothing read yet is null, so the registry draws every row")
assert.strictEqual(jmap.absentMailboxes(null), null)

// One sentence for a missing mailbox, wherever it is caught.
assert.strictEqual(jmap.missingMailboxError("archive"), "This account has no Archive mailbox")
assert.strictEqual(jmap.missingMailboxError("junk"), "This account has no Junk mailbox")
assert.strictEqual(jmap.missingMailboxError("trash"), "This account has no Trash mailbox")
assert.strictEqual(jmap.missingMailboxError("nonesuch"), "This account has no such mailbox")

// ------------------------------------------------------------- the query DSL

deepEqual(jmap.parseQuery("role:inbox"),
  { role: "inbox", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery("role:inbox unseen"),
  { role: "inbox", mailboxId: "", criteria: "unseen", text: "" })
deepEqual(jmap.parseQuery("role:inbox flagged"),
  { role: "inbox", mailboxId: "", criteria: "flagged", text: "" })
deepEqual(jmap.parseQuery("role:junk"), { role: "junk", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery("  role:trash  "),
  { role: "trash", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery("role:inbox nonsense"),
  { role: "inbox", mailboxId: "", criteria: "", text: "" },
  "a criterion this DSL does not have is no criterion, not a filter nobody wrote")

deepEqual(jmap.parseQuery("mailbox:a1b2"),
  { role: "", mailboxId: "a1b2", criteria: "", text: "" })
deepEqual(jmap.parseQuery("text:invoice from ada"),
  { role: "", mailboxId: "", criteria: "", text: "invoice from ada" })
deepEqual(jmap.parseQuery('text:"of three"'),
  { role: "", mailboxId: "", criteria: "", text: '"of three"' },
  "a quoted phrase reaches the server exactly as it was typed")

// Every string the panel produces round trips through the parse.
for (const box of registry.define(description).mailboxes) {
  const parsed = jmap.parseQuery(box.query)
  assert.strictEqual(parsed.role !== "", true, box.key + " names a role")
  assert.strictEqual(jmap.filterFor(parsed, jmap.roleMap(unrolled)) !== null, true,
    box.key + " builds a filter on an account that has every mailbox")
}
assert.strictEqual(jmap.parseQuery(description.searchQuery('  a "b c"  ')).text, 'a "b c"')
assert.strictEqual(jmap.parseQuery(description.labelQuery("  a1b2 ")).mailboxId, "a1b2")

// A query that names nothing is the inbox, which is where every other provider
// falls back to as well.
deepEqual(jmap.parseQuery(""), { role: "inbox", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery(null), { role: "inbox", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery("role:"), { role: "inbox", mailboxId: "", criteria: "", text: "" })
deepEqual(jmap.parseQuery("text:  "), { role: "inbox", mailboxId: "", criteria: "", text: "" })
// And a string that is none of the three is read as a search for those words:
// the only way to make one is a default query typed into settings, and showing
// somebody their words beats showing them an empty mailbox.
deepEqual(jmap.parseQuery("in:inbox older_than:1d"),
  { role: "", mailboxId: "", criteria: "", text: "in:inbox older_than:1d" })

// ----------------------------------------------------------------- filters

const roles = jmap.roleMap(boxes)

deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox"), roles), { inMailbox: "a" })
// Unread is the absence of `$seen`, which is the one inversion in the vocabulary.
deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox unseen"), roles),
  { inMailbox: "a", notKeyword: "$seen" })
deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox flagged"), roles),
  { inMailbox: "a", hasKeyword: "$flagged" })
deepEqual(jmap.filterFor(jmap.parseQuery("role:sent"), roles), { inMailbox: "e" })
deepEqual(jmap.filterFor(jmap.parseQuery("role:drafts"), roles), { inMailbox: "d" })
deepEqual(jmap.filterFor(jmap.parseQuery("role:junk"), roles), { inMailbox: "c" })
deepEqual(jmap.filterFor(jmap.parseQuery("role:trash"), roles), { inMailbox: "b" })
deepEqual(jmap.filterFor(jmap.parseQuery("mailbox:zz9"), roles), { inMailbox: "zz9" })

// A rail row this account has no mailbox for builds no filter and no rows, and
// says so in the sentence the button and the registry already use.
assert.strictEqual(jmap.filterFor(jmap.parseQuery("role:archive"), roles), null)
assert.strictEqual(jmap.queryError(jmap.parseQuery("role:archive"), roles),
  "This account has no Archive mailbox")
assert.strictEqual(jmap.queryError(jmap.parseQuery("role:inbox"), roles), "")

// A search names no mailbox and excludes two, which is Gmail's rule and
// Fastmail's own web default.
deepEqual(jmap.filterFor(jmap.parseQuery("text:notes"), roles), {
  operator: "AND",
  conditions: [{ text: "notes" }, { inMailboxOtherThan: ["c", "b"] }]
})
deepEqual(jmap.filterFor(jmap.parseQuery('text:"of three"'), roles), {
  operator: "AND",
  conditions: [{ text: '"of three"' }, { inMailboxOtherThan: ["c", "b"] }]
})
// An account with neither mailbox needs no exclusion, and an empty
// `inMailboxOtherThan` is a condition some servers refuse.
deepEqual(jmap.filterFor(jmap.parseQuery("text:notes"), { inbox: "a" }), { text: "notes" })
deepEqual(jmap.filterFor(jmap.parseQuery("text:notes"), { inbox: "a", trash: "b" }), {
  operator: "AND",
  conditions: [{ text: "notes" }, { inMailboxOtherThan: ["b"] }]
})

// ------------------------------------------------------------------ paging

// The request. `receivedAt` descending on every page, collapsed to one row per
// conversation on every one of them, and `calculateTotal` on every one too.
deepEqual(jmap.emailQuery("t", { inMailbox: "a" }, 3, ""), {
  accountId: "t",
  filter: { inMailbox: "a" },
  sort: [{ property: "receivedAt", isAscending: false }],
  collapseThreads: true,
  limit: 3,
  calculateTotal: true,
  position: 0
})
// A page with a token is fetched by anchor: newest-first with mail arriving
// between pages is the common case, and the anchor keeps the seam exact.
deepEqual(jmap.emailQuery("t", { inMailbox: "a" }, 3, "3|maaaaaf"), {
  accountId: "t",
  filter: { inMailbox: "a" },
  sort: [{ property: "receivedAt", isAscending: false }],
  collapseThreads: true,
  limit: 3,
  calculateTotal: true,
  anchor: "maaaaaf",
  anchorOffset: 1
})
// And recovered by the position beside it when the anchor has gone.
deepEqual(jmap.emailQuery("t", { inMailbox: "a" }, 3, "3|maaaaaf", true).position, 3)
assert.strictEqual(jmap.emailQuery("t", null, 3, "3|maaaaaf", true).anchor, undefined)
assert.strictEqual(jmap.emailQuery("t", null, 0, "").limit, 25, "a page size of nothing is 25")

deepEqual(jmap.parsePageToken("3|maaaaaf"), { position: 3, anchor: "maaaaaf" })
deepEqual(jmap.parsePageToken(""), { position: 0, anchor: "" })
deepEqual(jmap.parsePageToken("nonsense"), { position: 0, anchor: "" })
deepEqual(jmap.parsePageToken("3|"), { position: 0, anchor: "" })
assert.strictEqual(jmap.pageToken(3, ["x", "y", "z"]), "6|z")
assert.strictEqual(jmap.pageToken(0, []), "")

// The reply, with a total: the estimate is the total, exact on both reference
// servers, and the token stops the moment the total is reached.
deepEqual(jmap.queryPage({ position: 0, ids: ["2aaaaah", "yaaaaag", "maaaaaf"], total: 7 }, 3),
  { ids: ["2aaaaah", "yaaaaag", "maaaaaf"], threadIds: [], nextPageToken: "3|maaaaaf", estimate: 7 })
deepEqual(jmap.queryPage({ position: 3, ids: ["maaaaae", "maaaaad", "iaaaaac"], total: 7 }, 3),
  { ids: ["maaaaae", "maaaaad", "iaaaaac"], threadIds: [], nextPageToken: "6|iaaaaac", estimate: 7 })
deepEqual(jmap.queryPage({ position: 6, ids: ["eaaaaab"], total: 7 }, 3),
  { ids: ["eaaaaab"], threadIds: [], nextPageToken: "", estimate: 7 })
// A position past the end is an empty page, not an error.
deepEqual(jmap.queryPage({ position: 50, ids: [], total: 7 }, 3),
  { ids: [], threadIds: [], nextPageToken: "", estimate: 7 })
deepEqual(jmap.queryPage({ position: 0, ids: ["baaaaaai"], total: 1 }, 25),
  { ids: ["baaaaaai"], threadIds: [], nextPageToken: "", estimate: 1 })

// And without one, which RFC 8620 lets a server decline: what has been seen so
// far, plus one for a page that came back full — the same lower bound the IMAP
// search reports, and the reason the panel words a provider total as "about".
deepEqual(jmap.queryPage({ position: 0, ids: ["x", "y", "z"] }, 3),
  { ids: ["x", "y", "z"], threadIds: [], nextPageToken: "3|z", estimate: 4 })
deepEqual(jmap.queryPage({ position: 3, ids: ["p", "q"] }, 3),
  { ids: ["p", "q"], threadIds: [], nextPageToken: "", estimate: 5 },
  "a short page is the end of the result under either reading")
deepEqual(jmap.queryPage({ position: 0, ids: [] }, 3),
  { ids: [], threadIds: [], nextPageToken: "", estimate: 0 })
deepEqual(jmap.queryPage(null, 3),
  { ids: [], threadIds: [], nextPageToken: "", estimate: 0 })
// `total: 0` is a calculated total and not a missing one.
deepEqual(jmap.queryPage({ position: 0, ids: [], total: 0 }, 3).estimate, 0)

// -------------------------------------------------------- mailboxes as labels

const labels = jmap.mailboxLabels(boxes, roles)
deepEqual(labels.map(label => label.id), ["b", "d", "a", "c", "e"],
  "one sort order across the account, so the printed path breaks the tie")
deepEqual(labels.filter(label => label.id === "a")[0], {
  id: "a",
  name: "Inbox",
  // The id twice: one is the cache key, the other is what goes back in a
  // filter, and only the printed name is a path.
  rawName: "a",
  system: true,
  unread: 2,
  total: 7,
  threadsUnread: 2
})
assert.strictEqual(labels.every(label => label.system), true,
  "every mailbox on this account is a row the rail already draws")

// A folder tree is printed as a path, because the sidebar is a flat list and
// two folders called "Receipts" would otherwise be one row twice.
const nested = [
  { id: "p", name: "Projects", parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
  { id: "k", name: "Receipts", parentId: "p", sortOrder: 0, totalEmails: 4, unreadEmails: 1 },
  { id: "w", name: "Work", parentId: null, sortOrder: 1, totalEmails: 2, unreadEmails: 0 },
  { id: "i", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0 }
]
const nestedLabels = jmap.mailboxLabels(nested, jmap.roleMap(nested))
deepEqual(nestedLabels.map(label => label.name),
  ["Inbox", "Projects", "Projects / Receipts", "Work"])
deepEqual(nestedLabels.map(label => label.system), [true, false, false, false],
  "a mailbox the rail does not draw is a label under its own name")
assert.strictEqual(nestedLabels.filter(label => label.id === "k")[0].unread, 1)

// A parent chain that loops is a server bug; here it would be an infinite loop
// on the thread that draws the whole desktop.
deepEqual(jmap.mailboxLabels(
  [{ id: "1", name: "One", parentId: "2" }, { id: "2", name: "Two", parentId: "1" }],
  {}).map(label => label.name), ["One / Two", "Two / One"])

deepEqual(jmap.labelCounts({ id: "a", totalEmails: 7, unreadEmails: 2, unreadThreads: 2 }),
  { id: "a", unread: 2, total: 7, threadsUnread: 2 })
deepEqual(jmap.labelCounts(null), { id: "", unread: 0, total: 0, threadsUnread: 0 })

// ------------------------------------------------------------- label ids
//
// Every keyword and every membership, because a row, a star and an unread dot
// above the seam are read from Gmail's vocabulary and nothing else.

assert.strictEqual(jmap.labelIdsFor({ keywords: {} }, roles).indexOf("UNREAD"), 0,
  "unread is the absence of $seen")
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true } }, roles), [])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true, "$flagged": true } }, roles), ["STARRED"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true, "$draft": true } }, roles), ["DRAFT"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { d: true } }, roles),
  ["DRAFT"], "membership of the Drafts mailbox says the same thing the keyword does")
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { a: true } }, roles),
  ["INBOX"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { e: true } }, roles),
  ["SENT"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { b: true } }, roles),
  ["TRASH"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { c: true } }, roles),
  ["SPAM"])
deepEqual(jmap.labelIdsFor({ keywords: {}, mailboxIds: { a: true, e: true } }, roles),
  ["UNREAD", "INBOX", "SENT"], "a message in two mailboxes gets both, as Gmail's does")
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { zz9: true } }, roles),
  [], "a user folder is no label id at all")
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { "": true } }, roles), [],
  "and neither is an unresolved role, whose id is the empty string")
deepEqual(jmap.labelIdsFor(null, roles), ["UNREAD"])

// ------------------------------------------------- an Email as a message row
//
// The Email is the reference account's own, read from the server with the
// client's property list — including the leading space Stalwart writes on a raw
// header value, and the key it files one under.

const listEmail = {
  id: "2aaaaah",
  blobId: "cbiovn1qoqv0990mypxekxgla3z2fmw3qyp3e09bw73o1fnn00mfmeyaa2",
  threadId: "h",
  mailboxIds: { a: true },
  keywords: {},
  size: 242,
  receivedAt: "2026-08-24T09:00:00Z",
  from: [{ name: "Eve Lund", email: "eve@example.net" }],
  to: [{ name: null, email: "ada@example.org" }],
  cc: null,
  subject: "[omamail-test] Unread",
  preview: "This one is unread.\n",
  hasAttachment: false,
  messageId: ["unread@omamail-test.invalid"],
  inReplyTo: null,
  references: null,
  "header:List-Unsubscribe": null,
  "header:List-Unsubscribe-Post": null,
  // Not `header:Date:asRaw`, which is what was asked for: the reference server
  // answers under the name without the form, and a composer that read only the
  // asked-for key got no Date and no unsubscribe link at all.
  "header:Date": " Mon, 24 Aug 2026 09:00:00 +0000"
}

const row = jmap.toMessage(listEmail, roles)
assert.strictEqual(row.id, "2aaaaah", "the bare Email id: unique per account, stable across a move")
assert.strictEqual(row.threadId, "h")
deepEqual(row.labelIds, ["UNREAD", "INBOX"])
assert.strictEqual(row.internalDate, String(Date.parse("2026-08-24T09:00:00Z")))
assert.strictEqual(row.sizeEstimate, 242)
assert.strictEqual(row.payload.mimeType, "text/plain")
deepEqual(row.payload.parts, [])
deepEqual(row.payload.headers, [
  { name: "From", value: '"Eve Lund" <eve@example.net>' },
  { name: "To", value: "ada@example.org" },
  { name: "Subject", value: "[omamail-test] Unread" },
  { name: "Date", value: "Mon, 24 Aug 2026 09:00:00 +0000" },
  { name: "Message-ID", value: "<unread@omamail-test.invalid>" }
])

// The snippet is escaped because `Mail.decodeSnippet` unescapes Gmail's, so a
// sender writing "<3" keeps it instead of losing it to a tag nobody wrote.
assert.strictEqual(jmap.toMessage({ preview: "a < b & c > d" }, roles).snippet,
  "a &lt; b &amp; c &gt; d")
assert.strictEqual(message.decodeSnippet(jmap.toMessage({ preview: "a < b & c" }, roles).snippet),
  "a < b & c", "and comes back out of the row exactly as the server wrote it")

// The header forms JMAP splits apart and a header line joins together.
deepEqual(jmap.toMessage({
  messageId: ["m@x"], inReplyTo: ["p@x"], references: ["r1@x", "r2@x"],
  "header:List-Unsubscribe:asRaw": " <https://example.org/u>",
  "header:List-Unsubscribe-Post:asRaw": " List-Unsubscribe=One-Click"
}, roles).payload.headers, [
  { name: "Message-ID", value: "<m@x>" },
  { name: "In-Reply-To", value: "<p@x>" },
  { name: "References", value: "<r1@x> <r2@x>" },
  { name: "List-Unsubscribe", value: "<https://example.org/u>" },
  { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }
])

// A row is what the panel reads through, so it is checked through the panel's
// own reader rather than field by field here.
const summary = message.summarize(row, new Date(Date.parse("2026-08-24T10:00:00Z")))
assert.strictEqual(summary.subject, "[omamail-test] Unread")
assert.strictEqual(summary.from.email, "eve@example.net")
assert.strictEqual(summary.from.name, "Eve Lund")
assert.strictEqual(summary.unread, true)
assert.strictEqual(summary.inInbox, true)
assert.strictEqual(summary.snippet, "This one is unread.")
assert.strictEqual(summary.date.getTime(), Date.parse("2026-08-24T09:00:00Z"),
  "the row's date is `receivedAt`, which is what every list and every sort reads")

deepEqual(jmap.toMessage(null, roles).payload.headers, [])
assert.strictEqual(jmap.toMessage(null, roles).internalDate, "")

// ---------------------------------------------------- what a read asks for
//
// The two `Email/get` argument objects, in one place, because the difference
// between them is the whole difference between a row and a reader.

deepEqual(jmap.emailGet("t", ["2aaaaah"], false), {
  accountId: "t",
  ids: ["2aaaaah"],
  properties: jmap.LIST_PROPERTIES
})

const fullGet = jmap.emailGet("t", ["iaaaaac"], true)
deepEqual(fullGet.properties,
  jmap.LIST_PROPERTIES.concat(["headers", "bodyStructure", "bodyValues"]))
deepEqual(fullGet.bodyProperties, ["partId", "blobId", "size", "name", "type",
  "charset", "disposition", "cid", "headers"])
assert.strictEqual(fullGet.fetchTextBodyValues, true)
assert.strictEqual(fullGet.fetchHTMLBodyValues, true)
// Never `fetchAllBodyValues`: it ships every text *attachment* inline too, and
// the probe measured `notes.txt` arriving whole because of it.
assert.strictEqual(fullGet.fetchAllBodyValues, undefined)
// And `maxBodyValueBytes` is left unset, so the server's own default — no
// truncation — applies rather than a ceiling this client invented.
assert.strictEqual(fullGet.maxBodyValueBytes, undefined)
assert.strictEqual(jmap.emailGet("t", ["x"], false).bodyProperties, undefined)
deepEqual(jmap.emailGet("t", null, true).ids, [])

// ------------------------------------------------- an Email as a full read
//
// The reference account's own plain message, read with the full property list.
// A single-part message has no children at all: its root *is* the text part,
// which is why the payload carries the data rather than a parts array.

const plainEmail = {
  id: "eaaaaab",
  threadId: "b",
  mailboxIds: { a: true },
  keywords: { "$seen": true },
  size: 262,
  receivedAt: "2026-08-20T09:00:00Z",
  from: [{ name: "Ari Novak", email: "ari@example.com" }],
  to: [{ name: null, email: "ada@example.org" }],
  subject: "[omamail-test] Plain text",
  preview: "A plain-text message, nothing more.\n",
  messageId: ["plain@omamail-test.invalid"],
  "header:Date": " Thu, 20 Aug 2026 09:00:00 +0000",
  headers: [
    { name: "From", value: " Ari Novak <ari@example.com>" },
    { name: "To", value: " ada@example.org" },
    { name: "Subject", value: " [omamail-test] Plain text" },
    { name: "Date", value: " Thu, 20 Aug 2026 09:00:00 +0000" },
    { name: "Message-ID", value: " <plain@omamail-test.invalid>" },
    { name: "Reply-To", value: " Ari Novak <replies@example.com>" },
    { name: "Content-Type", value: " text/plain; charset=utf-8" }
  ],
  bodyStructure: {
    partId: "0", blobId: "cbplain", size: 36, name: null, type: "text/plain",
    charset: "utf-8", disposition: null, cid: null,
    headers: [{ name: "Content-Type", value: " text/plain; charset=utf-8" }]
  },
  bodyValues: {
    "0": { isEncodingProblem: false, isTruncated: false,
      value: "A plain-text message, nothing more.\n" }
  }
}

const plainRead = jmap.toMessage(plainEmail, roles, true)
assert.strictEqual(plainRead.payload.mimeType, "text/plain; charset=utf-8",
  "a value JMAP handed over has already been decoded, so it is UTF-8 whatever the sender wrote")
assert.strictEqual(plainRead.payload.partId, "0")
deepEqual(plainRead.payload.parts, [])
assert.strictEqual(plainRead.payload.body.data,
  message.encodeBase64Url("A plain-text message, nothing more.\n"))
assert.strictEqual(plainRead.payload.body.size, 36)
assert.strictEqual(plainRead.payload.body.attachmentId, undefined,
  "a text part that arrived is read in place and never fetched again")
assert.strictEqual(message.extractBody(plainRead.payload).text,
  "A plain-text message, nothing more.\n")
assert.strictEqual(message.extractBody(plainRead.payload).source, "plain")

// The header array a full read carries: the ten composed names first, in the
// order a message writes them, then everything else the server reported. The
// composed ten come first because `Message.headerValue` takes the first match
// and a row and its reader disagreeing about who a message is from is worse
// than either answer alone — and a name already written is never repeated.
deepEqual(plainRead.payload.headers, [
  { name: "From", value: '"Ari Novak" <ari@example.com>' },
  { name: "To", value: "ada@example.org" },
  { name: "Subject", value: "[omamail-test] Plain text" },
  { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0000" },
  { name: "Message-ID", value: "<plain@omamail-test.invalid>" },
  { name: "Reply-To", value: "Ari Novak <replies@example.com>" },
  { name: "Content-Type", value: "text/plain; charset=utf-8" }
])
// Which is the whole point of asking for `headers` at all: JMAP has no parsed
// field for Reply-To, and a reply is written to it.
assert.strictEqual(
  message.summarize(plainRead, new Date()).replyTo.email, "replies@example.com")

// The snippet on a full read is the preview again, escaped, never rebuilt from
// the body — a reader that recomputed it would show a different snippet from
// the row it was opened out of.
assert.strictEqual(plainRead.snippet, "A plain-text message, nothing more.\n")

// A server that answered a full read without a structure still opens as a row.
assert.strictEqual(jmap.toMessage({ id: "x", preview: "p" }, roles, true).payload.mimeType,
  "text/plain")
deepEqual(jmap.toMessage({ id: "x", preview: "p" }, roles, true).payload.parts, [])

// ------------------------------ a multipart with an inline image and a file
//
// The seeded HTML message, exactly as the reference server describes it:
// `multipart/mixed` over a `multipart/related` holding the HTML and its
// `cid:` PNG, with `notes.txt` beside them. Note `subParts`, which is JMAP's
// name for children, and the `header:` values Stalwart files without the form.

const htmlEmail = {
  id: "iaaaaac",
  threadId: "c",
  mailboxIds: { a: true },
  keywords: { "$seen": true },
  size: 1021,
  receivedAt: "2026-08-21T10:00:00Z",
  from: [{ name: "Dana Ridley", email: "dana@example.net" }],
  to: [{ name: null, email: "ada@example.org" }],
  subject: "[omamail-test] HTML with inline image and attachment",
  preview: "Hello from HTML. Here is the logo:\nNotes are attached.\n",
  hasAttachment: true,
  messageId: ["html@omamail-test.invalid"],
  "header:Date": " Fri, 21 Aug 2026 10:00:00 +0000",
  headers: [
    { name: "From", value: " Dana Ridley <dana@example.net>" },
    { name: "MIME-Version", value: " 1.0" },
    { name: "Content-Type", value: ' multipart/mixed; boundary="mixed1"' }
  ],
  bodyStructure: {
    partId: null, blobId: null, size: null, name: null, type: "multipart/mixed",
    charset: null, disposition: null, cid: null,
    headers: [{ name: "Content-Type", value: ' multipart/mixed; boundary="mixed1"' }],
    subParts: [
      {
        partId: null, blobId: null, size: null, name: null,
        type: "multipart/related", charset: null, disposition: null, cid: null,
        headers: [{ name: "Content-Type", value: ' multipart/related; boundary="rel1"' }],
        subParts: [
          {
            partId: "2", blobId: "cghtml", size: 144, name: null,
            type: "text/html", charset: "utf-8", disposition: null, cid: null,
            headers: [{ name: "Content-Type", value: " text/html; charset=utf-8" }]
          },
          {
            partId: "3", blobId: "copng", size: 70, name: "logo.png",
            type: "image/png", charset: null, disposition: "inline",
            cid: "logo@omamail-test",
            headers: [
              { name: "Content-Type", value: ' image/png; name="logo.png"' },
              { name: "Content-Transfer-Encoding", value: " base64" },
              { name: "Content-ID", value: " <logo@omamail-test>" },
              { name: "Content-Disposition", value: ' inline; filename="logo.png"' }
            ]
          }
        ]
      },
      {
        partId: "4", blobId: "cgnotes", size: 63, name: "notes.txt",
        type: "text/plain", charset: "utf-8", disposition: "attachment", cid: null,
        headers: [
          { name: "Content-Type", value: ' text/plain; charset=utf-8; name="notes.txt"' },
          { name: "Content-Disposition", value: ' attachment; filename="notes.txt"' }
        ]
      }
    ]
  },
  // Only the parts `fetchTextBodyValues` and `fetchHTMLBodyValues` cover. The
  // text attachment is *absent*, which is the whole reason for asking that way.
  bodyValues: {
    "2": {
      isEncodingProblem: false, isTruncated: false,
      value: '<html><body><p>Hello from <b>HTML</b>. Here is the logo:</p>'
        + '<img src="cid:logo@omamail-test" alt="logo"><p>Notes are attached.</p></body></html>'
    }
  }
}

const htmlRead = jmap.toMessage(htmlEmail, roles, true)
assert.strictEqual(htmlRead.payload.mimeType, "multipart/mixed")
assert.strictEqual(htmlRead.payload.body.size, 0,
  "a container carries its children and nothing else")
assert.strictEqual(htmlRead.payload.body.attachmentId, undefined)
assert.strictEqual(htmlRead.payload.parts.length, 2)

const related = htmlRead.payload.parts[0]
assert.strictEqual(related.mimeType, "multipart/related")
assert.strictEqual(related.parts.length, 2)

const htmlPart = related.parts[0]
assert.strictEqual(htmlPart.partId, "2")
assert.strictEqual(htmlPart.mimeType, "text/html; charset=utf-8")
assert.strictEqual(htmlPart.filename, "")
assert.strictEqual(htmlPart.body.attachmentId, undefined)
assert.strictEqual(message.decodeBase64Url(htmlPart.body.data),
  htmlEmail.bodyValues["2"].value)
assert.strictEqual(htmlPart.body.size, 144)

// The inline image: no data, its blob as the attachment id, and both halves of
// the `cid:` link kept — the field and the header — so a JMAP message behaves
// as an IMAP one does rather than being the one provider that lost the link.
const png = related.parts[1]
assert.strictEqual(png.partId, "3")
assert.strictEqual(png.mimeType, "image/png")
assert.strictEqual(png.filename, "logo.png")
assert.strictEqual(png.cid, "logo@omamail-test")
assert.strictEqual(png.body.attachmentId, "copng")
assert.strictEqual(png.body.size, 70)
assert.strictEqual(png.body.data, undefined)
deepEqual(png.headers, [
  { name: "Content-Type", value: 'image/png; name="logo.png"' },
  { name: "Content-Transfer-Encoding", value: "base64" },
  { name: "Content-ID", value: "<logo@omamail-test>" },
  { name: "Content-Disposition", value: 'inline; filename="logo.png"' }
], "part header values are trimmed of the space the server writes after the colon")

// A text attachment must not arrive inline. `notes.txt` is `text/plain` and it
// still gets a size and an id and no data, because its value was never asked
// for — the reason the full read names the two body-value flags rather than
// `fetchAllBodyValues`.
const notes = htmlRead.payload.parts[1]
assert.strictEqual(notes.partId, "4")
assert.strictEqual(notes.mimeType, "text/plain; charset=utf-8",
  "a part delivered as a blob keeps the charset the sender declared, because "
  + "those octets are still in it")
assert.strictEqual(notes.filename, "notes.txt")
assert.strictEqual(notes.body.attachmentId, "cgnotes")
assert.strictEqual(notes.body.size, 63)
assert.strictEqual(notes.body.data, undefined)

// The charset a blob-delivered text part keeps is the sender's own, not the
// UTF-8 an inlined value would have been decoded to. `notes.txt` happens to
// declare UTF-8, so the rule is stated on a part that does not — a calendar
// invitation in Latin-1 is the ordinary case, not the exotic one, and this is
// the charset `Calendar.fromAttachment` reads its octets through.
const latinAttachment = jmap.toMessage({
  bodyStructure: { partId: null, type: "multipart/mixed", subParts: [
    { partId: "1", blobId: "cbtext", size: 20, name: "notes.txt",
      type: "text/plain", charset: "iso-8859-1", disposition: "attachment" },
    { partId: "2", blobId: "cbics", size: 400, name: "invite.ics",
      type: "text/calendar", disposition: "attachment" }
  ] },
  bodyValues: {}
}, roles, true)
assert.strictEqual(latinAttachment.payload.parts[0].mimeType, "text/plain; charset=iso-8859-1")
assert.strictEqual(latinAttachment.payload.parts[0].body.attachmentId, "cbtext")
// A part that declared no charset states none rather than one this client
// guessed for it.
assert.strictEqual(latinAttachment.payload.parts[1].mimeType, "text/calendar")
// Which is what makes the invitation card a second request rather than nothing:
// a calendar part the server described but did not send is exactly the shape
// the reader already asks Gmail for.
assert.strictEqual(
  calendar.pendingPart(latinAttachment.payload).body.attachmentId, "cbics")

// And the panel's own readers, which is what the shape is for.
assert.strictEqual(message.extractHtml(htmlRead.payload), htmlEmail.bodyValues["2"].value,
  "the body is the HTML part, never the text attachment beside it")
assert.strictEqual(message.extractBody(htmlRead.payload).source, "html")
assert.strictEqual(message.extractBody(htmlRead.payload).text.indexOf("These are the attached"), -1)
deepEqual(message.attachments(htmlRead.payload), [
  { filename: "logo.png", mimeType: "image/png", size: 70, attachmentId: "copng" },
  { filename: "notes.txt", mimeType: "text/plain; charset=utf-8", size: 63,
    attachmentId: "cgnotes" }
], "the existing attachment rule decides, and it lists a part the sender named — "
  + "the inline image included, exactly as it does on IMAP")
assert.strictEqual(message.partForAttachment(htmlRead.payload, "cgnotes").filename, "notes.txt")

// ------------------------------------------------------ a truncated part
//
// RFC 8621 lets a server truncate a body value whatever the client asked for,
// and a reader showing a body that stops mid-sentence is worse than a second
// request. The part is named, fetched whole through the attachment path, and
// put back before the message is delivered.

const truncatedEmail = {
  id: "iaaaaac",
  preview: "Hello from HTML.",
  bodyStructure: {
    partId: null, type: "multipart/mixed",
    subParts: [
      { partId: "2", blobId: "cghtml", size: 144, type: "text/html", charset: "utf-8" },
      { partId: "4", blobId: "cgnotes", size: 63, name: "notes.txt",
        type: "text/plain", charset: "utf-8", disposition: "attachment" }
    ]
  },
  bodyValues: {
    "2": { isEncodingProblem: false, isTruncated: true, value: "<html><body><p>Hello from " }
  }
}

deepEqual(jmap.truncatedParts(truncatedEmail), [
  { partId: "2", blobId: "cghtml", size: 144, type: "text/html", charset: "utf-8" }
], "only a text part the server said it cut, and only one with a blob to fetch")
// A value that arrived whole is nothing to fetch, and neither is a part whose
// value was never asked for.
deepEqual(jmap.truncatedParts(htmlEmail), [])
deepEqual(jmap.truncatedParts(null), [])
deepEqual(jmap.truncatedParts({ bodyStructure: { partId: "1", type: "text/html" },
  bodyValues: { "1": { isTruncated: true } } }), [],
  "a truncated part with no blob id is not a part anything could fetch")

const truncatedRead = jmap.toMessage(truncatedEmail, roles, true)
assert.strictEqual(message.extractHtml(truncatedRead.payload), "<html><body><p>Hello from ")
const whole = '<html><body><p>Hello from <b>HTML</b>.</p></body></html>'
assert.strictEqual(jmap.substitutePart(truncatedRead.payload,
  jmap.truncatedParts(truncatedEmail)[0], message.encodeBase64(whole)), true)
assert.strictEqual(message.extractHtml(truncatedRead.payload), whole,
  "and the reader is handed the whole body rather than the beginning of one")
assert.strictEqual(truncatedRead.payload.parts[0].body.size, whole.length)

// The charset moves with the octets. The value that was there had been decoded
// to UTF-8 by the server; a blob is the sender's own bytes in the sender's own
// charset, so a part that declared one has to go back to declaring it.
const latin = jmap.toMessage({
  bodyStructure: { partId: null, type: "multipart/mixed", subParts: [
    { partId: "1", blobId: "cb1", size: 6, type: "text/plain", charset: "iso-8859-1" }
  ] },
  bodyValues: { "1": { isTruncated: true, value: "Grus" } }
}, roles, true)
assert.strictEqual(latin.payload.parts[0].mimeType, "text/plain; charset=utf-8",
  "while the value is the server's decoding of it")
jmap.substitutePart(latin.payload,
  { partId: "1", blobId: "cb1", size: 6, type: "text/plain", charset: "iso-8859-1" },
  "R3L832Vu")
assert.strictEqual(latin.payload.parts[0].mimeType, "text/plain; charset=iso-8859-1")
assert.strictEqual(message.extractBody(latin.payload).text, "Grüßen")

// A substitution that found nothing says so rather than reporting a repair it
// did not make.
assert.strictEqual(jmap.substitutePart(truncatedRead.payload,
  { partId: "9", type: "text/html" }, "AAAA"), false)
assert.strictEqual(jmap.substitutePart(truncatedRead.payload,
  { partId: "2", type: "text/html" }, ""), false)
assert.strictEqual(jmap.substitutePart(null, { partId: "2" }, "AAAA"), false)

// Both alphabets and either padding, because the composer writes unpadded
// base64url and the transport hands back padded standard base64.
assert.strictEqual(jmap.base64ByteLength(""), 0)
assert.strictEqual(jmap.base64ByteLength("QQ=="), 1)
assert.strictEqual(jmap.base64ByteLength("QUI="), 2)
assert.strictEqual(jmap.base64ByteLength("QUJD"), 3)
assert.strictEqual(jmap.base64ByteLength("QQ"), 1)
assert.strictEqual(jmap.base64ByteLength(message.encodeBase64Url("Grüßen")), 8,
  "the byte length of the UTF-8 re-encoding, not the character count")

// ----------------------------------------------------------- the blob path
//
// An attachment id is the part's `blobId`, and a blob is fetched through the
// session's own download template — never a re-read of the message and never a
// URL this client assembled out of a host it guessed.

const withDownload = session({
  downloadUrl: "https://api.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}"
})
assert.strictEqual(jmap.downloadTemplate(withDownload),
  "https://api.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}")
assert.strictEqual(jmap.downloadTemplate(JSON.stringify(withDownload)),
  "https://api.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  "a session restored from the cache is still text when it is read")
assert.strictEqual(jmap.downloadTemplate(session()), "",
  "and a server that published no template is not one this client invents one for")
assert.strictEqual(jmap.downloadTemplate(null), "")
assert.strictEqual(
  jmap.downloadUrl(jmap.downloadTemplate(withDownload), "t", "cgnotes",
    "attachment", "application/octet-stream"),
  "https://api.example.org/jmap/download/t/cgnotes/attachment?accept=application%2Foctet-stream")
// The ceiling the transport fixes on every answer it reads whole —
// `tests/test_jmap_transport.sh` asserts the same literal in the config — and
// the sentence somebody who just clicked an attachment reads when a blob is
// past it.
assert.strictEqual(jmap.MAX_BLOB_BYTES, 20971520)
assert.strictEqual(jmap.downloadError({ exit: 63, status: 0, stderr: "" }, ""),
  "This attachment is larger than 20 MB")

// ------------------------------------------------------------- known states
//
// The newest state per type, which push reads to tell its own echo from
// somebody else's change.

deepEqual(jmap.recordStates({}, [["Mailbox/get", { state: "sia", list: [] }, "0"]]),
  { Mailbox: "sia" })
deepEqual(jmap.recordStates({ Mailbox: "sia" }, [["Email/get", { state: "s41", list: [] }, "0"]]),
  { Mailbox: "sia", Email: "s41" })
deepEqual(jmap.recordStates({ Email: "s1" },
  [["Email/set", { oldState: "s1", newState: "s2" }, "0"]]), { Email: "s2" },
  "a set moves the type to its new state")
// `queryState` is the state of one query rather than of the type, a change
// notification never names one, and filing it under Email would silence a real
// change.
deepEqual(jmap.recordStates({}, [["Email/query", { queryState: "sia", ids: [] }, "0"]]), {})
deepEqual(jmap.recordStates({ Email: "s1" }, [["error", { type: "anchorNotFound" }, "0"]]),
  { Email: "s1" })
deepEqual(jmap.recordStates(null, null), {})

// ------------------------------------------------------------ the event stream
//
// Where the stream connects. The template is the session's own, and every
// value goes through the same percent-encoding a download URL's does: a server
// is free to publish a template whose variables sit in the path, and a `types`
// list carrying a `&` or a `/` would otherwise steer the request off the
// address the session named.

const eventTemplate =
  "https://api.example.org/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}"

assert.strictEqual(jmap.eventSourceTemplate(session({ eventSourceUrl: eventTemplate })),
  eventTemplate)
assert.strictEqual(
  jmap.eventSourceTemplate(JSON.stringify(session({ eventSourceUrl: eventTemplate }))),
  eventTemplate, "the document may still be text")
assert.strictEqual(jmap.eventSourceTemplate(session()), "",
  "a server that publishes no event source has none")
assert.strictEqual(jmap.eventSourceTemplate(null), "")

assert.strictEqual(
  jmap.eventSourceUrl(eventTemplate, jmap.EVENT_TYPES, jmap.EVENT_PING_SECONDS),
  "https://api.example.org/jmap/eventsource/"
  + "?types=Email%2CMailbox&closeafter=no&ping=30")

// `closeafter` is never asked for: ending the response after the first state
// event is a poll with a long wait, for proxies that will not pass a
// persistent response, and rotation here is curl's own `max-time`.
assert.ok(jmap.eventSourceUrl(eventTemplate, "Email", 30).indexOf("closeafter=no") > 0,
  "the response is persisted, whatever the caller asks for")

// The same placeholder more than once, and a value that would otherwise be
// read as another parameter.
assert.strictEqual(
  jmap.eventSourceUrl("https://s.example/{types}/es?types={types}&closeafter={closeafter}&ping={ping}",
    "Email,Mailbox", 30),
  "https://s.example/Email%2CMailbox/es?types=Email%2CMailbox&closeafter=no&ping=30")
assert.strictEqual(
  jmap.eventSourceUrl("https://s.example/es?types={types}&closeafter={closeafter}&ping={ping}",
    "Email&ping=0", 30),
  "https://s.example/es?types=Email%26ping%3D0&closeafter=no&ping=30",
  "a type list cannot smuggle a second parameter past the template")

// No template, no stream. An empty answer is what the owner reads as "this
// server has no event source" rather than connecting to the empty string.
assert.strictEqual(jmap.eventSourceUrl("", "Email", 30), "")
assert.strictEqual(jmap.eventSourceUrl(null, "Email", 30), "")

// Defaults, for a caller that asked for nothing sensible.
assert.ok(jmap.eventSourceUrl(eventTemplate, "", 30).indexOf("types=Email%2CMailbox") > 0)
assert.ok(jmap.eventSourceUrl(eventTemplate, "Email", -5).indexOf("ping=30") > 0)
assert.ok(jmap.eventSourceUrl(eventTemplate, "Email", "x").indexOf("ping=30") > 0)
assert.ok(jmap.eventSourceUrl(eventTemplate, "Email", 0).indexOf("ping=0") > 0,
  "zero is a real answer — it means no pings — and is left alone")

assert.strictEqual(jmap.EVENT_TYPES, "Email,Mailbox",
  "Thread never moves without an Email change, EmailSubmission has no consumer "
  + "and Identity is read once per session")
assert.strictEqual(jmap.EVENT_PING_SECONDS, 30)

// ------------------------------------------------------------- event lines
//
// One line at a time, because that is how curl hands the stream over. The
// state carried between calls is the half-read event, and the answer is in the
// same object: `kind` is "" until a blank line ends one.

function readEvent(lines) {
  let state = jmap.emptyEventState()
  const events = []
  for (let i = 0; i < lines.length; i++) {
    state = jmap.parseEventLine(state, lines[i])
    if (state.kind !== "") events.push(state)
  }
  return events
}

const stateJson =
  '{"@type":"StateChange","changed":{"t":{"Email":"s42","Mailbox":"s9"}}}'

let events = readEvent(["event: state", "data: " + stateJson, ""])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].kind, "state")
deepEqual(events[0].changed, { t: { Email: "s42", Mailbox: "s9" } })

// A ping says the interval the server settled on, which may not be the one
// that was asked for: RFC 8620 lets a server clamp, and Stalwart clamps up to
// thirty. The watchdog follows what the server said rather than what it wanted.
events = readEvent(["event: ping", 'data: {"interval": 60}', ""])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].kind, "ping")
assert.strictEqual(events[0].interval, 60)
assert.strictEqual(events[0].changed, null)

// Stalwart sends a third event on the same connection. A mail client has
// nothing to do with it and must not mistake it for either of the two it does.
events = readEvent(["event: calendarAlert", 'data: {"id":"7"}', ""])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].kind, "calendarAlert")
assert.strictEqual(events[0].changed, null)
assert.strictEqual(events[0].interval, 0)

// A comment line is the spec's keep-alive and carries nothing.
events = readEvent([": keep-alive", ""])
assert.strictEqual(events.length, 0, "a comment is not an event, and ends none")

// CRLF. `SplitParser` splits on "\n", so a server writing CRLF leaves the CR
// on the end of every line — including the blank one that ends an event, which
// would then never be blank and no event would ever complete.
events = readEvent(["event: state\r", "data: " + stateJson + "\r", "\r"])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].kind, "state")
deepEqual(events[0].changed, { t: { Email: "s42", Mailbox: "s9" } })

// An id line is dropped: Stalwart sends none, so there is nothing to replay
// and no `Last-Event-ID` to send back. A retry line is dropped too — the
// reconnect table here is this client's own.
events = readEvent(["id: 9", "retry: 5000", "event: state", "data: " + stateJson, ""])
assert.strictEqual(events.length, 1)
deepEqual(events[0].changed, { t: { Email: "s42", Mailbox: "s9" } })

// Two events on one connection, and the accumulator carrying nothing across.
events = readEvent(["event: ping", 'data: {"interval":30}', "",
  "event: state", "data: " + stateJson, ""])
assert.strictEqual(events.length, 2)
assert.strictEqual(events[0].kind, "ping")
assert.strictEqual(events[1].kind, "state")
deepEqual(events[1].changed, { t: { Email: "s42", Mailbox: "s9" } })

// Data over more than one line is joined with a newline, as the spec says, so
// a document a server chose to wrap still parses.
events = readEvent(["event: state", 'data: {"@type":"StateChange",',
  'data: "changed":{"t":{"Email":"s42"}}}', ""])
assert.strictEqual(events.length, 1)
deepEqual(events[0].changed, { t: { Email: "s42" } })

// A single space after the colon is the separator and is dropped; a second one
// is data. No space at all is legal too.
events = readEvent(["event:state", "data:" + stateJson, ""])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].kind, "state")

// An event whose data is not a JSON object completes with nothing to act on,
// rather than throwing inside the process that draws the desktop.
events = readEvent(["event: state", "data: not json", ""])
assert.strictEqual(events.length, 1)
assert.strictEqual(events[0].changed, null)
events = readEvent(["event: state", "data: []", ""])
assert.strictEqual(events[0].changed, null, "an array is not a changed map")

// A blank line between events is the spec's own keep-alive and completes
// nothing.
events = readEvent(["", "", ""])
assert.strictEqual(events.length, 0)

// The half-read event is held in the process that draws the whole desktop, so
// a server or a proxy that never sends the blank line cannot grow it forever.
let long = jmap.emptyEventState()
long = jmap.parseEventLine(long, "event: state")
for (let i = 0; i < 40; i++)
  long = jmap.parseEventLine(long, "data: " + new Array(4000).join("x"))
assert.ok(long.data.length <= jmap.MAX_EVENT_CHARS,
  "an event that never ends is dropped rather than accumulated")

// ---------------------------------------------------------- what a push means

const known = { Email: "s41", Mailbox: "s8" }

// Another account on the same server. One connection carries changes for every
// account the credential can see, and this one is not ours.
assert.strictEqual(jmap.refreshPlan({ other: { Email: "s99" } }, "t", known), null)
assert.strictEqual(jmap.refreshPlan({ t: { Email: "s42" } }, "", known), null)
assert.strictEqual(jmap.refreshPlan(null, "t", known), null)
assert.strictEqual(jmap.refreshPlan({ t: null }, "t", known), null)

// The echo. Stalwart tells every connection about this panel's own write about
// a second after the action's callback has already revalidated, and the state
// it names is the one that reply handed over.
assert.strictEqual(jmap.refreshPlan({ t: { Email: "s41" } }, "t", known), null)
assert.strictEqual(jmap.refreshPlan({ t: { Email: "s41", Mailbox: "s8" } }, "t", known), null,
  "every state matching is the whole event being an echo")

// One type moving is enough, and it is the only one acted on.
deepEqual(jmap.refreshPlan({ t: { Email: "s41", Mailbox: "s9" } }, "t", known),
  { mail: false, mailboxes: true },
  "a rename or a folder added: the rail moves, the list does not")
deepEqual(jmap.refreshPlan({ t: { Email: "s42", Mailbox: "s8" } }, "t", known),
  { mail: true, mailboxes: false })
deepEqual(jmap.refreshPlan({ t: { Email: "s42", Mailbox: "s9" } }, "t", known),
  { mail: true, mailboxes: true },
  "a keyword flip moves both on this server, which is what reloads the counts")

// A type the client has never recorded is a change, because it has never been
// told otherwise.
deepEqual(jmap.refreshPlan({ t: { Email: "s42" } }, "t", {}), { mail: true, mailboxes: false })
deepEqual(jmap.refreshPlan({ t: { Email: "s42" } }, "t", null), { mail: true, mailboxes: false })

// Types this account subscribes to nothing for. `Thread` never moves without
// an `Email` change and `EmailSubmission` has no consumer, so an event naming
// only those is not a reason to fetch anything.
assert.strictEqual(jmap.refreshPlan({ t: { Thread: "s3" } }, "t", known), null)
assert.strictEqual(jmap.refreshPlan({ t: { EmailSubmission: "s3" } }, "t", known), null)

// ---------------------------------------------------------------- reconnect

// A clean close and the planned rotation: at once, and the failure count is
// left where it was — only a line off a working connection resets it.
deepEqual(jmap.reconnectDelay(0, 200, 0), { delay: 0, attempt: 0, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(28, 200, 4), { delay: 0, attempt: 4, stop: false, rejected: false })

// Everything else doubles from a second.
deepEqual(jmap.reconnectDelay(7, 0, 0), { delay: 1000, attempt: 1, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(6, 0, 1), { delay: 2000, attempt: 2, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(35, 0, 2), { delay: 4000, attempt: 3, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(52, 0, 3), { delay: 8000, attempt: 4, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(56, 0, 4), { delay: 16000, attempt: 5, stop: false, rejected: false })

// The cap. Five minutes is what a server that is down is asked at, rather than
// a doubling that reaches hours and never comes back.
assert.strictEqual(jmap.reconnectDelay(7, 0, 8).delay, 256000)
assert.strictEqual(jmap.reconnectDelay(7, 0, 9).delay, 300000)
assert.strictEqual(jmap.reconnectDelay(7, 0, 40).delay, 300000,
  "and it stays capped however long it has been failing")

// The reset is the caller's: it passes zero once a line has arrived.
assert.strictEqual(jmap.reconnectDelay(7, 0, 0).delay, 1000,
  "the first failure after a working connection waits a second again")

// `--fail` turns any 4xx or 5xx into exit 22, and the `http <code>` trailer is
// what splits it. Only a 401 is a credential: it is a revoked app password,
// there is nothing to retry, and re-sending a Basic password is what locks one.
deepEqual(jmap.reconnectDelay(22, 401, 0), { delay: 0, attempt: 0, stop: true, rejected: true })
deepEqual(jmap.reconnectDelay(22, 401, 6), { delay: 0, attempt: 6, stop: true, rejected: true })
deepEqual(jmap.reconnectDelay(22, 403, 0), { delay: 1000, attempt: 1, stop: false, rejected: false },
  "a forbidden stream is the server, not the password")
deepEqual(jmap.reconnectDelay(22, 429, 0), { delay: 1000, attempt: 1, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(22, 502, 2), { delay: 4000, attempt: 3, stop: false, rejected: false })
// A 401 on something that is not the stream's own failure exit is not this
// rule: the status without the exit is a trailer left over from an earlier
// connection, and the exit without a status is a connection that never got one.
deepEqual(jmap.reconnectDelay(7, 401, 0), { delay: 1000, attempt: 1, stop: false, rejected: false })
deepEqual(jmap.reconnectDelay(22, 0, 0), { delay: 1000, attempt: 1, stop: false, rejected: false })

// The owner's own code for a connection it stopped because the server had gone
// silent, or because the credential could not be read. Not a curl exit, and it
// backs off like one.
assert.strictEqual(jmap.EXIT_STREAM_SILENT, -1)
deepEqual(jmap.reconnectDelay(jmap.EXIT_STREAM_SILENT, 0, 0),
  { delay: 1000, attempt: 1, stop: false, rejected: false })

// curl's trailer, told from an event line. It arrives on the same stdout as
// the events, and reading it as one is what resets the backoff on every failed
// connection — measured as a reconnect every second for as long as the server
// was down, before this rule existed.
assert.strictEqual(jmap.streamTrailerStatus("http 401"), 401)
assert.strictEqual(jmap.streamTrailerStatus("http 200"), 200)
assert.strictEqual(jmap.streamTrailerStatus("http 200\n"), 200,
  "the tail of the stream keeps the newline curl printed")
assert.strictEqual(jmap.streamTrailerStatus("http 401\r"), 401)
// Zero is a real answer and -1 is "not the trailer". curl writes `000` when
// there was no HTTP response at all — a refused connection, a failed handshake
// — which is the commonest trailer of all and what `reconnectDelay` reads as
// "no status". Folding the two together made every failed connection look like
// a line off a working one, and the backoff never grew past a second.
assert.strictEqual(jmap.streamTrailerStatus("http 000"), 0)
assert.strictEqual(jmap.streamTrailerStatus("event: state"), -1)
assert.strictEqual(jmap.streamTrailerStatus('data: {"http": 200}'), -1)
assert.strictEqual(jmap.streamTrailerStatus("http401"), -1)
assert.strictEqual(jmap.streamTrailerStatus(""), -1)
assert.strictEqual(jmap.streamTrailerStatus(null), -1)

// What the table reads for a connection that has just ended. A connection that
// heard nothing is not a clean close whatever curl exited with: a server or a
// proxy answering 200 and closing at once would otherwise be reopened every few
// milliseconds for as long as it kept doing it.
assert.strictEqual(jmap.streamExit(0, true), 0, "an hour of pings then a close is clean")
assert.strictEqual(jmap.streamExit(28, true), 28, "and so is the planned rotation")
assert.strictEqual(jmap.streamExit(0, false), jmap.EXIT_STREAM_SILENT)
assert.strictEqual(jmap.streamExit(28, false), jmap.EXIT_STREAM_SILENT)
// Every other exit keeps its own meaning, which is what leaves the 401 alone:
// `--fail` writes no body, so a rejected credential always heard nothing.
assert.strictEqual(jmap.streamExit(22, false), 22)
assert.strictEqual(jmap.streamExit(7, false), 7)
assert.strictEqual(jmap.streamExit(35, true), 35)

assert.strictEqual(jmap.streamExit(0, undefined), jmap.EXIT_STREAM_SILENT,
  "silence is the default, not a clean close")
deepEqual(jmap.reconnectDelay(jmap.streamExit(22, false), 401, 0),
  { delay: 0, attempt: 0, stop: true, rejected: true },
  "the two rules together are what stops a revoked app password being retried")
deepEqual(jmap.reconnectDelay(jmap.streamExit(0, false), 200, 0),
  { delay: 1000, attempt: 1, stop: false, rejected: false })

// ------------------------------------------------------------- a clock jump
//
// Qt's timers run on the monotonic clock, which stops while the machine is
// suspended: a thirty-second timer that fires after four hours has counted
// thirty seconds of running time and knows nothing happened. The wall clock is
// what knows.

const tick = 30000
assert.strictEqual(jmap.clockJumped(1000, 1000 + tick, tick), false,
  "a timer that fired on time is a timer that fired on time")
assert.strictEqual(jmap.clockJumped(1000, 1000 + tick * 2, tick), false,
  "twice the interval is the threshold, and the threshold is not over it")
assert.strictEqual(jmap.clockJumped(1000, 1000 + tick * 2 + 1, tick), true)
assert.strictEqual(jmap.clockJumped(1000, 1000 + 4 * 3600 * 1000, tick), true,
  "a night's suspend")
// A busy GUI thread delays a timer by tens of milliseconds routinely, and
// reconnecting every time the desktop was busy would be worse than the problem.
assert.strictEqual(jmap.clockJumped(1000, 1000 + tick + 500, tick), false)
// The clock going backwards — an NTP correction — is not a resume.
assert.strictEqual(jmap.clockJumped(1000 + tick, 1000, tick), false)
assert.strictEqual(jmap.clockJumped(0, 0, 0), false)
assert.strictEqual(jmap.clockJumped(null, undefined, tick), false)

// -------------------------------------------------- session limits and calls
//
// Read from the session, never assumed. The figures are the reference server's,
// measured through the transport.

const limited = session({
  capabilities: {
    "urn:ietf:params:jmap:core": {
      maxSizeUpload: 50000000, maxConcurrentUpload: 4, maxSizeRequest: 10000000,
      maxConcurrentRequests: 4, maxCallsInRequest: 16,
      maxObjectsInGet: 500, maxObjectsInSet: 500
    },
    "urn:ietf:params:jmap:mail": {},
    "urn:ietf:params:jmap:submission": {}
  }
})

assert.strictEqual(jmap.sessionLimit(limited, "maxObjectsInGet", 100), 500)
assert.strictEqual(jmap.sessionLimit(limited, "maxConcurrentRequests", 4), 4)
assert.strictEqual(jmap.sessionLimit(limited, "maxObjectsInSet", 100), 500)
assert.strictEqual(jmap.sessionLimit(limited, "notAThing", 7), 7,
  "the floor under a server that omitted one, not an assumption about one that stated it")
assert.strictEqual(jmap.sessionLimit(null, "maxObjectsInGet", 100), 100)
assert.strictEqual(jmap.sessionLimit(limited, "maxObjectsInGet", 0), 500)
assert.strictEqual(jmap.sessionLimit(JSON.stringify(limited), "maxObjectsInGet", 100), 500,
  "the document may still be text")
assert.strictEqual(jmap.primaryAccountId(session()), "t")
assert.strictEqual(jmap.primaryAccountId(null), "")

deepEqual(jmap.chunked(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]])
deepEqual(jmap.chunked(["a", "b"], 500), [["a", "b"]])
deepEqual(jmap.chunked([], 500), [])
deepEqual(jmap.chunked(["a", "b"], 0), [["a"], ["b"]])

const reply = [
  ["Email/query", { position: 0, ids: ["x"], total: 1 }, "0"],
  ["Email/get", { state: "s41", list: [{ id: "x" }] }, "1"]
]
deepEqual(jmap.responseArguments(reply, "Email/get"), { state: "s41", list: [{ id: "x" }] })
assert.strictEqual(jmap.responseArguments(reply, "Mailbox/get"), null,
  "which is a different thing from an invocation that answered an empty list")
assert.strictEqual(jmap.responseArguments(null, "Email/get"), null)

// ------------------------------------------------------ actions as patches
//
// `roles` above is the reference test account's map — Inbox `a`, Trash `b`,
// Junk `c`, Drafts `d`, Sent `e` — and **no Archive at all**, which is what
// makes the unresolved-role rows below the account's real behaviour rather than
// a hypothetical. `filed` is the same account with one.

const filed = jmap.roleMap(boxes.concat([
  { id: "f", name: "Archive", parentId: null, role: "archive", sortOrder: 0 }
]))

assert.strictEqual(roles.archive, "")
assert.strictEqual(filed.archive, "f")

// Every row of the table, in the vocabulary `Model.labelChangesFor` speaks.

// Read and unread. The inversion is the one that has to be right: Gmail's
// UNREAD is a label you add, `$seen` is a keyword you take away.
deepEqual(jmap.patchFor([], ["UNREAD"], roles), { "keywords/$seen": true })
deepEqual(jmap.patchFor(["UNREAD"], [], roles), { "keywords/$seen": null })

// Star, both ways. Removal is `null`, the RFC 8620 patch form; `false` also
// works on the reference server and is deliberately not used.
deepEqual(jmap.patchFor(["STARRED"], [], roles), { "keywords/$flagged": true })
deepEqual(jmap.patchFor([], ["STARRED"], roles), { "keywords/$flagged": null })

// Archive swaps Inbox for Archive and leaves every other membership alone, so a
// message filed in a user folder as well stays filed there.
deepEqual(jmap.patchFor([], ["INBOX"], filed),
  { "mailboxIds/f": true, "mailboxIds/a": null })
deepEqual(jmap.patchFor(["INBOX"], [], filed),
  { "mailboxIds/a": true, "mailboxIds/f": null })

// Trash and spam are whole-property replaces: the message is there and nowhere
// else, which is what the after-action rule already assumes about it.
deepEqual(jmap.patchFor(["TRASH"], [], roles), { mailboxIds: { b: true } })
deepEqual(jmap.patchFor(["SPAM"], [], roles), {
  mailboxIds: { c: true },
  "keywords/$junk": true,
  "keywords/$notjunk": null
})

// Untrash is the TRASH label coming off, and it goes to the Inbox because JMAP
// keeps no record of where a trashed message came from.
deepEqual(jmap.patchFor([], ["TRASH"], roles),
  { "mailboxIds/a": true, "mailboxIds/b": null })

// Several label ids combine in one patch: one message, one update object.
deepEqual(jmap.patchFor(["STARRED"], ["UNREAD"], roles),
  { "keywords/$flagged": true, "keywords/$seen": true })
deepEqual(jmap.patchFor(["TRASH"], ["UNREAD"], roles),
  { "keywords/$seen": true, mailboxIds: { b: true } })

// A later move overrides an earlier one, and this is the case that matters:
// "report spam" arrives as add SPAM *and* remove INBOX. Reading the first of
// those as an archive would file the message rather than report it — and on
// this account, which has no Archive mailbox, would refuse the request outright
// for a user who asked for junk.
deepEqual(jmap.patchFor(["SPAM"], ["INBOX"], roles), {
  mailboxIds: { c: true },
  "keywords/$junk": true,
  "keywords/$notjunk": null
})
deepEqual(jmap.patchFor(["SPAM"], ["INBOX"], filed), {
  mailboxIds: { c: true },
  "keywords/$junk": true,
  "keywords/$notjunk": null
}, "and the same on an account that does have one, rather than an archive")
deepEqual(jmap.patchFor(["TRASH"], ["INBOX"], filed), { mailboxIds: { b: true } })

// The three unresolved-role errors: a destination this account has no mailbox
// for is a failure in the client, in the query's own wording, before any
// request. Not a silent success, which is what IMAP does today, and not a patch
// that would leave the message in no mailbox at all — the server refuses that
// with "Message has to belong to at least one mailbox".
assert.strictEqual(jmap.patchFor([], ["INBOX"], roles),
  "This account has no Archive mailbox")
assert.strictEqual(jmap.patchFor(["TRASH"], [], jmap.roleMap([])),
  "This account has no Trash mailbox")
assert.strictEqual(jmap.patchFor(["SPAM"], [], jmap.roleMap([])),
  "This account has no Junk mailbox")
assert.strictEqual(jmap.patchFor(["INBOX"], [], jmap.roleMap([])),
  "This account has no Inbox mailbox",
  "and unarchive names the mailbox it was going to, not the one it was leaving")

// The refusal is the *destination*. Unarchiving on an account with no Archive
// mailbox has nowhere to leave from and that is nothing to do, so the patch is
// the move into the Inbox and no `null` for a key that could not exist.
deepEqual(jmap.patchFor(["INBOX"], [], roles), { "mailboxIds/a": true })
deepEqual(jmap.patchFor([], ["TRASH"], jmap.roleMap([
  { id: "a", name: "Inbox", parentId: null, role: "inbox" }
])), { "mailboxIds/a": true })

// A keyword change never needs a mailbox, so it never refuses.
deepEqual(jmap.patchFor([], ["UNREAD"], jmap.roleMap([])), { "keywords/$seen": true })

// Nothing recognised is an empty patch rather than an error, and the client
// answers it without a round trip.
deepEqual(jmap.patchFor([], [], roles), {})
deepEqual(jmap.patchFor(["IMPORTANT"], ["CATEGORY_PROMOTIONS"], roles), {})
deepEqual(jmap.patchFor(null, null, null), {})
assert.strictEqual(jmap.patchIsEmpty(jmap.patchFor([], [], roles)), true)
assert.strictEqual(jmap.patchIsEmpty(jmap.patchFor([], ["UNREAD"], roles)), false)
assert.strictEqual(jmap.patchIsEmpty(null), true)
assert.strictEqual(jmap.patchIsEmpty("This account has no Archive mailbox"), true,
  "a refusal is not a patch to send either")

// Label ids arrive uppercase from the model, and a stray lower-case one is the
// same request rather than a silent no-op.
deepEqual(jmap.patchFor(["starred"], [], roles), { "keywords/$flagged": true })

// ---------------------------------------------------------- the set request

// One patch per message under one `update` map, and never `ifInState` — a
// value the server never issued is a request-level 400 on the reference server
// rather than the `stateMismatch` the RFC describes.
const seen = jmap.patchFor([], ["UNREAD"], roles)
deepEqual(jmap.emailSet("t", ["eaaaaab", "iaaaaac"], seen), {
  accountId: "t",
  update: {
    eaaaaab: { "keywords/$seen": true },
    iaaaaac: { "keywords/$seen": true }
  }
})
assert.strictEqual("ifInState" in jmap.emailSet("t", ["eaaaaab"], seen), false)
deepEqual(jmap.emailSet("t", ["eaaaaab", "", null], seen), {
  accountId: "t",
  update: { eaaaaab: { "keywords/$seen": true } }
}, "an empty id would name a message the server has no way to refuse")
deepEqual(jmap.emailSet("t", [], seen), { accountId: "t", update: {} })
deepEqual(jmap.emailSet("t", null, seen), { accountId: "t", update: {} })

// Chunking, at and above the session's own figure. The reference server says
// 500; the fallback is a floor under a server that omitted a mandatory number,
// not a guess about one that stated it.
const many = []
for (let i = 0; i < 501; i++) many.push("id" + i)
const setLimit = jmap.sessionLimit(limited, "maxObjectsInSet", jmap.DEFAULT_OBJECTS_IN_SET)
assert.strictEqual(setLimit, 500)
assert.strictEqual(jmap.sessionLimit(null, "maxObjectsInSet", jmap.DEFAULT_OBJECTS_IN_SET), 100)

assert.strictEqual(jmap.chunked(many.slice(0, 499), setLimit).length, 1)
assert.strictEqual(jmap.chunked(many.slice(0, 500), setLimit).length, 1,
  "exactly the limit is one request, not two")
const split = jmap.chunked(many, setLimit)
assert.strictEqual(split.length, 2)
assert.strictEqual(split[0].length, 500)
deepEqual(split[1], ["id500"])
assert.strictEqual(jmap.chunked(many, setLimit)
  .reduce((total, chunk) => total + chunk.length, 0), 501,
  "and every id is in exactly one of them")

// ------------------------------------------------------------- set errors

assert.strictEqual(jmap.setError({ type: "notFound" }),
  "That message is no longer on the server")
assert.strictEqual(jmap.setError({ type: "forbidden" }), "The server refused that change")
assert.strictEqual(jmap.setError({ type: "tooLarge" }),
  "The mailbox is over its storage quota")
assert.strictEqual(jmap.setError({ type: "overQuota" }),
  "The mailbox is over its storage quota")
assert.strictEqual(jmap.setError({ type: "rateLimit" }),
  "The mail server is busy. Try again shortly")
// Anything else in the server's own words, because a type name is not a
// sentence — and redacted, because those words are the server's.
assert.strictEqual(jmap.setError({
  type: "invalidProperties",
  description: "Message has to belong to at least one mailbox"
}), "Message has to belong to at least one mailbox")
assert.strictEqual(jmap.setError({ type: "invalidPatch" }),
  "The mail server could not complete this request")
assert.strictEqual(jmap.setError({}), "The mail server could not complete this request")
assert.strictEqual(jmap.setError(null), "The mail server could not complete this request")
assert.strictEqual(jmap.setError({
  type: "serverFail",
  description: "upstream said Bearer sk-live-41d2 was rejected"
}), "upstream said Bearer [redacted] was rejected")

// ------------------------------------------------- what a reply amounts to

const updatedBoth = {
  accountId: "t",
  newState: "s42",
  updated: { eaaaaab: null, iaaaaac: null },
  notUpdated: null
}
assert.strictEqual(jmap.notUpdatedError(updatedBoth, true), "")
assert.strictEqual(jmap.notUpdatedError(updatedBoth, false), "")
assert.strictEqual(jmap.notUpdatedError({ accountId: "t", newState: "s42" }, false), "")
assert.strictEqual(jmap.notUpdatedError(null, false), "")

// "Mark these read" over a page somebody else has been deleting from finishes
// and reports nothing: what is still there was marked, and the next list load
// drops the rest.
const oneGone = {
  updated: { eaaaaab: null },
  notUpdated: { nosuchid: { type: "notFound" } }
}
assert.strictEqual(jmap.notUpdatedError(oneGone, true), "")
// The same reply for one message the user pointed at is the answer.
assert.strictEqual(jmap.notUpdatedError(oneGone, false),
  "That message is no longer on the server")

// Any other refusal is an error either way, and the first entry is the one
// reported — one sentence is what the account shows.
assert.strictEqual(jmap.notUpdatedError({
  notUpdated: { eaaaaab: { type: "forbidden" } }
}, true), "The server refused that change")
assert.strictEqual(jmap.notUpdatedError({
  notUpdated: {
    nosuchid: { type: "notFound" },
    eaaaaab: { type: "overQuota" }
  }
}, true), "The mailbox is over its storage quota",
  "the tolerated one is passed over rather than ending the search")
assert.strictEqual(jmap.notUpdatedError({
  notUpdated: { eaaaaab: { type: "notFound" }, iaaaaac: { type: "forbidden" } }
}, false), "That message is no longer on the server")

// -------------------------------------------------------- sending and drafts
//
// Every request below is the one the reference account answered: the probes
// beside the map ran each of these against Stalwart, and the replies asserted
// on are its own words rather than invented ones.

const sendSession = session({
  uploadUrl: "https://api.example.org/jmap/upload/{accountId}/",
  capabilities: {
    "urn:ietf:params:jmap:core": { maxSizeUpload: 50000000, maxConcurrentUpload: 4 },
    "urn:ietf:params:jmap:mail": {},
    "urn:ietf:params:jmap:submission": {}
  }
})

assert.strictEqual(jmap.uploadTemplate(sendSession),
  "https://api.example.org/jmap/upload/{accountId}/")
assert.strictEqual(jmap.uploadTemplate(JSON.stringify(sendSession)),
  "https://api.example.org/jmap/upload/{accountId}/", "the document may still be text")
assert.strictEqual(jmap.uploadTemplate(session()), "")
assert.strictEqual(jmap.uploadTemplate(null), "")

assert.strictEqual(jmap.uploadUrl(jmap.uploadTemplate(sendSession), "t"),
  "https://api.example.org/jmap/upload/t/")
// An account id is a server's own string, so it is encoded on the way into
// somebody else's template exactly as a blob id is.
assert.strictEqual(jmap.uploadUrl("https://h/upload/{accountId}/", "a/b?c"),
  "https://h/upload/a%2Fb%3Fc/")
assert.strictEqual(jmap.uploadUrl("", "t"), "")
assert.strictEqual(jmap.uploadUrl(null, "t"), "")

// What an upload answers with, and the answer that is not one.
assert.strictEqual(jmap.uploadedBlobId(
  '{"accountId":"t","blobId":"edvsg29zokw9x2r71c0","type":"message/rfc822","size":221}'),
  "edvsg29zokw9x2r71c0")
assert.strictEqual(jmap.uploadedBlobId("<html>no</html>"), "")
assert.strictEqual(jmap.uploadedBlobId('{"accountId":"t"}'), "")
assert.strictEqual(jmap.uploadedBlobId(null), "")

// The session states its own upload concurrency; one is the floor under a
// server that omitted a mandatory figure.
assert.strictEqual(jmap.DEFAULT_CONCURRENT_UPLOAD, 1)
assert.strictEqual(
  jmap.sessionLimit(sendSession, "maxConcurrentUpload", jmap.DEFAULT_CONCURRENT_UPLOAD), 4)
assert.strictEqual(
  jmap.sessionLimit(session(), "maxConcurrentUpload", jmap.DEFAULT_CONCURRENT_UPLOAD), 1)

// ------------------------------------------------------------- three guards

// Nothing is wrong with an ordinary message on the reference account.
assert.strictEqual(jmap.sendGuard(sendSession, roles, 4096), "")
assert.strictEqual(jmap.saveGuard(sendSession, roles, 4096), "")

// The ceiling is the server's own figure, and exactly it is allowed.
assert.strictEqual(jmap.sendGuard(sendSession, roles, 50000000), "")
assert.strictEqual(jmap.sendGuard(sendSession, roles, 50000001),
  "This message is larger than the server accepts")
assert.strictEqual(jmap.saveGuard(sendSession, roles, 50000001),
  "This message is larger than the server accepts")
// A server that published no figure refuses nothing for size: RFC 8620 makes
// it mandatory, so its absence is the server's omission rather than a reason
// to refuse every message this client is asked to send.
assert.strictEqual(jmap.sendGuard(session(), roles, 50000001), "")

// The two roles, in the order they are checked. Both exist on both target
// servers, so these guard an account whose folder was deleted since the last
// read rather than a server this client expects to meet.
assert.strictEqual(jmap.sendGuard(sendSession, { sent: "", drafts: "d" }, 10),
  "This account has no Sent mailbox")
assert.strictEqual(jmap.sendGuard(sendSession, { sent: "e", drafts: "" }, 10),
  "This account has no Drafts mailbox")
assert.strictEqual(jmap.sendGuard(sendSession, null, 10), "This account has no Sent mailbox")
// A draft never reaches Sent, so a missing Sent mailbox is not its business.
assert.strictEqual(jmap.saveGuard(sendSession, { sent: "", drafts: "d" }, 10), "")
assert.strictEqual(jmap.saveGuard(sendSession, { sent: "e", drafts: "" }, 10),
  "This account has no Drafts mailbox")
// Size is answered before either, because it is about this message rather
// than about the account.
assert.strictEqual(jmap.sendGuard(sendSession, { sent: "", drafts: "" }, 50000001),
  "This message is larger than the server accepts")

// ------------------------------------------------------ one header, no parse

const outgoing = [
  "From: \"Test Account\" <ada@example.org>",
  "To: a@b.example,",
  "\tc@d.example",
  "Subject: [omamail-test] hello",
  "MIME-Version: 1.0",
  "",
  "From: this line is the body and is not a header"
].join("\r\n")

assert.strictEqual(jmap.messageHeader(outgoing, "From"),
  "\"Test Account\" <ada@example.org>")
assert.strictEqual(jmap.messageHeader(outgoing, "from"), jmap.messageHeader(outgoing, "From"),
  "a header name is not case-sensitive")
assert.strictEqual(jmap.messageHeader(outgoing, "To"), "a@b.example, c@d.example",
  "a folded continuation belongs to the header above it")
assert.strictEqual(jmap.messageHeader(outgoing, "Cc"), "")
assert.strictEqual(jmap.messageHeader(outgoing, ""), "")
assert.strictEqual(jmap.messageHeader("", "From"), "")
assert.strictEqual(jmap.messageHeader(null, "From"), "")
// The header block ends at the blank line, so an attachment cannot forge one.
assert.strictEqual(jmap.messageHeader(outgoing, "Subject"), "[omamail-test] hello")
assert.strictEqual(
  jmap.messageHeader("Subject: only headers\r\n", "Subject"), "only headers",
  "a message that never reached its blank line still has the headers it has")

// ------------------------------------------------------------- identities

// `Identity/get` on the reference account, and a second identity to choose
// between. `mayDelete`, `replyTo` and the signatures are the server's and none
// of them is read.
const serverIdentities = [
  {
    id: "b", name: "Test Account", email: "ada@example.org",
    replyTo: null, bcc: null, textSignature: "", htmlSignature: "", mayDelete: true
  },
  { id: "c", name: "", email: "Alias@example.org" }
]

deepEqual(jmap.identityAliases(serverIdentities, "ada@example.org"), [
  {
    id: "b", email: "ada@example.org", displayName: "Test Account",
    isPrimary: true, isDefault: true
  },
  { id: "c", email: "Alias@example.org", displayName: "", isPrimary: false, isDefault: false }
])
// The signed-in address is matched without regard to case, on either side.
assert.strictEqual(jmap.identityAliases(serverIdentities, "ADA@Example.org")[0].isDefault, true)
deepEqual(jmap.identityAliases([{ id: "c", email: "ALIAS@example.org" }], "alias@example.org"), [
  { id: "c", email: "ALIAS@example.org", displayName: "", isPrimary: true, isDefault: true }
])
// A row with no id could never be submitted under and a row with no address
// could never be chosen, so neither is offered.
deepEqual(jmap.identityAliases([{ name: "nameless" }, { id: "d" }], "x@y"), [])
deepEqual(jmap.identityAliases([], "x@y"), [])
deepEqual(jmap.identityAliases(null, "x@y"), [])

const sendAs = jmap.identityAliases(serverIdentities, "ada@example.org")

// The address the message states wins.
assert.strictEqual(jmap.identityFor(sendAs, "Alias@example.org"), "c")
assert.strictEqual(jmap.identityFor(sendAs, "ada@example.org"), "b")
// Case on either side, and the address inside the angle brackets rather than a
// phrase that happens to contain an `@`.
assert.strictEqual(jmap.identityFor(sendAs, "\"a@b.example\" <ALIAS@EXAMPLE.ORG>"), "c")
assert.strictEqual(jmap.identityFor(sendAs, "Test Account <ada@example.org>"), "b")
// No match is not a refusal: the RSVP and the unsubscribe send from the alias
// the mail arrived at, and the server forces the envelope sender to the
// identity while delivering the header as written.
assert.strictEqual(jmap.identityFor(sendAs, "someone@example.org"), "b")
assert.strictEqual(jmap.identityFor(sendAs, ""), "b")
assert.strictEqual(jmap.identityFor(sendAs, null), "b")
// No identity is the signed-in address, so there is no default and the first
// is what a send goes out under.
assert.strictEqual(jmap.identityFor(jmap.identityAliases(serverIdentities, ""),
  "nowhere@example.org"), "b")
// An account with no identity at all answers nothing, and the server refuses
// the submission in its own words.
assert.strictEqual(jmap.identityFor([], "a@b.example"), "")
assert.strictEqual(jmap.identityFor(null, "a@b.example"), "")

// ------------------------------------------------------------ the send request

// The creation ids are this client's own labels: `#m` is what the submission's
// `emailId` names and `#s` is what `onSuccessUpdateEmail` is keyed on — the
// *submission's* creation id, not the email's.
assert.strictEqual(jmap.CREATE_EMAIL, "m")
assert.strictEqual(jmap.CREATE_SUBMISSION, "s")

const importCall = ["Email/import", {
  accountId: "t",
  emails: { m: { blobId: "blob1", mailboxIds: { d: true }, keywords: { $draft: true, $seen: true } } }
}, "0"]

const submitCall = ["EmailSubmission/set", {
  accountId: "t",
  create: { s: { emailId: "#m", identityId: "b" } },
  onSuccessUpdateEmail: {
    "#s": { "mailboxIds/e": true, "mailboxIds/d": null, "keywords/$draft": null }
  }
}, "1"]

deepEqual(jmap.sendRequest("t", "blob1", "b", roles, ""), [importCall, submitCall])

// Existing drafts are never destroyed in a batch that may fail before sending.
deepEqual(jmap.sendRequest("t", "blob1", "b", roles, "maaaaad"), [
  importCall, submitCall
])

// No envelope, ever. The server derives the sender from the identity and the
// recipients from To, Cc and Bcc, which is the same set the IMAP client reads
// off the same headers.
assert.strictEqual(
  "envelope" in jmap.sendRequest("t", "blob1", "b", roles, "")[1][1].create.s, false)
// And no `sendAt`: the reference server sets it and refuses it as input.
assert.strictEqual(
  "sendAt" in jmap.sendRequest("t", "blob1", "b", roles, "")[1][1].create.s, false)

// A send with no identity to name still builds a request. It is refused by the
// server rather than by a client that decided the account could not send.
assert.strictEqual(jmap.sendRequest("t", "blob1", "", roles, "")[1][1].create.s.identityId, "")

// ------------------------------------------------------------ the save request

deepEqual(jmap.saveRequest("t", "blob2", roles, ""), [
  ["Email/import", {
    accountId: "t",
    emails: { m: { blobId: "blob2", mailboxIds: { d: true }, keywords: { $draft: true, $seen: true } } }
  }, "0"]
])

deepEqual(jmap.saveRequest("t", "blob2", roles, "buaaaaan"), [
  ["Email/import", {
    accountId: "t",
    emails: { m: { blobId: "blob2", mailboxIds: { d: true }, keywords: { $draft: true, $seen: true } } }
  }, "0"]
])

// There is no update: an Email is immutable apart from its keywords and its
// mailboxes, and the reference server refuses a subject patch outright.
assert.strictEqual(typeof jmap.updateDraft, "undefined")

// --------------------------------------------- what the reply is read for

// The reference server's own answer to an import that worked.
const importedOk = {
  accountId: "t", oldState: "sgy", newState: "sg2",
  created: { m: { id: "dmaaaaa9", threadId: "9", blobId: "caiopsc0fv0q", size: 267 } }
}
assert.strictEqual(jmap.createdId(importedOk, jmap.CREATE_EMAIL), "dmaaaaa9")
assert.strictEqual(jmap.notCreatedEntry(importedOk, jmap.CREATE_EMAIL), null)
assert.strictEqual(jmap.createdId(importedOk, "somethingelse"), "")
assert.strictEqual(jmap.createdId(null, "m"), "")
assert.strictEqual(jmap.notCreatedEntry(null, "s"), null)

// A submission the server refused in the same request as its import. Measured:
// the import stands, so the imported id is what the follow-up destroys before
// the error reaches the compose window.
const refusedSend = [
  ["Email/import", importedOk, "0"],
  ["EmailSubmission/set", {
    accountId: "t",
    notCreated: { s: { type: "noRecipients", description: "No recipients found in email." } }
  }, "1"]
]
const stranded = jmap.createdId(
  jmap.responseArguments(refusedSend, "Email/import"), jmap.CREATE_EMAIL)
assert.strictEqual(stranded, "dmaaaaa9")
deepEqual(jmap.destroyRequest("t", [stranded]),
  [["Email/set", { accountId: "t", destroy: ["dmaaaaa9"] }, "0"]])
assert.strictEqual(jmap.submissionError(jmap.notCreatedEntry(
  jmap.responseArguments(refusedSend, "EmailSubmission/set"), jmap.CREATE_SUBMISSION)),
  "Add a recipient first")

// One id or a list, and an id named twice is destroyed once.
deepEqual(jmap.destroyRequest("t", "x"), [["Email/set", { accountId: "t", destroy: ["x"] }, "0"]])
deepEqual(jmap.destroyRequest("t", ["x", "x", "", null]),
  [["Email/set", { accountId: "t", destroy: ["x"] }, "0"]])
deepEqual(jmap.destroyRequest("t", []), [["Email/set", { accountId: "t", destroy: [] }, "0"]])

// ------------------------------------------------------- submission errors

assert.strictEqual(jmap.submissionError({
  type: "forbiddenFrom",
  description: "Envelope mailFrom does not match identity email address."
}), "This account may not send as that address")
assert.strictEqual(jmap.submissionError({ type: "noRecipients" }), "Add a recipient first")
assert.strictEqual(jmap.submissionError({ type: "tooLarge" }),
  "The message is too large for this server")
assert.strictEqual(jmap.submissionError({ type: "tooManyRecipients" }),
  "Too many recipients for this server")
assert.strictEqual(jmap.submissionError({ type: "forbiddenToSend" }),
  "This account is not allowed to send mail")
assert.strictEqual(jmap.submissionError({ type: "rateLimit" }),
  "The mail server is busy. Try again shortly")

// The import's own refusal, answered here because both failures reach the user
// through the same call.
assert.strictEqual(jmap.submissionError({
  type: "invalidEmail", description: "Blob does not contain a valid RFC 5322 message."
}), "The server could not read the message")

// Anything else in the server's own words, because a type name is not a
// sentence — the reference server's answer to a bogus identity and to a bogus
// email id are both `invalidProperties` with a description worth reading.
assert.strictEqual(jmap.submissionError({
  type: "invalidProperties", description: "Identity not found.", properties: ["identityId"]
}), "Identity not found.")
assert.strictEqual(jmap.submissionError({
  type: "invalidProperties", description: "Email not found.", properties: ["emailId"]
}), "Email not found.")
// And redacted, because those words are the server's.
assert.strictEqual(jmap.submissionError({
  type: "serverFail", description: "upstream said Bearer sk-live-41d2 was rejected"
}), "upstream said Bearer [redacted] was rejected")

assert.strictEqual(jmap.submissionError({}), "The message could not be sent")
assert.strictEqual(jmap.submissionError(null), "The message could not be sent")
assert.strictEqual(jmap.submissionError({ type: "unheardOf" }), "The message could not be sent")
// A draft that could not be imported did not fail to be sent.
assert.strictEqual(jmap.submissionError({}, "The draft could not be saved"),
  "The draft could not be saved")
assert.strictEqual(jmap.submissionError({ type: "invalidEmail" }, "The draft could not be saved"),
  "The server could not read the message")

// ------------------------------------------------------ what a save amounts to

// The import is the first call and it succeeded, so the draft is saved
// whatever became of the copy it replaces.
deepEqual(jmap.draftSaveResult({ accountId: "t", destroyed: ["buaaaaan"] }),
  { saved: true, warning: "" })
deepEqual(jmap.draftSaveResult({ accountId: "t" }), { saved: true, warning: "" })
deepEqual(jmap.draftSaveResult(null), { saved: true, warning: "" })
// Somebody else deleted it, which is the outcome that was wanted.
deepEqual(jmap.draftSaveResult({ notDestroyed: { buaaaaan: { type: "notFound" } } }),
  { saved: true, warning: "" })
// Anything else is a warning, not a failure: a leftover shows up as a
// duplicate draft on the next refresh and the user can remove it.
deepEqual(jmap.draftSaveResult({ notDestroyed: { buaaaaan: { type: "forbidden" } } }),
  { saved: true, warning: "Draft saved, but the older copy could not be removed" })
deepEqual(jmap.draftSaveResult({
  notDestroyed: { buaaaaan: { type: "forbidden", description: "Mailbox is read-only" } }
}), { saved: true, warning: "Draft saved, but the older copy could not be removed: Mailbox is read-only" })
deepEqual(jmap.draftSaveResult({
  notDestroyed: {
    gone: { type: "notFound" },
    buaaaaan: { type: "forbidden" }
  }
}), { saved: true, warning: "Draft saved, but the older copy could not be removed" },
  "the tolerated one is passed over rather than ending the search")

// The send request is the one call that adds the submission capability, and it
// never adds a vendor URN.
deepEqual(jmap.USING_SUBMISSION, [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission"
])

// ------------------------------------------------------ per-account refusals
//
// The provider's list is a ceiling and an account withdraws from it. Presence
// of a key is the refusal; the value is the sentence a user reads.

// The reference account: a Junk mailbox, a server that learns from it, a
// credential that may submit — and no Archive at all.
deepEqual(jmap.refusals(session(), "t", boxes),
  { archive: "This account has no Archive mailbox" })
deepEqual(jmap.refusals(JSON.stringify(session()), "t", boxes),
  { archive: "This account has no Archive mailbox" })

// The same account on a server with no vendor URN and no Fastmail host: the
// Junk mailbox is real, only the verb is gone, and the row stays on the rail.
function generic(overrides) {
  const doc = session(Object.assign({ apiUrl: "https://mail.example.org/jmap/" }, overrides || {}))
  delete doc.accounts.t.accountCapabilities["urn:stalwart:jmap"]
  return doc
}

deepEqual(jmap.refusals(generic(), "t", boxes), {
  archive: "This account has no Archive mailbox",
  spam: "This server is not known to learn from its Junk mailbox"
})

// Stalwart is named by its URN, and by the *account's* capabilities first —
// which is where the reference server puts it. A rule written to the session's
// top-level list alone would refuse spam on the very server it was written for.
assert.strictEqual(jmap.learnsFromJunk(session(), "t"), true)
assert.strictEqual(jmap.learnsFromJunk(generic(), "t"), false)
const publishedOnSession = generic()
publishedOnSession.capabilities["urn:stalwart:jmap"] = {}
assert.strictEqual(jmap.learnsFromJunk(publishedOnSession, "t"), true,
  "and the session's own list is read as well, for a server that publishes it there")

// Fastmail publishes no vendor URN naming itself, so the API host identifies it.
assert.strictEqual(
  jmap.learnsFromJunk(generic({ apiUrl: "https://api.fastmail.com/jmap/api/" }), "t"), true)
assert.strictEqual(
  jmap.learnsFromJunk(generic({ apiUrl: "https://api.fastmail.com:443/jmap/" }), "t"), true,
  "the port is not part of the host")
assert.strictEqual(
  jmap.learnsFromJunk(generic({ apiUrl: "https://api.notfastmail.com/jmap/" }), "t"), false,
  "a host that merely ends in the same letters is not the same host")
assert.strictEqual(
  jmap.learnsFromJunk(generic({ apiUrl: "https://fastmail.com/jmap/" }), "t"), false)
assert.strictEqual(jmap.learnsFromJunk(null, "t"), false)

// Every row of the table on one account: no Archive, no Junk, no submission.
const inboxOnly = [{ id: "a", name: "Inbox", parentId: null, role: "inbox" }]
const readOnlyCredential = generic()
delete readOnlyCredential.accounts.t.accountCapabilities["urn:ietf:params:jmap:submission"]
deepEqual(jmap.refusals(readOnlyCredential, "t", inboxOnly), {
  archive: "This account has no Archive mailbox",
  spam: "This account has no Junk mailbox",
  send: "This account cannot send mail"
})

// Submission is asked of the account and not of the session, which still
// declares it: a session-level fallback would draw a Send button for a
// read-only credential.
assert.strictEqual(
  readOnlyCredential.capabilities["urn:ietf:params:jmap:submission"] !== undefined, true)
assert.strictEqual(jmap.hasSubmission(readOnlyCredential, "t"), false)
assert.strictEqual(jmap.hasSubmission(session(), "t"), true)

// An account that refuses nothing answers an empty object, which is a positive
// statement and not the same thing as null.
deepEqual(jmap.refusals(session(), "t", unrolled), {})

// Null until both a session and a mailbox list are in hand: with null the
// registry answers the ceiling, which is what a button should say while the
// list is still on its way rather than a promise about a mailbox nobody has
// looked for yet.
assert.strictEqual(jmap.refusals(session(), "t", []), null)
assert.strictEqual(jmap.refusals(session(), "t", null), null)
assert.strictEqual(jmap.refusals(null, "t", boxes), null)

// And the whole point of it, through the registry the panel actually asks.
const accountRefusals = jmap.refusals(session(), "t", boxes)
assert.strictEqual(registry.can("jmap", "archive", accountRefusals), false,
  "no Archive mailbox, so no archive button and no `e` hint")
assert.strictEqual(registry.refusal("jmap", "archive", accountRefusals),
  "This account has no Archive mailbox")
assert.strictEqual(registry.can("jmap", "spam", accountRefusals), true,
  "and a Report spam button, because this server is known to learn from Junk")
assert.strictEqual(registry.can("jmap", "star", accountRefusals), true)
assert.strictEqual(registry.can("jmap", "send", accountRefusals), true)
deepEqual(registry.mailboxes("jmap", jmap.absentMailboxes(boxes)).map(box => box.key),
  ["inbox", "unread", "starred", "sent", "drafts", "spam", "trash"],
  "the Archive row is gone and Junk moves up, because the number keys are positional")

// ------------------------------------------------------- the provider itself
//
// Loaded through the registry's own `define`, which is what the panel sees.
// The chooser's own listing is asserted in the provider tests; this is the
// shape being proven rather than the order.

const provider = registry.define(description)

assert.strictEqual(provider.id, "jmap")
assert.strictEqual(provider.name, "JMAP")
assert.strictEqual(provider.summary, "Any server that speaks JMAP")
assert.strictEqual(provider.auth, "password")
assert.strictEqual(provider.mark, "", "there is no JMAP brand: the themed envelope is drawn")
assert.strictEqual(provider.logo, "")
assert.strictEqual(provider.webHomeUrl(), "", "and no front door to open")

// The ceiling. An account may refuse archive, spam or send from what its own
// session and mailbox list say; nothing may add one back.
//
// Declared wholesale here, because this literal is the provider's own and a
// whole-object check is what catches a capability quietly added to or dropped
// from it.
deepEqual(description.CAPABILITIES, {
  labels: false,
  threads: true,
  conversations: true,
  archive: true,
  spam: true,
  star: true,
  batch: true,
  search: true,
  send: true,
  web: false,
  webBox: false
})

// And value by value through `define`, which is what the panel actually asks.
// Not as a whole object: the registry's vocabulary is shared with every other
// provider and grows when one of them needs a new word — `conversations` is
// exactly that, arriving with the capability refinement hook — and a provider's
// test that failed on somebody else's addition would be asserting the
// registry's business rather than its own.
assert.strictEqual(provider.capabilities.labels, false,
  "a message is in one mailbox: the label strip was built for Gmail")
assert.strictEqual(provider.capabilities.threads, true, "the thread id is the server's own")
assert.strictEqual(provider.capabilities.archive, true)
assert.strictEqual(provider.capabilities.spam, true,
  "unlike IMAP: a move into Junk is a verb some servers really do learn from")
assert.strictEqual(provider.capabilities.star, true)
assert.strictEqual(provider.capabilities.batch, true)
assert.strictEqual(provider.capabilities.search, true)
assert.strictEqual(provider.capabilities.send, true)
assert.strictEqual(provider.capabilities.web, false, "no web UI this plugin knows the address of")
assert.strictEqual(provider.capabilities.webBox, false)

// `conversations` is the word arriving with that hook, and this is the one
// assertion that has to be written for both trees: absent from the registry's
// vocabulary it is `undefined` here, and present it must be the `true` the
// description declares — a registry that learned the word and dropped this
// provider's answer would be one row per message on a mailbox that has threads.
if (provider.capabilities.conversations !== undefined) {
  assert.strictEqual(provider.capabilities.conversations, true,
    "one row per conversation, from the server's own thread id")
}

// IMAP's eight rows, keyed on RFC 8621 roles rather than on folder names, and
// the last three optional because an account may have no such mailbox at all.
deepEqual(provider.mailboxes, [
  { key: "inbox", label: "Inbox", icon: "inbox", query: "role:inbox", optional: false },
  { key: "unread", label: "Unread", icon: "unread", query: "role:inbox unseen", optional: false },
  { key: "starred", label: "Flagged", icon: "star", query: "role:inbox flagged", optional: false },
  { key: "sent", label: "Sent", icon: "sent", query: "role:sent", optional: false },
  { key: "drafts", label: "Drafts", icon: "compose", query: "role:drafts", optional: false },
  { key: "archive", label: "Archive", icon: "archive", query: "role:archive", optional: true },
  { key: "spam", label: "Junk", icon: "spam", query: "role:junk", optional: true },
  { key: "trash", label: "Trash", icon: "trash", query: "role:trash", optional: true }
])

// A typed search names no mailbox: the server's `text` condition searches the
// account, and the client excludes Junk and Trash when it builds the filter.
assert.strictEqual(provider.searchQuery("  invoice from ada  "), "text:invoice from ada")
assert.strictEqual(provider.searchQuery(""), "")
assert.strictEqual(provider.searchQuery("   "), "")
assert.strictEqual(provider.searchQuery(null), "")
assert.strictEqual(provider.searchQuery("\"quoted phrase\""), 'text:"quoted phrase"',
  "the whole of the rest of the string is the text, quotes included")

// A sidebar mailbox is selected by its id, which is what every filter takes;
// its name can change under it and repeat under another parent.
assert.strictEqual(provider.labelQuery(" a1b2 "), "mailbox:a1b2")
assert.strictEqual(provider.labelQuery(""), "")

// Gmail's search-cache rule, for Gmail's reason: the local preview only
// understands plain text, so a row known to be in Junk or Trash is outside the
// server search being previewed.
assert.strictEqual(provider.cachedSummaryInSearch("role:inbox", { labelIds: ["INBOX"] }), true)
assert.strictEqual(provider.cachedSummaryInSearch("role:inbox", { labelIds: ["SPAM"] }), false)
assert.strictEqual(provider.cachedSummaryInSearch("role:inbox", { labelIds: ["INBOX", "TRASH"] }), false)
assert.strictEqual(provider.cachedSummaryInSearch("role:junk", { labelIds: ["INBOX"] }), false,
  "and a search of Junk is not a search the client sends")
assert.strictEqual(provider.cachedSummaryInSearch("role:trash", {}), false)
assert.strictEqual(provider.cachedSummaryInSearch("mailbox:a1b2", { labelIds: [] }), true)
assert.strictEqual(provider.cachedSummaryInSearch("", null), true)

console.log("jmap ok")
