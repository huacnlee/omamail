.pragma library

// Google's OAuth 2.0 flow for installed apps: authorization code with PKCE,
// answered on a loopback listener. Everything here is pure string work so the
// same code the shell runs is what the node tests exercise.
//
// Google's rules that shape this file:
//   - loopback redirects may use any port; only 127.0.0.1 / [::1] are allowed
//   - the client secret of a "Desktop app" client is not confidential, but it
//     is still required in the token exchange for that client type
//   - refresh tokens are only re-issued when consent is asked for again, so
//     the authorization request always sends prompt=consent

var AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
var TOKEN_URL = "https://oauth2.googleapis.com/token"
var REVOKE_URL = "https://oauth2.googleapis.com/revoke"

var DEFAULT_PORT = 9481
var CALLBACK_PATH = "/oauth2callback"

// gmail.modify is read plus label/trash changes — it deliberately cannot
// permanently delete. gmail.send is what reply and compose need. Neither
// grants access to the account profile beyond the mailbox address.
var SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send"
]

function normalizedPort(value) {
  var port = Math.floor(Number(value))
  return port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
}

function redirectUri(port) {
  return "http://127.0.0.1:" + normalizedPort(port) + CALLBACK_PATH
}

function encode(value) {
  return encodeURIComponent(String(value === undefined || value === null ? "" : value))
}

function decode(value) {
  try { return decodeURIComponent(String(value || "").replace(/\+/g, " ")) }
  catch (e) { return "" }
}

function formBody(values) {
  var parts = []
  for (var key in values) {
    if (values[key] === undefined || values[key] === null || values[key] === "") continue
    parts.push(encode(key) + "=" + encode(values[key]))
  }
  return parts.join("&")
}

function parseQuery(raw) {
  var result = {}
  var query = String(raw || "")
  if (query.charAt(0) === "?") query = query.substring(1)
  var parts = query.split("&")
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    var separator = parts[i].indexOf("=")
    var key = separator < 0 ? parts[i] : parts[i].substring(0, separator)
    var value = separator < 0 ? "" : parts[i].substring(separator + 1)
    result[decode(key)] = decode(value)
  }
  return result
}

function authorizationUrl(options) {
  var settings = options || {}
  var scopes = Array.isArray(settings.scopes) && settings.scopes.length > 0
    ? settings.scopes : SCOPES
  return AUTH_URL + "?" + formBody({
    client_id: settings.clientId,
    redirect_uri: redirectUri(settings.port),
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: settings.challenge,
    code_challenge_method: "S256",
    state: settings.state,
    access_type: "offline",
    // Without this Google returns a refresh token only on the very first
    // consent, so a user who reinstalls the plugin would be stuck with an
    // access token that expires in an hour and never comes back.
    prompt: "consent",
    login_hint: settings.loginHint
  })
}

// The listener is a raw socat pipe, so the first request line is all there is
// to work with. Anything that is not the expected callback path is refused
// rather than guessed at.
function parseCallbackRequestLine(line, expectedPath) {
  var match = String(line || "").match(/^GET\s+([^\s]+)\s+HTTP\/\d(?:\.\d)?$/)
  if (!match) return { ok: false, error: "Invalid sign-in callback request" }
  var target = match[1]
  var separator = target.indexOf("?")
  var path = separator < 0 ? target : target.substring(0, separator)
  var requiredPath = String(expectedPath || CALLBACK_PATH)
  if (path !== requiredPath) return { ok: false, error: "Unexpected sign-in callback path" }
  var values = parseQuery(separator < 0 ? "" : target.substring(separator + 1))
  if (values.error) {
    return {
      ok: false,
      error: values.error === "access_denied"
        ? "Google sign-in was cancelled"
        : (values.error_description || values.error),
      state: values.state || ""
    }
  }
  if (!values.code) {
    return {
      ok: false,
      error: "Google did not return an authorization code",
      state: values.state || ""
    }
  }
  return { ok: true, code: values.code, state: values.state || "" }
}

function parsePkceOutput(line) {
  var parts = String(line || "").trim().split("\t")
  if (parts.length !== 3) return { ok: false, error: "Could not create PKCE parameters" }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(parts[0])) return { ok: false, error: "Invalid PKCE verifier" }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(parts[1])) return { ok: false, error: "Invalid PKCE challenge" }
  if (!/^[A-Fa-f0-9]{32,128}$/.test(parts[2])) return { ok: false, error: "Invalid OAuth state" }
  return { ok: true, verifier: parts[0], challenge: parts[1], state: parts[2] }
}

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

// Anything that could carry a credential is scrubbed before it can reach a
// label. Errors from Google echo request parameters more often than not.
function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/(refresh_token|access_token|code_verifier|client_secret|id_token)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/"(refresh_token|access_token|code_verifier|client_secret|id_token)"\s*:\s*"[^"]*"/gi, "\"$1\":\"[redacted]\"")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/\bGOCSPX-[A-Za-z0-9._-]+/g, "[redacted]")
}

function tokenErrorMessage(payload, fallback) {
  if (!payload) return fallback
  var code = String(payload.error || "")
  var detail = String(payload.error_description || "")
  if (code === "invalid_grant")
    return "Google rejected the saved session. Sign in again"
  if (code === "invalid_client")
    return "Google rejected the OAuth client. Check the client ID and secret"
  if (code === "unauthorized_client")
    return "This OAuth client is not allowed to use the desktop sign-in flow"
  if (code === "access_denied")
    return "Google sign-in was cancelled"
  if (detail) return redact(detail)
  if (code) return redact(code)
  return fallback
}

function parseTokenResponse(status, text, previousRefreshToken) {
  var payload = parseJson(text, null)
  if (status < 200 || status >= 300 || !payload || !payload.access_token) {
    return {
      ok: false,
      invalidGrant: !!payload && payload.error === "invalid_grant",
      error: tokenErrorMessage(payload,
        "Could not complete Google sign-in. Please try again")
    }
  }
  return {
    ok: true,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || previousRefreshToken || ""),
    expiresIn: Math.max(60, Number(payload.expires_in) || 3600),
    scope: String(payload.scope || "")
  }
}

// A grant is only useful if it came back with everything the panel needs. A
// user who unticks a checkbox on Google's consent screen gets a working token
// with a scope set that silently breaks half the actions.
function missingScopes(granted, required) {
  var have = String(granted || "").split(/\s+/)
  var want = Array.isArray(required) && required.length > 0 ? required : SCOPES
  var missing = []
  for (var i = 0; i < want.length; i++) {
    if (have.indexOf(want[i]) < 0) missing.push(want[i])
  }
  return missing
}

function scopeShortName(scope) {
  var value = String(scope || "")
  var slash = value.lastIndexOf("/")
  return slash < 0 ? value : value.substring(slash + 1)
}

function missingScopeMessage(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return ""
  var names = []
  for (var i = 0; i < missing.length; i++) names.push(scopeShortName(missing[i]))
  return "Google sign-in finished without the " + names.join(" and ")
    + " permission. Sign in again and leave every checkbox ticked"
}

function htmlPage(title, heading, body) {
  return "<!doctype html><meta charset=\"utf-8\"><title>" + title + "</title>"
    + "<style>:root{color-scheme:light dark}body{font-family:system-ui;background:Canvas;color:CanvasText;"
    + "display:grid;place-items:center;height:100vh;margin:0}"
    + "main{max-width:32rem;padding:2rem;border:1px solid GrayText;border-radius:.5rem}</style>"
    + "<main><h1>" + heading + "</h1>" + body + "</main>"
}

function httpResponse(statusLine, body) {
  return "HTTP/1.1 " + statusLine + "\r\nContent-Type: text/html; charset=utf-8\r\n"
    + "Cache-Control: no-store\r\nContent-Length: " + body.length
    + "\r\nConnection: close\r\n\r\n" + body
}

function successResponse() {
  return httpResponse("200 OK", htmlPage("Omarchy Gmail", "Authorization complete",
    "<p>Returning to Omarchy Gmail…</p><p><small>If this tab stays open, it is safe to close.</small></p>"
    + "<script>setTimeout(function(){window.close()},150)</script>"))
}

function failureResponse() {
  return httpResponse("400 Bad Request", htmlPage("Authorization failed",
    "Authorization failed", "<p>Return to Omarchy for details.</p>"))
}
