.pragma library

// A local copy of everything the window shows, so switching mailboxes paints
// immediately and the network only ever updates what is already on screen.
//
// One account is one JSON file rewritten atomically, which is the right shape
// for a few hundred kilobytes and the wrong shape for megabytes — hence the
// caps below. Accounts get separate files so switching between them keeps both
// caches, which is the entire reason a cache exists. Everything here is pure:
// CacheStore.qml owns the file.

var VERSION = 1
var MAX_QUERIES = 12
var MAX_BODIES = 60

function emptyStore() {
  return { version: VERSION, account: "", profile: null, labels: [], queries: {}, bodies: {} }
}

function parseJson(text, fallback) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Anything unreadable becomes an empty cache. A cache is a convenience; a
// corrupt one must never stop the app from starting.
function load(text) {
  var raw = parseJson(text, null)
  if (!isObject(raw)) return emptyStore()
  if (Number(raw.version) !== VERSION) return emptyStore()
  var store = emptyStore()
  store.account = String(raw.account || "")
  store.profile = isObject(raw.profile) ? raw.profile : null
  store.labels = Array.isArray(raw.labels) ? raw.labels : []
  store.queries = isObject(raw.queries) ? raw.queries : {}
  store.bodies = isObject(raw.bodies) ? raw.bodies : {}
  return store
}

function serialize(store) {
  return JSON.stringify(store || emptyStore())
}

function queryKey(query, maxResults) {
  return String(query || "").replace(/^\s+|\s+$/g, "")
    + "|" + Math.max(1, Math.floor(Number(maxResults) || 25))
}

// ------------------------------------------------------------- hydration
//
// Dates do not survive JSON, so they cross as epoch milliseconds. Left as
// Date objects they come back as strings and every cached row renders
// "Invalid Date".

function dehydrate(summaries) {
  var list = Array.isArray(summaries) ? summaries : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = {}
    for (var key in list[i]) {
      if (key === "date") continue
      entry[key] = list[i][key]
    }
    var at = list[i].date ? list[i].date.getTime() : NaN
    entry.dateMs = isFinite(at) ? at : null
    out.push(entry)
  }
  return out
}

function hydrate(entries) {
  var list = Array.isArray(entries) ? entries : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var summary = {}
    for (var key in list[i]) {
      if (key === "dateMs") continue
      summary[key] = list[i][key]
    }
    var at = Number(list[i].dateMs)
    summary.date = isFinite(at) && at > 0 ? new Date(at) : null
    out.push(summary)
  }
  return out
}

// ---------------------------------------------------------------- queries

function copyStore(store) {
  var source = store || emptyStore()
  return {
    version: VERSION,
    account: source.account || "",
    profile: source.profile || null,
    labels: source.labels || [],
    queries: source.queries || {},
    bodies: source.bodies || {}
  }
}

function putQuery(store, key, page, nowMs) {
  var next = copyStore(store)
  var queries = {}
  for (var existing in next.queries) queries[existing] = next.queries[existing]
  queries[String(key)] = {
    summaries: dehydrate(page && page.summaries),
    estimate: Math.max(0, Math.floor(Number(page && page.estimate) || 0)),
    nextPageToken: String(page && page.nextPageToken ? page.nextPageToken : ""),
    at: Number(nowMs) || 0
  }
  next.queries = queries
  return next
}

function getQuery(store, key) {
  var source = store || emptyStore()
  var entry = source.queries ? source.queries[String(key)] : null
  return isObject(entry) ? entry : null
}

function putBody(store, id, body, nowMs) {
  var next = copyStore(store)
  var bodies = {}
  for (var existing in next.bodies) bodies[existing] = next.bodies[existing]
  bodies[String(id)] = {
    text: String(body && body.text ? body.text : ""),
    source: String(body && body.source ? body.source : ""),
    html: String(body && body.html ? body.html : ""),
    attachments: Array.isArray(body && body.attachments) ? body.attachments : [],
    at: Number(nowMs) || 0
  }
  next.bodies = bodies
  return next
}

function getBody(store, id) {
  var source = store || emptyStore()
  var entry = source.bodies ? source.bodies[String(id)] : null
  return isObject(entry) ? entry : null
}

function putLabels(store, labels, nowMs) {
  var next = copyStore(store)
  next.labels = Array.isArray(labels) ? labels : []
  return next
}

function putProfile(store, profile, nowMs) {
  var next = copyStore(store)
  next.profile = isObject(profile) ? profile : null
  if (next.profile && next.profile.email) next.account = String(next.profile.email)
  return next
}

// ------------------------------------------------------------ file naming
//
// One file per account, named after the address so a store on disk can be
// matched to its mailbox by eye. The address is lower-cased first: mail
// addresses are compared case-insensitively in practice, and two files for one
// mailbox would silently halve the cache — which also keeps the name unique on
// a case-insensitive filesystem, where the two spellings could not coexist.
//
// Every character outside [a-z0-9.-] becomes "_" plus the lower-case hex of one
// UTF-8 byte. Nothing else can produce a "_", so the encoding is prefix-free
// and reversible, and two different addresses therefore cannot land on one
// name. Reversibility is also what makes the name safe: no "/", NUL, space, or
// newline survives it, so the result is always a single component that stays
// inside the cache directory.

var SAFE_NAME_CHAR = /^[a-z0-9.\-]$/

// A file name has to fit in 255 bytes and an address may be four times its own
// length once escaped.
var MAX_NAME_CHARS = 120

function hexByte(code) {
  var text = code.toString(16)
  return text.length < 2 ? "0" + text : text
}

// encodeURIComponent is the only UTF-8 encoder the QML engine has. It leaves a
// handful of ASCII punctuation alone, which the code-point branch catches, and
// it throws on a surrogate that lost its partner — "_u" cannot begin a byte
// escape, so that fallback stays distinguishable from an encoded byte.
function escapeNameChar(text) {
  var code = text.charCodeAt(0)
  if (code < 128) return "_" + hexByte(code)
  try {
    return encodeURIComponent(text).replace(/%/g, "_").toLowerCase()
  } catch (e) {
    return "_u" + ("000" + code.toString(16)).slice(-4)
  }
}

function encodeAccountId(id) {
  var out = ""
  for (var i = 0; i < id.length; i++) {
    var ch = id.charAt(i)
    if (SAFE_NAME_CHAR.test(ch)) {
      out += ch
      continue
    }
    // A character above the basic plane is two code units, and half a pair is
    // not a character encodeURIComponent will accept.
    var code = ch.charCodeAt(0)
    var next = i + 1 < id.length ? id.charCodeAt(i + 1) : 0
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out += escapeNameChar(id.substr(i, 2))
      i++
      continue
    }
    out += escapeNameChar(ch)
  }
  return out
}

// 32-bit FNV-1a. The multiply is written as shifts because a 32-bit product
// through a double loses its low bits, and Math.imul is younger than the
// engine this runs in.
function fnv1a(text) {
  var hash = 0x811c9dc5
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16)
}

function fileName(accountId) {
  var encoded = encodeAccountId(String(accountId || "").toLowerCase())
  // A missing address still needs somewhere to put a store. The trailing "_"
  // is what keeps this name out of every real address's reach: the encoder
  // never leaves a "_" without hex behind it.
  if (encoded === "") return "account-none_.json"
  if (encoded.length > MAX_NAME_CHARS) {
    // Past this length the name stops being reversible, so it carries a hash
    // of the whole address to keep two long look-alikes apart. A truncated
    // name is longer than any untruncated one, so the two forms cannot meet.
    encoded = encoded.substr(0, MAX_NAME_CHARS) + "-" + fnv1a(encoded)
  }
  return "account-" + encoded + ".json"
}

// A cache belongs to one mailbox, and showing one account's mail under
// another's name would be the worst bug this file could have. Each account now
// has its own file, so a mismatch here is no longer an account switch — it
// means the wrong file was handed to the wrong mailbox, and the only safe
// answer is to show nothing until the network refills it. The other account's
// file is untouched either way.
//
// An empty address only means the profile has not loaded yet, and a store with
// no address yet was still read from this mailbox's own file, so its rows are
// this mailbox's rows.
function forAccount(store, email) {
  var address = String(email || "")
  if (address === "") return copyStore(store)
  var source = copyStore(store)
  if (source.account === "") {
    source.account = address
    return source
  }
  if (source.account.toLowerCase() === address.toLowerCase()) return source
  var fresh = emptyStore()
  fresh.account = address
  return fresh
}

function isStale(at, nowMs, ttlMs) {
  var stamp = Number(at)
  if (!isFinite(stamp) || stamp <= 0) return true
  var now = Number(nowMs) || 0
  var ttl = Math.max(0, Number(ttlMs) || 0)
  // A clock that went backwards makes `now - stamp` negative, which must read
  // as fresh rather than as immortal or expired.
  return now - stamp > ttl
}

// ---------------------------------------------------------------- pruning

function keepNewest(bucket, limit) {
  var keys = []
  for (var key in bucket) keys.push(key)
  if (keys.length <= limit) return bucket
  keys.sort(function(a, b) {
    return (Number(bucket[b].at) || 0) - (Number(bucket[a].at) || 0)
  })
  var kept = {}
  for (var i = 0; i < limit; i++) kept[keys[i]] = bucket[keys[i]]
  return kept
}

function prune(store) {
  var next = copyStore(store)
  next.queries = keepNewest(next.queries, MAX_QUERIES)
  next.bodies = keepNewest(next.bodies, MAX_BODIES)
  return next
}
