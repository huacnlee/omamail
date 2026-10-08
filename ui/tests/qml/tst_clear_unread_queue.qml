import QtQuick
import QtTest
import "../../account" as Account
import "../../account/Model.js" as Model

// "Mark all read..." over several mailboxes: one after another, totals added,
// and one mailbox failing does not keep the next from running.
Item {
  width: 200
  height: 100

  Component {
    id: hostFactory
    QtObject {
      property string name: ""
      // {marked, failed, stalled, limited, error} to finish with, or null to
      // refuse the start the way a busy or signed-out mailbox does.
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

  Account.ClearUnreadQueue { id: queue }
  SignalSpy { id: finished; target: queue; signalName: "finished" }

  TestCase {
    name: "ClearUnreadQueue"
    when: windowShown

    function host(name, outcome) {
      return hostFactory.createObject(null, { name: name, outcome: outcome, recorder: recorder })
    }
    function result(marked, error) {
      return { marked: marked, failed: 0, stalled: false, limited: false, error: error || "" }
    }

    function init() {
      recorder.names = []
      finished.clear()
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
  }
}
