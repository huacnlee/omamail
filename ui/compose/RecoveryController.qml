import QtQuick
import "Recovery.js" as Recovery
import "../account/Navigation.js" as Nav

// Reconcile a recovered composer with durable delivery receipts before reopening
// it. A transport failure cannot turn a potentially sent message into a retry.
QtObject {
  id: controller
  required property var app
  required property var composer
  required property var recoveryTimer
  readonly property var composeRecoveryTimer: recoveryTimer
  readonly property var root: app
  readonly property var compose: composer
  readonly property var service: app ? app.service : null
  function reconcileComposeReceipts() {
    if (root.composeReceiptChecking) return
    var record = root.composeRecovery
    var drafts = record && record.active && record.draft ? [record.draft].concat(record.parked || []) : []
    var pending = drafts.filter(function(draft) { return String(draft.pendingSendId || "") !== "" })
    if (pending.length === 0) { Qt.callLater(root.restoreComposeRecovery); return }
    if (!root.service || !root.service.backend || !root.service.backend.ready) return
    root.composeReceiptChecking = true
    var mine = root.composeRecoveryRevision
    var states = {}
    var at = 0
    function next() {
      if (!root || typeof root.restoreComposeRecovery !== "function") return
      if (mine !== root.composeRecoveryRevision) { root.composeReceiptChecking = false; return }
      if (at >= pending.length) { finish(); return }
      var draft = pending[at++]
      root.service.backend.call("outbox.snapshot", { accountId: String(draft.accountId || ""), sendId: String(draft.pendingSendId) }, function(result, error) {
        if (!root || typeof root.restoreComposeRecovery !== "function") return
        if (error || !result || !Array.isArray(result.entries)) {
          root.composeReceiptChecking = false
          root.draftSavedNotice = "Checking whether the recovered message was sent. Reconnect the mail backend."
          return
        }
        states[String(draft.accountId) + "\n" + String(draft.pendingSendId)] = result.entries.length ? String(result.entries[0].state || "unknown") : "missing"
        Qt.callLater(next)
      })
    }
    function finish() {
      root.composeReceiptChecking = false
      root.composeDeliveryStates = states
      var restored = [], waiting = [], receipts = []
      for (var i = 0; i < drafts.length; i++) {
        var draft = drafts[i]
        var id = String(draft.pendingSendId || "")
        if (id === "") { restored.push(draft); continue }
        var state = states[String(draft.accountId) + "\n" + id]
        if (state === "queued" || state === "sending") { waiting.push(draft); continue }
        if (state !== "unknown" && state !== "missing") receipts.push({accountId: String(draft.accountId), sendId: id})
        if (state === "sent") continue
        var recovered = Object.assign({}, draft)
        delete recovered.pendingSendId
        recovered.deliveryUnknown = state === "unknown"
        restored.push(recovered)
      }
      var parked = compose.parkedDrafts.slice()
      for (var w = 0; w < waiting.length; w++) {
        var id = String(waiting[w].pendingSendId)
        if (!parked.some(function(entry) { return entry.sendId === id && entry.draft && String(entry.draft.accountId || "") === String(waiting[w].accountId || "") })) parked.push({sendId:id,draft:waiting[w]})
      }
      compose.parkedDrafts = parked
      var all = restored.concat(waiting)
      var updated = all.length ? {version:1,active:true,returnView:record.returnView,draft:all[0],parked:all.slice(1)} : Recovery.empty()
      root.composeRecovery = updated
      root.composeRecoveryRevision++
      root.lastComposeRecoveryText = updated.active ? JSON.stringify(updated) : ""
      root.writeComposeRecovery(JSON.stringify(updated))
      for (var a = 0; a < receipts.length; a++) root.queueComposeReceiptAck(receipts[a].accountId, receipts[a].sendId, root.composeRecoveryRevision)
      Qt.callLater(root.restoreComposeRecovery)
    }
    next()
  }

  function queueComposeReceiptAck(accountId, sendId, revision) {
    if (accountId === "" || sendId === "") return
    var next = root.composeReceiptAcks.filter(function(entry) { return entry.accountId !== accountId || entry.sendId !== sendId })
    next.push({accountId:accountId,sendId:sendId,revision:revision})
    root.composeReceiptAcks = next
    controller.acknowledgeComposeReceipts()
  }
  function acknowledgeComposeReceipts() {
    if (!root.service || !root.service.backend || !root.service.backend.ready) return
    for (var i = 0; i < root.composeReceiptAcks.length; i++) {
      (function(entry) {
        var key = entry.accountId + "\n" + entry.sendId
        if (entry.revision > root.composeCommittedRevision || root.composeReceiptAckBusy[key]) return
        var busy = Object.assign({}, root.composeReceiptAckBusy); busy[key] = true; root.composeReceiptAckBusy = busy
        root.service.backend.call("outbox.snapshot", {accountId:entry.accountId,sendId:entry.sendId}, function(result,error) {
          if (!root || typeof root.acknowledgeComposeReceipts !== "function") return
          var state = !error && result && result.entries && result.entries.length ? result.entries[0].state : ""
          if (state !== "sent" && state !== "cancelled" && state !== "failed") {
            var busy = Object.assign({}, root.composeReceiptAckBusy); delete busy[key]; root.composeReceiptAckBusy = busy
            return
          }
          root.service.backend.call("outbox.forget", {accountId:entry.accountId,sendId:entry.sendId}, function(result,error) {
            if (!root || typeof root.acknowledgeComposeReceipts !== "function") return
            var busy = Object.assign({}, root.composeReceiptAckBusy); delete busy[key]; root.composeReceiptAckBusy = busy
            if (!error) root.composeReceiptAcks = root.composeReceiptAcks.filter(function(value) { return value.accountId !== entry.accountId || value.sendId !== entry.sendId })
          })
        })
      })(root.composeReceiptAcks[i])
    }
  }

  function readComposeRecovery() {
    if (!root.service || !root.service.backend || !root.service.backend.ready || root.composeReading) return
    root.composeReading = true
    var mine = root.composeRecoveryRevision
    root.service.backend.call("compose.recoveryRead", {}, function(result, error) {
      if (!root) return
      root.composeReading = false
      if (error || !result) return
      if (root.composeRecoveryConflict && root.composeWriteQueued) return
      root.composeStorageRevision = String(result.revision || "")
      root.composeRecoveryLoaded = true
      if (root.composeRecoveryRevision === mine && root.composeWritePayload === "") {
        root.composeCommittedRevision = mine
        root.loadComposeRecovery(result.record)
      }
      root.drainComposeRecovery()
    })
  }

  function restoreComposeRecovery() {
    if (root.composeReceiptChecking || !root.opened || !root.composeRecoveryLoaded || root.composeRecovery.active !== true
        || compose.opened || !root.composeRecovery.draft) return false
    if (String(root.composeRecovery.draft.pendingSendId || "") !== "") return false
    if (root.composeRecovery.draft.deliveryUnknown === true) root.draftSavedNotice = "Delivery status is unknown. Check Sent before trying again."
    var accountId = String(root.composeRecovery.draft.accountId || "")
    if (accountId !== "" && root.service
        && String(root.service.activeAccountId || "") !== accountId
        && typeof root.service.switchTo === "function" && root.service.switchTo(accountId) === false) {
      root.draftSavedNotice = "This draft belongs to an unavailable account."
      return false
    }
    root.pendingComposeReturnTo = root.composeRecovery.returnView === "reader" ? Nav.depth(root.nav) : 1
    root.composeRecoveryRestoring = true
    compose.restoreDraft(root.composeRecovery.draft)
    root.composeRecoveryRestoring = false
    var parked = (root.composeRecovery.parked || []).filter(function(draft) { return String(draft.pendingSendId || "") === "" })
    if (parked.length > 0) compose.recoveryDrafts = compose.recoveryDrafts.concat(parked)
    return true
  }

  function parkedBesides(draft) {
    var out = []
    var parked = compose.parkedDrafts || []
    for (var i = 0; i < parked.length; i++) {
      if (parked[i].draft !== draft) out.push(Object.assign({}, parked[i].draft, {pendingSendId: String(parked[i].sendId || "")}))
    }
    var recovered = compose.recoveryDrafts || []
    for (var j = 0; j < recovered.length; j++) {
      if (recovered[j] !== draft) out.push(recovered[j])
    }
    return out
  }

  function saveComposeRecovery(saved) {
    composeRecoveryTimer.stop()
    var draft = saved || (compose.opened ? compose.snapshotDraft()
      : (compose.parkedForSend ? compose.pendingDraft : null))
    if (!draft) {
      root.clearComposeRecovery()
      return root.composeRecoveryRevision
    }
    var recordDraft = draft
    var sends = compose.parkedDrafts || []
    for (var p = 0; p < sends.length; p++) if (sends[p].draft === draft) recordDraft = Object.assign({}, draft, {pendingSendId: String(sends[p].sendId || "")})
    var record = { version: 1, active: true, returnView: root.composeReturnView(), draft: recordDraft, parked: root.parkedBesides(draft) }
    var raw = JSON.stringify(record)
    root.composeRecovery = record
    if (raw === root.lastComposeRecoveryText) return root.composeRecoveryRevision
    root.composeRecoveryRevision++
    root.lastComposeRecoveryText = raw
    root.writeComposeRecovery(raw)
    return root.composeRecoveryRevision
  }

  function scheduleComposeRecovery() {
    if (root.composeRecoveryRestoring) return
    composeRecoveryTimer.restart()
  }

  function clearComposeRecovery(expectedRevision) {
    if (expectedRevision !== undefined
        && Number(expectedRevision) !== root.composeRecoveryRevision) return false
    composeRecoveryTimer.stop()
    root.composeRecovery = Recovery.empty()
    root.composeRecoveryRevision++
    if (root.lastComposeRecoveryText === "") return true
    root.lastComposeRecoveryText = ""
    root.writeComposeRecovery('{"version":1,"active":false}')
    return true
  }

  function writeComposeRecovery(raw) {
    root.composeWritePayload = String(raw || "")
    root.composeWriteQueued = true
    if (!root.composeRecoveryLoaded || root.composeStorageRevision === "") root.readComposeRecovery()
    else root.drainComposeRecovery()
  }

  function drainComposeRecovery() {
    if (root.composeRecoveryConflict || root.composeWriting || !root.composeWriteQueued || !root.composeRecoveryLoaded
        || !root.service || !root.service.backend || !root.service.backend.ready || root.composeStorageRevision === "") return
    var raw = root.composeWritePayload
    var mine = root.composeRecoveryRevision
    root.composeWriteQueued = false
    root.composeWriting = true
    root.service.backend.call("compose.recoverySave", { record: JSON.parse(raw), expectedRevision: root.composeStorageRevision }, function(result, error) {
      if (!root) return
      root.composeWriting = false
      if (error || !result) {
        // Keep the live draft. A stale process must never overwrite another
        // instance's saved recovery just by retrying with a fresh revision.
        root.composeWriteQueued = true
        root.composeRecoveryConflict = !!error && error.message === "recovery_conflict"
        root.draftSavedNotice = "Draft recovery could not be saved. Keep this window open."
        return
      }
      root.composeStorageRevision = String(result.revision || "")
      root.composeCommittedRevision = Math.max(root.composeCommittedRevision, mine)
      root.acknowledgeComposeReceipts()
      if (mine === root.composeRecoveryRevision && !root.composeWriteQueued) {
        root.composeRecovery = result.record
        if (!result.record || result.record.active !== true) root.lastComposeRecoveryText = ""
        root.composeWritePayload = ""
      }
      root.drainComposeRecovery()
    })
  }

}
