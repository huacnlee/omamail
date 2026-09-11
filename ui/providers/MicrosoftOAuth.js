.pragma library

.import "OAuth.js" as OAuth

// Microsoft OAuth for installed applications. Outlook uses the device-code
// flow: the client is public, carries no secret, and does not need a redirect
// URI or a listener left on the desktop.

var TENANT = "consumers"
var AUTHORITY = "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0"
var DEVICE_URL = AUTHORITY + "/devicecode"
var TOKEN_URL = AUTHORITY + "/token"

// `openid` brings an id token with each mail token, naming the account by
// its object id: what the Graph sign-in's code is held to.
var SCOPES = [
  "openid",
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send"
]

// Sending through Microsoft Graph, for a work or school tenant that has
// switched authenticated SMTP off. A token is for one resource, so this is a
// second token — asked for with the same refresh token, which Microsoft lets
// a public client exchange for any resource the registration was consented
// for.
var GRAPH_SCOPES = [
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Calendars.ReadWrite"
]

// The tenant the sign-in is addressed to. Personal accounts live under
// `consumers`; a Microsoft 365 mailbox lives under its own tenant, which
// `organizations` finds from the address, or a tenant id or domain names
// outright. Anything that is not one of those spellings is the consumer
// tenant, so a stored value cannot steer the sign-in to another host: the
// tenant is one path segment of a fixed URL, never a URL of its own.
// Every request names one resource, the device-code request that starts a
// sign-in included: Microsoft refuses two in one (AADSTS28000). So consent
// for Graph is a sign-in of its own — a second code — asked for only when
// the exchange of the refresh token for Graph is refused for want of it:
// straight after the mail sign-in where the tenant sends through Graph,
// else from the mailbox's settings when the calendar's exchange is refused.
// Consent is per user and client, not per token: once given, either
// sign-in's refresh token exchanges for either resource.
// `openid` brings an id token naming the account that entered the code —
// by object id, held to the mail sign-in's; by name (`profile`, `email`)
// where the mail session's id is not known — so a code entered as someone
// else is refused, not filed as the mailbox.
var GRAPH_SIGN_IN_SCOPES = ["openid", "profile", "email", "offline_access"].concat(GRAPH_SCOPES)

function normalizeTenant(value) {
  var text = trimmed(value).toLowerCase()
  if (text === "" || text === "consumers") return "consumers"
  if (text === "organizations" || text === "common") return text
  if (/^[a-z0-9][a-z0-9.-]{0,254}$/.test(text) && text.indexOf("..") < 0) return text
  return "consumers"
}

function isWorkTenant(tenant) {
  return normalizeTenant(tenant) !== "consumers"
}

function authorityFor(tenant) {
  return "https://login.microsoftonline.com/" + normalizeTenant(tenant) + "/oauth2/v2.0"
}

// The consumer tenant answers with the constants above, which is what lets a
// test point them at a server of its own.
function deviceUrlFor(tenant) {
  if (normalizeTenant(tenant) === "consumers") return DEVICE_URL
  return authorityFor(tenant) + "/devicecode"
}

function tokenUrlFor(tenant) {
  if (normalizeTenant(tenant) === "consumers") return TOKEN_URL
  return authorityFor(tenant) + "/token"
}

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
  // The pages Microsoft sends people to: microsoft.com/devicelogin and
  // www.microsoft.com/link for personal accounts, login.microsoft.com/device
  // for a work or school tenant, and the sign-in host itself.
  var host = match[1].toLowerCase()
  if (host !== "microsoft.com" && host !== "www.microsoft.com"
      && host !== "login.microsoft.com" && host !== "login.microsoftonline.com") return ""
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

function graphRefreshBody(clientId, refreshToken) {
  return refreshTokenBody(clientId, refreshToken, GRAPH_SCOPES)
}

// Whether a token answer lists a scope: by its full name or, as Microsoft
// lists Graph's, by the short one. An answer that lists none says nothing
// and is taken as granted — a permission truly missing is refused where it
// is used, not mistaken for consent to collect.
function scopeListed(granted, scope) {
  var text = String(granted || "").trim().toLowerCase()
  if (text === "") return true
  var have = text.split(/\s+/)
  var full = String(scope || "").toLowerCase()
  var short = full.substring(full.lastIndexOf("/") + 1)
  return have.indexOf(full) >= 0 || have.indexOf(short) >= 0
}

// Whether a Graph token answered with the scope sending needs, and whether
// with the one the calendar needs. A registration consented for one and
// not the other is told which.
function missingGraphScope(granted) {
  return !scopeListed(granted, GRAPH_SCOPES[0])
}

function missingCalendarScope(granted) {
  return !scopeListed(granted, GRAPH_SCOPES[1])
}

function calendarScopeMessage() {
  return "Microsoft did not grant the Calendars.ReadWrite permission for Microsoft Graph. "
    + "Add it to the app registration, then sign in again"
}
function graphScopeMessage() {
  return "This sign-in has not granted the Mail.Send permission for Microsoft Graph. "
    + "Sign in again to grant it; if that does not help, add it to the app registration"
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
      consentRequired: consentRequired(payload),
      error: errorMessage(payload, "Could not complete Microsoft sign-in. Please try again")
    }
  }
  return {
    ok: true,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || previousRefreshToken || ""),
    expiresIn: Math.max(60, Number(payload.expires_in) || 3600),
    scope: String(payload.scope || ""),
    idToken: String(payload.id_token || "")
  }
}

// The account an id token names, lower-cased, or "" when it names none. The
// token is Microsoft's own answer over TLS, read for the name alone and not
// verified: it authorises nothing, it says who entered the code.
function base64UrlDecode(text) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  var input = String(text || "").replace(/=+$/, "")
  var out = ""
  var bits = 0
  var value = 0
  for (var i = 0; i < input.length; i++) {
    var index = alphabet.indexOf(input.charAt(i))
    if (index < 0) return ""
    value = ((value << 6) | index) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      var byte = (value >> bits) & 255
      out += "%" + (byte < 16 ? "0" : "") + byte.toString(16)
    }
  }
  try { return decodeURIComponent(out) } catch (e) { return "" }
}

function idTokenClaims(idToken) {
  var parts = String(idToken || "").split(".")
  if (parts.length < 2) return null
  return parseJson(base64UrlDecode(parts[1]))
}

function signedInAs(idToken) {
  var claims = idTokenClaims(idToken)
  if (!claims) return ""
  var names = ["preferred_username", "email", "upn"]
  for (var i = 0; i < names.length; i++) {
    var value = trimmed(claims[names[i]]).toLowerCase()
    if (value !== "") return value
  }
  return ""
}

// The account an id token names by tenant and object id — what does not
// change when a name does — or "" when it carries neither.
function accountKey(idToken) {
  var claims = idTokenClaims(idToken)
  if (!claims) return ""
  var tenant = trimmed(claims.tid)
  var object = trimmed(claims.oid)
  return tenant !== "" && object !== "" ? tenant + "/" + object : ""
}

// Whether the id token names the mailbox's own account: the one the mail
// session is, by id, where that is known; else by name against the
// address — or names none, which cannot be told and is let through.
function sameAccount(idToken, email, mailKey) {
  var key = trimmed(mailKey)
  if (key !== "") return accountKey(idToken) === key
  var who = signedInAs(idToken)
  return who === "" || who === trimmed(email).toLowerCase()
}

function otherAccountMessage(who, email) {
  var name = String(who || "")
  return "the second code was entered as " + (name !== "" ? name : "another Microsoft account")
    + ", not " + trimmed(email) + ". Sign in to Microsoft as the mailbox's own account"
}

function graphScopeNames() {
  var names = []
  for (var i = 0; i < GRAPH_SCOPES.length; i++) {
    var value = String(GRAPH_SCOPES[i] || "")
    names.push(value.substring(value.lastIndexOf("/") + 1))
  }
  return names.join(" and ")
}

// What a Graph sign-in that did not go through leaves on the setup page:
// the mailbox is signed in, and how to ask again — or whom to ask, where
// Microsoft wanted an administrator's approval, which the refusal that
// started it cannot tell from consent nobody has given yet.
function graphRefusedMessage(reason) {
  return "Microsoft Graph was not allowed: " + String(reason || "") + ". The mailbox is signed in; "
    + "Allow Microsoft Graph... in its settings asks again. If Microsoft asked for admin approval, "
    + "an administrator must grant the app registration " + graphScopeNames() + " first"
}

// Microsoft's answer to an exchange for a resource the user has not
// consented this client to: a bad grant that a sign-in can mend, told apart
// from one that cannot — a revoked or expired session — by its sub-error or
// its code (AADSTS65001).
function consentRequired(payload) {
  if (!payload || typeof payload !== "object") return false
  var code = String(payload.error || "")
  if (code !== "invalid_grant" && code !== "interaction_required") return false
  if (String(payload.suberror || "") === "consent_required") return true
  var codes = Array.isArray(payload.error_codes) ? payload.error_codes : []
  for (var i = 0; i < codes.length; i++) if (Number(codes[i]) === 65001) return true
  return /AADSTS65001/.test(String(payload.error_description || ""))
}

function graphConsentMessage() {
  return "Microsoft Graph needs its own consent for this mailbox. "
    + "Open the mailbox's settings and press Allow Microsoft Graph"
}

function missingMailScopes(granted) {
  var missing = []
  for (var i = 0; i < SCOPES.length; i++) {
    var scope = SCOPES[i]
    // Not resource scopes: a token answer does not list them.
    if (scope === "offline_access" || scope === "openid") continue
    if (!scopeListed(granted, scope)) missing.push(scope)
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
