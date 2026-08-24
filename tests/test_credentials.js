const assert = require("assert")
const { load, deepEqual } = require("./load")

const credentials = load("providers/Credentials.js")

// ------------------------------------------------------------ client ids

assert.strictEqual(credentials.isValidClientId("1234567890-abcDEF_123.apps.googleusercontent.com"), true)
assert.strictEqual(credentials.isValidClientId("  1234-abc.apps.googleusercontent.com  "), true)
assert.strictEqual(credentials.isValidClientId("1234-abc.example.com"), false)
assert.strictEqual(credentials.isValidClientId("apps.googleusercontent.com"), false)
assert.strictEqual(credentials.isValidClientId(""), false)
assert.strictEqual(credentials.isValidClientId(null), false)

// ------------------------------------------------- the downloaded JSON file
//
// This is the exact shape the Google Cloud console hands out for a Desktop
// app client, so a user can paste the file without editing it first.

const downloaded = JSON.stringify({
  installed: {
    client_id: "1234-abc.apps.googleusercontent.com",
    project_id: "omarchy-gmail-42",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: "GOCSPX-secretvalue",
    redirect_uris: ["http://localhost"]
  }
})

const parsed = credentials.parse(downloaded)
assert.strictEqual(parsed.ok, true)
deepEqual(parsed.credentials, {
  clientId: "1234-abc.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secretvalue",
  projectId: "omarchy-gmail-42"
})

// A Web application client hands back a valid-looking id but can never
// complete the loopback flow, so it is refused at paste time rather than at
// the end of a failed sign-in.
const web = credentials.parse(JSON.stringify({
  web: { client_id: "1234-abc.apps.googleusercontent.com", client_secret: "x" }
}))
assert.strictEqual(web.ok, false)
assert.strictEqual(web.error, "That is a Web application client. Create a Desktop app client instead")

assert.strictEqual(credentials.parse("{not json").error, "That is not valid JSON")
assert.strictEqual(credentials.parse(JSON.stringify({ installed: {} })).ok, false)
assert.strictEqual(credentials.parse("").ok, false)

// ------------------------------------------------------------ typed by hand

const typed = credentials.parse("1234-abc.apps.googleusercontent.com\nGOCSPX-typed")
assert.strictEqual(typed.ok, true)
assert.strictEqual(typed.credentials.clientId, "1234-abc.apps.googleusercontent.com")
assert.strictEqual(typed.credentials.clientSecret, "GOCSPX-typed")

// The secret is genuinely optional: Google only requires it for some client
// types, and a user who pastes just the id should get a working setup.
const idOnly = credentials.parse("  1234-abc.apps.googleusercontent.com  ")
assert.strictEqual(idOnly.ok, true)
assert.strictEqual(idOnly.credentials.clientSecret, "")

assert.strictEqual(credentials.parse("hello world").ok, false)
assert.ok(credentials.parse("hello world").error.indexOf(".apps.googleusercontent.com") > 0)

// ----------------------------------------------------------- round tripping

const serialized = credentials.serialize(parsed.credentials)
// The payload crosses a line-oriented pipe into credentials-store.sh, whose
// `read` stops at the first newline. Anything multi-line arrives truncated.
assert.ok(serialized.indexOf("\n") < 0, "the serialized client must be one line")
const reloaded = credentials.load(serialized)
deepEqual(reloaded, parsed.credentials)
assert.strictEqual(JSON.parse(serialized).installed.client_id, "1234-abc.apps.googleusercontent.com")

deepEqual(credentials.load(""), { clientId: "", clientSecret: "", projectId: "" })
deepEqual(credentials.load("garbage"), { clientId: "", clientSecret: "", projectId: "" })

assert.strictEqual(credentials.isConfigured(parsed.credentials), true)
assert.strictEqual(credentials.isConfigured(credentials.empty()), false)
assert.strictEqual(credentials.isConfigured(null), false)

// ---------------------------------------------------------------- display

assert.strictEqual(credentials.describe(parsed.credentials), "omarchy-gmail-42 · 1234")
assert.strictEqual(credentials.describe(credentials.empty()), "")
assert.strictEqual(
  credentials.path("/home/jason"), "/home/jason/.config/omamail/credentials.json")

// -------------------------------------------------------- built-in client
//
// Shipping a client is a one-constant change once the project passes Google's
// OAuth verification. Until then BUILTIN is empty on purpose: an unverified
// project is stuck in "Testing", where refresh tokens expire after seven days,
// so a shipped client would sign every user out weekly.

assert.strictEqual(credentials.hasBuiltin(), false, "no client is shipped yet")
deepEqual(credentials.builtin(), { clientId: "", clientSecret: "", projectId: "" })

// With no built-in and no file, there is nothing to sign in with.
deepEqual(credentials.effective(""), { clientId: "", clientSecret: "", projectId: "" })
assert.strictEqual(credentials.usingBuiltin(""), false)

// The user's own client always wins over anything shipped: someone who made
// one wants their own quota and their own consent screen.
deepEqual(credentials.effective(serialized), parsed.credentials)
assert.strictEqual(credentials.usingBuiltin(serialized), false)

// Simulate the post-verification state by filling the constant the same way a
// release would, and check the fallback actually engages.
credentials.BUILTIN.clientId = "999-shipped.apps.googleusercontent.com"
credentials.BUILTIN.clientSecret = "GOCSPX-shipped"
assert.strictEqual(credentials.hasBuiltin(), true)
assert.strictEqual(credentials.effective("").clientId, "999-shipped.apps.googleusercontent.com")
assert.strictEqual(credentials.usingBuiltin(""), true)
assert.strictEqual(credentials.effective(serialized).clientId, parsed.credentials.clientId,
  "a user's own client still wins once one exists")
assert.strictEqual(credentials.usingBuiltin(serialized), false)
credentials.BUILTIN.clientId = ""
credentials.BUILTIN.clientSecret = ""


// ------------------------------------------------------ keyring attributes
//
// A Cloud OAuth client belongs to a project, not to a mailbox, so two accounts
// may legitimately run on one. Keyed by client id alone, the second sign-in
// would overwrite the first account's refresh token and silently sign it out.

const sharedClient = "1234-abc.apps.googleusercontent.com"
const first = credentials.keyringAttributes(sharedClient, "one@gmail.com")
const second = credentials.keyringAttributes(sharedClient, "two@gmail.com")

deepEqual(first, [
  "service", "omamail",
  "kind", "refresh-token",
  "client-id", sharedClient,
  "account", "one@gmail.com",
  "grant", "calendar-events-v1"
])
assert.notStrictEqual(JSON.stringify(first), JSON.stringify(second),
  "two accounts on one client must not share a keyring entry")

// The lookup runs on every session restore; an attribute set that drifts
// between calls would look exactly like a signed-out account.
deepEqual(credentials.keyringAttributes(sharedClient, "one@gmail.com"), first)
deepEqual(credentials.keyringAttributes(sharedClient, "  One@Gmail.com  "), first,
  "the same mailbox typed differently is the same account")

// secret-tool reads an empty attribute value as a wildcard, which would match
// some other account's token, so no value may ever be blank.
const attributeSets = [
  first,
  second,
  credentials.keyringAttributes(sharedClient, ""),
  credentials.keyringAttributes(sharedClient, null),
  credentials.legacyKeyringAttributes(sharedClient)
]
for (const attributes of attributeSets) {
  assert.strictEqual(attributes.length % 2, 0, "attributes are name, value pairs")
  assert.ok(attributes.length > 0)
  for (const value of attributes) {
    assert.strictEqual(typeof value, "string")
    assert.ok(value.length > 0, "an empty attribute value is a secret-tool wildcard")
  }
}
assert.strictEqual(credentials.keyringAttributes(sharedClient, "").indexOf("default") > 0, true,
  "an account with no name yet still gets a literal account attribute")

deepEqual(credentials.previousGrantKeyringAttributes(sharedClient, "one@gmail.com"), [
  "service", "omamail",
  "kind", "refresh-token",
  "client-id", sharedClient,
  "account", "one@gmail.com"
])

// Without a client id there is nothing to look up, and an attribute-free
// lookup would match every token the plugin ever stored.
deepEqual(credentials.keyringAttributes("", "one@gmail.com"), [])
deepEqual(credentials.legacyKeyringAttributes(""), [])

// The old single-account entries carry no account or grant attribute. The
// upgrade detects them separately and asks Google for Calendar permission.
deepEqual(credentials.legacyKeyringAttributes(sharedClient), [
  "service", "omamail",
  "kind", "refresh-token",
  "client-id", sharedClient
])
assert.strictEqual(credentials.legacyKeyringAttributes(sharedClient).indexOf("account"), -1)

deepEqual(credentials.renamedKeyringAttributes(sharedClient, "one@gmail.com"), [
  "service", "omarchy-gmail",
  "kind", "refresh-token",
  "client-id", sharedClient,
  "account", "one@gmail.com"
])
deepEqual(credentials.renamedLegacyKeyringAttributes(sharedClient), [
  "service", "omarchy-gmail",
  "kind", "refresh-token",
  "client-id", sharedClient
])

// A rejected token must be cleared from the exact lookup stage that produced
// it. Clearing only the canonical entry leaves a legacy token to be found and
// rejected again on every restart.
deepEqual(credentials.refreshTokenAttributes(sharedClient, "me@example.com", 0),
  credentials.keyringAttributes(sharedClient, "me@example.com"))
deepEqual(credentials.refreshTokenAttributes(sharedClient, "me@example.com", 1),
  credentials.previousGrantKeyringAttributes(sharedClient, "me@example.com"))
deepEqual(credentials.refreshTokenAttributes(sharedClient, "me@example.com", 2),
  credentials.legacyKeyringAttributes(sharedClient))
deepEqual(credentials.refreshTokenAttributes(sharedClient, "me@example.com", 3),
  credentials.renamedKeyringAttributes(sharedClient, "me@example.com"))
deepEqual(credentials.refreshTokenAttributes(sharedClient, "me@example.com", 4),
  credentials.renamedLegacyKeyringAttributes(sharedClient))

// --------------------------------------------- looking before the leap
//
// Why the legacy read counts before it asks is in Credentials.js. What it has
// to get right is here: two mailboxes on one Cloud client, where the wildcard
// over "account" matches both.

function recordLines(count) {
  var lines = []
  for (var i = 0; i < count; i++) {
    lines.push("[/" + (i + 10) + "]")
    lines.push("label = Omamail refresh token")
    lines.push("secret = token-" + i)
    lines.push("created = 2026-08-21 13:01:00")
    lines.push("modified = 2026-08-21 13:01:00")
    lines.push("schema = org.freedesktop.Secret.Generic")
  }
  return lines
}

function attributeLines(accounts) {
  var lines = []
  for (var i = 0; i < accounts.length; i++) {
    lines.push("attribute.service = omamail")
    lines.push("attribute.kind = refresh-token")
    lines.push("attribute.client-id = " + sharedClient)
    if (accounts[i] !== null) lines.push("attribute.account = " + accounts[i])
  }
  return lines
}

// The counting the QML does, line by line, so it is never holding a stream of
// secrets to count.
function countWith(predicate, lines) {
  var found = 0
  for (var i = 0; i < lines.length; i++) {
    if (predicate(lines[i])) found++
  }
  return found
}

function searchFound(records, accounts) {
  return credentials.hasLoneLegacyEntry(
    countWith(credentials.isKeyringMatchLine, recordLines(records)),
    countWith(credentials.isKeyringAttributedLine, attributeLines(accounts)),
    countWith(credentials.isKeyringNamedLine, attributeLines(accounts)))
}

assert.strictEqual(searchFound(1, [null]), true,
  "one match, and no account attribute in it, is the entry the legacy read is for")

// The regression. Both matches answer the legacy lookup and neither is this
// account's to take.
assert.strictEqual(searchFound(2, ["one@gmail.com", "two@gmail.com"]), false,
  "two mailboxes on one client are not a legacy entry")
assert.strictEqual(searchFound(1, ["one@gmail.com"]), false,
  "a single named mailbox is not one either")

// A nameless entry beside named ones: which one the lookup answers with cannot
// be asked, so it is left where it is.
assert.strictEqual(searchFound(2, [null, "two@gmail.com"]), false,
  "a legacy entry with named siblings is ambiguous, and ambiguous is refused")

// The stand-in a mailbox with no address yet is stored under has an "account"
// attribute and still no name, so it stays adoptable. Reading it once is what
// an install from before the hold on unnamed tokens needs.
assert.strictEqual(searchFound(1, ["default"]), true,
  "the literal stand-in is not a named mailbox")
assert.strictEqual(searchFound(2, ["default", "two@gmail.com"]), false,
  "the stand-in beside a named mailbox is ambiguous like any other")

// The stand-in is the whole literal value and nothing else. An address that
// merely starts with it, or differs in case, is a mailbox with a name: read
// any looser, this is the line that makes a real account look nameless and
// hands its token to another one.
assert.strictEqual(credentials.isKeyringNamedLine("attribute.account = default"), false)
assert.strictEqual(credentials.isKeyringNamedLine("attribute.account = default@x.com"), true)
assert.strictEqual(credentials.isKeyringNamedLine("attribute.account = defaults"), true)
assert.strictEqual(credentials.isKeyringNamedLine("attribute.account = Default"), true)
assert.strictEqual(credentials.isKeyringNamedLine("attribute.account = "), true)

assert.strictEqual(credentials.hasLoneLegacyEntry(0, 0, 0), false, "no match is not an entry")

// Fail closed on a stream that says nothing about the match it belongs to. An
// attribute that was never read is not an attribute that is absent, and the
// difference between the two is whose mailbox opens.
assert.strictEqual(credentials.hasLoneLegacyEntry(1, 0, 0), false,
  "an attribute stream that accounts for no match is not an account-less entry")

// Neither stream may be read as the other's: the record lines carry no
// attributes, and the attribute lines carry no records.
assert.strictEqual(countWith(credentials.isKeyringMatchLine, recordLines(3)), 3)
assert.strictEqual(countWith(credentials.isKeyringMatchLine, attributeLines([null, null])), 0)
assert.strictEqual(countWith(credentials.isKeyringAttributedLine, recordLines(1)), 0)
assert.strictEqual(countWith(credentials.isKeyringNamedLine, recordLines(2)), 0)

// ------------------------------------------------------------ the store
//
// The file written before accounts existed holds one client in the console's
// own shape. It has to keep loading, as a single unnamed account.

const legacyStore = credentials.loadStore(serialized)
deepEqual(credentials.accountIds(legacyStore), [""])
deepEqual(credentials.forAccount(legacyStore, ""), parsed.credentials)
// The account learns its own address only after a sign-in, which needs the
// client this file already holds. Refusing to match it would ask a working
// install to set its client up again.
deepEqual(credentials.forAccount(legacyStore, "one@gmail.com"), parsed.credentials)
deepEqual(credentials.load(serialized, "one@gmail.com"), parsed.credentials)

deepEqual(credentials.loadStore(""), { accounts: [] })
deepEqual(credentials.loadStore("garbage"), { accounts: [] })
deepEqual(credentials.forAccount(credentials.emptyStore(), "one@gmail.com"), credentials.empty())

// One client, two mailboxes, plus a second project of its own: the shape the
// keyring scheme above exists for.
let store = credentials.emptyStore()
store = credentials.withAccount(store, "one@gmail.com", {
  clientId: sharedClient, clientSecret: "GOCSPX-shared", projectId: "omarchy-gmail-42"
})
store = credentials.withAccount(store, "two@gmail.com", {
  clientId: sharedClient, clientSecret: "GOCSPX-shared", projectId: "omarchy-gmail-42"
})
store = credentials.withAccount(store, "three@work.com", {
  clientId: "5678-work.apps.googleusercontent.com", clientSecret: "GOCSPX-work", projectId: "work-99"
})

const storedText = credentials.serialize(store)
assert.ok(storedText.indexOf("\n") < 0, "the serialized store must be one line")
assert.strictEqual(JSON.parse(storedText).accounts.length, 3)
assert.strictEqual(JSON.parse(storedText).accounts[0].installed.client_secret, "GOCSPX-shared")

const roundTripped = credentials.loadStore(storedText)
deepEqual(credentials.accountIds(roundTripped), ["one@gmail.com", "two@gmail.com", "three@work.com"])
deepEqual(roundTripped, store)
deepEqual(credentials.forAccount(roundTripped, "three@work.com"), {
  clientId: "5678-work.apps.googleusercontent.com",
  clientSecret: "GOCSPX-work",
  projectId: "work-99"
})
deepEqual(credentials.load(storedText, "two@gmail.com"), credentials.forAccount(store, "two@gmail.com"))
deepEqual(credentials.effective(storedText, "three@work.com"), credentials.forAccount(store, "three@work.com"))

// Naming every account rules out the pre-accounts fallback: an id nobody has
// heard of is a missing account, not the first one in the list.
deepEqual(credentials.forAccount(roundTripped, "nobody@gmail.com"), credentials.empty())
deepEqual(credentials.load(storedText, ""), credentials.empty())

// Two accounts on one client each keep their own token.
assert.notStrictEqual(
  JSON.stringify(credentials.keyringAttributes(credentials.forAccount(store, "one@gmail.com").clientId, "one@gmail.com")),
  JSON.stringify(credentials.keyringAttributes(credentials.forAccount(store, "two@gmail.com").clientId, "two@gmail.com")))

// Saving a client again for an account it already has must not shuffle the
// panel's order.
const rewritten = credentials.withAccount(store, "one@gmail.com", {
  clientId: sharedClient, clientSecret: "GOCSPX-rotated", projectId: "omarchy-gmail-42"
})
deepEqual(credentials.accountIds(rewritten), ["one@gmail.com", "two@gmail.com", "three@work.com"])
assert.strictEqual(credentials.forAccount(rewritten, "one@gmail.com").clientSecret, "GOCSPX-rotated")

// A lone unnamed account is still written in the console's shape, so the file
// stays interchangeable with a downloaded one and an older build still reads
// it. Only a named or a second account promotes the file.
const singleText = credentials.serialize(
  credentials.withAccount(credentials.emptyStore(), "", parsed.credentials))
assert.strictEqual(singleText, serialized)

// A hand-edited entry loses that account, not every other one.
const damaged = credentials.loadStore(JSON.stringify({
  version: 2,
  accounts: [
    { id: "one@gmail.com", installed: { client_id: "nonsense" } },
    { id: "three@work.com", installed: { client_id: "5678-work.apps.googleusercontent.com" } }
  ]
}))
deepEqual(credentials.accountIds(damaged), ["three@work.com"])


// Adding a second mailbox must not send the user back through the Google Cloud
// walkthrough: a client belongs to the project, not to the address.
{
  var shared = credentials.withAccount(credentials.emptyStore(), "one@gmail.com",
    { clientId: "111-a.apps.googleusercontent.com", clientSecret: "s1" })
  var text = credentials.serialize(shared)
  assert.strictEqual(credentials.effective(text, "two@gmail.com").clientId,
    "111-a.apps.googleusercontent.com", "a new account borrows the configured client")
  assert.strictEqual(credentials.effective(text, "").clientId,
    "111-a.apps.googleusercontent.com", "a pending account borrows it too")
  assert.strictEqual(credentials.effective(text, "two@gmail.com").clientSecret, "s1")

  var own = credentials.withAccount(shared, "two@gmail.com",
    { clientId: "222-b.apps.googleusercontent.com", clientSecret: "s2" })
  assert.strictEqual(credentials.effective(credentials.serialize(own), "two@gmail.com").clientId,
    "222-b.apps.googleusercontent.com", "an account with its own client keeps it")

  assert.strictEqual(credentials.effective("", "x@y.com").clientId, "",
    "nothing configured stays nothing")
}

console.log("test_credentials.js ok")
