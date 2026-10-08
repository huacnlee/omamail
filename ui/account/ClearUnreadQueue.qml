import QtQuick

// "Mark all read..." over the mailboxes on screen: one after another, so the
// status line counts one run, and every mailbox gets its turn even when an
// earlier one fails. The first error is the one reported; the rest still ran.
QtObject {
  id: root

  property bool running: false
  // Messages marked so far across every mailbox in this run.
  property int cleared: 0

  signal finished(var total)

  // `hosts` answer `clearUnread(onProgress, onDone)`, returning false when
  // they cannot start (busy or signed out); those are skipped.
  function run(hosts) {
    var list = Array.isArray(hosts) ? hosts.slice() : []
    if (running || list.length === 0) return false
    running = true
    cleared = 0
    var total = { marked: 0, failed: 0, stalled: false, limited: false, error: "" }
    var index = 0

    function next() {
      while (index < list.length) {
        var host = list[index++]
        var before = total.marked
        var started = host.clearUnread(function(marked) {
          root.cleared = before + marked
        }, function(result) {
          total.marked = before + (result.marked || 0)
          total.failed += result.failed || 0
          total.stalled = total.stalled || result.stalled === true
          total.limited = total.limited || result.limited === true
          if (!total.error && result.error) total.error = result.error
          root.cleared = total.marked
          next()
        })
        if (started) return
      }
      running = false
      finished(total)
    }
    next()
    return true
  }
}
