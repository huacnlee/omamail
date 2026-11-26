import QtQuick
import "Model.js" as Model
import "../providers/Registry.js" as Provider

// Changes to the label list — create beside or beneath a label, rename it,
// move it under another, delete it — and the counts of the labels watched
// for new mail. Every change goes to the provider first and reads the list
// back from the server after: a label is the server's fact, not this
// window's, and a Gmail label's id is only known once Gmail has made it.
// Beside the account rather than in it, which is at its size ceiling.
QtObject {
  id: labelActions

  required property var account

  // The account.labels watched for new mail, by id: set from the account entry, and
  // counted on every refresh the way the inbox is. A count that grew says so
  // on the status line; the rail's row carries the number either way.
  //
  // A few requests at a time, not one per watched label at once: a dozen
  // watched folders on a slow IMAP server would otherwise open a dozen
  // connections on every poll. The handles are kept so the account can
  // drop the lot when it signs out or goes away.
  property bool monitoredLoading: false
  readonly property int monitorConcurrency: 3
  property var monitorHandles: []
  property var monitorQueue: []
  property var monitorGrown: []
  property int monitorRemaining: 0
  // Which poll a count belongs to: one abandoned by `abortMonitored` may
  // still answer, and its answer must not be taken off the next poll's tally.
  property int monitorSerial: 0

  function refreshMonitored() {
    var ids = Array.isArray(account.monitoredIds) ? account.monitoredIds : []
    if (!account.ready || monitoredLoading || ids.length === 0) return
    monitoredLoading = true
    monitorSerial++
    monitorQueue = ids.map(function(id) { return String(id) })
    monitorGrown = []
    monitorRemaining = monitorQueue.length
    for (var i = 0; i < monitorConcurrency; i++) nextMonitorCount()
  }

  function nextMonitorCount() {
    if (monitorQueue.length === 0) return
    var labelId = monitorQueue[0]
    monitorQueue = monitorQueue.slice(1)
    var serial = monitorSerial
    var answered = false
    var handle = account.api.getLabelCounts(labelId, function(counts, error) {
      if (!labelActions || serial !== monitorSerial || answered) return
      answered = true
      monitorHandles = monitorHandles.filter(function(h) { return h !== handle })
      if (!error && counts) recordMonitorCount(labelId, counts)
      monitorCountDone()
    })
    // A provider that answered before returning, or that made no request
    // at all, leaves nothing to keep; the rest are held for `abortMonitored`.
    if (!handle && !answered) { answered = true; monitorCountDone(); return }
    if (handle && !answered) monitorHandles = monitorHandles.concat([handle])
  }

  function monitorCountDone() {
    monitorRemaining--
    if (monitorRemaining > 0) { nextMonitorCount(); return }
    monitoredLoading = false
    if (monitorGrown.length > 0) account.note(Model.monitoredNote(monitorGrown))
    monitorGrown = []
    account.cache.putLabels(account.labels)
  }

  function recordMonitorCount(labelId, counts) {
    var index = Model.indexById(account.labels, labelId)
    if (index < 0) return
    var before = Math.max(0, Math.floor(Number(account.labels[index].unread) || 0))
    var after = Math.max(0, Math.floor(Number(counts.unread) || 0))
    var updated = {}
    for (var key in account.labels[index]) updated[key] = account.labels[index][key]
    updated.unread = after
    updated.total = Math.max(0, Math.floor(Number(counts.total) || 0))
    account.labels = Model.replaceById(account.labels, updated)
    if (after > before && monitoredSeen[labelId] !== undefined)
      monitorGrown = monitorGrown.concat([{ name: String(updated.name || labelId), delta: after - before }])
    var seen = {}
    for (var k in monitoredSeen) seen[k] = monitoredSeen[k]
    seen[labelId] = after
    monitoredSeen = seen
  }

  // Every count still in flight, dropped, and the queue with it: what a
  // sign-out or the account's end does with a poll that is half done.
  function abortMonitored() {
    var handles = monitorHandles
    monitorSerial++
    monitorHandles = []
    monitorQueue = []
    monitorRemaining = 0
    monitorGrown = []
    monitoredLoading = false
    for (var i = 0; i < handles.length; i++) account.abortRequest(handles[i])
  }

  // A sign-out drops the counts in flight along with everything else.
  readonly property bool ready: !!account && account.ready
  onReadyChanged: if (!ready) abortMonitored()
  Component.onDestruction: abortMonitored()

  // The last count each watched label was seen at, so a refresh knows growth
  // from the first read. Not persisted: a restart reads once and says nothing.
  property var monitoredSeen: ({})

  // Whether the label list can be changed from here, and the four changes:
  // create beside or beneath a label, rename it, move it under another,
  // delete it. Every one goes to the provider first and reloads the list
  // from the server after — a label is the server's fact, not this window's,
  // and a Gmail label's id is only known once Gmail has made it.
  readonly property bool canManageLabels: Provider.can(account.providerId, "manageLabels")

  function labelById(id) {
    var index = Model.indexById(account.labels, id)
    return index >= 0 ? account.labels[index] : null
  }

  // The path as a person reads it: the decoded name, which on IMAP is what
  // LIST's modified-UTF-7 spelled and on Gmail is the name itself. The wire
  // name — the id — is what goes back to the server for a folder it has.
  function labelPathOf(label) {
    return label ? String(label.name || label.rawName || "") : ""
  }

  function labelByPath(path) {
    for (var i = 0; i < account.labels.length; i++) if (labelPathOf(account.labels[i]) === String(path || "")) return account.labels[i]
    return null
  }

  // A name the list already has is refused before it reaches the server:
  // a server that accepted it would leave two rows reading the same, and
  // the one the window follows or watches after the change is found by
  // its path, which would then name the wrong row.
  function takenProblem(name) {
    return labelByPath(name) ? "There is already a label named " + name : ""
  }

  function createLabel(parentPath, leaf) {
    if (!account.ready || !canManageLabels) return false
    var parent = labelByPath(parentPath)
    var delimiter = Model.labelDelimiter(parent || (account.labels.length > 0 ? account.labels[0] : null))
    var problem = Model.labelNestProblem(parentPath, delimiter) || Model.labelNameProblem(leaf, delimiter)
    var name = Model.labelPathJoin(parentPath, leaf, delimiter)
    problem = problem || takenProblem(name)
    if (problem !== "") { account.fail(problem); return false }
    account.api.createLabel(name, function(payload, error) {
      if (!labelActions) return
      if (error) { account.fail("Could not create " + name + ": " + String(error)); return }
      account.note("Created " + name)
      reloadLabels()
    })
    return true
  }

  function renameLabel(id, leaf) {
    var label = labelById(id)
    if (!account.ready || !canManageLabels || !label) return false
    var delimiter = Model.labelDelimiter(label)
    var problem = Model.labelNameProblem(leaf, delimiter)
    if (problem !== "") { account.fail(problem); return false }
    var path = labelPathOf(label)
    var name = Model.labelPathJoin(Model.labelParent(path, delimiter), leaf, delimiter)
    if (name === path) return false
    problem = takenProblem(name)
    if (problem !== "") { account.fail(problem); return false }
    var before = account.labels
    account.api.renameLabel(String(label.id), name, function(payload, error) {
      if (!labelActions) return
      if (error) { account.fail("Could not rename " + path + ": " + String(error)); return }
      account.note("Renamed to " + name)
      afterLabelMoved(label, name, before)
    })
    return true
  }

  function moveLabel(id, newParentPath) {
    var label = labelById(id)
    if (!account.ready || !canManageLabels || !label) return false
    var delimiter = Model.labelDelimiter(label)
    var problem = Model.labelNestProblem(newParentPath, delimiter)
    if (problem !== "") { account.fail(problem); return false }
    var path = labelPathOf(label)
    var name = Model.labelPathJoin(newParentPath, Model.labelLeaf(path, delimiter), delimiter)
    if (name === path) return false
    problem = takenProblem(name)
    if (problem !== "") { account.fail(problem); return false }
    var before = account.labels
    account.api.renameLabel(String(label.id), name, function(payload, error) {
      if (!labelActions) return
      if (error) { account.fail("Could not move " + path + ": " + String(error)); return }
      account.note("Moved to " + name)
      afterLabelMoved(label, name, before)
    })
    return true
  }

  function deleteLabel(id) {
    var label = labelById(id)
    if (!account.ready || !canManageLabels || !label) return false
    var path = labelPathOf(label)
    var before = account.labels
    account.api.deleteLabel(String(label.id), function(payload, error) {
      if (!labelActions) return
      if (error) { account.fail("Could not delete " + path + ": " + String(error)); return }
      account.note("Deleted " + path)
      // The list this window was looking at may have been the label just
      // deleted; the inbox is the honest place to stand then.
      if (account.rawLabelId === String(label.id)) account.selectMailbox("inbox")
      migrations = migrations.concat([{ before: before, oldPath: path, newPath: "", delimiter: Model.labelDelimiter(label) }])
      reloadLabels()
    })
    return true
  }

  // The label on screen follows its own rename. Its new wire name is the
  // server's to spell, so the list is read again first and the label is
  // found by the name it now has; a rename of a label not on screen only
  // reloads. The watched ids follow the same way, once the fresh listing
  // says what the moved folders are called now.
  //
  // The moves waiting on a listing are a queue, not a slot: two changes
  // made before the first listing lands are applied in order, and a listing
  // that fails leaves them waiting for the next one rather than dropping
  // them — a watch that did not follow its folder would poll a name the
  // server no longer has.
  property string followLabelPath: ""
  property var migrations: []
  property bool reloadRetried: false
  property bool reloading: false
  property bool reloadQueued: false

  function afterLabelMoved(label, newPath, before) {
    var wasOpen = account.rawQuery !== "" && account.rawLabelId === String(label.id || "")
    followLabelPath = wasOpen ? String(newPath || "") : ""
    migrations = migrations.concat([{ before: before, oldPath: labelPathOf(label), newPath: String(newPath || ""),
      delimiter: Model.labelDelimiter(label) }])
    reloadLabels()
  }

  function reloadLabels() {
    if (!account.ready) return
    if (reloading) { reloadQueued = true; return }
    reloading = true
    account.api.getLabels(function(result, error) {
      if (!labelActions) return
      reloading = false
      // A later mutation requested a newer listing. Keep its migrations until
      // a read started after that mutation returns, even if this read failed.
      if (reloadQueued) {
        reloadQueued = false
        reloadLabels()
        return
      }
      if (error) {
        // The change went through; the listing did not. One more try, and
        // after that the moves wait for the next listing a change brings.
        followLabelPath = ""
        account.fail("Could not read the labels back: " + String(error))
        if (!reloadRetried) { reloadRetried = true; Qt.callLater(reloadLabels) }
        return
      }
      reloadRetried = false
      account.labels = result
      account.cache.putLabels(result)
      var moves = migrations
      migrations = []
      if (moves.length > 0) {
        var watched = Array.isArray(account.monitoredIds) ? account.monitoredIds : []
        var next = Model.migrateMonitoredChanges(watched, moves, result)
        if (next !== watched) account.monitoredMigrated(next)
      }
      if (followLabelPath !== "") {
        var moved = labelByPath(followLabelPath)
        followLabelPath = ""
        if (moved) account.selectLabel(String(moved.rawName || moved.name || ""), String(moved.id || ""))
        else account.selectMailbox("inbox")
      }
    })
  }
}
