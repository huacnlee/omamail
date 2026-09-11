import QtQuick

// Registration belongs to the account lifetime, not the window lifetime.
// Rust owns the timer, networking, coalescing and the latest snapshot.
Item {
  id: root
  property var backend: null
  property bool enabled: false
  property string accountId: ""
  property string query: ""
  property int intervalSec: 120
  property int pageSize: 25
  property var registeredBackend: null
  property string registeredAccount: ""
  property string registrationKey: ""
  property bool unregistering: false
  property int epoch: 0
  property real sequence: 0
  signal updated(var snapshot)

  function scheduleReconcile() { reconcileTimer.restart() }
  Timer { id: reconcileTimer; interval: 0; onTriggered: root.reconcile() }
  // This retries registration only; mailbox polling itself belongs to Rust.
  Timer { id: retryTimer; interval: 5000; onTriggered: root.reconcile() }

  function stop() {
    retryTimer.stop()
    var oldBackend = registeredBackend
    var oldAccount = registeredAccount
    registeredBackend = null
    registeredAccount = ""
    registrationKey = ""
    sequence = 0
    epoch++
    if (oldBackend && oldBackend.ready && oldAccount) {
      unregistering = true
      oldBackend.call("mail.unwatch", { accountId: oldAccount }, function() {
        if (!root) return
        root.unregistering = false
        root.scheduleReconcile()
      })
    }
  }

  function reconcile() {
    if (unregistering) return
    if (!enabled || !backend || !backend.ready || !accountId) { stop(); return }
    var key = JSON.stringify([accountId, query, intervalSec, pageSize])
    if (registeredBackend === backend && registrationKey === key) return
    retryTimer.stop()
    // Updating an existing watch is atomic in Rust; an unwatch racing a new
    // watch would otherwise remove the replacement.
    if (registeredBackend !== backend || registeredAccount !== accountId) stop()
    if (unregistering) return
    registeredBackend = backend
    registeredAccount = accountId
    registrationKey = key
    var mine = ++epoch
    backend.call("mail.watch", { accountId: accountId, query: query, intervalSec: intervalSec, pageSize: pageSize }, function(result, error) {
      if (mine !== root.epoch) return
      if (error) {
        root.registrationKey = ""
        if (root.enabled && root.backend && root.backend.ready) retryTimer.restart()
        return
      }
      root.accept(result)
    })
  }

  function accept(snapshot) {
    if (!enabled || !snapshot || snapshot.accountId !== accountId
        || typeof snapshot.sequence !== "number" || snapshot.sequence <= sequence) return
    sequence = snapshot.sequence
    updated(snapshot)
  }

  function check() {
    reconcile()
    if (!registeredBackend || !registeredBackend.ready || !registrationKey) return
    registeredBackend.call("mail.check", { accountId: registeredAccount }, function() {})
  }

  onEnabledChanged: scheduleReconcile()
  onBackendChanged: scheduleReconcile()
  onAccountIdChanged: scheduleReconcile()
  onQueryChanged: scheduleReconcile()
  onIntervalSecChanged: scheduleReconcile()
  onPageSizeChanged: scheduleReconcile()
  Component.onCompleted: scheduleReconcile()
  Component.onDestruction: { reconcileTimer.stop(); stop() }
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() { root.reconcile() }
    function onNotification(method, params) {
      if (method === "mail.updated") root.accept(params)
    }
  }
}
