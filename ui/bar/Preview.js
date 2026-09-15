.pragma library

.import "../message/Html.js" as Html

function messageTime(item) {
  var value = item ? item.date : null
  if (value && typeof value.getTime === "function") return value.getTime()
  var numeric = Number(value)
  if (isFinite(numeric) && numeric > 0) return numeric
  var parsed = Date.parse(String(value || ""))
  if (isFinite(parsed) && parsed > 0) return parsed
  return Number(item && item.internalDate) || 0
}

function latestMessages(accounts, limit) {
  var values = Array.isArray(accounts) ? accounts : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var account = values[i] || {}
    var messages = Array.isArray(account.messages) ? account.messages : []
    for (var j = 0; j < messages.length; j++) {
      var item = messages[j] || {}
      if (item.unread !== true) continue
      var copy = ({})
      for (var key in item) copy[key] = item[key]
      copy.accountId = String(account.id || "")
      copy.sourceLabel = String(account.label || "Mailbox") + " · "
        + String(account.inbox || "Inbox")
      copy.receivedLabel = String(item.fullTime || "")
      out.push(copy)
    }
  }
  out.sort(function(left, right) {
    return messageTime(right) - messageTime(left)
  })
  return out.slice(0, Math.max(0, Math.floor(Number(limit) || 0)))
}

// The month the bar previews, keyed by the day rather than the moment: the
// range is what the event cache stores under, so a start that moved with the
// clock never hit, and the cache filled with copies of the same month.
function previewRange(nowMs) {
  var now = new Date(Number(nowMs) || Date.now())
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return [today.getTime(),
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 31).getTime()]
}

function upcomingEvents(events, nowMs, limit) {
  var values = Array.isArray(events) ? events : []
  var now = Number(nowMs) || Date.now()
  var out = []
  for (var i = 0; i < values.length; i++) {
    var item = values[i] || {}
    if (!item.start || Number(item.start.ms) < now) continue
    var copy = ({})
    for (var key in item) copy[key] = item[key]
    copy.sourceLabel = String(item.sourceName || item.sourceId || "Calendar")
    var location = String(item.location || "").trim()
    copy.callUrl = Html.externallyOpenableHttpUrl(item.meetLink)
      || Html.externallyOpenableHttpUrl(/^https?:\/\/\S+$/i.test(location) ? location : "")
    out.push(copy)
  }
  out.sort(function(left, right) { return Number(left.start.ms) - Number(right.start.ms) })
  return out.slice(0, Math.max(0, Math.floor(Number(limit) || 0)))
}
