import QtQuick
import QtTest
import "../../calendar" as Calendar
import "../../components" as Views

Item {
  width: 660
  height: 600
  SystemPalette { id: palette }
  QtObject {
    id: backend
    property bool ready: false
    property var calls: []
    property var callbacks: []
    function call(method, args, callback) {
      calls = calls.concat([{method:method,args:args}])
      callbacks = callbacks.concat([callback])
    }
  }
  QtObject {
    id: shell
    property var opened: null
    function summon(id, payload) { opened = JSON.parse(payload) }
  }
  QtObject {
    id: mailService
    property var backend: backend
    property var shell: shell
    property int calendarSnoozeMinutes: 5
    property var calendarReminderInbox: inbox
    property var calendarController: null
    property var accountSummaries: []
  }
  Calendar.CalendarReminderInbox { id: inbox; service: mailService }
  Component {
    id: reminderComponent
    Calendar.CalendarReminders {
      service: mailService
      pluginDir: ""
      notificationForeground: palette.text.toString()
      notificationAccent: palette.highlight.toString()
    }
  }
  Views.CalendarReminderPanel {
    id: panel
    width: parent.width
    service: mailService
    textColor: palette.text
    dimColor: palette.mid
    accentColor: palette.highlight
    urgentColor: palette.highlight
    panelFontFamily: "monospace"
  }
  TestCase {
    name: "CalendarReminderInbox"
    when: windowShown
    function record() { return {key:"ledger-key",title:"<b>Planning</b>",sourceId:"personal",eventId:"event",accountId:"me@example.test",start:1000,end:5000} }
    function init() {
      inbox.records=[]; inbox.pendingKeys=[]; inbox.lastError=""
      backend.calls=[]; backend.callbacks=[]; shell.opened=null; panel.eventKey=""
    }
    function test_open_preserves_snooze_and_dismiss_choices() {
      var notice=inbox.receive(record())
      inbox.open(notice)
      compare(shell.opened.eventId,"personal\nevent")
      compare(backend.calls.length,0)
      compare(inbox.records.length,1)
    }
    function test_simultaneous_events_have_independent_details_and_actions() {
      var first = inbox.receive(record())
      var second = record()
      second.key = "second-ledger-key"
      second.eventId = "second-event"
      second.title = "Second meeting"
      second = inbox.receive(second)
      compare(inbox.records.length, 2)
      panel.eventKey = "personal\nsecond-event"
      compare(panel.records.length, 1)
      compare(panel.records[0].title, "Second meeting")
      inbox.open(second)
      compare(shell.opened.eventId, "personal\nsecond-event")
      verify(inbox.action(first.key, "dismiss", first.noticeId))
      backend.callbacks[0]({}, "")
      compare(inbox.records.length, 1)
      verify(inbox.current(second.key, second.noticeId))
      verify(inbox.action(second.key, "snooze", second.noticeId))
      compare(backend.calls[1].args.key, second.key)
    }
    function test_desktop_process_limit_keeps_every_event_in_the_inbox() {
      var reminders = createTemporaryObject(reminderComponent, panel, {waiters:16})
      verify(reminders !== null)
      var first = record(), second = record()
      second.key = "second-ledger-key"
      second.eventId = "second-event"
      reminders.deliver(first)
      reminders.deliver(second)
      compare(reminders.inbox.records.length, 2)
      compare(reminders.inbox.records[1].eventId, "second-event")
      compare(backend.calls.length, 0, "process saturation must not discard or requeue inbox entries")
    }
    function test_action_failure_retains_notice_and_success_removes_it() {
      var notice=inbox.receive(record())
      verify(inbox.action(notice.key,"snooze",notice.noticeId))
      compare(backend.calls[0].args.minutes,5)
      compare(inbox.records.length,1)
      verify(!inbox.action(notice.key,"dismiss",notice.noticeId))
      backend.callbacks[0](null,"Unavailable")
      compare(inbox.records.length,1)
      verify(inbox.lastError!=="")
      verify(inbox.action(notice.key,"snooze",notice.noticeId))
      backend.callbacks[1]({},"")
      compare(inbox.records.length,0)
      compare(inbox.lastError,"")
    }
    function test_old_notification_cannot_acknowledge_a_new_delivery() {
      var old=inbox.receive(record())
      var next=inbox.receive(record())
      verify(!inbox.action(old.key,"dismiss",old.noticeId))
      inbox.open(old)
      compare(backend.calls.length,0)
      compare(shell.opened,null)
      verify(inbox.current(next.key,next.noticeId))
    }
    function test_late_callback_keeps_new_delivery() {
      var old=inbox.receive(record())
      inbox.action(old.key,"dismiss",old.noticeId)
      var next=inbox.receive(record())
      backend.callbacks[0]({},"")
      compare(inbox.records.length,1)
      verify(inbox.current(next.key,next.noticeId))
    }
    function test_expired_reminders_leave_the_panel() {
      inbox.receive(record());inbox.prune(5000)
      compare(inbox.records.length,0)
      verify(!panel.visible)
    }
    function test_panel_actions_and_event_identity() {
      inbox.receive(record());wait(0)
      verify(panel.visible)
      panel.eventKey="another\nevent";verify(!panel.visible)
      panel.eventKey="personal\nevent";wait(50)
      var dismiss=findChild(panel,"calendar-reminder-dismiss")
      mouseClick(dismiss,dismiss.width/2,dismiss.height/2)
      compare(backend.calls.length,1)
      compare(backend.calls[0].args.operation,"dismiss")
      backend.callbacks[0]({},"")
      verify(!panel.visible)
    }
  }
}
