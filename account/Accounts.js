.pragma library

.import "Aliases.js" as Aliases

// The list of Gmail accounts and which one the window is showing. One account
// was the original design; several is a list plus a selection, and every rule
// about what that selection may point at lives here so the QML only has to
// paint rows and call one of these functions.
//
// Everything is pure and every mutator returns a new list: the QML side owns
// the file and the keyring, and a list handed to a view must not change under
// it after it has been rendered.

var VERSION = 1

// Not RFC 5322 — that is unimplementable and the wrong question anyway. This
// only has to separate "an address Google could have given us" from a blank
// field or a typed-in fragment, so a domain with a dot in it is the test.
var EMAIL_PATTERN = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

function emptyList() {
  return { version: VERSION, accounts: [], activeId: "" }
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

// Whether text is an accounts file rather than a failed or half-finished read.
// `load` deliberately turns either into an empty list for first run; a service
// that already has accounts needs the distinction so a transient FileView
// failure cannot replace them with the first-run placeholder.
function isSerializedList(text) {
  var raw = parseJson(text, null)
  return isObject(raw) && Number(raw.version) === VERSION
    && Array.isArray(raw.accounts)
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(trimmed(value))
}

// Addresses are case-insensitive in practice and a server echoes the address
// back in whatever case it was typed, so it is normalised once here and
// everything downstream compares ids rather than emails.
//
// One address can also legitimately be two mailboxes: a Gmail account reached
// through Google's API, and the same address reached over IMAP with an app
// password. Keyed on the address alone they would be one entry, each sign-in
// overwriting the other's.
//
// A Gmail account keeps the bare address as its id, so nothing already on disk
// — its cache directory, its keyring entry, the activeId in accounts.json —
// has to be migrated. Only the providers that did not exist before carry a
// prefix.
function accountId(email, provider) {
  if (!isValidEmail(email)) return ""
  var address = trimmed(email).toLowerCase()
  var kind = normalizeProvider(provider)
  return kind === DEFAULT_PROVIDER ? address : kind + ":" + address
}

// Which service this mailbox is. Anything unrecognised — and, importantly,
// anything written before providers existed — is Gmail: that is what every
// account in an upgraded install actually is, and defaulting to it is what
// stops an upgrade from presenting a working mailbox as unconfigured.
var PROVIDERS = ["gmail", "hey", "imap"]
var DEFAULT_PROVIDER = "gmail"

function normalizeProvider(value) {
  var name = trimmed(value).toLowerCase()
  for (var i = 0; i < PROVIDERS.length; i++) {
    if (PROVIDERS[i] === name) return name
  }
  return DEFAULT_PROVIDER
}

// The server settings an IMAP account needs. Kept on the account rather than
// in the credentials file because none of it is secret — the password is the
// secret, and that lives in the keyring. A host here is not trusted: `Imap.js`
// validates it again before it can reach a URL.
// A port out of range falls back to the default rather than being clamped into
// range. Clamping turns 999999 into 65535 — a port that is valid, reachable and
// not the one anybody meant, which fails as a connection nobody can explain.
// The same rule as `Imap.normalizedPort`, deliberately: two normalisers that
// disagree about the same field is a bug waiting for the one caller that uses
// the other one.
function portOr(value, fallback) {
  var port = Math.floor(Number(value))
  if (!isFinite(port) || port < 1 || port > 65535) return fallback
  return port
}

function makeImapSettings(raw) {
  var values = raw || {}
  return {
    imapHost: trimmed(values.imapHost),
    imapPort: portOr(values.imapPort, 993),
    smtpHost: trimmed(values.smtpHost),
    smtpPort: portOr(values.smtpPort, 465),
    username: trimmed(values.username),
    aliases: Aliases.parse(values.aliases),
    insecure: values.insecure === true
  }
}

// The address arrives with the first successful sign-in for Gmail, and is
// typed by hand for IMAP, so an account exists for a while with no id at all.
// Such an entry is kept — it holds the OAuth client or the server settings the
// sign-in needs — but it is not addressable, and the guard in indexOfId is what
// keeps it out of every lookup.
function makeAccount(account) {
  var raw = account || {}
  var email = trimmed(raw.email)
  var provider = normalizeProvider(raw.provider)
  return {
    id: accountId(email, provider),
    email: email,
    provider: provider,
    clientId: trimmed(raw.clientId),
    clientSecret: trimmed(raw.clientSecret),
    imap: makeImapSettings(raw.imap),
    label: trimmed(raw.label)
  }
}

function copyList(list) {
  var source = list || emptyList()
  return {
    version: VERSION,
    accounts: Array.isArray(source.accounts) ? source.accounts.slice() : [],
    activeId: String(source.activeId || "")
  }
}

// An empty id matches nothing, deliberately: it is what every pending account
// carries, and letting it match would make find, setActive and remove all act
// on an arbitrary one of them.
function indexOfId(accounts, id) {
  var key = trimmed(id)
  if (!key) return -1
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i] && accounts[i].id === key) return i
  }
  return -1
}

function find(list, id) {
  var source = copyList(list)
  var at = indexOfId(source.accounts, id)
  return at < 0 ? null : source.accounts[at]
}

function active(list) {
  return find(list, (list || {}).activeId)
}

function count(list) {
  var source = list || {}
  return Array.isArray(source.accounts) ? source.accounts.length : 0
}

// A pending row is implementation detail, not an account. In particular this
// must not be inferred from whether a host is signed in: sessions are restored
// asynchronously, and signed-out accounts still exist and must never be
// overwritten by Add account.
function hasSavedAccounts(list) {
  var source = list || {}
  var values = Array.isArray(source.accounts) ? source.accounts : []
  for (var i = 0; i < values.length; i++) {
    var entry = values[i] || {}
    if (trimmed(entry.id) !== "" || trimmed(entry.email) !== "") return true
  }
  return false
}

// Shown in the switcher. A pending account has neither a label nor an address
// yet and still needs a name, or its row is an empty strip nobody can aim at.
function label(account) {
  var raw = account || {}
  var name = trimmed(raw.label)
  if (name) return name
  var local = trimmed(raw.email).split("@")[0]
  return local || "New account"
}

// ------------------------------------------------------------------ edits

// Re-adding an address is how a wrong client id or a new label gets corrected,
// so it replaces the entry where it already sits. Appending instead would show
// the same mailbox twice, and moving it to the end would lose the order the
// user put their accounts in.
function add(list, account) {
  var next = copyList(list)
  var entry = makeAccount(account)
  var at = indexOfId(next.accounts, entry.id)
  if (at >= 0) next.accounts[at] = entry
  else next.accounts.push(entry)
  // Nothing is on screen until the first account with a real address arrives;
  // once one has, adding another must not yank the view away from it.
  if (entry.id && indexOfId(next.accounts, next.activeId) < 0) next.activeId = entry.id
  return next
}

// The neighbour that slides into the removed row is the least surprising
// replacement, and the scan wraps so removing the last row falls back up the
// list. Pending accounts are skipped: the window cannot show one.
function nextActiveId(accounts, from) {
  for (var i = 0; i < accounts.length; i++) {
    var entry = accounts[(from + i) % accounts.length]
    if (entry && entry.id) return entry.id
  }
  return ""
}

function remove(list, id) {
  var next = copyList(list)
  var at = indexOfId(next.accounts, id)
  if (at < 0) return next
  var wasActive = next.accounts[at].id === next.activeId
  next.accounts.splice(at, 1)
  if (wasActive) next.activeId = nextActiveId(next.accounts, at)
  return next
}

// An id that is not in the list means the caller is acting on a list that has
// moved on. Leaving the previous account on screen is better than blanking the
// window, so an unknown id — "" included — changes nothing.
// An account that never finished signing in has no id, so nothing can name it
// — and a failed sign-in leaves exactly that. Removing by position is the only
// handle the window has on one.
function removeAt(list, index) {
  var source = copyList(list)
  var at = Math.floor(Number(index))
  if (!isFinite(at) || at < 0 || at >= source.accounts.length) return source
  var removed = source.accounts[at]
  source.accounts.splice(at, 1)
  if (removed.id !== "" && source.activeId === removed.id)
    source.activeId = nextActiveId(source.accounts, at)
  return source
}

// The request is an immutable description of the row the user saw. Keeping
// both its id and position lets confirmation reject a stale request instead of
// deleting whichever account later moved into the same row.
function removalRequest(list, index) {
  var values = Array.isArray((list || {}).accounts) ? list.accounts : []
  if (values.length <= 1) return null
  var at = Math.floor(Number(index))
  if (!isFinite(at) || at < 0 || at >= values.length) return null
  var entry = values[at] || {}
  if (!entry.id) return null
  return { id: String(entry.id || ""), email: String(entry.email || ""), index: at }
}

function confirmRemoval(list, request) {
  if (!request) return -1
  var values = Array.isArray((list || {}).accounts) ? list.accounts : []
  var at = Math.floor(Number(request.index))
  if (!isFinite(at) || at < 0 || at >= values.length) return -1
  var entry = values[at] || {}
  var id = String(request.id || "")
  return id !== "" && String(entry.id || "") === id ? at : -1
}

function discardDraftAt(list, index) {
  var source = copyList(list)
  var at = Math.floor(Number(index))
  if (!isFinite(at) || at < 0 || at >= source.accounts.length) return source
  if (source.accounts[at].id !== "") return source
  return removeAt(source, at)
}

function setActive(list, id) {
  var next = copyList(list)
  var at = indexOfId(next.accounts, id)
  if (at >= 0) next.activeId = next.accounts[at].id
  return next
}

// ------------------------------------------------------------ persistence

// Anything unreadable becomes an empty list rather than an error. A user with
// a corrupt file has to be able to add an account again from the UI; a startup
// failure leaves them with nothing to do it from.
function load(text) {
  var raw = parseJson(text, null)
  if (!isSerializedList(text)) return emptyList()

  var next = emptyList()
  var entries = Array.isArray(raw.accounts) ? raw.accounts : []
  for (var i = 0; i < entries.length; i++) {
    if (!isObject(entries[i])) continue
    var entry = makeAccount(entries[i])
    // The id is recomputed rather than trusted, so a hand-edited file cannot
    // introduce two entries the rest of the code believes are different
    // accounts while Gmail treats them as one.
    if (entry.id && indexOfId(next.accounts, entry.id) >= 0) continue
    next.accounts.push(entry)
  }

  var wanted = trimmed(raw.activeId).toLowerCase()
  next.activeId = indexOfId(next.accounts, wanted) >= 0 ? wanted : nextActiveId(next.accounts, 0)
  return next
}

// Compact rather than indented: this crosses a line-oriented pipe on the way
// to disk, so a newline in the middle of it truncates the account list. JSON
// escapes the newlines a label could contain, which is the other half of that.
function serialize(list) {
  return JSON.stringify(copyList(list))
}
