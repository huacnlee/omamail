const assert = require("assert")
const { load, deepEqual } = require("./load")

const ms = load("providers/OutlookOAuth.js")

// ------------------------------------------------------------------ ports
//
// A public client's loopback redirect carries no path: Microsoft matches
// `http://localhost` and ignores the port, so the callback arrives at "/".
assert.strictEqual(ms.normalizedPort(9481), 9481)
assert.strictEqual(ms.normalizedPort("9481"), 9481)
assert.strictEqual(ms.normalizedPort(80), 9481, "privileged ports fall back")
assert.strictEqual(ms.normalizedPort(70000), 9481)
assert.strictEqual(ms.normalizedPort(""), 9481)
assert.strictEqual(ms.redirectUri(9481), "http://localhost:9481")
assert.strictEqual(ms.redirectUri(0), "http://localhost:9481")
assert.strictEqual(ms.CALLBACK_PATH, "/", "a loopback redirect has no path")

// ------------------------------------------------------- authorization URL

const url = ms.authorizationUrl({
  clientId: "9a14c565-731b-47dc-baef-63dd89ed9d7f",
  challenge: "CHALLENGE",
  state: "STATE",
  port: 9481
})

assert.ok(url.indexOf("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?") === 0,
  "personal accounts use the consumers endpoint")
assert.ok(url.indexOf("response_type=code") > 0)
assert.ok(url.indexOf("code_challenge_method=S256") > 0)
assert.ok(url.indexOf("response_mode=query") > 0,
  "the code has to arrive in the query string the listener reads")
assert.ok(url.indexOf("redirect_uri=http%3A%2F%2Flocalhost%3A9481") > 0,
  "the loopback redirect reaches the request with no path")
assert.ok(url.indexOf("scope=https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All%20") > 0,
  "the outlook.office.com resource form is what protocol access needs")
assert.ok(url.indexOf("https%3A%2F%2Foutlook.office.com%2FSMTP.Send") > 0)
assert.ok(url.indexOf("offline_access") > 0, "offline_access is what makes a refresh token come back")
// The Graph scopes authorize the Graph API and are refused by IMAP and SMTP.
assert.ok(url.indexOf("graph.microsoft.com") < 0, "Graph scopes do not work for protocol access")
assert.ok(url.indexOf("login_hint") < 0, "an absent hint is omitted, not sent empty")

const hinted = ms.authorizationUrl({
  clientId: "9a14c565-731b-47dc-baef-63dd89ed9d7f",
  challenge: "C", state: "S", loginHint: "user@outlook.com"
})
assert.ok(hinted.indexOf("login_hint=user%40outlook.com") > 0)

// --------------------------------------------------------------- callback

const good = ms.parseCallbackRequestLine(
  "GET /?code=M.R3_BAY&state=abc123 HTTP/1.1", "/")
deepEqual(good, { ok: true, code: "M.R3_BAY", state: "abc123" })

const denied = ms.parseCallbackRequestLine(
  "GET /?error=access_denied&state=abc HTTP/1.1", "/")
assert.strictEqual(denied.ok, false)
assert.strictEqual(denied.error, "Microsoft sign-in was cancelled")
assert.strictEqual(denied.state, "abc")

const wrongPath = ms.parseCallbackRequestLine("GET /favicon.ico HTTP/1.1", "/")
assert.strictEqual(wrongPath.ok, false)
assert.strictEqual(wrongPath.error, "Unexpected sign-in callback path")

assert.strictEqual(ms.parseCallbackRequestLine("POST / HTTP/1.1").ok, false)
assert.strictEqual(ms.parseCallbackRequestLine("").ok, false)
assert.strictEqual(
  ms.parseCallbackRequestLine("GET /?state=abc HTTP/1.1", "/").error,
  "Microsoft did not return an authorization code")

// ------------------------------------------------------------------- PKCE

const pkce = ms.parsePkceOutput(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123\t" +
  "ZmFrZS1jaGFsbGVuZ2UtdmFsdWUtd2l0aC1lbm91Z2gtY2hhcnM0Mw\t" +
  "0123456789abcdef0123456789abcdef")
assert.strictEqual(pkce.ok, true, "the PKCE generator is shared with the Google flow")

// ---------------------------------------------------------------- tokens

// A real id token is three base64url segments. Only the payload matters here,
// and it is where a personal account's address comes from.
function idToken(claims) {
  const body = Buffer.from(JSON.stringify(claims), "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  // A real JWT header is `{"alg":"RS256","typ":"JWT"}`; the `eyJ` prefix is
  // what the scrubber recognises.
  return "eyJhbGciOiJSUzI1NiJ9." + body + ".signature"
}

const token = ms.parseTokenResponse(200, JSON.stringify({
  access_token: "EwBAA8l6", refresh_token: "M.R3_BAY-refresh", expires_in: 3599,
  scope: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid profile email",
  id_token: idToken({ preferred_username: "user@outlook.com" })
}), "")
assert.strictEqual(token.ok, true)
assert.strictEqual(token.accessToken, "EwBAA8l6")
assert.strictEqual(token.refreshToken, "M.R3_BAY-refresh")
assert.strictEqual(token.expiresIn, 3599)
assert.strictEqual(token.account, "user@outlook.com",
  "the id token names the mailbox Microsoft signed in")

// Microsoft rotates the refresh token. A response that carries a new one is
// the new one; a response that omits it keeps the old.
const rotated = ms.parseTokenResponse(200, JSON.stringify({
  access_token: "new", refresh_token: "rotated", expires_in: 3599,
  id_token: idToken({ email: "user@outlook.com" })
}), "old")
assert.strictEqual(rotated.refreshToken, "rotated")
assert.strictEqual(rotated.account, "user@outlook.com", "the email claim works too")

const kept = ms.parseTokenResponse(200, JSON.stringify({
  access_token: "new", expires_in: 3599
}), "old")
assert.strictEqual(kept.refreshToken, "old",
  "a refresh response without a new token must not drop the saved one")

const revoked = ms.parseTokenResponse(400, JSON.stringify({
  error: "invalid_grant",
  error_description: "AADSTS70008: The refresh token has expired."
}), "")
assert.strictEqual(revoked.ok, false)
assert.strictEqual(revoked.invalidGrant, true)
assert.strictEqual(revoked.error, "Microsoft rejected the saved session. Sign in again")

assert.strictEqual(ms.parseTokenResponse(500, "<html>", "").ok, false)
assert.strictEqual(ms.parseTokenResponse(200, "{}", "").ok, false, "no access_token is a failure")

assert.strictEqual(ms.refreshFailureDisposition({ ok: false, invalidGrant: false }), "retry")
assert.strictEqual(ms.refreshFailureDisposition({ ok: false, invalidGrant: true }), "signed_out")
assert.strictEqual(ms.refreshRetryDelay(0), 5000)
assert.strictEqual(ms.refreshRetryDelay(100), 300000)

// --------------------------------------------------------------- scopes

// Microsoft grants the resource-form scopes but reports them by short name in
// the token response, so the comparison folds both sides.
deepEqual(ms.missingScopes(
  "IMAP.AccessAsUser.All SMTP.Send offline_access openid profile email"), [])
// The response Microsoft actually sends: resource scopes only, and that is
// enough — a refresh token's presence is the proof offline_access was granted.
deepEqual(ms.missingScopes(ms.RESOURCE_SCOPES.join(" ")), [])
deepEqual(ms.missingScopes(
  "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"), [])
deepEqual(ms.missingScopes(ms.SCOPES.join(" ")), [])
deepEqual(ms.missingScopes("https://outlook.office.com/IMAP.AccessAsUser.All"),
  ["https://outlook.office.com/SMTP.Send"])
deepEqual(ms.missingScopes("offline_access openid profile email"),
  ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"])
assert.ok(ms.missingScopeMessage(["https://outlook.office.com/SMTP.Send"])
  .indexOf("SMTP.Send") > 0)
assert.strictEqual(ms.missingScopeMessage([]), "")

// ------------------------------------------------------------ browser pages

const theme = {
  background: "#101315", foreground: "#cacccc",
  accent: "#7aa2f7", urgent: "#a55555", fontFamily: "monospace"
}
const success = ms.successResponse(theme)
assert.ok(success.indexOf("HTTP/1.1 200 OK") === 0)
assert.ok(success.indexOf("#101315") > 0)
assert.ok(success.indexOf("Mailbox connected") > 0)

const failure = ms.failureResponse(theme, "Microsoft sign-in was cancelled")
assert.ok(failure.indexOf("HTTP/1.1 400 Bad Request") === 0)
assert.ok(failure.indexOf("Microsoft sign-in was cancelled") > 0)

// Nothing from the error path may carry a credential onto a web page. A
// Microsoft access token starts with `Ew`; an id token is a JWT.
assert.ok(ms.failureResponse(theme,
  "bad EwBAA8l6abcdefghijklmnopqrstuvwxyz0123456789 here")
  .indexOf("EwBAA8l6abcdefghijklmnopqrstuvwxyz0123456789") < 0)
assert.ok(ms.failureResponse(theme,
  "bad " + idToken({ preferred_username: "user@outlook.com" }) + " here")
  .indexOf("eyJ") < 0, "an id token is scrubbed too")

for (const page of [success, failure, ms.successResponse()]) {
  const declared = Number(page.match(/Content-Length: (\d+)/)[1])
  const body = page.substring(page.indexOf("\r\n\r\n") + 4)
  assert.strictEqual(declared, Buffer.byteLength(body, "utf8"),
    "declared length must match the bytes sent")
}

console.log("test_outlook_oauth.js ok")
