.pragma library

// A local copy of everything the window shows, so switching mailboxes paints
// immediately and the network only ever updates what is already on screen.
//
// One account is one JSON file rewritten atomically, which is the right shape
// for a few hundred kilobytes and the wrong shape for megabytes — hence the
// caps below. Accounts get separate files so switching between them keeps both
// caches, which is the entire reason a cache exists. Everything here is pure:
// Rust owns the file; this module holds the current presentation snapshot.

// Bumped for the summary fields a page is read for: rows written before
// `inSpam` and `isSent` existed answer "not spam" to a menu that asks, and
// offer to move a spam message to the inbox until the first load replaces
// them. Bodies are separate files, so a bump costs one cold list load.
var VERSION = 2
var MAX_QUERIES = 12
var MAX_SUMMARIES_PER_QUERY = 100
// Bodies are the one thing worth keeping deep: a message body never changes, so
// a hit is always correct and always saves a round trip. They live one file per
// message rather than in this store — measured against a real mailbox a body
// runs 5KB at the median and 35KB at the top, and a thousand of those inside
// the store would mean re-serialising megabytes on the GUI thread every time a
// list changed. As files they cost nothing to keep and nothing to save, and the
// ceiling is a plain file count.
var MAX_BODIES = 1000

function emptyStore() {
  return { version: VERSION, account: "", profile: null, labels: [], queries: {}, session: null }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function queryKey(query, maxResults) {
  return String(query || "").replace(/^\s+|\s+$/g, "")
    + "|" + Math.max(1, Math.floor(Number(maxResults) || 25))
}

function queryFromKey(key) {
  return String(key || "").replace(/\|\d+$/, "")
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
    session: source.session || null
  }
}

function putQuery(store, key, page, nowMs) {
  var next = copyStore(store)
  var queries = {}
  for (var existing in next.queries) queries[existing] = next.queries[existing]
  var source = page && Array.isArray(page.summaries) ? page.summaries : []
  var capped = source.slice(0, MAX_SUMMARIES_PER_QUERY)
  queries[String(key)] = {
    summaries: dehydrate(capped),
    estimate: Math.max(0, Math.floor(Number(page && page.estimate) || 0)),
    // A token that follows rows omitted from the cache would skip them after a
    // restart. The live first-page refresh supplies a new token shortly after
    // the capped preview is painted, so closing pagination meanwhile is the
    // only honest answer.
    nextPageToken: source.length > capped.length ? ""
      : String(page && page.nextPageToken ? page.nextPageToken : ""),
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

// --------------------------------------------------------- local search
//
// A typed search has no cache entry the first time it is made, but the store
// already holds the sender, recipients, subject and snippet of every row the
// account has shown. Those rows are enough for a useful immediate answer while
// the provider searches headers and bodies on the server.
//
// This is deliberately a conservative subset of provider search syntax. A
// term carrying `:` or a leading `-` may be an operator whose meaning belongs
// to Gmail, HEY or IMAP; pretending it is ordinary text would put rows on
// screen that do not answer the query. An exact cached query is still painted
// by MailAccount before this fallback is considered.

function localSearchTerms(query) {
  var text = String(query === undefined || query === null ? "" : query)
    .replace(/^\s+|\s+$/g, "").toLowerCase()
  if (text === "") return []

  var terms = []
  var current = ""
  var quoted = false
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i)
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (/\s/.test(character) && !quoted) {
      if (current !== "") terms.push(current)
      current = ""
    } else {
      current += character
    }
  }
  if (current !== "") terms.push(current)

  for (var j = 0; j < terms.length; j++) {
    if (terms[j].charAt(0) === "-" || terms[j].indexOf(":") >= 0) return []
  }
  return terms
}

function addressSearchText(address) {
  if (!address) return ""
  return String(address.display || "") + " " + String(address.name || "")
    + " " + String(address.email || "")
}

function addressListSearchText(addresses) {
  var list = Array.isArray(addresses) ? addresses : []
  var text = ""
  for (var i = 0; i < list.length; i++) text += " " + addressSearchText(list[i])
  return text
}

function summarySearchText(summary) {
  var row = summary || {}
  return (addressSearchText(row.from)
    + addressListSearchText(row.to)
    + addressListSearchText(row.cc)
    + " " + String(row.subject || "")
    + " " + String(row.snippet || "")).toLowerCase()
}

function matchesLocalSearch(summary, terms) {
  var wanted = Array.isArray(terms) ? terms : []
  if (wanted.length === 0) return false
  var text = summarySearchText(summary)
  for (var i = 0; i < wanted.length; i++) {
    if (text.indexOf(wanted[i]) < 0) return false
  }
  return true
}

// All matching rows from eligible cached queries, newest first and only once
// per message. Which cached mailbox belongs to a provider search is a provider
// fact, so the caller supplies that predicate. Queries are read newest first;
// the newest copy decides both the row and its current scope, while older
// copies may still supply searchable fields an earlier build omitted.
function searchSummaries(store, query, includes) {
  var terms = localSearchTerms(query)
  if (terms.length === 0) return []
  var source = store || emptyStore()
  var queries = source.queries || {}
  var keys = []
  for (var key in queries) keys.push(key)
  keys.sort(function(a, b) {
    return (Number(queries[b] && queries[b].at) || 0)
      - (Number(queries[a] && queries[a].at) || 0)
  })

  var positions = {}
  var candidates = []
  var order = 0
  for (var i = 0; i < keys.length; i++) {
    var sourceQuery = queryFromKey(keys[i])
    var rows = hydrate(queries[keys[i]] && queries[keys[i]].summaries)
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j]
      var id = String(row && row.id ? row.id : "")
      if (id === "") continue
      if (positions[id] === undefined) {
        positions[id] = candidates.length
        candidates.push({
          row: row,
          order: order++,
          eligible: typeof includes !== "function" || includes(sourceQuery, row),
          matched: false
        })
      }
      // Match against every cached copy: an older entry may carry recipients
      // that a cache written by an earlier build did not put on every row. The
      // candidate itself stays the newest copy because keys are newest first.
      if (candidates[positions[id]].eligible && matchesLocalSearch(row, terms))
        candidates[positions[id]].matched = true
    }
  }

  var found = []
  for (var candidate = 0; candidate < candidates.length; candidate++) {
    if (candidates[candidate].matched) found.push(candidates[candidate])
  }
  found.sort(function(a, b) {
    var aTime = a.row && a.row.date ? Number(a.row.date.getTime()) : 0
    var bTime = b.row && b.row.date ? Number(b.row.date.getTime()) : 0
    if (aTime !== bTime) return bTime - aTime
    return a.order - b.order
  })
  var out = []
  for (var k = 0; k < found.length; k++) out.push(found[k].row)
  return out
}





function putLabels(store, labels, nowMs) {
  var next = copyStore(store)
  next.labels = Array.isArray(labels) ? labels : []
  return next
}

// A JMAP session object, kept beside the queries it paid for. It is the
// server's answer rather than the account's settings — its URLs, its limits
// and its state all move when the server does — so it lives here, where a
// stale copy costs one refetch, rather than in accounts.json where it would
// be edited by hand.
//
// Keyed on the URL it came from and the state the server stamped on it. The
// URL because a mailbox pointed at a different server is a different session,
// and the state because that is the server's own word for "nothing has
// changed": a push saying it moved is what makes the cached copy wrong.
function putSession(store, url, state, session, nowMs) {
  var next = copyStore(store)
  next.session = isObject(session)
    ? { url: String(url || ""), state: String(state || ""), session: session, at: Number(nowMs) || 0 }
    : null
  return next
}

// The cached session for this URL, or null. A different URL answers null
// rather than the wrong server's session — the credential goes to the URLs
// read out of this object, so handing back one fetched from somewhere else is
// the one mistake here worth being careful about.
function getSession(store, url) {
  var source = store || emptyStore()
  var entry = isObject(source.session) ? source.session : null
  if (!entry || !isObject(entry.session)) return null
  if (String(entry.url || "") !== String(url || "")) return null
  return entry
}

function putProfile(store, profile, nowMs) {
  var next = copyStore(store)
  next.profile = isObject(profile) ? profile : null
  if (next.profile && next.profile.email) next.account = String(next.profile.email)
  return next
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
  var capped = {}
  for (var key in next.queries) {
    var entry = next.queries[key] || {}
    var summaries = Array.isArray(entry.summaries) ? entry.summaries : []
    capped[key] = {
      summaries: summaries.slice(0, MAX_SUMMARIES_PER_QUERY),
      estimate: Math.max(0, Math.floor(Number(entry.estimate) || 0)),
      nextPageToken: summaries.length > MAX_SUMMARIES_PER_QUERY
        ? "" : String(entry.nextPageToken || ""),
      at: Number(entry.at) || 0
    }
  }
  next.queries = capped
  return next
}
