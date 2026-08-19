const assert = require("assert")
const { load, deepEqual } = require("./load")

const credentials = load("Credentials.js")

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
  credentials.path("/home/jason"), "/home/jason/.config/omarchy-gmail/credentials.json")

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

console.log("test_credentials.js ok")
