import QtQuick
import "Unified.js" as Unified

// Account-local transactions report one result for the user's whole selection.
QtObject {
  id: root
  required property var service
  property int serial: 0
  property string status: ""
  property string error: ""
  readonly property string scope: JSON.stringify([service.unified, service.activeAccountId, service.mailboxKey, service.rawQuery])
  onScopeChanged: clear()
  property Timer noticeTimer: Timer { interval: 5000; onTriggered: root.status = "" }
  function clear() { serial++; status = ""; error = ""; noticeTimer.stop() }

  function run(ids, action, completion) {
    var groups = Unified.groupByAccount(ids)
    if (groups.length === 0) return false
    clear()
    var generation = serial
    var originalScope = scope
    var remaining = groups.length
    var failed = []
    var notes = new Array(groups.length)
    var total = 0
    var label = "Done"
    var acted = false
    for (var n = 0; n < groups.length; n++) total += groups[n].ids.length
    function replyFor(group, index, host) {
      var answered = false
      return function(result) {
        if (answered) return
        answered = true
        var reportedFailures = result && Array.isArray(result.failedIds) ? result.failedIds : group.ids
        var localFailures = []
        // A reply cannot name another account or a row outside this request.
        for (var f = 0; f < reportedFailures.length; f++) {
          var id = reportedFailures[f]
          if (group.ids.indexOf(id) >= 0 && localFailures.indexOf(id) < 0) {
            localFailures.push(id)
            failed.push(Unified.unifiedId(group.accountId, id))
          }
        }
        var count = group.ids.length - localFailures.length
        var name = group.accountId
        notes[index] = name + ": " + Math.max(0, count) + " completed, " + localFailures.length + " failed"
        if (--remaining !== 0) return
        if (generation === serial && service.unified && scope === originalScope) {
          status = label + ": " + (total - failed.length) + " of " + total
            + " selected across " + groups.length + " mailboxes. " + notes.join("; ")
          error = failed.length > 0 ? status : ""
          service.note(status)
          noticeTimer.restart()
        }
        if (typeof completion === "function") completion({failedIds: failed})
      }
    }
    for (var i = 0; i < groups.length; i++) {
      var host = service.findAccount(groups[i].accountId)
      if (host && typeof host.actionLabel === "function") label = host.actionLabel(action)
      var reply = replyFor(groups[i], i, host)
      if (host && host.actMany(groups[i].ids, action, reply)) acted = true
      else reply({failedIds: groups[i].ids})
    }
    return acted
  }
}
