const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapProtocol.js")

// The small rules `JmapProtocol.js` is written with — ids as a list, a value
// that is there, the one walk over a reply's invocations — and beside them the
// reply-shaped errors, the waiting list the client holds three of, and the
// credential and scheme rules the sign-in reads. Split from `test_jmap.js`
// for the reason `test_jmap_threads.js` was: the 128 KB ceiling on a tracked
// file.

// ---------------------------------------------------------- the small rules
//
// Three helpers the rest of the file is written with: ids as a clean list, a
// value that is there, and the one walk over a reply's invocations.

deepEqual(jmap.uniqueIds(["b", " a ", "", "b", null, "a"]), ["b", "a"],
  "trimmed, without blanks or repeats, in first-appearance order")
deepEqual(jmap.uniqueIds("solo"), ["solo"], "one id is a list of one")
deepEqual(jmap.uniqueIds(undefined), [])

assert.strictEqual(jmap.isSet(true), true)
assert.strictEqual(jmap.isSet("x"), true)
assert.strictEqual(jmap.isSet(0), true, "only the three absent values are absent")
assert.strictEqual(jmap.isSet(null), false, "RFC 8620's patched-out value")
assert.strictEqual(jmap.isSet(false), false, "and the one the reference server also takes")
assert.strictEqual(jmap.isSet(undefined), false)

deepEqual(jmap.invocations([
  ["Email/get", { list: [] }, "0"],
  ["error", { type: "serverFail" }, " 1 "],
  "not a triple", null, ["Mailbox/get"], ["Thread/get", null]
]), [
  { name: "Email/get", arguments: { list: [] }, callId: "0" },
  { name: "error", arguments: { type: "serverFail" }, callId: "1" },
  { name: "Thread/get", arguments: {}, callId: "" }
], "every triple, trimmed, with absent arguments read as none; anything else skipped")
deepEqual(jmap.invocations(null), [])
deepEqual(jmap.invocations("[]"), [], "a string is not a reply")

// ------------------------------------------------------------ reply errors

// The reply object the transport hands over, read without spelling its fields
// out; and a blob download's own reading of it, where exit 63 is about the
// attachment rather than the server.
assert.strictEqual(jmap.replyError({ exit: 7, status: 0, body: "", stderr: "" }),
  "Could not reach the mail server")
assert.strictEqual(jmap.replyError({ exit: 0, status: 429, body: "", stderr: "" }, "45"),
  "The server asked to slow down (retry in 45s)")
assert.strictEqual(jmap.replyError(null), "Could not reach the mail server")
assert.strictEqual(jmap.downloadError({ exit: 63, status: 200 }, ""), "This attachment is larger than 20 MB")
assert.strictEqual(jmap.downloadError({ exit: 0, status: 404 }, ""),
  "The server has no such mailbox or message")
assert.strictEqual(jmap.downloadError({ exit: 0, status: 403 }, '{"detail":"Blob is not yours"}'),
  "Blob is not yours", "the problem document is the decoded body the caller hands over")

// ------------------------------------------------------------- the waiters

// The waiting list behind a read many callers need and one performs. The
// first to join performs it; everybody who joined is answered once; and the
// next join after the answer performs it again.
{
  const gate = jmap.makeWaiters()
  const answers = []
  assert.strictEqual(gate.join(e => answers.push("one:" + e)), true, "the first joiner reads")
  assert.strictEqual(gate.join(e => answers.push("two:" + e)), false, "the second only waits")
  assert.strictEqual(gate.join(null), false, "a joiner with no callback still only waits")
  gate.finish("")
  deepEqual(answers, ["one:", "two:"], "every waiter is answered once, in order")
  gate.finish("late")
  deepEqual(answers, ["one:", "two:"], "and a second finish has nobody to answer")
  assert.strictEqual(gate.join(e => answers.push("three:" + e)), true, "the next read starts afresh")
  gate.finish(null)
  deepEqual(answers, ["one:", "two:", "three:"], "null is no error")
}

// The credential the transport takes, three fields and a scheme it knows.
deepEqual(jmap.credential("bearer", "ada", "tok"), { scheme: "bearer", username: "ada", secret: "tok" })
deepEqual(jmap.credential("Basic", "ada", "pw"), { scheme: "basic", username: "ada", secret: "pw" })
deepEqual(jmap.credential("none", "", ""), { scheme: "none", username: "", secret: "" })
deepEqual(jmap.credential("", null, undefined), { scheme: "basic", username: "", secret: "" },
  "nothing recorded is Basic, RFC 8620's own credential")
deepEqual(jmap.credential("digest", "a", "b"), { scheme: "basic", username: "a", secret: "b" },
  "a scheme the script would refuse is not sent")

// --------------------------------------------------------------- schemes

// An account that has signed in before starts from the scheme it recorded, so a
// re-verify on a token-only server does not buy a 401 before the token is
// tried. Nothing recorded, or a scheme that is not a credential, is the default.
deepEqual(jmap.schemeOrder("bearer"), ["bearer", "basic"])
deepEqual(jmap.schemeOrder("basic"), ["basic", "bearer"])
deepEqual(jmap.schemeOrder("Bearer "), ["bearer", "basic"], "matched like every other scheme value")
deepEqual(jmap.schemeOrder(""), ["basic", "bearer"])
deepEqual(jmap.schemeOrder("none"), ["basic", "bearer"])
deepEqual(jmap.schemeOrder(undefined), ["basic", "bearer"])


// ------------------------------------------------- the session's addresses
//
// The fixture `test_jmap.js` judges sessions with, repeated here for the rule
// that came after the split.
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

// The session's four addresses are the server's to write and the credential
// goes to every one of them. HTTPS or nothing — the transport refuses anything
// else before curl runs, and this is the same rule at the gate where the
// session is judged, with this client's sentence rather than the script's.
var notHttps = "The server's session names an address that is not HTTPS"
assert.strictEqual(jmap.verifySession(session({ apiUrl: "http://api.example.org/jmap/" })).error, notHttps)
assert.strictEqual(jmap.verifySession(session({ downloadUrl: "file:///etc/passwd?{blobId}" })).error, notHttps)
assert.strictEqual(jmap.verifySession(session({ uploadUrl: "ftp://api.example.org/{accountId}" })).error, notHttps)
assert.strictEqual(jmap.verifySession(session({ eventSourceUrl: "ws://api.example.org/es" })).error, notHttps)
assert.strictEqual(jmap.verifySession(session({ apiUrl: "/jmap/" })).error, notHttps,
  "a relative address is not one this client can send to either")
assert.strictEqual(jmap.verifySession(session({ apiUrl: "HTTPS://API.EXAMPLE.ORG/jmap/" })).error, "",
  "the scheme is judged without regard to case")
assert.strictEqual(jmap.verifySession(session({ eventSourceUrl: "" })).error, "",
  "an address the server did not publish is not a wrong one")
assert.strictEqual(jmap.verifySession(session({ downloadUrl: undefined })).error, "")

// -------------------------------------------------------- the redirect hop

assert.strictEqual(jmap.redirectHop(302, "https://mail.example.org/jmap/session"), "https://mail.example.org/jmap/session")
assert.strictEqual(jmap.redirectHop(302, "https://a:b@mail.example.org/jmap/session"), "",
  "a hop carrying userinfo is not followed: curl would send it as a Basic credential")
assert.strictEqual(jmap.redirectHop(302, "https://mail.example.org/jmap/session?next=a@b"), "https://mail.example.org/jmap/session?next=a@b",
  "an @ past the authority is only a character")

// ---------------------------------------------------- a settled connection
// A connection is believed once it has lasted a whole ping interval. Before
// that a line the server sent says nothing about whether it will keep the
// connection open — a server that answers a comment and closes cleanly gives
// curl exit 0 in sixty milliseconds, and reading that line as a working
// connection reset the backoff and reconnected at once, forever.
assert.strictEqual(jmap.connectionSettled(1000, 31000, 30), true, "a whole interval")
assert.strictEqual(jmap.connectionSettled(1000, 30999, 30), false, "one millisecond short")
assert.strictEqual(jmap.connectionSettled(1000, 1060, 30), false, "the handshake-and-close case")
assert.strictEqual(jmap.connectionSettled(1000, 3600000, 30), true, "an hour")
assert.strictEqual(jmap.connectionSettled(0, 0, 30), false, "the moment it opened")
assert.strictEqual(jmap.connectionSettled(1000, 31000, 0), false, "no interval to measure by")
assert.strictEqual(jmap.connectionSettled(NaN, 31000, 30), false)
assert.strictEqual(jmap.connectionSettled(1000, "soon", 30), false)

console.log("jmap helpers ok")
