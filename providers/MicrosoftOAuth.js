.pragma library

.import "OAuth.js" as OAuth

// Microsoft OAuth for installed applications. Outlook uses the device-code
// flow: the client is public, carries no secret, and does not need a redirect
// URI or a listener left on the desktop.

var TENANT = "consumers"
var AUTHORITY = "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0"
var DEVICE_URL = AUTHORITY + "/devicecode"
var TOKEN_URL = AUTHORITY + "/token"

var SCOPES = [
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send"
]

// A maintainer-owned public-client registration can make Outlook a one-click
// setup later. Until then, each user supplies the Application (client) ID of
// their own registration, just as Gmail users supply their own OAuth client.
var BUILTIN_CLIENT_ID = ""

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isValidClientId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(trimmed(value))
}

function effectiveClientId(value) {
  var configured = trimmed(value)
  return isValidClientId(configured) ? configured : trimmed(BUILTIN_CLIENT_ID)
}

function verificationUri(value) {
  var text = trimmed(value)
  var match = text.match(/^https:\/\/([^\/:?#]+)(?::443)?(?:[\/?#]|$)/i)
  if (!match) return ""
  var host = match[1].toLowerCase()
  if (host !== "microsoft.com" && host !== "www.microsoft.com"
      && host !== "login.microsoftonline.com") return ""
  return text
}

function scopeText(scopes) {
  var values = Array.isArray(scopes) && scopes.length > 0 ? scopes : SCOPES
  return values.join(" ")
}

function deviceAuthorizationBody(clientId, scopes) {
  return OAuth.formBody({ client_id: trimmed(clientId), scope: scopeText(scopes) })
}

function deviceTokenBody(clientId, deviceCode) {
  return OAuth.formBody({
    client_id: trimmed(clientId),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: String(deviceCode || "")
  })
}

function refreshTokenBody(clientId, refreshToken, scopes) {
  return OAuth.formBody({
    client_id: trimmed(clientId),
    grant_type: "refresh_token",
    refresh_token: String(refreshToken || ""),
    scope: scopeText(scopes)
  })
}

function parseJson(text) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch (e) {
    return null
  }
}

function redact(text) {
  return OAuth.redact(text)
    .replace(/(device_code|user_code)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/"(device_code|user_code)"\s*:\s*"[^"]*"/gi, "\"$1\":\"[redacted]\"")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "[redacted]")
}

function errorMessage(payload, fallback) {
  var value = payload || {}
  var code = String(value.error || "")
  var detail = String(value.error_description || "")
  if (code === "authorization_declined" || code === "access_denied")
    return "Microsoft sign-in was cancelled"
  if (code === "expired_token" || code === "bad_verification_code")
    return "The Microsoft sign-in code expired. Please try again"
  if (code === "invalid_client" || code === "unauthorized_client")
    return "Microsoft rejected this OAuth client. Check the client ID and public-client setting"
  if (code === "invalid_grant")
    return "Microsoft rejected the saved session. Sign in again"
  if (detail) return redact(detail)
  if (code) return redact(code)
  return fallback
}

function parseDeviceResponse(status, text) {
  var payload = parseJson(text)
  if (status < 200 || status >= 300 || !payload || !payload.device_code
      || !payload.user_code || !verificationUri(payload.verification_uri)) {
    return { ok: false, error: errorMessage(payload,
      "Could not start Microsoft sign-in. Please try again") }
  }
  return {
    ok: true,
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code),
    verificationUri: verificationUri(payload.verification_uri),
    expiresIn: Math.max(60, Number(payload.expires_in) || 900),
    interval: Math.max(5, Number(payload.interval) || 5),
    message: String(payload.message || "")
  }
}

function parseTokenResponse(status, text, previousRefreshToken) {
  var payload = parseJson(text)
  var code = payload ? String(payload.error || "") : ""
  if (code === "authorization_pending" || code === "slow_down") {
    return { ok: false, pending: true, slowDown: code === "slow_down", error: "" }
  }
  if (status < 200 || status >= 300 || !payload || !payload.access_token) {
    return {
      ok: false,
      pending: false,
      invalidGrant: code === "invalid_grant",
      error: errorMessage(payload, "Could not complete Microsoft sign-in. Please try again")
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

function missingMailScopes(granted) {
  var have = String(granted || "").toLowerCase().split(/\s+/)
  var missing = []
  for (var i = 0; i < SCOPES.length; i++) {
    var scope = SCOPES[i]
    if (scope === "offline_access") continue
    if (have.indexOf(scope.toLowerCase()) < 0) missing.push(scope)
  }
  return missing
}

function missingScopeMessage(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return ""
  var names = []
  for (var i = 0; i < missing.length; i++) {
    var value = String(missing[i] || "")
    names.push(value.substring(value.lastIndexOf("/") + 1))
  }
  return "Microsoft sign-in finished without the " + names.join(" and ")
    + " permission. Check the app registration and sign in again"
}

function refreshFailureDisposition(result) {
  return result && result.invalidGrant ? "signed_out" : "retry"
}

function refreshRetryDelay(attempt) {
  return OAuth.refreshRetryDelay(attempt)
}
