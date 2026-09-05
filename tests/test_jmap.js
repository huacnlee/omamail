const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapProtocol.js")
const description = load("providers/Jmap.js")
const registry = load("providers/Registry.js")

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

// ------------------------------------------------------- the provider itself
//
// Loaded through the registry's own `define`, which is what the panel sees.
// Not added to the chooser here — that is the setup page's ticket — so this is
// the shape being proven rather than the listing.

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
deepEqual(provider.capabilities, {
  labels: false,
  threads: true,
  archive: true,
  spam: true,
  star: true,
  batch: true,
  web: false,
  webBox: false,
  search: true,
  send: true
})
assert.strictEqual(description.CAPABILITIES.conversations, true,
  "one row per conversation, from the server's own thread id")

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
