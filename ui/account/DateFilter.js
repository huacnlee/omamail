.pragma library

// Inbox date filters. Gmail's after:/before: take Unix seconds as well as
// dates; seconds are exact in the local time zone, where a date would be read
// in the account's Pacific time. Days are counted from local midnight, so
// "Last 7 days" is today and the six days before it.
var FILTERS = [
  { key: "", label: "All" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" }
]

function isKnown(key) {
  for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === key) return true
  return false
}

// Local midnight `daysBack` days before `nowMs`, in Unix seconds. Built with
// setDate rather than by subtracting 86400 so a daylight-saving change in the
// range does not shift the boundary by an hour.
function midnight(nowMs, daysBack) {
  var day = new Date(nowMs)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - daysBack)
  return Math.floor(day.getTime() / 1000)
}

// The Gmail terms for a filter, or "" for none.
function gmailTerms(key, nowMs) {
  if (key === "today") return "after:" + midnight(nowMs, 0)
  if (key === "yesterday") return "after:" + midnight(nowMs, 1) + " before:" + midnight(nowMs, 0)
  if (key === "7d") return "after:" + midnight(nowMs, 6)
  if (key === "30d") return "after:" + midnight(nowMs, 29)
  return ""
}

// The mailbox query narrowed by a filter. Only Gmail understands the terms;
// other providers keep their query unchanged.
function apply(query, key, providerId, nowMs) {
  var terms = providerId === "gmail" ? gmailTerms(key, nowMs) : ""
  var base = String(query || "").trim()
  if (terms === "") return base
  return base === "" ? terms : base + " " + terms
}
