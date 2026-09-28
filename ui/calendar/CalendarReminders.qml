import QtQuick
import Quickshell.Io
import "Reminders.js" as Reminders

Item {
  id: root
  required property var service
  required property string pluginDir
  required property string notificationForeground
  required property string notificationAccent
  property double lastCheck: 0
  property bool polling: false
  property int waiters: 0
  property string lastError: ""
  visible: false

  function refresh() {
    if (!calendars.sourcesLoaded || calendars.loading) return
    var today = new Date()
    var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    calendars.refresh(midnight - 86400000, midnight + 30 * 86400000)
  }

  function action(key, operation) {
    service.backend.call("calendar.reminders", { operation: operation, key: key,
      now: Date.now(), minutes: service.calendarSnoozeMinutes }, function(result, error) {
      if (error) root.lastError = "The reminder action could not be saved"
    })
  }

  function poll() {
    if (polling || !calendars.sourcesLoaded || calendars.loading) return
    var now = Date.now()
    polling = true
    service.backend.call("calendar.reminders", { operation: "poll", now: now, lastCheck: lastCheck,
      candidates: Reminders.candidates(calendars.events, calendars.availableSources) }, function(result, error) {
      root.polling = false
      if (error) { root.lastError = "Desktop reminders could not read their saved state"; return }
      if (result && result.retry === true) return
      root.lastError = ""
      root.lastCheck = now
      var notifications = result && Array.isArray(result.notifications) ? result.notifications : []
      for (var i = 0; i < notifications.length; i++) root.deliver(notifications[i])
    })
  }

  function deliver(record) {
    if (waiters >= 16) { action(record.key, "failed"); return }
    var body = Qt.formatDateTime(new Date(record.start), "ddd, MMM d · hh:mm")
    var count = 1 + (Array.isArray(record.relatedKeys) ? record.relatedKeys.length : 0)
    var title = count > 1 ? String(count) + " calendar reminders" : record.title
    if (count > 1) body = record.title + " · " + body
    var process = notification.createObject(root, { record: record,
      command: ["python3", pluginDir + "/scripts/notify-mail.py", "--calendar",
        notificationForeground, notificationAccent, "--", title, body] })
    if (!process) { action(record.key, "failed"); return }
    waiters++
    process.running = true
  }

  CalendarController {
    id: calendars
    service: root.service
    pluginDir: root.pluginDir
    cacheName: "calendar-reminders"
    reminderMode: true
    onSourcesLoadedChanged: if (sourcesLoaded) Qt.callLater(root.refresh)
    onLoadingChanged: if (!loading) Qt.callLater(root.poll)
  }
  Connections {
    target: root.service.calendarController
    function onSourceListChanged() {
      calendars.sourceList = root.service.calendarController.sourceList
      Qt.callLater(root.refresh)
    }
  }
  Timer { interval: 60000; running: true; repeat: true; onTriggered: root.refresh() }
  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.poll() }

  Component {
    id: notification
    Process {
      id: delivery
      property var record
      property Timer deadline: Timer {
        interval: 3600000
        running: delivery.running
        onTriggered: delivery.running = false
      }
      stdout: StdioCollector {
        onStreamFinished: {
          var choice = text.trim()
          if (choice === "snooze") root.action(delivery.record.key, "snooze")
          else if (choice === "default") {
            root.action(delivery.record.key, "dismiss")
            if (root.service.shell && typeof root.service.shell.summon === "function")
              root.service.shell.summon("omamail", JSON.stringify({ view: "calendar",
                accountId: delivery.record.accountId,
                eventId: delivery.record.sourceId + "\n" + delivery.record.eventId,
                eventStart: delivery.record.start }))
          } else if (choice === "dismiss") root.action(delivery.record.key, "dismiss")
        }
      }
      onExited: function(code, status) {
        root.waiters--
        if (code !== 0) {
          root.lastError = "Desktop reminder delivery failed"
          root.action(record.key, "failed")
        }
        destroy()
      }
    }
  }
}
