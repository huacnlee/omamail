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
  property alias inbox: reminderInbox
  visible: false

  CalendarReminderInbox { id: reminderInbox; service: root.service }

  function refresh() {
    if (!calendars.sourcesLoaded || calendars.loading) return
    var today = new Date()
    var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    calendars.refresh(midnight - 86400000, midnight + 30 * 86400000)
  }

  function action(key, operation) {
    reminderInbox.action(key, operation)
  }

  function poll() {
    if (polling || !calendars.sourcesLoaded || calendars.loading) return
    var now = Date.now()
    reminderInbox.prune(now)
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
    var notice = reminderInbox.receive(record)
    // The process budget limits desktop waiters, never the actionable inbox.
    if (waiters >= 16) return
    var body = Qt.formatDateTime(new Date(record.start), "ddd, MMM d · hh:mm")
    var process = notification.createObject(root, { record: notice,
      command: ["python3", pluginDir + "/scripts/notify-mail.py", "--calendar",
        notificationForeground, notificationAccent, "--", record.title, body] })
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
          if (choice === "default") reminderInbox.open(delivery.record)
          else if (choice === "snooze" || choice === "dismiss")
            reminderInbox.action(delivery.record.key, choice, delivery.record.noticeId)
        }
      }
      onExited: function(code, status) {
        root.waiters--
        if (code !== 0) {
          root.lastError = "Desktop reminder delivery failed"
          reminderInbox.action(record.key, "failed", record.noticeId)
        }
        destroy()
      }
    }
  }
}
