const assert = require("assert")
const { load, deepEqual } = require("./load")

const oauth = load("providers/OAuth.js")

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
//
// This page is the only part of the app that renders outside Quickshell, so it
// carries the active theme rather than inventing a look of its own.

const theme = {
  background: "#101315", foreground: "#cacccc",
  accent: "#7aa2f7", urgent: "#a55555", fontFamily: "monospace"
}
const success = oauth.successResponse(theme)
assert.ok(success.indexOf("HTTP/1.1 200 OK") === 0)
assert.ok(success.indexOf("#101315") > 0, "the theme background reaches the page")
assert.ok(success.indexOf("#7aa2f7") > 0, "so does the accent")
assert.ok(success.indexOf("Mailbox connected") > 0)

const failure = oauth.failureResponse(theme, "Google sign-in was cancelled")
assert.ok(failure.indexOf("HTTP/1.1 400 Bad Request") === 0)
assert.ok(failure.indexOf("#a55555") > 0, "a failure takes the urgent colour")
assert.ok(failure.indexOf("Google sign-in was cancelled") > 0)

// Nothing from the error path may carry a credential onto a web page.
assert.ok(oauth.failureResponse(theme, "bad ya29.abcDEF123 token").indexOf("ya29.") < 0)

// Called with no theme at all it still renders, because a listener that
// answers nothing leaves the browser hanging on a blank tab.
assert.ok(oauth.successResponse().indexOf("HTTP/1.1 200 OK") === 0)

// Content-Length is a BYTE count. Measuring it in JS characters truncated the
// response for any page containing a multi-byte character — which the old
// page did, with its ellipsis.
function byteLen(text) { return Buffer.byteLength(text, "utf8") }
for (const page of [success, failure, oauth.successResponse()]) {
  const declared = Number(page.match(/Content-Length: (\d+)/)[1])
  const body = page.substring(page.indexOf("\r\n\r\n") + 4)
  assert.strictEqual(declared, byteLen(body), "declared length must match the bytes sent")
}
assert.strictEqual(oauth.byteLength("Gmail\u2026"), 8, "an ellipsis is three bytes, not one")
assert.strictEqual(oauth.byteLength("\u4f60\u597d"), 6)
assert.strictEqual(oauth.byteLength(""), 0)


// ------------------------------------------------- the callback's own page
//
// The loopback listener answers whatever connects to it — it cannot tell
// Google's redirect from any other request to that port — so everything the
// callback carries is attacker-controlled, and parseQuery hands it back
// percent-decoded.
{
  var hostile = "<img src=x onerror=alert(1)><script>alert(2)</" + "script>"
  var line = "GET /oauth2callback?error=x&error_description="
    + encodeURIComponent(hostile) + " HTTP/1.1"
  var parsed = oauth.parseCallbackRequestLine(line, "/oauth2callback")
  assert.strictEqual(parsed.ok, false)
  assert.strictEqual(parsed.error, hostile, "the description arrives decoded")

  var page = oauth.failureResponse(null, parsed.error)
  assert.ok(page.indexOf("<img") < 0, "no element survives into the page")
  assert.ok(page.toLowerCase().indexOf("<script") < 0, "and no script does either")
  assert.ok(page.indexOf("&lt;img src=x onerror=alert(1)&gt;") > 0, "it is shown as text")

  // Escaping lengthens the body, and a Content-Length that disagrees with it
  // truncates the page in the browser.
  var split = page.indexOf("\r\n\r\n")
  var declared = Number(page.match(/Content-Length: (\d+)/)[1])
  assert.strictEqual(declared, oauth.byteLength(page.substring(split + 4)))

  // The success page carries no callback text at all, which is why only the
  // failure path could ever have echoed anything.
  assert.ok(oauth.successResponse(null).indexOf("alert") < 0)
}

// The palette lands in a stylesheet, where escaping does nothing: a value
// carrying "}" or "</style>" would close the rule and turn the rest into
// markup. A theme is installed rather than sent, but this page is the one thing
// here a browser renders.
{
  const hostile = oauth.failureResponse({
    background: "#131313;}</style><script>alert(1)</script><style>{",
    foreground: "red;} body{display:none",
    urgent: "#FF5257",
    fontFamily: 'monospace";}</style><img src=x onerror=alert(1)>'
  }, "went wrong")
  assert.ok(hostile.indexOf("<script") < 0, "a failure page carries no script at all")
  assert.ok(hostile.indexOf("<img") < 0)
  assert.ok(hostile.indexOf("display:none") < 0)
  // One stylesheet, closed once: nothing in the palette ended it early.
  assert.strictEqual(hostile.split("</style>").length - 1, 1)
  // A colour that is not a colour falls back rather than disappearing, so the
  // page is still readable.
  assert.ok(hostile.indexOf("background:#131313;") > 0)
  assert.ok(hostile.indexOf("#FF5257") > 0)

  // A real theme still comes through untouched.
  const normal = oauth.successResponse({
    background: "#1d2021", foreground: "#ebdbb2", accent: "#458588",
    urgent: "#cc241d", fontFamily: "CaskaydiaMono Nerd Font"
  })
  assert.ok(normal.indexOf("#1d2021") > 0)
  assert.ok(normal.indexOf("CaskaydiaMono Nerd Font") > 0)
}

console.log("test_oauth.js ok")