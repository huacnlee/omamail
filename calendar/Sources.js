.pragma library

.import "Palette.js" as Palette

var VERSION = 1
var KINDS = ["caldav", "google", "hey"]
var COLOR_KEYS = Palette.keys()

function defaultColorKey(identity) { return Palette.defaultKey(identity) }

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function emptyList() {
  return { version: VERSION, sources: [] }
}

function normalizeKind(value) {
  var kind = trimmed(value).toLowerCase()
  return KINDS.indexOf(kind) >= 0 ? kind : "caldav"
}

function sourceId(raw) {
  var value = raw || {}
  var kind = normalizeKind(value.kind)
  if (kind === "google") return "google:" + trimmed(value.accountId)
  var address = trimmed(value.url).toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return kind + ":" + address
}

function makeSource(raw) {
  var value = raw || {}
  var kind = normalizeKind(value.kind)
  var id = trimmed(value.id)
  var colorKey = Palette.normalizeKey(value.colorKey)
  if (colorKey === "") colorKey = Palette.defaultKey(id)
  return {
    id: id, kind: kind, name: trimmed(value.name),
    url: trimmed(value.url), username: trimmed(value.username),
    accountId: trimmed(value.accountId), enabled: value.enabled !== false,
    readOnly: value.readOnly === true, colorKey: colorKey
  }
}

function copyList(list) {
  var value = list || emptyList()
  return {
    version: VERSION,
    sources: Array.isArray(value.sources) ? value.sources.slice() : []
  }
}

function add(list, raw) {
  var next = copyList(list)
  var source = makeSource(raw)
  if (source.id === "") return next
  var found = -1
  for (var i = 0; i < next.sources.length; i++) {
    if (next.sources[i] && next.sources[i].id === source.id) { found = i; break }
  }
  if (found >= 0) next.sources[found] = source
  else next.sources.push(source)
  return next
}

function remove(list, id) {
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (next.sources[i] && next.sources[i].id === wanted) {
      next.sources.splice(i, 1)
      break
    }
  }
  return next
}

function setEnabled(list, id, enabled) {
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (!next.sources[i] || next.sources[i].id !== wanted) continue
    var changed = makeSource(next.sources[i])
    changed.enabled = enabled !== false
    next.sources[i] = changed
    break
  }
  return next
}

function setColor(list, id, colorKey) {
  var normalized = Palette.normalizeKey(colorKey)
  if (normalized === "") return copyList(list)
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (!next.sources[i] || next.sources[i].id !== wanted) continue
    var changed = makeSource(next.sources[i])
    changed.colorKey = normalized
    next.sources[i] = changed
    break
  }
  return next
}

function validate(raw) {
  var source = makeSource(raw)
  if (source.kind === "google") {
    return source.accountId !== ""
      ? { ok: true, source: source }
      : { ok: false, error: "Choose a signed-in Google account" }
  }
  if (source.kind === "hey")
    return { ok: false, error: "The HEY CLI does not expose calendar events" }
  if (source.name === "") return { ok: false, error: "Add a calendar name" }
  if (!/^https:\/\//i.test(source.url))
    return { ok: false, error: "Use an HTTPS CalDAV calendar address" }
  if (source.username === "") return { ok: false, error: "Add the CalDAV username" }
  return { ok: true, source: source }
}

function serialize(list) {
  return JSON.stringify(copyList(list))
}

function load(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) {}
  var input = parsed && Array.isArray(parsed.sources) ? parsed.sources : []
  var list = emptyList()
  for (var i = 0; i < input.length; i++) list = add(list, input[i])
  return list
}

function keyringAttributes(sourceId) {
  var id = trimmed(sourceId)
  if (id === "") return []
  return ["service", "omamail", "kind", "calendar-password", "source", id]
}

function withGoogleAccounts(list, accountSummaries) {
  var next = copyList(list)
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i] || {}
    if (account.provider !== "gmail" || account.signedIn !== true) continue
    var accountId = trimmed(account.id || account.email)
    if (accountId === "") continue
    var saved = null
    for (var s = 0; s < next.sources.length; s++) {
      if (next.sources[s] && next.sources[s].id === "google:" + accountId) {
        saved = next.sources[s]
        break
      }
    }
    next = add(next, {
      id: "google:" + accountId,
      kind: "google",
      // Calendar errors name their source. The full address is load-bearing
      // here: two Google accounts commonly share the same local part, and the
      // mailbox's short display label cannot say which grant needs attention.
      name: trimmed(account.email || account.label || "Google Calendar"),
      accountId: accountId,
      enabled: saved ? saved.enabled !== false : true,
      // A Google calendar accepts writes through the API. Older versions
      // persisted readOnly on these synthesized sources, so it must not be
      // inherited: keeping the stamp would hide Edit and Delete after an
      // upgrade. Hand-configured CalDAV sources still keep their own flag.
      readOnly: false,
      colorKey: saved ? saved.colorKey : Palette.defaultKey("google:" + accountId)
    })
  }
  return next
}

function forAccount(list, accountId) {
  var source = list || emptyList()
  var wanted = trimmed(accountId)
  if (wanted === "") return copyList(source)
  var next = emptyList()
  var values = Array.isArray(source.sources) ? source.sources : []
  for (var i = 0; i < values.length; i++) {
    if (!values[i]) continue
    if (values[i].kind !== "google" || trimmed(values[i].accountId) === wanted)
      next = add(next, values[i])
  }
  return next
}

function providerLabel(kind) {
  var value = trimmed(kind).toLowerCase()
  if (value === "google" || value === "gmail") return "Google"
  if (value === "hey") return "HEY"
  return "CalDAV"
}

function groupByAccount(list, accountSummaries) {
  var values = list && Array.isArray(list.sources) ? list.sources : []
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  var groups = []
  var assigned = ({})

  function calendarMatches(source, account) {
    var accountId = trimmed(account.id || account.email).toLowerCase()
    var email = trimmed(account.email).toLowerCase()
    var owner = trimmed(source.accountId).toLowerCase()
    var username = trimmed(source.username).toLowerCase()
    if (owner !== "" && (owner === accountId || owner === email)) return true
    return source.kind === "caldav" && email !== "" && username === email
  }

  for (var a = 0; a < accounts.length; a++) {
    var account = accounts[a] || {}
    var calendars = []
    for (var i = 0; i < values.length; i++) {
      var source = values[i] || {}
      if (assigned[source.id] || !calendarMatches(source, account)) continue
      calendars.push(source)
      assigned[source.id] = true
    }
    if (calendars.length === 0) continue
    groups.push({
      id: "account:" + trimmed(account.id || account.email),
      providerLabel: providerLabel(calendars[0].kind || account.provider),
      accountLabel: account.provider === "gmail"
        ? trimmed(account.email || account.label || "Google account")
        : trimmed(account.label || account.email || "Account"),
      calendars: calendars
    })
  }

  for (var v = 0; v < values.length; v++) {
    var remaining = values[v] || {}
    if (assigned[remaining.id]) continue
    var ownerKey = trimmed(remaining.accountId || remaining.username)
    if (ownerKey === "") ownerKey = providerLabel(remaining.kind)
    var groupId = "source:" + remaining.kind + ":" + ownerKey.toLowerCase()
    var group = null
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].id === groupId) { group = groups[g]; break }
    }
    if (!group) {
      group = { id: groupId, providerLabel: providerLabel(remaining.kind),
        accountLabel: ownerKey, calendars: [] }
      groups.push(group)
    }
    group.calendars.push(remaining)
  }
  return groups
}

// A calendar a write can be offered on. A read-only source still draws its
// events; it is not offered as somewhere to put one.
function writable(source) {
  return !!source && source.readOnly !== true
}

// The picker groups with the read-only calendars left out, and a group left
// empty by that left out too.
function writableGroups(groups) {
  var values = Array.isArray(groups) ? groups : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var group = values[i] || {}
    var calendars = (Array.isArray(group.calendars) ? group.calendars : [])
      .filter(function(source) { return writable(source) })
    if (calendars.length === 0) continue
    out.push({ id: group.id, providerLabel: group.providerLabel,
      accountLabel: group.accountLabel, calendars: calendars })
  }
  return out
}

function calendarEditorUrl(list) {
  var values = list && Array.isArray(list.sources) ? list.sources : []
  for (var i = 0; i < values.length; i++) {
    var source = values[i] || {}
    if (source.enabled === false) continue
    if (source.kind === "google")
      return "https://calendar.google.com/calendar/u/0/r/eventedit"
    if (source.kind === "caldav") {
      var match = /^(https:\/\/[^/]+)/i.exec(String(source.url || ""))
      if (match) return match[1] + "/apps/calendar/"
    }
  }
  return ""
}
