.pragma library

var VERSION = 1
var MAX_AGE_MS = 120000

function empty() {
  return { version: VERSION, unread: 0, running: false, updatedAt: 0 }
}

function parse(text) {
  var raw
  try {
    raw = JSON.parse(String(text || ""))
  } catch (error) {
    return empty()
  }
  if (!raw || Number(raw.version) !== VERSION) return empty()
  var unread = Math.floor(Number(raw.unread))
  if (!isFinite(unread) || unread < 0) unread = 0
  var updatedAt = Math.floor(Number(raw.updatedAt))
  if (!isFinite(updatedAt) || updatedAt < 0) updatedAt = 0
  return {
    version: VERSION,
    unread: unread,
    running: raw.running === true,
    updatedAt: updatedAt
  }
}

function presentation(text, nowMs, maxAgeMs) {
  var value = parse(text)
  var now = Number(nowMs)
  var maxAge = Math.max(0, Number(maxAgeMs) || 0)
  var age = now - value.updatedAt
  var stale = value.updatedAt <= 0 || age < 0 || age > maxAge
  return {
    // A count without a current writer is worse than no count: it claims mail
    // is waiting even after the application has exited or the atomically
    // replaced file briefly disappears. The bar stays useful as a launcher,
    // but says nothing unverified about a mailbox.
    unread: stale ? 0 : value.unread,
    running: value.running && !stale,
    stale: stale
  }
}

function snapshotPath(stateHome, home) {
  var state = String(stateHome || "")
  var userHome = String(home || "")
  if (state !== "") return state + "/omamail/status.json"
  if (userHome !== "") return userHome + "/.local/state/omamail/status.json"
  return ""
}

function command(program, action, payload) {
  var known = ["open", "refresh", "compose-mailto"]
  var verb = known.indexOf(String(action || "")) >= 0 ? String(action) : "open"
  var out = [String(program || "omamail"), "--command", verb]
  var value = String(payload || "")
  if (verb === "compose-mailto" && value !== "") out.push("--payload", value)
  return out
}
