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
  "account", "one@gmail.com"
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

// Without a client id there is nothing to look up, and an attribute-free
// lookup would match every token the plugin ever stored.
deepEqual(credentials.keyringAttributes("", "one@gmail.com"), [])
deepEqual(credentials.legacyKeyringAttributes(""), [])

// The old single-account entries carry no "account" attribute, so the new
// lookup cannot see them. They are read once with these and rewritten, rather
// than leaving an already signed-in user at a sign-in button.
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
