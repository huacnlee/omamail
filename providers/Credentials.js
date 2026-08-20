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

// ------------------------------------------------------------------- store
//
// Several accounts share one file, because a Cloud OAuth client belongs to a
// project rather than to a mailbox: two accounts may legitimately run on one
// client, and two others may each need their own.
//
// A lone account that has never been named keeps the console's own shape, so
// the file stays interchangeable with a freshly downloaded one and a build
// from before accounts existed still reads it:
//
//   {"installed": {...}}
//
// Anything else is written as:
//
//   {"version":2,"accounts":[{"id":"me@gmail.com","installed":{...}}, ...]}
//
// A list rather than an object keyed by id, because the order is the order the
// panel shows accounts in — that is data, not an artefact of how a JSON object
// happens to be written out.
var FILE_VERSION = 2

function emptyStore() {
  return { accounts: [] }
}

// The id is whatever the caller knows the account by — the address once a
// sign-in has produced one, "" for a file written before accounts had names.
function accountEntry(accountId, credentials) {
  var value = credentials || empty()
  return {
    id: trimmed(accountId),
    clientId: trimmed(value.clientId),
    clientSecret: trimmed(value.clientSecret),
    projectId: trimmed(value.projectId)
  }
}

function credentialsOf(entry) {
  return { clientId: entry.clientId, clientSecret: entry.clientSecret, projectId: entry.projectId }
}

function isStore(value) {
  return !!value && !!value.accounts && typeof value.accounts.length === "number"
}

// Every entry point takes either a store or a single credentials object, so
// the single-account callers that predate this module's split keep working.
function asStore(value) {
  if (!isStore(value)) return { accounts: [accountEntry("", value)] }
  var store = emptyStore()
  for (var i = 0; i < value.accounts.length; i++) {
    var entry = value.accounts[i]
    if (entry) store.accounts.push(accountEntry(entry.id, entry))
  }
  return store
}

function accountIds(store) {
  var accounts = asStore(store).accounts
  var ids = []
  for (var i = 0; i < accounts.length; i++) ids.push(accounts[i].id)
  return ids
}

// Case folded, because an address is the usual id and a mailbox typed as
// Me@Gmail.com is the same account as me@gmail.com — two entries for it would
// mean two half-signed-in accounts.
function accountKey(accountId) {
  return trimmed(accountId).toLowerCase()
}

function indexOfAccount(accounts, accountId) {
  var wanted = accountKey(accountId)
  for (var i = 0; i < accounts.length; i++) {
    if (accountKey(accounts[i].id) === wanted) return i
  }
  return -1
}

function forAccount(store, accountId) {
  var accounts = asStore(store).accounts
  var found = indexOfAccount(accounts, accountId)
  if (found >= 0) return credentialsOf(accounts[found])
  // The pre-accounts file holds one nameless entry. An account that has since
  // learned its own address still has to find its client there, or the first
  // upgrade looks exactly like a missing client and asks for setup again.
  if (accounts.length === 1 && !accounts[0].id) return credentialsOf(accounts[0])
  return empty()
}

// Replaces in place rather than appending, so saving a client twice for one
// account does not push it to the end of the panel's list.
function withAccount(store, accountId, credentials) {
  var next = asStore(store)
  var entry = accountEntry(accountId, credentials)
  var found = indexOfAccount(next.accounts, accountId)
  if (found >= 0) next.accounts[found] = entry
  else next.accounts.push(entry)
  return next
}

function installedBlock(value) {
  return {
    client_id: trimmed(value.clientId),
    project_id: trimmed(value.projectId),
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: trimmed(value.clientSecret),
    redirect_uris: ["http://localhost"]
  }
}

// Compact rather than indented, and one line whether it holds one account or
// six: it crosses a line-oriented pipe on the way to disk, whose `read` stops
// at the first newline.
function serialize(value) {
  var accounts = asStore(value).accounts
  if (accounts.length === 0) return JSON.stringify({ installed: installedBlock(empty()) })
  if (accounts.length === 1 && !accounts[0].id)
    return JSON.stringify({ installed: installedBlock(accounts[0]) })

  var entries = []
  for (var i = 0; i < accounts.length; i++) {
    entries.push({ id: accounts[i].id, installed: installedBlock(accounts[i]) })
  }
  return JSON.stringify({ version: FILE_VERSION, accounts: entries })
}

// A single account that fails to parse leaves the rest readable: one hand-
// edited entry should not sign every other account out.
function storeFromObject(raw) {
  var store = emptyStore()
  if (!raw || typeof raw !== "object") return store

  if (raw.accounts && typeof raw.accounts.length === "number") {
    for (var i = 0; i < raw.accounts.length; i++) {
      var entry = raw.accounts[i]
      if (!entry || typeof entry !== "object") continue
      var result = fromObject(entry)
      if (!result.ok) continue
      if (indexOfAccount(store.accounts, entry.id) >= 0) continue
      store.accounts.push(accountEntry(entry.id, result.credentials))
    }
    return store
  }

  var single = fromObject(raw)
  if (single.ok) store.accounts.push(accountEntry("", single.credentials))
  return store
}

function loadStore(text) {
  var raw = String(text || "").trim()
  if (!raw) return emptyStore()
  return storeFromObject(parseJson(raw, null))
}

function load(text, accountId) {
  return forAccount(loadStore(text), accountId)
}

// A Cloud OAuth client belongs to a project, not to a mailbox. One client signs
// in every account its owner has — which is exactly why the keyring keys tokens
// by account as well as by client — so an account with no client of its own
// borrows the one already set up.
//
// Without this, adding a second mailbox drops the user back on the console
// walkthrough they already completed, to make a second client they do not need.
function sharedClient(store) {
  var accounts = asStore(store).accounts
  for (var i = 0; i < accounts.length; i++) {
    var found = credentialsOf(accounts[i])
    if (isConfigured(found)) return found
  }
  return empty()
}

// The user's own client always wins: someone who went to the trouble of making
// one wants their own quota and their own consent screen, not the shipped one.
function effective(fileText, accountId) {
  var store = loadStore(fileText)
  var own = forAccount(store, accountId)
  if (isConfigured(own)) return own
  var shared = sharedClient(store)
  if (isConfigured(shared)) return shared
  return builtin()
}

function usingBuiltin(fileText, accountId) {
  var store = loadStore(fileText)
  if (isConfigured(forAccount(store, accountId))) return false
  if (isConfigured(sharedClient(store))) return false
  return hasBuiltin()
}

function path(home) {
  var base = trimmed(home)
  return (base || "~") + "/.config/omamail/credentials.json"
}

// ----------------------------------------------------------------- keyring
//
// The refresh token is keyed by account as well as by client, because two
// accounts may share one client: keyed by client alone, the second sign-in
// would overwrite the first account's token and silently sign it out.
var KEYRING_SERVICE = "omamail"
var RENAMED_KEYRING_SERVICE = "omarchy-gmail"
var KEYRING_KIND = "refresh-token"

// secret-tool reads an empty attribute value as "match anything", which would
// hand back some other account's token, so an account with no name yet gets a
// literal one. No address can collide with it: every address has an "@".
var UNNAMED_ACCOUNT = "default"

// Alternating name, value — the form secret-tool takes on its command line.
// An entry with no client id is not addressable at all, and asking for one
// would be a wildcard lookup over every token this plugin ever stored.
function keyringAttributes(clientId, accountId) {
  var id = trimmed(clientId)
  if (!id) return []
  return [
    "service", KEYRING_SERVICE,
    "kind", KEYRING_KIND,
    "client-id", id,
    "account", accountKey(accountId) || UNNAMED_ACCOUNT
  ]
}

// What a single-account install stored before accounts existed. Such an entry
// has no "account" attribute, so the lookup above never matches it: it is read
// once with these and written back with the ones above, rather than leaving
// the user staring at a sign-in button that used to say they were signed in.
function legacyKeyringAttributes(clientId) {
  var id = trimmed(clientId)
  if (!id) return []
  return ["service", KEYRING_SERVICE, "kind", KEYRING_KIND, "client-id", id]
}

// An IMAP account has no OAuth client to key on — it has a server and a
// password. The attributes therefore key on the account alone, under a kind of
// their own so an IMAP password and a Gmail refresh token for the same address
// are two entries rather than one overwriting the other.
var IMAP_KEYRING_KIND = "imap-password"

function imapKeyringAttributes(accountId) {
  var id = accountKey(accountId)
  // As above: an empty attribute value is a wildcard to secret-tool, which
  // would hand back some other account's password. An account with no name yet
  // gets the literal placeholder, which no address can collide with.
  return ["service", KEYRING_SERVICE, "kind", IMAP_KEYRING_KIND,
    "account", id || UNNAMED_ACCOUNT]
}

// Entries from before the Omamail rename are read once and rewritten under
// the new service name, so an upgrade keeps the user's signed-in session.
function renamedKeyringAttributes(clientId, accountId) {
  var attributes = keyringAttributes(clientId, accountId)
  if (attributes.length) attributes[1] = RENAMED_KEYRING_SERVICE
  return attributes
}

function renamedLegacyKeyringAttributes(clientId) {
  var attributes = legacyKeyringAttributes(clientId)
  if (attributes.length) attributes[1] = RENAMED_KEYRING_SERVICE
  return attributes
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
