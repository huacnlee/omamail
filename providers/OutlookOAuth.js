.pragma library

// Microsoft's OAuth 2.0 flow for a personal Outlook account, which is a
// consumer (`/consumers/`) authorization code flow with PKCE answered on a
// loopback listener.
//
// A sibling of `OAuth.js` rather than a branch inside it. The two flows share
// the shape of the protocol but almost none of their words: different hosts,
// different scopes, a public client with no secret, a redirect URI with no
// path, and a refresh token that rotates on every use. Keeping Google's file
// untouched is what stops a Microsoft change from being able to break Gmail.
//
// The generic string work — form encoding, the query parser, the PKCE output,
// the theme page and the byte count — is Google's own pure functions, reused
// here because none of them knows whose provider it is.
.import "OAuth.js" as Google

var AUTH_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
var TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"

var DEFAULT_PORT = 9481
// A loopback redirect for a public client must carry no path and no query:
// Microsoft matches `http://localhost` and ignores the port, so the callback
// arrives at "/" with the code in its query.
var CALLBACK_PATH = "/"

// The `outlook.office.com` resource form is the one that works for protocol
// access. The Graph scopes (`graph.microsoft.com/Mail.Read`) authorize the
// Graph API and are refused by IMAP and SMTP — the mailbox signs in and every
// fetch then comes back as an authentication failure.
var SCOPES = [
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "offline_access",
  "openid",
  "profile",
  "email"
]

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// The generic helpers Google's flow already owns, re-exported so the shell
// and the tests reach them through this module rather than through two.
function formBody(values) { return Google.formBody(values) }
function parsePkceOutput(line) { return Google.parsePkceOutput(line) }

// Google's scrubber knows Google's token shapes. A Microsoft access token
// starts with `Ew` and an id token is any JWT, so both get an extra rule —
// this is the one place a token could reach a label or a web page.
function redact(text) {
  return Google.redact(text)
    .replace(/\bEw[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
}

function normalizedPort(value) {
  var port = Math.floor(Number(value))
  return port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
}

function redirectUri(port) {
  return "http://localhost:" + normalizedPort(port)
}

// Microsoft takes the same authorization code with PKCE parameters as Google,
// plus `response_mode=query` so the code comes back in the query string the
// loopback listener already knows how to read. `offline_access` is in the
// scopes, which is what makes the refresh token be issued.
function authorizationUrl(options) {
  var settings = options || {}
  var scopes = Array.isArray(settings.scopes) && settings.scopes.length > 0
    ? settings.scopes : SCOPES
  return AUTH_URL + "?" + Google.formBody({
    client_id: settings.clientId,
    response_type: "code",
    redirect_uri: redirectUri(settings.port),
    response_mode: "query",
    scope: scopes.join(" "),
    code_challenge: settings.challenge,
    code_challenge_method: "S256",
    state: settings.state,
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
  var values = Google.parseQuery(separator < 0 ? "" : target.substring(separator + 1))
  if (values.error) {
    return {
      ok: false,
      error: values.error === "access_denied"
        ? "Microsoft sign-in was cancelled"
        : (values.error_description || values.error),
      state: values.state || ""
    }
  }
  if (!values.code) {
    return {
      ok: false,
      error: "Microsoft did not return an authorization code",
      state: values.state || ""
    }
  }
  return { ok: true, code: values.code, state: values.state || "" }
}

function tokenErrorMessage(payload, fallback) {
  if (!payload) return fallback
  var code = String(payload.error || "")
  var detail = String(payload.error_description || "")
  if (code === "invalid_grant")
    return "Microsoft rejected the saved session. Sign in again"
  if (code === "invalid_client")
    return "Microsoft rejected the OAuth client. Check the client ID"
  if (code === "unauthorized_client")
    return "This OAuth client is not allowed to use the desktop sign-in flow"
  if (code === "access_denied")
    return "Microsoft sign-in was cancelled"
  if (detail) return redact(detail)
  if (code) return redact(code)
  return fallback
}

// Microsoft returns `expires_in` and a fresh `refresh_token` on every exchange.
// A refresh response that omits one keeps the one that was already saved.
function parseTokenResponse(status, text, previousRefreshToken) {
  var payload = Google.parseJson(text, null)
  if (status < 200 || status >= 300 || !payload || !payload.access_token) {
    return {
      ok: false,
      invalidGrant: !!payload && payload.error === "invalid_grant",
      error: tokenErrorMessage(payload,
        "Could not complete Microsoft sign-in. Please try again")
    }
  }
  var idToken = String(payload.id_token || "")
  return {
    ok: true,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || previousRefreshToken || ""),
    expiresIn: Math.max(60, Number(payload.expires_in) || 3600),
    scope: String(payload.scope || ""),
    idToken: idToken,
    account: emailFromIdToken(idToken)
  }
}

// A saved grant stops being a session only when Microsoft says the grant
// itself is invalid. Timeouts, transport failures and server errors leave it
// intact and must be retried when the network is usable again.
function refreshFailureDisposition(result) {
  return result && result.invalidGrant ? "signed_out" : "retry"
}

// Retries start promptly, then back off to one request every five minutes.
function refreshRetryDelay(attempt) {
  return Google.refreshRetryDelay(attempt)
}

// The grant is only useful if it came back with everything the protocol needs.
//
// Microsoft answers the request with the full resource form
// (`https://outlook.office.com/IMAP.AccessAsUser.All`) but reports what it
// granted in the token response by short name (`IMAP.AccessAsUser.All`).
// Comparing the two literally would read every successful sign-in as a
// refusal, so both sides are folded to their short name before comparing.
// Google's folder already owns the rule; this is the same one.
function scopeShortName(scope) {
  return Google.scopeShortName(scope).toLowerCase()
}

// Only the resource scopes are checkable and only they matter to the protocol.
// Microsoft's token response reports the resource scopes alone: `offline_access`
// never appears in the echo even when a refresh token was issued (its presence
// is the proof), and the OIDC scopes' proof is the id token's claims. Demanding
// the OIDC set here would refuse every sign-in Microsoft ever completes.
var RESOURCE_SCOPES = SCOPES.filter(function(scope) {
  return scope.indexOf("https://") === 0
})

function missingScopes(granted, required) {
  var have = String(granted || "").split(/\s+/)
  var haveShort = []
  for (var i = 0; i < have.length; i++) haveShort.push(scopeShortName(have[i]))
  var want = Array.isArray(required) && required.length > 0 ? required : RESOURCE_SCOPES
  var missing = []
  for (var j = 0; j < want.length; j++) {
    if (haveShort.indexOf(scopeShortName(want[j])) < 0) missing.push(want[j])
  }
  return missing
}

function missingScopeMessage(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return ""
  var names = []
  for (var i = 0; i < missing.length; i++) names.push(Google.scopeShortName(missing[i]))
  return "Microsoft sign-in finished without the " + names.join(" and ")
    + " permission. Sign in again and approve every request"
}

// ------------------------------------------------------------- id token

var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// A small, pure decoder so the JWT can be read in the shell, in the node tests,
// and anywhere else without depending on a browser's `atob`.
function base64Decode(input) {
  var text = String(input || "").replace(/[^A-Za-z0-9+/=]/g, "")
  var out = ""
  var buffer = 0
  var bits = 0
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i)
    if (character === "=") break
    var value = BASE64_ALPHABET.indexOf(character)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((buffer >> bits) & 0xff)
    }
  }
  return out
}

function utf8Decode(binary) {
  var text = String(binary || "")
  var encoded = ""
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    encoded += "%" + (code < 16 ? "0" : "") + code.toString(16)
  }
  try { return decodeURIComponent(encoded) }
  catch (e) { return text }
}

function decodeIdToken(idToken) {
  var parts = String(idToken || "").split(".")
  if (parts.length < 2) return null
  return Google.parseJson(utf8Decode(base64Decode(parts[1])), null)
}

// The address Microsoft signed in. For a personal account it is the
// `preferred_username` claim; `email` and `upn` are there for the accounts
// that name it that way instead.
function emailFromIdToken(idToken) {
  var claims = decodeIdToken(idToken)
  if (!claims) return ""
  return trimmed(claims.preferred_username || claims.email || claims.upn)
}

// ----------------------------------------------------------- browser pages

function successResponse(theme) {
  return Google.httpResponse("200 OK", Google.themedPage(theme, {
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
  return Google.httpResponse("400 Bad Request", Google.themedPage(theme, {
    title: "Sign-in failed",
    heading: "Sign-in did not finish",
    failed: true,
    body: "<p>" + (detail ? Google.escapeHtml(detail)
      : "Microsoft did not complete the authorization.") + "</p>"
      + "<p>Close this tab and try again from the Omamail window.</p>"
  }))
}
