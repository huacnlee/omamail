.pragma library

// Gmail has no shared public client the way Spotify does: every user brings
// their own Google Cloud OAuth client. This module turns whatever they have in
// hand — the JSON file the Cloud console hands out, a pasted client id, or an
// id and secret on two lines — into the one shape the rest of the plugin uses.

var CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/

// A client shipped with the plugin, so most people never see the setup at all.
// Empty until the project completes Google's OAuth verification: gmail.modify
// and gmail.send are RESTRICTED scopes, and an unverified project is stuck in
// "Testing", where Google issues refresh tokens that expire after seven days.
// Shipping a client under those terms would sign every user out weekly, which
// is worse than asking them to make their own.
//
// A desktop client's secret is explicitly not confidential to Google, so both
// values may live in this file once verification lands. Filling these in is the
// only change needed — everything downstream already prefers them.
var BUILTIN = { clientId: "", clientSecret: "", projectId: "" }

function builtin() {
  return { clientId: BUILTIN.clientId, clientSecret: BUILTIN.clientSecret, projectId: BUILTIN.projectId }
}

function hasBuiltin() {
  return isValidClientId(BUILTIN.clientId)
}

function empty() {
  return { clientId: "", clientSecret: "", projectId: "" }
}

function isValidClientId(value) {
  return CLIENT_ID_PATTERN.test(String(value || "").trim())
}

function isConfigured(credentials) {
  return !!credentials && isValidClientId(credentials.clientId)
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// The console wraps the credentials in "installed" for a desktop client and
// "web" for a web client. A web client cannot complete the loopback flow, so
// it is read but reported as the wrong type rather than silently half-working.
function fromObject(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Not a credentials file", credentials: empty() }
  var kind = ""
  var body = raw
  if (raw.installed && typeof raw.installed === "object") {
    kind = "installed"
    body = raw.installed
  } else if (raw.web && typeof raw.web === "object") {
    kind = "web"
    body = raw.web
  }

  var clientId = trimmed(body.client_id || body.clientId)
  var clientSecret = trimmed(body.client_secret || body.clientSecret)
  var projectId = trimmed(body.project_id || body.projectId)

  if (!clientId)
    return { ok: false, error: "That file has no client ID in it", credentials: empty() }
  if (!isValidClientId(clientId))
    return { ok: false, error: "That client ID is not a Google OAuth client ID", credentials: empty() }
  if (kind === "web")
    return {
      ok: false,
      error: "That is a Web application client. Create a Desktop app client instead",
      credentials: empty()
    }

  return {
    ok: true,
    error: "",
    credentials: { clientId: clientId, clientSecret: clientSecret, projectId: projectId }
  }
}

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

// Accepts the downloaded JSON, or the id and secret typed in by hand on one or
// two lines. Anything else comes back as an error the panel can show verbatim.
function parse(text) {
  var raw = String(text || "").trim()
  if (!raw) return { ok: false, error: "Paste the client ID, or the JSON file from Google Cloud", credentials: empty() }

  if (raw.charAt(0) === "{") {
    var json = parseJson(raw, null)
    if (!json) return { ok: false, error: "That is not valid JSON", credentials: empty() }
    return fromObject(json)
  }

  var lines = raw.split(/[\s,]+/)
  var clientId = ""
  var clientSecret = ""
  for (var i = 0; i < lines.length; i++) {
    var value = trimmed(lines[i])
    if (!value) continue
    if (isValidClientId(value)) clientId = value
    else if (value.indexOf("GOCSPX-") === 0 || (clientId && !clientSecret)) clientSecret = value
  }
  if (!clientId)
    return { ok: false, error: "No client ID found. It ends in .apps.googleusercontent.com", credentials: empty() }
  return {
    ok: true,
    error: "",
    credentials: { clientId: clientId, clientSecret: clientSecret, projectId: "" }
  }
}

// Written back in the console's own shape so the file stays interchangeable
// with a freshly downloaded one. Compact rather than indented: it crosses a
// line-oriented pipe on the way to disk.
function serialize(credentials) {
  var value = credentials || empty()
  return JSON.stringify({
    installed: {
      client_id: trimmed(value.clientId),
      project_id: trimmed(value.projectId),
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: trimmed(value.clientSecret),
      redirect_uris: ["http://localhost"]
    }
  })
}

function load(text) {
  var raw = String(text || "").trim()
  if (!raw) return empty()
  var result = fromObject(parseJson(raw, null))
  return result.ok ? result.credentials : empty()
}

// The user's own client always wins: someone who went to the trouble of making
// one wants their own quota and their own consent screen, not the shipped one.
function effective(fileText) {
  var own = load(fileText)
  if (isConfigured(own)) return own
  return builtin()
}

function usingBuiltin(fileText) {
  return !isConfigured(load(fileText)) && hasBuiltin()
}

function path(home) {
  var base = trimmed(home)
  return (base || "~") + "/.config/omarchy-gmail/credentials.json"
}

// Shown under the client id in the panel so a user with several Cloud projects
// can tell which one is wired up without opening the file.
function describe(credentials) {
  if (!isConfigured(credentials)) return ""
  var id = trimmed(credentials.clientId)
  var head = id.substring(0, id.indexOf("-") < 0 ? 8 : id.indexOf("-"))
  var project = trimmed(credentials.projectId)
  return project ? project + " · " + head : head
}
