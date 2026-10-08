import QtQuick
import QtTest
import "../../account" as Account
import "../../account/Model.js" as Model

// "Mark all read..." over the mailboxes on screen: which ones, one after
// another, totals added, and one mailbox failing does not keep the next from
// running. The service it reads is a stand-in with the same members.
Item {
  width: 200
  height: 100

  Component {
    id: hostFactory
    QtObject {
      property string name: ""
      property string accountId: name
      property bool ready: true
      property int inboxUnread: 1
      property var messages: []
      // {marked, failed, stalled, limited, error} to finish with, or null to
      // refuse the start the way a busy mailbox does.
      property var outcome: null
      property var recorder: null
      function clearUnread(onProgress, onDone) {
        if (outcome === null) return false
        var self = this
        recorder.record(name)
        Qt.callLater(function() {
          if (self.outcome.marked > 0) onProgress(self.outcome.marked)
          onDone(self.outcome)
        })
        return true
      }
    }
  }

  // A QML `var` property holds a copy of a JS array, so the hosts report to
  // one shared object rather than pushing into an array of their own.
  QtObject {
    id: recorder
    property var names: []
    function record(name) { names = names.concat([name]) }
  }

  QtObject {
    id: service
    property bool unified: false
    property var current: null
    property var hosts: []
    property var backend: ({ ready: true, apiVersion: 7 })
    property var accountSummaries: []
    property int inboxUnread: 0
    property var notes: []
    function eachHost(callback) { for (var i = 0; i < hosts.length; i++) callback(hosts[i]) }
    function note(text) { notes = notes.concat([text]) }
  }

  Account.ClearUnreadQueue { id: queue }
  SignalSpy { id: finished; target: queue; signalName: "finished" }

  TestCase {
    name: "ClearUnreadQueue"
    when: windowShown

    function host(name, outcome, extra) {
      var properties = { name: name, outcome: outcome, recorder: recorder }
      for (var key in extra || {}) properties[key] = extra[key]
      return hostFactory.createObject(null, properties)
    }
    function result(marked, error) {
      return { marked: marked, failed: 0, stalled: false, limited: false, error: error || "" }
    }

    function init() {
      recorder.names = []
      finished.clear()
      service.unified = false
      service.current = null
      service.hosts = []
      service.backend = { ready: true, apiVersion: 7 }
      service.accountSummaries = []
      service.notes = []
      queue.service = null
    }

    function test_unified_runs_accounts_in_turn() {
      verify(queue.run([host("perso", result(0, "credential refused")), host("work", result(40))]))
      verify(queue.running)
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(recorder.names), JSON.stringify(["perso", "work"]))
      var total = finished.signalArguments[0][0]
      compare(total.marked, 40)
      compare(total.error, "credential refused", "the first error is kept")
      compare(Model.clearUnreadNote(total), "40 marked read, then stopped: credential refused")
      verify(!queue.running)
    }

    function test_progress_adds_across_accounts() {
      var seen = []
      var watch = function() { seen.push(queue.cleared) }
      queue.clearedChanged.connect(watch)
      queue.run([host("perso", result(100)), host("work", result(30))])
      tryCompare(finished, "count", 1)
      queue.clearedChanged.disconnect(watch)
      verify(seen.indexOf(100) >= 0)
      compare(seen[seen.length - 1], 130)
      compare(finished.signalArguments[0][0].marked, 130)
    }

    function test_flags_carry_over() {
      var limited = result(20000)
      limited.limited = true
      var stalled = result(5)
      stalled.stalled = true
      queue.run([host("perso", limited), host("work", stalled)])
      tryCompare(finished, "count", 1)
      var total = finished.signalArguments[0][0]
      verify(total.limited)
      verify(total.stalled)
    }

    function test_busy_mailbox_is_skipped() {
      queue.run([host("perso", null), host("work", result(7))])
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(recorder.names), JSON.stringify(["work"]))
      compare(finished.signalArguments[0][0].marked, 7)
    }

    function test_second_run_is_ignored() {
      verify(queue.run([host("perso", result(1))]))
      verify(!queue.run([host("work", result(1))]))
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(recorder.names), JSON.stringify(["perso"]))
    }

    function test_nothing_to_run() {
      verify(!queue.run([]))
      verify(!queue.running)
      wait(10)
      compare(finished.count, 0)
    }

    function test_available_needs_a_ready_api_7_backend() {
      queue.service = service
      verify(queue.available)
      service.backend = { ready: true, apiVersion: 6 }
      verify(!queue.available, "an older backend has no clear-unread step")
      service.backend = { ready: false, apiVersion: 7 }
      verify(!queue.available)
      service.current = host("perso", result(1))
      verify(!queue.start(), "nothing starts without the step")
      compare(recorder.names.length, 0)
    }

    function test_start_runs_the_mailbox_on_screen() {
      service.current = host("perso", result(3))
      service.hosts = [service.current, host("work", result(9))]
      queue.service = service
      verify(queue.start())
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(recorder.names), JSON.stringify(["perso"]))
    }

    function test_start_in_the_unified_view_takes_signed_in_mailboxes_with_unread() {
      service.unified = true
      service.hosts = [
        host("perso", result(3), { inboxUnread: 3 }),
        host("empty", result(1), { inboxUnread: 0 }),
        host("signed-out", result(1), { inboxUnread: 9, ready: false }),
        host("work", result(2), { inboxUnread: 2 })
      ]
      queue.service = service
      verify(queue.start())
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(recorder.names), JSON.stringify(["perso", "work"]))
    }

    function test_notes_show_progress_then_the_result() {
      service.current = host("perso", result(100))
      queue.service = service
      queue.start()
      tryCompare(finished, "count", 1)
      compare(JSON.stringify(service.notes), JSON.stringify([
        "Marking all read: 100 so far", "100 messages marked read"]))
    }

    function test_loaded_unread_counts_the_loaded_rows_of_the_view() {
      var unread = [{ unread: true }, { unread: false }, { unread: true }]
      service.current = host("perso", null, { messages: unread })
      service.hosts = [service.current, host("work", null, { messages: [{ unread: true }] })]
      queue.service = service
      compare(queue.loadedUnread, 2)
      service.unified = true
      compare(queue.loadedUnread, 3)
    }

    function test_lines_follow_the_view() {
      service.current = host("perso", null)
      service.accountSummaries = [
        { id: "perso", label: "perso", unread: 234, signedIn: true },
        { id: "work", label: "work", unread: 500, signedIn: true }
      ]
      queue.service = service
      compare(JSON.stringify(queue.lines), JSON.stringify([{ label: "perso", count: "234", capped: false }]))
      service.unified = true
      compare(queue.lines.length, 2)
      compare(queue.lines[1].count, "500 or more")
    }
  }
}
