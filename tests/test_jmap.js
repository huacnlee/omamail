const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapProtocol.js")
const description = load("providers/Jmap.js")
const registry = load("providers/Registry.js")
const message = load("message/Message.js")

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

// The `using` array of every request, built here and nowhere else: a vendor URN
// in one of them would make every request refuseable by a server that never
// heard of it, and a missing one comes back `unknownCapability`.
deepEqual(jmap.USING_MAIL, ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"])
deepEqual(jmap.USING_SUBMISSION, ["urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  "mail as well as submission: a send also imports the message into a mailbox")

// --------------------------------------------------------------- discovery
//
// Where a JMAP server is looked for. Both halves are real: the reference
// Stalwart is found only by a typed host, because its well-known path answers
// 403 and it publishes no SRV record, and Fastmail is found only by discovery,
// because nobody knows to type api.fastmail.com.

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

// With nothing typed: the SRV record first, then the domain's own well-known
// URL. The SRV step carries no URL because it has not been looked up yet.
deepEqual(jmap.discoveryPlan("Ada@Example.ORG", ""), {
  error: "",
  domain: "example.org",
  steps: [
    { kind: "srv", url: "" },
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

// ------------------------------------------------------------- SRV records
//
// Two tools print the same record two ways, and the parser reads both. The
// resolvectl line is the one measured on this machine, interface suffix and
// all: counting fields from the end would read `wlp9s0` as the target.

deepEqual(jmap.parseSrv("_jmap._tcp.fastmail.com IN SRV 0 1 443 api.fastmail.com     -- link: wlp9s0"), {
  target: "api.fastmail.com",
  port: 443,
  url: "https://api.fastmail.com/.well-known/jmap"
})
deepEqual(jmap.parseSrv("0 1 443 api.fastmail.com."), {
  target: "api.fastmail.com",
  port: 443,
  url: "https://api.fastmail.com/.well-known/jmap"
}, "dig writes the fully qualified name, and a URL does not want the dot")

// RFC 2782: the lowest priority wins, whatever order the answers arrive in.
assert.strictEqual(jmap.parseSrv("10 5 443 second.example.org.\n1 5 443 first.example.org.").target,
  "first.example.org")
assert.strictEqual(jmap.parseSrv("1 5 443 first.example.org.\n10 5 443 second.example.org.").target,
  "first.example.org")

// Then the highest weight among equals. A client fetching one session object
// has nothing to spread across a random draw, so the heaviest simply wins.
assert.strictEqual(jmap.parseSrv("1 5 443 light.example.org.\n1 50 443 heavy.example.org.").target,
  "heavy.example.org")

// A target of "." is the record saying the service is decidedly not available
// here — a different statement from no record at all, and the same answer.
deepEqual(jmap.parseSrv("0 0 443 ."), { target: "", port: 0, url: "" })
deepEqual(jmap.parseSrv(""), { target: "", port: 0, url: "" })
deepEqual(jmap.parseSrv("_jmap._tcp.example.org: resolve call failed: no such record"),
  { target: "", port: 0, url: "" }, "a tool's complaint is not a record")
deepEqual(jmap.parseSrv(null), { target: "", port: 0, url: "" })

// A port that is not 443 is written into the URL; 443 is not, because a URL
// saying `:443` is the same address spelled longer.
assert.strictEqual(jmap.parseSrv("0 1 8443 jmap.example.org.").url,
  "https://jmap.example.org:8443/.well-known/jmap")
assert.strictEqual(jmap.parseSrv("0 1 8443 jmap.example.org.").port, 8443)
assert.strictEqual(jmap.parseSrv("0 1 0 jmap.example.org.").target, "",
  "port 0 is not somewhere to connect")
assert.strictEqual(jmap.parseSrv("0 1 443 https://jmap.example.org/").target, "",
  "a target that is not a hostname is not a record this client can act on")

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
        name: "omamail-test@depodra.com",
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
    apiUrl: "https://mx2.depodra.com/jmap/",
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
assert.strictEqual(jmap.apiUrl(session()), "https://mx2.depodra.com/jmap/")
assert.strictEqual(jmap.apiUrl(JSON.stringify(session())), "https://mx2.depodra.com/jmap/")
assert.strictEqual(jmap.apiUrl(session({ apiUrl: undefined })), "")
assert.strictEqual(jmap.apiUrl("not a session"), "")

// The server's own word for "nothing has changed", which is what a cached
// session is keyed on.
assert.strictEqual(jmap.sessionState(session()), "abc")
assert.strictEqual(jmap.sessionState(session({ state: undefined })), "")
assert.strictEqual(jmap.sessionState(null), "")

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
assert.strictEqual(jmap.sessionHost("https://mail.depodra.com/jmap/session"), "mail.depodra.com")
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

// The request. `receivedAt` descending on every page, uncollapsed until ticket
// 11 flips it, and `calculateTotal` on every one of them.
deepEqual(jmap.emailQuery("t", { inMailbox: "a" }, 3, ""), {
  accountId: "t",
  filter: { inMailbox: "a" },
  sort: [{ property: "receivedAt", isAscending: false }],
  collapseThreads: false,
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
  collapseThreads: false,
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
  to: [{ name: null, email: "omamail-test@depodra.com" }],
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
  { name: "To", value: "omamail-test@depodra.com" },
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
