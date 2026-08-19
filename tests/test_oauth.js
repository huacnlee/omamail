const assert = require("assert")
const { load, deepEqual } = require("./load")

const oauth = load("OAuth.js")

// ------------------------------------------------------------------ ports
//
// The port is user-editable in plugin settings, so anything outside the
// unprivileged range has to fall back rather than fail at listen time.

assert.strictEqual(oauth.normalizedPort(9481), 9481)
assert.strictEqual(oauth.normalizedPort("9481"), 9481)
assert.strictEqual(oauth.normalizedPort(80), 9481, "privileged ports fall back")
assert.strictEqual(oauth.normalizedPort(70000), 9481)
assert.strictEqual(oauth.normalizedPort(""), 9481)
assert.strictEqual(oauth.normalizedPort(null), 9481)
assert.strictEqual(oauth.redirectUri(9481), "http://127.0.0.1:9481/oauth2callback")
assert.strictEqual(oauth.redirectUri(0), "http://127.0.0.1:9481/oauth2callback")

// ------------------------------------------------------- authorization URL

const url = oauth.authorizationUrl({
  clientId: "123-abc.apps.googleusercontent.com",
  challenge: "CHALLENGE",
  state: "STATE",
  port: 9481
})

assert.ok(url.indexOf("https://accounts.google.com/o/oauth2/v2/auth?") === 0)
assert.ok(url.indexOf("code_challenge_method=S256") > 0)
assert.ok(url.indexOf("access_type=offline") > 0)
// Without prompt=consent Google issues a refresh token only on the very first
// authorization, so a reinstall would leave the plugin unable to stay signed in.
assert.ok(url.indexOf("prompt=consent") > 0)
assert.ok(url.indexOf("redirect_uri=http%3A%2F%2F127.0.0.1%3A9481%2Foauth2callback") > 0)
assert.ok(url.indexOf("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify%20") > 0)
assert.ok(url.indexOf("login_hint") < 0, "an absent hint is omitted, not sent empty")

const hinted = oauth.authorizationUrl({
  clientId: "123-abc.apps.googleusercontent.com",
  challenge: "C", state: "S", loginHint: "user@example.com"
})
assert.ok(hinted.indexOf("login_hint=user%40example.com") > 0)

// --------------------------------------------------------------- callback

const good = oauth.parseCallbackRequestLine(
  "GET /oauth2callback?code=4/0AY0e&state=abc123 HTTP/1.1", "/oauth2callback")
deepEqual(good, { ok: true, code: "4/0AY0e", state: "abc123" })

const denied = oauth.parseCallbackRequestLine(
  "GET /oauth2callback?error=access_denied&state=abc HTTP/1.1", "/oauth2callback")
assert.strictEqual(denied.ok, false)
assert.strictEqual(denied.error, "Google sign-in was cancelled")
assert.strictEqual(denied.state, "abc")

// A browser that prefetches favicon.ico on the callback port must not be
// mistaken for the callback and must not consume the single-shot listener.
const wrongPath = oauth.parseCallbackRequestLine("GET /favicon.ico HTTP/1.1", "/oauth2callback")
assert.strictEqual(wrongPath.ok, false)
assert.strictEqual(wrongPath.error, "Unexpected sign-in callback path")

assert.strictEqual(oauth.parseCallbackRequestLine("POST /oauth2callback HTTP/1.1").ok, false)
assert.strictEqual(oauth.parseCallbackRequestLine("").ok, false)
assert.strictEqual(
  oauth.parseCallbackRequestLine("GET /oauth2callback?state=abc HTTP/1.1", "/oauth2callback").error,
  "Google did not return an authorization code")

// ------------------------------------------------------------------- PKCE

const pkce = oauth.parsePkceOutput(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123\t" +
  "ZmFrZS1jaGFsbGVuZ2UtdmFsdWUtd2l0aC1lbm91Z2gtY2hhcnM0Mw\t" +
  "0123456789abcdef0123456789abcdef")
assert.strictEqual(pkce.ok, true)
assert.strictEqual(pkce.state, "0123456789abcdef0123456789abcdef")
assert.strictEqual(oauth.parsePkceOutput("only\ttwo").ok, false)
assert.strictEqual(oauth.parsePkceOutput("short\tshort\tshort").ok, false)

// ---------------------------------------------------------------- tokens

const token = oauth.parseTokenResponse(200, JSON.stringify({
  access_token: "ya29.a0AfH", refresh_token: "1//0gRefresh", expires_in: 3599,
  scope: "https://www.googleapis.com/auth/gmail.modify"
}), "")
assert.strictEqual(token.ok, true)
assert.strictEqual(token.accessToken, "ya29.a0AfH")
assert.strictEqual(token.refreshToken, "1//0gRefresh")
assert.strictEqual(token.expiresIn, 3599)

// A refresh response carries no new refresh token; the old one has to survive.
const refreshed = oauth.parseTokenResponse(200, JSON.stringify({
  access_token: "ya29.new", expires_in: 3599
}), "1//0gPrevious")
assert.strictEqual(refreshed.refreshToken, "1//0gPrevious")

const revoked = oauth.parseTokenResponse(400, JSON.stringify({
  error: "invalid_grant", error_description: "Token has been expired or revoked."
}), "")
assert.strictEqual(revoked.ok, false)
assert.strictEqual(revoked.invalidGrant, true)
assert.strictEqual(revoked.error, "Google rejected the saved session. Sign in again")

assert.strictEqual(oauth.parseTokenResponse(500, "<html>", "").ok, false)
assert.strictEqual(oauth.parseTokenResponse(200, "{}", "").ok, false, "no access_token is a failure")

// --------------------------------------------------------------- scopes

deepEqual(
  oauth.missingScopes("https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send"),
  [])
deepEqual(
  oauth.missingScopes("https://www.googleapis.com/auth/gmail.modify"),
  ["https://www.googleapis.com/auth/gmail.send"])
assert.strictEqual(
  oauth.missingScopeMessage(["https://www.googleapis.com/auth/gmail.send"]),
  "Google sign-in finished without the gmail.send permission. Sign in again and leave every checkbox ticked")
assert.strictEqual(oauth.missingScopeMessage([]), "")

// -------------------------------------------------------------- redaction
//
// Google echoes request parameters back in error descriptions, so anything
// heading for a label goes through this first.

assert.strictEqual(oauth.redact("failed for ya29.a0AfH_longtoken here"), "failed for [redacted] here")
assert.strictEqual(oauth.redact("refresh_token=1//abc&x=1"), "refresh_token=[redacted]&x=1")
assert.strictEqual(oauth.redact("{\"access_token\":\"abc\"}"), "{\"access_token\":\"[redacted]\"}")
assert.strictEqual(oauth.redact("secret GOCSPX-aBcD_1234 leaked"), "secret [redacted] leaked")
assert.strictEqual(oauth.redact("nothing sensitive"), "nothing sensitive")
assert.strictEqual(oauth.redact(null), "")

// ------------------------------------------------------------ form bodies

assert.strictEqual(
  oauth.formBody({ a: "1", b: "two words", c: "", d: null }),
  "a=1&b=two%20words")

// ----------------------------------------------------------- browser pages

const success = oauth.successResponse()
assert.ok(success.indexOf("HTTP/1.1 200 OK") === 0)
assert.ok(success.indexOf("Content-Length: ") > 0)
assert.ok(oauth.failureResponse().indexOf("HTTP/1.1 400 Bad Request") === 0)

// The listener writes bytes, so the declared length has to match the body it
// actually sends or the browser hangs waiting for the rest.
const length = Number(success.match(/Content-Length: (\d+)/)[1])
assert.strictEqual(success.substring(success.indexOf("\r\n\r\n") + 4).length, length)

console.log("test_oauth.js ok")
