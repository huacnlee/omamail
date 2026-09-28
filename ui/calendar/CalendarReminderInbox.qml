import QtQuick

// The desktop notification is an entry point, not the only action surface.
// Keep delivered reminders actionable until acknowledged or the event ends.
QtObject {
  id: root
  required property var service
  property var records: []
  property var pendingKeys: []
  property string lastError: ""
  property int serial: 0

  function prune(now) {
    records = records.filter(function(record) { return Number(record.end) > now })
  }

  function receive(record) {
    var next = {}
    for (var key in record) next[key] = record[key]
    next.noticeId = ++serial
    records = records.filter(function(value) { return value.key !== next.key }).concat([next])
    return next
  }

  function current(key, noticeId) {
    return records.some(function(record) { return record.key === key && record.noticeId === noticeId })
  }

  function action(key, operation, noticeId) {
    if (operation !== "snooze" && operation !== "dismiss" && operation !== "failed") return false
    if (noticeId !== undefined && !current(key, noticeId)) return false
    if (pendingKeys.indexOf(key) >= 0) return false
    pendingKeys = pendingKeys.concat([key])
    lastError = ""
    service.backend.call("calendar.reminders", { operation: operation, key: key,
      now: Date.now(), minutes: service.calendarSnoozeMinutes }, function(result, error) {
      root.pendingKeys = root.pendingKeys.filter(function(value) { return value !== key })
      if (error) { root.lastError = "Could not save the reminder action. Try again."; return }
      root.records = root.records.filter(function(record) {
        return record.key !== key || (noticeId !== undefined && record.noticeId !== noticeId)
      })
    })
    return true
  }

  function open(record) {
    if (!record || !current(record.key, record.noticeId)) return
    if (service.shell && typeof service.shell.summon === "function")
      service.shell.summon("omamail", JSON.stringify({ view: "calendar",
        accountId: record.accountId, eventId: record.sourceId + "\n" + record.eventId,
        eventStart: record.start }))
  }
}
