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

// Content-Length is a BYTE count. The old page said "Returning to Omarchy
// Gmail\u2026", whose ellipsis is one JS character and three UTF-8 bytes, so
// the browser was told to expect a shorter response than it got and rendered
// a truncated page. Measuring properly means the copy is free to use any
// character it likes.
function byteLength(text) {
  var value = String(text || "")
  var bytes = 0
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      bytes += 4
      i++
    } else if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else bytes += 3
  }
  return bytes
}

function defaultTheme() {
  return {
    background: "#131313",
    foreground: "#DEDEDE",
    accent: "#077CFD",
    urgent: "#FF5257",
    fontFamily: "monospace"
  }
}

// The page the browser lands on after Google redirects. It is the only part of
// this app that renders outside Quickshell, so it takes the active Omarchy
// theme with it rather than inventing a look of its own: same monospace, same
// square corners, same hairline border at 40% foreground.

// Everything the callback carries is attacker-controlled. The loopback listener
// answers whatever connects to it — it cannot tell Google's redirect from any
// other request to that port — so a crafted GET can put arbitrary text in
// error_description, and parseQuery hands it back percent-decoded. Interpolated
// raw, that text became markup in a page served from http://127.0.0.1, which is
// an origin the browser trusts as much as any other.
function escapeHtml(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// The palette crosses into a stylesheet rather than into text, where escaping
// does nothing: a value carrying "}" or "</style>" would close the rule or the
// element and everything after it would be markup. It comes from the active
// Omarchy theme, which is a file the user installed rather than something a
// stranger sent — but this page is the one thing here a browser renders, and a
// colour that is not a colour has no business reaching it either way.
function cssColor(value, fallback) {
  var text = String(value === undefined || value === null ? "" : value).trim()
  return /^#[0-9A-Fa-f]{3,8}$/.test(text) ? text : fallback
}

// Quoted in the stylesheet, so the quote itself is the character that must not
// survive. What is left is what a font is actually named.
function cssFontFamily(value) {
  var text = String(value === undefined || value === null ? "" : value)
    .replace(/[^A-Za-z0-9 _-]/g, "").trim()
  return text === "" ? "monospace" : text
}

// `body` is markup by design — the success page carries a script that closes the
// tab — so it is the caller's job to have escaped anything untrusted inside it.
// Everything else this builds is escaped here.
function themedPage(theme, options) {
  var palette = theme || defaultTheme()
  var settings = options || {}
  var fg = cssColor(palette.foreground, "#DEDEDE")
  var bg = cssColor(palette.background, "#131313")
  var mark = settings.failed ? cssColor(palette.urgent, "#FF5257")
    : cssColor(palette.accent, "#077CFD")
  var family = cssFontFamily(palette.fontFamily)

  return "<!doctype html><html><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + escapeHtml(settings.title) + "</title><style>"
    + "*{box-sizing:border-box}"
    + "html,body{height:100%}"
    + "body{margin:0;background:" + bg + ";color:" + fg + ";"
    + "font-family:\"CaskaydiaMono Nerd Font\",\"JetBrains Mono\",\"" + family + "\",ui-monospace,monospace;"
    + "font-size:13px;line-height:1.7;display:flex;align-items:center;justify-content:center;padding:24px}"
    + "main{width:100%;max-width:420px;border:1px solid " + fg + "66;padding:28px 30px}"
    + "svg{display:block;margin-bottom:18px}"
    + "h1{margin:0 0 10px;font-size:16px;font-weight:700;letter-spacing:-0.01em}"
    + "p{margin:0;color:" + fg + "a6}"
    + "p+p{margin-top:14px;font-size:11px;color:" + fg + "70}"
    + "b{color:" + fg + ";font-weight:700}"
    + "</style></head><body><main>"
    + "<svg width=\"26\" height=\"26\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"" + mark + "\" "
    + "stroke-width=\"1.3\" stroke-linejoin=\"round\">"
    + "<rect x=\"1\" y=\"3.5\" width=\"14\" height=\"9\"/>"
    + "<path d=\"" + (settings.failed ? "M1 3.5 L8 8.5 L15 3.5" : "M1 3.5 L8 0.8 L15 3.5") + "\"/>"
    + "</svg>"
    + "<h1>" + escapeHtml(settings.heading) + "</h1>"
    + settings.body
    + "</main></body></html>"
}

function httpResponse(statusLine, body) {
  return "HTTP/1.1 " + statusLine + "\r\nContent-Type: text/html; charset=utf-8\r\n"
    + "Cache-Control: no-store\r\nContent-Length: " + byteLength(body)
    + "\r\nConnection: close\r\n\r\n" + body
}

function successResponse(theme) {
  return httpResponse("200 OK", themedPage(theme, {
    title: "Omamail",
    heading: "Mailbox connected",
    failed: false,
    body: "<p>Omamail can read this mailbox now. "
      + "Switch back to the window \u2014 your mail is already loading.</p>"
      + "<p>This tab closes itself. If it stays open, it is safe to close.</p>"
      + "<script>setTimeout(function(){window.close()},600)<\/script>"
  }))
}

function failureResponse(theme, reason) {
  var detail = redact(String(reason || ""))
  return httpResponse("400 Bad Request", themedPage(theme, {
    title: "Sign-in failed",
    heading: "Sign-in did not finish",
    failed: true,
    body: "<p>" + (detail ? escapeHtml(detail) : "Google did not complete the authorization.") + "</p>"
      + "<p>Close this tab and try again from the Omamail window.</p>"
  }))
}
