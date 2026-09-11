import QtQuick

// The editor supplies selection snapshots; Rust reads and prepares the context.
// Mail stays scoped to the captured account and launches no job until complete.
Item {
  id: root
  required property var service
  required property var runner
  property bool busy: false
  property string error: ""
  property int serial: 0
  property var handle: null
  property string requestId: ""
  property string accountId: ""

  function finishError(text) {
    serial++
    busy = false
    deadline.stop()
    error = String(text || "Could not prepare mail for AI")
    if (requestId !== "" && service && service.backend)
      service.backend.call("agent.contextCancel", {accountId:accountId,requestId:requestId}, function() {})
    requestId = ""
    if (handle && typeof handle.cancel === "function") handle.cancel()
    handle = null
  }

  function selectedSummary(owner, id) {
    var rows = owner.messages || []
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]
    if (owner.memberSummaries && owner.memberSummaries[id]) return owner.memberSummaries[id]
    return owner.selectedId === id ? owner.selectedMessage : null
  }

  function request(owner, ids, prompt) {
    if (busy || runner.starting) { error = "AI is still starting. Try again shortly."; return false }
    error = ""
    if (!owner || !Array.isArray(ids) || ids.length === 0 || ids.length > 20) {
      error = "Select between 1 and 20 messages from one mailbox."; return false
    }
    if (String(prompt || "").trim() === "") return false
    if (!service || !service.backend || !service.backend.ready) {
      error = "Mail backend unavailable"; return false
    }
    var summaries = []
    for (var i = 0; i < ids.length; i++) {
      var summary = selectedSummary(owner, ids[i])
      if (!summary) { error = "That message is no longer available."; return false }
      summaries.push(summary)
    }
    var token = ++serial
    var capturedOwner = String(owner.accountId || "")
    accountId = capturedOwner
    requestId = "context-" + Date.now() + "-" + token
    busy = true
    deadline.restart()
    handle = service.backend.call("agent.context", {accountId:capturedOwner,
      requestId:requestId, ids:ids, summaries:summaries,
      folder:String(owner.mailboxKey || ""), prompt:String(prompt)}, function(result, failure) {
      if (token !== root.serial) return
      if (!owner || root.service.findAccount(capturedOwner) !== owner) {
        root.finishError("That mailbox is no longer set up."); return
      }
      if (failure || !result || !result.payload) {
        root.finishError(failure && failure.message === "agent_context_too_large"
          ? "These messages are too large. Select fewer messages."
          : "Could not prepare mail for AI. Try again.")
        return
      }
      if (String(result.payload.accountId || "") !== capturedOwner) {
        root.finishError("Mail context does not belong to this mailbox."); return
      }
      root.busy = false
      root.deadlineStop()
      root.requestId = ""
      root.handle = null
      if (!root.runner.start(JSON.stringify(result.payload))) root.error = root.runner.lastError
    })
    return true
  }

  function deadlineStop() { deadline.stop() }
  Timer {
    id: deadline
    interval: 60000
    onTriggered: root.finishError("Reading mail for AI timed out. Try again.")
  }
  Component.onDestruction: {
    if (busy) finishError("Cancelled")
  }
}
