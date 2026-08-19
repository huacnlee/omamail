.pragma library

// A local copy of everything the window shows, so switching mailboxes paints
// immediately and the network only ever updates what is already on screen.
//
// The whole cache is one JSON file rewritten atomically, which is the right
// shape for a few hundred kilobytes and the wrong shape for megabytes — hence
// the caps below. Everything here is pure: CacheStore.qml owns the file.

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

// A cache belongs to one mailbox. Showing one account's mail under another's
// name would be the worst bug this file could have — but an empty address
// only means the profile has not loaded yet, which is not a reason to throw
// the cache away.
function forAccount(store, email) {
  var address = String(email || "")
  if (address === "") return copyStore(store)
  var source = copyStore(store)
  if (source.account === address) return source
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
