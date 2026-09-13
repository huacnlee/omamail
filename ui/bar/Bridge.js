.pragma library

// Replacement bars cannot receive the credential-bearing Service QObject.
// This plugin-owned interface shares only detached preview data and the three
// operations already offered by the bar. It never stores a service object.
var active = null

function text(value) {
  return typeof value === "string" ? value.slice(0, 4096) : ""
}

function identifier(value) {
  return typeof value === "string" && value.length <= 4096 ? value : ""
}

function settings(values, defaults) {
  var out = {}
  var source = values || {}
  for (var key in defaults) {
    var value = source[key]
    if (typeof value !== typeof defaults[key]) continue
    if (typeof value === "string" && value.length <= 4096) out[key] = value
    else if (typeof value === "number" && isFinite(value)) out[key] = value
    else if (typeof value === "boolean") out[key] = value
  }
  return out
}

function snapshot(value) {
  var source = value || {}
  var messages = Array.isArray(source.barMessages) ? source.barMessages : []
  var events = Array.isArray(source.barEvents) ? source.barEvents : []
  var mail = []
  var calendar = []
  for (var i = 0; i < Math.min(messages.length, 3); i++) {
    var message = messages[i] || {}
    mail.push({
      id: identifier(message.id), accountId: identifier(message.accountId),
      subject: text(message.subject), unread: message.unread === true,
      subjectDirection: message.subjectDirection === "rtl" || message.subjectDirection === "ltr"
        ? message.subjectDirection : "",
      from: { display: text(message.from && message.from.display) },
      sourceLabel: text(message.sourceLabel), receivedLabel: text(message.receivedLabel)
    })
  }
  for (var j = 0; j < Math.min(events.length, 2); j++) {
    var event = events[j] || {}
    var start = event.start && event.start.ms
    if (typeof start !== "number" || !isFinite(start)) continue
    calendar.push({
      uid: identifier(event.uid), start: { ms: start },
      summary: text(event.summary), sourceLabel: text(event.sourceLabel),
      callUrl: identifier(event.callUrl)
    })
  }
  return {
    ready: source.ready === true, windowOpen: source.windowOpen === true,
    showBarIcon: source.showBarIcon !== false,
    unreadTotal: typeof source.unreadTotal === "number" && isFinite(source.unreadTotal)
      ? Math.max(0, Math.floor(source.unreadTotal)) : 0,
    barTooltip: text(source.barTooltip), contentDirection: text(source.contentDirection),
    barMessages: mail, barEvents: calendar
  }
}

function publish(readSnapshot, applySettings, refresh, refreshCalendarPreview) {
  var api = Object.freeze({
    snapshot: function() { return active === api ? snapshot(readSnapshot()) : null },
    applySettings: function(values) { if (active === api) applySettings(values) },
    refresh: function() { if (active === api) refresh() },
    refreshCalendarPreview: function() { if (active === api) refreshCalendarPreview() }
  })
  active = api
  return api
}

function current() { return active }

// Retiring services must not clear a replacement registered during hot reload.
function clear(api) { if (active === api) active = null }
