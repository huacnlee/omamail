import QtQuick
import "Model.js" as Model

// "Mark all read..." over the mailboxes on screen: the mailbox shown, or each
// signed-in one with something unread in the merged view. They run one after
// another, so the status line counts one run, and every mailbox gets its turn
// even when an earlier one fails. The first error is the one reported.
//
// The service owns this for the shell's lifetime, so a run carries on after
// the window closes. Everything the window reads about the action is here,
// which keeps the service and the window to a line each.
QtObject {
  id: root

  property var service: null
  property bool running: false
  // Messages marked so far across every mailbox in this run.
  property int cleared: 0

  signal finished(var total)

  // The backend step this repeats arrived in API 7.
  readonly property bool available: !!service && !!service.backend
    && service.backend.ready === true && service.backend.apiVersion >= 7
  // What "Mark these read" would change, for its count in the menu.
  readonly property int loadedUnread: {
    if (!service) return 0
    if (!service.unified) return service.current ? Model.loadedUnreadCount(service.current.messages) : 0
    var total = 0
    service.eachHost(function(host) { total += Model.loadedUnreadCount(host.messages) })
    return total
  }
  readonly property int unread: service ? service.inboxUnread : 0
  // One line per mailbox the confirmation names.
  readonly property var lines: {
    if (!service) return []
    var current = service.current
    var summaries = service.accountSummaries || []
    return Model.clearUnreadLines(service.unified ? summaries : summaries.filter(function(summary) {
      return !!current && summary.id === current.accountId
    }))
  }

  function start() {
    if (!available) return false
    var hosts = []
    if (service.unified) service.eachHost(function(host) { if (host.ready && host.inboxUnread > 0) hosts.push(host) })
    else if (service.current) hosts.push(service.current)
    return run(hosts)
  }

  // `hosts` answer `clearUnread(onProgress, onDone)`, returning false when
  // they cannot start (busy or signed out); those are skipped.
  function run(hosts) {
    var list = Array.isArray(hosts) ? hosts.slice() : []
    if (running || list.length === 0) return false
    running = true
    cleared = 0
    var total = { marked: 0, failed: 0, stalled: false, limited: false, error: "" }
    var index = 0

    function note(text) { if (root.service) root.service.note(text) }
    function next() {
      while (index < list.length) {
        var host = list[index++]
        var before = total.marked
        var started = host.clearUnread(function(marked) {
          root.cleared = before + marked
          note(Model.clearUnreadProgress(root.cleared))
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
      note(Model.clearUnreadNote(total))
      finished(total)
    }
    next()
    return true
  }
}
