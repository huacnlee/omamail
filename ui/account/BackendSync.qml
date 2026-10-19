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
  // A check sent before mail.watch answers may fail with mail_watch_unknown and
  // is not needed, as a new watch checks at once.
  property bool registered: false
  property bool unregistering: false
  // One registration request at a time: Rust lists accounts before it takes
  // its operation lock, so a later watch or unwatch can overtake this one. An
  // unwatch requested meanwhile is stored here and sent from the watch's reply.
  property var watchRequest: null
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
    registered = false
    sequence = 0
    epoch++
    if (oldBackend && oldBackend.ready && oldAccount) {
      unregistering = true
      // The pending watch sends it on reply, even after this item is destroyed.
      if (watchRequest && watchRequest.backend === oldBackend) watchRequest.unwatch = oldAccount
      else oldBackend.call("mail.unwatch", { accountId: oldAccount }, unwatched)
    }
  }

  function unwatched() {
    if (!root) return
    root.unregistering = false
    root.scheduleReconcile()
  }

  function wantedKey() { return JSON.stringify([accountId, query, intervalSec, pageSize]) }

  function reconcile() {
    if (unregistering) return
    if (!enabled || !backend || !backend.ready || !accountId) { stop(); return }
    var key = wantedKey()
    if (registeredBackend === backend && registrationKey === key) return
    if (watchRequest && watchRequest.backend === backend) return
    retryTimer.stop()
    // Updating an existing watch is atomic in Rust; an unwatch racing a new
    // watch would otherwise remove the replacement.
    if (registeredBackend !== backend || registeredAccount !== accountId) stop()
    if (unregistering) return
    registeredBackend = backend
    registeredAccount = accountId
    registrationKey = key
    registered = false
    var mine = ++epoch
    var request = { backend: backend, unwatch: "" }
    // Captured so a deferred unwatch can still finish after destruction.
    var onUnwatched = root.unwatched
    watchRequest = request
    backend.call("mail.watch", { accountId: accountId, query: query, intervalSec: intervalSec, pageSize: pageSize }, function(result, error) {
      if (root && root.watchRequest === request) root.watchRequest = null
      if (request.unwatch) {
        request.backend.call("mail.unwatch", { accountId: request.unwatch }, onUnwatched)
        return
      }
      if (!root) return
      if (mine !== root.epoch) { root.scheduleReconcile(); return }
      // Settings changed while this watch was pending: register those instead.
      var current = root.wantedKey() === key
      if (error) {
        root.registrationKey = ""
        if (!current) root.scheduleReconcile()
        else if (root.enabled && root.backend && root.backend.ready) retryTimer.restart()
        return
      }
      root.registered = true
      if (current) root.accept(result)
      else root.scheduleReconcile()
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
    if (!registeredBackend || !registeredBackend.ready || !registered) return
    var mine = epoch
    registeredBackend.call("mail.check", { accountId: registeredAccount }, function(result, error) {
      if (!root || mine !== root.epoch || !error || error.message !== "mail_watch_unknown") return
      // The backend no longer holds this watch, so polling stopped: register again.
      root.registrationKey = ""
      root.registered = false
      root.scheduleReconcile()
    })
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
