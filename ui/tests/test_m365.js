const assert = require("assert")
const { load, deepEqual } = require("./load")

const M365 = load("providers/M365Protocol.js")
const Registry = load("providers/Registry.js")
const Accounts = load("account/Accounts.js")
const Model = load("account/Model.js")

// ------------------------------------------------- what the backend says

// Every code the backend answers with has a sentence of its own, said plainly:
// no code, protocol, header or status reaches a person.
const CODES = ["auth_account_missing", "auth_keyring_failed", "backend_needs_update", "credential_store_unavailable",
  "m365_access_denied", "m365_attachment_not_found", "m365_auth_failed", "m365_bad_response", "m365_cancelled",
  "m365_consent_required", "m365_declined", "m365_draft_unconfirmed", "m365_expired", "m365_folder_unavailable",
  "m365_invalid_request",
  "m365_invalid_response", "m365_message_not_found", "m365_message_too_large",
  "m365_network_failed", "m365_not_a_draft", "m365_request_limit", "m365_response_too_large", "m365_send_failed",
  "m365_send_not_attempted", "m365_send_rejected", "m365_server_error", "m365_signed_out", "m365_tenant_invalid",
  "m365_throttled", "m365_timeout", "m365_tls_failed", "m365_wrong_account", "request_timed_out"]
{
  const seen = new Set()
  for (const code of CODES) {
    const text = M365.sentence({ message: code })
    assert.ok(text !== M365.GENERIC && text.length > 0, code + " has its own sentence")
    assert.strictEqual(M365.sentence(code), text, "a bare string is read like an error's message")
    assert.ok(!/m365_|HTTP|\b[45]\d\d\b|IMAP|SMTP|MIME|Graph/.test(text), code + " is said plainly: " + text)
    seen.add(code)
  }
  assert.strictEqual(seen.size, CODES.length)
  deepEqual(Object.keys(M365.SENTENCES).sort(), CODES, "no sentence is for a code nobody sends")
  for (const odd of ["", "m365_no_such_code", undefined, null, { message: "oops" }, { code: -32000 }, 42, "toString"])
    assert.strictEqual(M365.sentence(odd), M365.GENERIC, "an unknown code is the generic sentence: " + odd)
}
{
  const consent = M365.sentence("m365_consent_required")
  assert.ok(/administrator/.test(consent) && /private window/.test(consent), consent)
  assert.ok(/Sign in/.test(M365.sentence("m365_declined")) && /Sign in/.test(M365.sentence("m365_expired")))
  assert.ok(/Application \(client\) ID/.test(M365.sentence("m365_auth_failed")))
}

// A wrong account names the one Microsoft reported, as bounded plain text.
{
  const named = M365.failureSentence("m365_wrong_account", "ada@other.example.org", "jane@corp.example.test")
  assert.ok(named.includes("ada@other.example.org") && named.includes("jane@corp.example.test"), named)
  assert.strictEqual(M365.failureSentence("m365_wrong_account", "", "x@y.test"), M365.sentence("m365_wrong_account"))
  assert.strictEqual(M365.failureSentence("m365_timeout", "ada", "x@y.test"), M365.sentence("m365_timeout"))
  const poll = M365.pollResult({ state: "failed", error: "m365_wrong_account", signedInAs: "A\u202eB\n" + "x".repeat(200) })
  assert.ok(poll.who.length <= 80 && !/[\u202e\n]/.test(poll.who), poll.who)
}

// Which failures end a session, which mean nothing is saved yet, and which pass.
for (const [code, signedOut, nothing, transient] of [
  ["m365_signed_out", true, true, false], ["auth_account_missing", false, true, false],
  ["m365_network_failed", false, false, true], ["m365_timeout", false, false, true],
  ["request_timed_out", false, false, true], ["m365_throttled", false, false, true],
  ["m365_server_error", false, false, true], ["m365_request_limit", false, false, true],
  ["m365_bad_response", false, false, true], ["auth_keyring_failed", false, false, true],
  ["m365_access_denied", false, false, false],
  ["m365_consent_required", false, false, false], ["m365_auth_failed", false, false, false]]) {
  const error = { code: -32000, message: code }
  assert.strictEqual(M365.isSignedOut(error), signedOut, code)
  assert.strictEqual(M365.isNothingSaved(error), nothing, code)
  assert.strictEqual(M365.isTransient(error), transient, code)
}

// A keyring that is locked hides a saved sign-in, which unlocking it brings back;
// a sign-in that could not be saved there has to be done again.
assert.ok(/Unlock/.test(M365.sentence("auth_keyring_failed")) && !/sign in again/i.test(M365.sentence("auth_keyring_failed")))
assert.ok(/could not be saved/.test(M365.failureSentence("auth_keyring_failed", "", "x@y.test")))

// A sign-out that could not wait for the sign-in may not have been done; any other
// failure says the saved sign-in could not be removed, and why.
assert.ok(/could not be completed/.test(M365.signOutFailure({ message: "m365_timeout" })))
assert.strictEqual(M365.signOutFailure({ message: "auth_keyring_failed" }),
  "The saved sign-in could not be removed. " + M365.sentence("auth_keyring_failed"))

// A draft whose save was not confirmed may be in Drafts already.
assert.ok(/may already be in Drafts/.test(M365.sentence("m365_draft_unconfirmed")))

// Too large is a message too large to send, whether Omamail or Microsoft said so
// (the sentence names neither), or a message too large to open.
for (const method of ["m365.send", "m365.saveDraft"]) {
  const tooLarge = M365.requestSentence(method, {}, { message: "m365_message_too_large" })
  assert.ok(/too large to send/.test(tooLarge) && !/refused/.test(tooLarge), method + ": " + tooLarge)
}
for (const method of ["m365.read", "m365.messages", "m365.attachment"])
  assert.ok(/larger than Omamail opens/.test(M365.requestSentence(method, {}, { message: "m365_message_too_large" })), method)

// A poll whose answer was lost, or which is still at Microsoft's or the keyring's,
// may leave a sign-in saved; one answered otherwise has said what it did, and a
// token request that timed out (`m365_timeout`) saved nothing.
for (const lost of ["request_timed_out", "Backend request timed out", "Backend response timed out",
  "Backend stopped", "Invalid backend response"])
  assert.strictEqual(M365.isLostAnswer({ code: -32010, message: lost }), true, lost)
for (const other of ["m365_timeout", "Backend unavailable", "m365_network_failed", ""])
  assert.strictEqual(M365.isLostAnswer({ message: other }), false, other)
for (const [result, failure, saved] of [
  [{ state: "signedIn" }, null, true], [{ state: "pending", warning: "m365_exchange_running" }, null, true],
  [{ state: "pending", warning: "m365_timeout" }, null, false],
  [{ state: "pending" }, null, false], [{ state: "pending", warning: "m365_network_failed" }, null, false],
  [{ state: "declined" }, null, false], [null, { message: "request_timed_out" }, true],
  [null, { message: "Backend response timed out" }, true], [null, { message: "Backend stopped" }, true],
  [null, { message: "Invalid backend response" }, true],
  [null, { message: "m365_invalid_request" }, false], [null, { message: "Backend unavailable" }, false]])
  assert.strictEqual(M365.pollMayHaveSaved(result, failure), saved, JSON.stringify([result, failure]))

// A search that is only quotes or operators comes back as Invalid params.
assert.strictEqual(M365.requestSentence("m365.list", { query: "text:\"" }, { code: -32602, message: "Invalid params" }),
  "That search has nothing Microsoft 365 can look for")
assert.strictEqual(M365.requestSentence("m365.list", { query: "role:inbox" }, { code: -32602, message: "Invalid params" }),
  M365.GENERIC, "only a typed search is told as an empty one")
assert.strictEqual(M365.requestSentence("m365.modify", { query: "text:x" }, { message: "m365_throttled" }),
  M365.sentence("m365_throttled"))

// ------------------------------------------------------------ the gate

assert.strictEqual(M365.MIN_API_VERSION, 8)
assert.strictEqual(M365.backendProblem({ ready: true, apiVersion: 8 }), "")
assert.strictEqual(M365.backendProblem({ ready: true }), "", "a stand-in that states no version is taken at its word")
assert.strictEqual(M365.backendProblem({ ready: true, apiVersion: 7 }), M365.sentence("backend_needs_update"))
assert.ok(/unavailable/.test(M365.backendProblem({ ready: false, apiVersion: 8 })))
assert.ok(M365.backendProblem(null) !== "")

// ------------------------------------------------------- the device sign-in

const begun = { requestId: "0123456789abcdef", userCode: "ABCD1234E", verificationUri: "https://microsoft.com/devicelogin",
  interval: 5 }
deepEqual(M365.beginResult(Object.assign({ expiresIn: 900 }, begun)), begun)
for (const [given, interval] of [[0, 5], ["soon", 5], [0.4, 5], [-3, 5], [1, 1], [7, 7], [500, 30]])
  assert.strictEqual(M365.beginResult(Object.assign({}, begun, { interval: given })).interval, interval, "interval " + given)
for (const bad of [{ userCode: "AB" }, { userCode: "A".repeat(33) }, { userCode: "ABCD 1234" }, { userCode: "<b>x</b>" },
  { userCode: "" }, { requestId: "" }, { requestId: "x\ny" }, { requestId: "x".repeat(257) },
  { verificationUri: "http://microsoft.com/devicelogin" }, { verificationUri: "https://evil.example/devicelogin" },
  { verificationUri: "https://microsoft.com.evil.example/devicelogin" }, { verificationUri: "" }, { verificationUri: undefined }])
  assert.strictEqual(M365.beginResult(Object.assign({}, begun, bad)), null, "unusable: " + JSON.stringify(bad))
for (const bad of [null, undefined, "text", 3, []]) assert.strictEqual(M365.beginResult(bad), null)

for (const [answer, expected] of [
  [{ state: "pending" }, { state: "pending", code: "", who: "" }],
  [{ state: "pending", warning: "m365_network_failed" }, { state: "pending", code: "", who: "" }],
  [{ state: "signedIn" }, { state: "signedIn", code: "", who: "" }],
  [{ state: "declined" }, { state: "declined", code: "m365_declined", who: "" }],
  [{ state: "expired" }, { state: "expired", code: "m365_expired", who: "" }],
  [{ state: "failed", error: "m365_consent_required" }, { state: "failed", code: "m365_consent_required", who: "" }],
  [{ state: "failed", error: "m365_tenant_invalid" }, { state: "failed", code: "m365_tenant_invalid", who: "" }],
  [{ state: "failed" }, { state: "failed", code: "m365_auth_failed", who: "" }],
  [{ state: "failed", error: "unheard_of" }, { state: "failed", code: "m365_auth_failed", who: "" }],
  [{ state: "failed", error: "m365_wrong_account", signedInAs: "Ada" }, { state: "failed", code: "m365_wrong_account", who: "Ada" }],
  [{ state: "done" }, { state: "failed", code: "m365_invalid_response", who: "" }],
  [{ state: "" }, { state: "failed", code: "m365_invalid_response", who: "" }],
  [{}, { state: "failed", code: "m365_invalid_response", who: "" }],
  [null, { state: "failed", code: "m365_invalid_response", who: "" }],
  ["pending", { state: "failed", code: "m365_invalid_response", who: "" }]])
  deepEqual(M365.pollResult(answer), expected, JSON.stringify(answer))

// -------------------------------------------------- what a check taught us

const checked = { ok: true, email: "jane@corp.example.test", displayName: "", scheme: "oauth", serverVersion: "",
  roles: { inbox: { total: 4, unread: 2 }, sent: { total: 1, unread: 0 }, drafts: { total: 0, unread: 0 },
    trash: { total: 0, unread: 0 }, junk: null, archive: { total: 9, unread: 0 } }, refusals: {}, learned: {} }
assert.strictEqual(M365.verified(checked), true)
for (const bad of [null, {}, "ok", { ok: "true" }, { ok: false, roles: {} }]) assert.strictEqual(M365.verified(bad), false)
deepEqual(M365.absentMailboxes(checked), ["spam"], "a mailbox without Junk draws no Junk row")
deepEqual(M365.absentMailboxes({ ok: true, roles: { archive: null, junk: {}, trash: null } }), ["archive", "trash"])
deepEqual(M365.absentMailboxes({ ok: true, roles: {} }), ["archive", "spam", "trash"])
assert.strictEqual(M365.absentMailboxes({ ok: true }), null, "no roles said, nothing hidden")
assert.strictEqual(M365.absentMailboxes(null), null)
assert.strictEqual(M365.absentMailboxes({ ok: false, roles: { archive: null } }), null, "a failed check teaches nothing")
deepEqual(M365.refusals(checked), {})
deepEqual(M365.refusals(Object.assign({}, checked, { refusals: { send: "No Sent folder", archive: "", star: null, junk: false } })),
  { send: "No Sent folder", archive: "This mailbox cannot do that" })
assert.strictEqual(M365.refusals(null), null)
assert.strictEqual(M365.refusals({ ok: false, refusals: { send: "x" } }), null)
assert.ok(M365.refusals(Object.assign({}, checked, { refusals: { send: "a\nb\u202e" + "x".repeat(500) } })).send.length <= 300)
assert.ok(!/[\n\u202e]/.test(M365.refusals(Object.assign({}, checked, { refusals: { send: "a\nb\u202e" } })).send))

// ------------------------------------------------ the provider and its place

const m365 = Registry.get("m365")
assert.strictEqual(m365.name, "Microsoft 365")
assert.strictEqual(Registry.authKind("m365"), "oauth")
assert.strictEqual(Registry.nativeSync("m365"), true)
assert.strictEqual(Registry.mark("m365"), "outlook.svg")
assert.strictEqual(Registry.webHomeUrl("m365"), "")
deepEqual(Object.keys(m365.capabilities).filter(name => m365.capabilities[name]).sort(),
  ["archive", "batch", "search", "send", "star"], "the ceiling is archive, star, batch, search and send")
deepEqual(m365.mailboxes.map(box => [box.key, box.query, box.optional]), [
  ["inbox", "role:inbox", false], ["unread", "role:inbox unseen", false], ["starred", "role:inbox flagged", false],
  ["drafts", "role:drafts", false], ["sent", "role:sent", false], ["archive", "role:archive", true],
  ["spam", "role:junk", true], ["trash", "role:trash", true]])
deepEqual(Registry.mailboxes("m365", M365.absentMailboxes(checked)).map(box => box.key),
  ["inbox", "unread", "starred", "drafts", "sent", "archive", "trash"])
assert.strictEqual(Registry.can("m365", "archive", {}), true)
assert.strictEqual(Registry.can("m365", "archive", { archive: "No Archive folder" }), false, "an account may withdraw Archive")
assert.strictEqual(Registry.can("m365", "labels", {}), false)
assert.strictEqual(Registry.can("m365", "spam", {}), false)

// ------------------------------------------------ the account and its calendar

assert.strictEqual(Accounts.normalizeProvider("M365"), "m365")
assert.strictEqual(Accounts.accountId(" Jane@Corp.Example.test ", "m365"), "m365:jane@corp.example.test")
assert.strictEqual(Accounts.calendarProvider({ provider: "m365", email: "jane@corp.example.test" }), "microsoft")
{
  const entry = Accounts.makeAccount({ provider: "m365", email: "jane@corp.example.test",
    clientId: "11111111-2222-3333-4444-555555555555" })
  assert.strictEqual(entry.provider, "m365")
  assert.strictEqual(entry.clientId, "11111111-2222-3333-4444-555555555555", "the ID is configuration, kept like Outlook's")
  assert.strictEqual(entry.clientSecret, "")
}
// The setup card speaks of Microsoft, not of a Cloud project.
for (const [state, text] of [["no_credentials", /Add this Microsoft 365 mailbox/], ["signing_in", /Waiting for Microsoft/],
  ["signed_out", /Sign in to Microsoft 365/]])
  assert.ok(text.test(Model.setupHeadline(state, "Microsoft 365", "oauth")), state)
assert.ok(/Application \(client\) ID/.test(Model.setupDetail("no_credentials", [], "", "Microsoft 365", "oauth")))
assert.strictEqual(Model.setupHeadline("no_credentials", "Outlook", "oauth"), "Add this Outlook mailbox")
assert.ok(/Microsoft public-client ID/.test(Model.setupDetail("no_credentials", [], "", "Outlook", "oauth")), "Outlook's words stay")
// Which sign-in is Microsoft's is the registry's to say, not the name's.
assert.strictEqual(Registry.named("Microsoft 365"), "m365")
assert.strictEqual(Registry.signsInWithMicrosoft("m365") && Registry.signsInWithMicrosoft("outlook"), true)
assert.strictEqual(Registry.signsInWithMicrosoft("gmail") || Registry.signsInWithMicrosoft(Registry.named("Nobody")), false)
assert.strictEqual(Model.setupHeadline("no_credentials", "Gmail", "oauth"), "Connect a Google Cloud project")

// The Application (client) ID is saved and sent in the spelling the backend keys a
// sign-in by, and this provider has no built-in one of its own (nor Outlook's).
assert.strictEqual(M365.BUILTIN_CLIENT_ID, undefined)
assert.strictEqual(M365.clientId(" 11111111-AAAA-3333-4444-55555555555F "), "11111111-aaaa-3333-4444-55555555555f")
for (const bad of ["", "not-a-guid", null, undefined, "11111111-2222-3333-4444-5555555555555"])
  assert.strictEqual(M365.clientId(bad), "", String(bad))
console.log("m365 ok")
