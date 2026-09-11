import QtQuick

// Rendering and callback correlation only. The backend owns undo deadlines,
// serial delivery, cancellation and durable recovery after a restart.
QtObject {
  id: queue
  required property var account
  readonly property var backend: account ? account.backend : null
  property var parked: []
  readonly property var latest: parked.length > 0 ? parked[parked.length - 1] : null
  property int serial: 0
  property double revision: -1
  property var submitted: ({})
  property var handled: ({})
  property var uncertain: ({})
  property var serverEntries: []
  property bool undoBusy: false
  property var undoPending: null
  property bool retired: false

  function available() { return backend && backend.ready }
  function request(method, params, callback) {
    if (!available()) {
      Qt.callLater(function() { if (queue && typeof queue.apply === "function" && !queue.retired) callback(null, "Mail backend unavailable") })
      return false
    }
    params.accountId = String(account.accountId || "")
    backend.call(method, params, function(result, error) {
      if (queue && typeof queue.apply === "function" && !queue.retired) callback(result, error ? String(error.message || "Mail backend request failed") : "")
    })
    return true
  }
  function apply(snapshot, partial) {
    if (!snapshot || String(snapshot.accountId || "") !== String(account.accountId || "")) return
    if (Number(snapshot.revision) < revision) return
    revision = Number(snapshot.revision)
    var entries = Array.isArray(snapshot.entries) ? snapshot.entries : []
    if (partial) {
      var merged = serverEntries.slice()
      for (var p = 0; p < entries.length; p++) {
        var found = -1
        for (var m = 0; m < merged.length; m++) if (merged[m].id === entries[p].id) { found = m; break }
        if (found < 0) merged.push(entries[p])
        else merged[found] = entries[p]
      }
      entries = merged
    }
    serverEntries = entries
    var waiting = []
    var busy = false
    var done = Object.assign({}, handled)
    var receipts = []
    var remaining = Object.assign({}, submitted)
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var id = String(entry.id || "")
      delete remaining[id]
      if (entry.state === "queued") waiting.push(entry)
      if (entry.state === "sending") busy = true
      if (done[id] === entry.state) continue
      if (entry.state === "sent") {
        done[id] = entry.state
        receipts.push(id)
        account.reportSendSuccess(entry.result || {}, id)
        if (entry.result && entry.result.draftRemoved && String(entry.draftId || "") !== ""
            && typeof account.sentDraftRemoved === "function") account.sentDraftRemoved(String(entry.draftId))
      } else if (entry.state === "failed" || entry.state === "unknown") {
        done[id] = entry.state
        account.reportSendFailure(entry.state === "unknown"
          ? "Delivery status is unknown. Check Sent before trying again."
          : "The message could not be sent. Your draft has been kept.", id)
      }
    }
    for (var key in remaining) waiting.push(remaining[key])
    waiting.sort(function(a, b) { return Number(a.order) - Number(b.order) || Number(a.queuedAt) - Number(b.queuedAt) })
    submitted = remaining
    handled = done
    parked = waiting
    account.sending = busy
    arm()
    for (var r = 0; r < receipts.length; r++) {
      (function(id) {
        Qt.callLater(function() {
          if (!queue || typeof queue.request !== "function" || queue.retired) return
          queue.request("outbox.forget", { sendId: id }, function(result, error) {
            if (!error) queue.apply(result.snapshot)
          })
        })
      })(receipts[r])
    }
  }
  function park(payload, id, order) {
    var sendId = String(id || "")
    var now = Date.now()
    var next = Object.assign({}, submitted)
    next[sendId] = { id: sendId, queuedAt: now, dueAt: now + account.undoSendSeconds * 1000, order: Number(order) || 0, state: "queued" }
    submitted = next
    parked = parked.concat([next[sendId]])
    arm()
    request("outbox.enqueue", { provider: String(account.providerId || ""), payload: payload,
      sendId: sendId, order: Math.max(0, Math.floor(Number(order) || 0)), delaySeconds: account.undoSendSeconds }, function(result, error) {
      if (error) {
        if (queue.handled[sendId] === "sent") return
        var unknown = Object.assign({}, queue.uncertain)
        unknown[sendId] = true
        queue.uncertain = unknown
        queue.account.note("Checking whether the message was queued")
        queue.reconcile(sendId)
        return
      }
      var remaining = Object.assign({}, queue.submitted)
      delete remaining[sendId]
      queue.submitted = remaining
      queue.apply(result.snapshot)
      queue.account.note("Message queued")
    })
    // The composer parks its draft immediately; refusal is reported later.
    return true
  }
  function reconcile(id) {
    if (!available()) return
    request("outbox.snapshot", { sendId: id }, function(result, error) {
      if (error || !result || !Array.isArray(result.entries)
          || String(result.accountId || "") !== String(queue.account.accountId || "")) return
      var unknown = Object.assign({}, queue.uncertain)
      delete unknown[id]
      queue.uncertain = unknown
      if (result && Array.isArray(result.entries) && result.entries.length > 0) {
        queue.apply(result, true)
        return
      }
      var remaining = Object.assign({}, queue.submitted)
      delete remaining[id]
      queue.submitted = remaining
      queue.parked = queue.parked.filter(function(entry) { return entry.id !== id })
      queue.arm()
      queue.account.reportSendFailure("The message was not queued. Your draft has been kept.", id)
    })
  }
  function sync() {
    if (!available() || String(account.accountId || "") === "") return
    request("outbox.snapshot", {}, function(result, error) { if (!error) queue.apply(result) })
    for (var id in uncertain) reconcile(id)
    if (undoPending) reconcileUndo()
  }
  function arm() {
    account.sendSecondsRemaining = latest ? Math.max(0, Math.ceil((latest.dueAt - Date.now()) / 1000)) : 0
    countdownTimer.running = parked.length > 0
  }
  // Existing callers can ask for reconciliation; only Rust starts delivery.
  function deliverDue() { sync(); return false }
  function deliverAll() {
    if (parked.length === 0) return false
    return request("outbox.flush", {}, function(result, error) {
      if (!error) queue.apply(result.snapshot)
      else queue.account.note("Queued messages could not be released")
    })
  }
  function finishUndo(id) {
    var pending = undoPending
    undoPending = null
    undoBusy = false
    if (pending && typeof pending.callback === "function") pending.callback(id)
  }
  function reconcileUndo() {
    if (!undoPending || !available()) return
    var id = undoPending.id
    request("outbox.snapshot", { sendId: id }, function(result, error) {
      if (error || !result || !Array.isArray(result.entries)
          || !queue.undoPending || queue.undoPending.id !== id) return
      if (result.entries.length > 0) queue.apply(result, true)
      var cancelled = result.entries.length > 0 && result.entries[0].state === "cancelled"
      queue.account.note(cancelled ? "Send undone" : "That message could not be undone")
      queue.finishUndo(cancelled ? id : "")
    })
  }
  function undoLatest(callback) {
    if (undoBusy || !latest) return false
    var id = String(latest.id)
    undoBusy = true
    undoPending = { id: id, callback: callback }
    return request("outbox.undo", { sendId: id }, function(result, error) {
      if (error) {
        queue.account.note("Checking whether the send was undone")
        queue.reconcileUndo()
        return
      }
      queue.apply(result.snapshot)
      queue.account.note("Send undone")
      queue.finishUndo(String(result.id || ""))
    })
  }
  function abandon() {
    if (!available()) return false
    var ids = parked.map(function(entry) { return String(entry.id) })
    return request("outbox.abandon", {}, function(result, error) {
      if (error) return
      queue.apply(result.snapshot)
      var entries = result.snapshot && Array.isArray(result.snapshot.entries) ? result.snapshot.entries : []
      for (var i = 0; i < ids.length; i++) {
        for (var e = 0; e < entries.length; e++) {
          if (entries[e].id === ids[i] && entries[e].state === "cancelled") {
            queue.account.reportSendFailure("Queued send cancelled. Your draft has been kept.", ids[i])
            break
          }
        }
      }
    })
  }
  readonly property Timer countdownTimer: Timer {
    interval: 250
    repeat: true
    onTriggered: queue.arm()
  }
  readonly property Connections backendEvents: Connections {
    target: queue.backend
    function onReadyChanged() {
      if (queue.available()) { queue.revision = -1; queue.sync() }
    }
    function onNotification(method, params) { if (method === "outbox.changed") queue.apply(params) }
  }
  readonly property Connections authEvents: Connections {
    target: queue.account ? queue.account.auth : null
    function onLoggedOut() { queue.abandon() }
  }
  Component.onCompleted: sync()
  Component.onDestruction: retired = true
}
